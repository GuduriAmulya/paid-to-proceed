/**
 * Thin PayPal REST client for the money-moving parts of Paid to Proceed:
 * Invoicing v2 (create / send / remind / record payment / get) and Payouts v1.
 * All calls go to the sandbox unless PAYPAL_ENVIRONMENT=PRODUCTION.
 */
import crypto from "node:crypto";
import { config, hasPayPal, paypalBaseUrl } from "./config.js";

let cachedToken: { value: string; expiresAt: number; scope: string; appId: string } | null = null;

/** Which PayPal features Paid to Proceed needs are missing from the app's granted scopes. */
export async function missingFeatures(): Promise<string[]> {
  await getAccessToken();
  const scope = cachedToken?.scope ?? "";
  const need: [string, string][] = [
    ["invoicing", "Invoicing"],
    ["payouts", "Payouts"],
    ["reporting", "Transaction search"],
  ];
  return need.filter(([k]) => !scope.includes(k)).map(([, label]) => label);
}

export class PayPalError extends Error {
  constructor(
    message: string,
    public status: number,
    public details?: unknown,
  ) {
    super(message);
  }
}

export async function getAccessToken(): Promise<string> {
  if (!hasPayPal) throw new PayPalError("PayPal credentials are not configured (PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET).", 500);
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;
  const basic = Buffer.from(`${config.paypalClientId}:${config.paypalClientSecret}`).toString("base64");
  const res = await fetch(`${paypalBaseUrl}/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  const body = (await res.json()) as { access_token?: string; expires_in?: number; error_description?: string; scope?: string; app_id?: string };
  if (!res.ok || !body.access_token) throw new PayPalError(`PayPal auth failed: ${body.error_description ?? res.status}`, res.status, body);
  cachedToken = {
    value: body.access_token,
    expiresAt: Date.now() + (body.expires_in ?? 3000) * 1000,
    scope: body.scope ?? "",
    appId: body.app_id ?? "",
  };
  return cachedToken.value;
}

async function pp<T = any>(method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}, retried = false): Promise<T> {
  const token = await getAccessToken();
  const res = await fetch(`${paypalBaseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "PayPal-Request-Id": crypto.randomUUID(),
      ...extraHeaders,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? safeJson(text) : {};
  // A cached token keeps the scopes the app had when it was issued. If a feature (e.g. Invoicing)
  // was just enabled in the dashboard, fetch a fresh token once and retry.
  if ((res.status === 401 || res.status === 403) && !retried) {
    cachedToken = null;
    return pp<T>(method, path, body, extraHeaders, true);
  }
  if (!res.ok) {
    const d = data as { message?: string; details?: { issue?: string; description?: string }[] };
    const detail = d.details?.map((x) => x.description ?? x.issue).join("; ");
    throw new PayPalError(`PayPal ${method} ${path} failed (${res.status}): ${d.message ?? text}${detail ? ` - ${detail}` : ""}`, res.status, data);
  }
  return data as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

const money = (value: number, currency: string) => ({ currency_code: currency, value: value.toFixed(2) });

export interface InvoiceInput {
  freelancerName: string;
  clientName: string;
  clientEmail: string;
  currency: string;
  itemName: string;
  itemDescription: string;
  amount: number;
  note: string;
  dueDate: string; // YYYY-MM-DD
  reference: string;
}

/** Creates a draft invoice and returns { id, number }. */
export async function createInvoice(input: InvoiceInput): Promise<{ id: string; number: string }> {
  const { invoice_number } = await pp<{ invoice_number: string }>("POST", "/v2/invoicing/generate-next-invoice-number");
  const invoice = await pp<{ id: string; detail: { invoice_number: string } }>(
    "POST",
    "/v2/invoicing/invoices",
    {
      detail: {
        invoice_number,
        reference: input.reference.slice(0, 120),
        currency_code: input.currency,
        note: input.note.slice(0, 4000),
        term: "Payment releases the next project phase.",
        payment_term: { due_date: input.dueDate },
      },
      invoicer: { business_name: input.freelancerName.slice(0, 300) },
      primary_recipients: [
        {
          billing_info: {
            business_name: input.clientName.slice(0, 300),
            email_address: input.clientEmail,
          },
        },
      ],
      items: [
        {
          name: input.itemName.slice(0, 200),
          description: input.itemDescription.slice(0, 1000),
          quantity: "1",
          unit_amount: money(input.amount, input.currency),
          unit_of_measure: "AMOUNT",
        },
      ],
      configuration: { allow_tip: false, tax_calculated_after_discount: true, tax_inclusive: false },
    },
    { Prefer: "return=representation" },
  );
  return { id: invoice.id, number: invoice.detail?.invoice_number ?? invoice_number };
}

export async function sendInvoice(id: string, subject: string, note: string): Promise<void> {
  await pp("POST", `/v2/invoicing/invoices/${id}/send`, {
    subject: subject.slice(0, 4000),
    note: note.slice(0, 4000),
    send_to_invoicer: true,
    send_to_recipient: true,
  });
}

export async function remindInvoice(id: string, subject: string, note: string): Promise<void> {
  await pp("POST", `/v2/invoicing/invoices/${id}/remind`, {
    subject: subject.slice(0, 4000),
    note: note.slice(0, 4000),
    send_to_invoicer: false,
    send_to_recipient: true,
  });
}

export interface InvoiceSummary {
  id: string;
  status: string;
  payerUrl?: string;
  paidAmount?: number;
  lastPaymentDate?: string;
}

export async function getInvoice(id: string): Promise<InvoiceSummary> {
  const inv = await pp<any>("GET", `/v2/invoicing/invoices/${id}`);
  const txs: any[] = inv.payments?.transactions ?? [];
  return {
    id: inv.id,
    status: inv.status,
    payerUrl: inv.detail?.metadata?.recipient_view_url,
    paidAmount: inv.payments?.paid_amount ? Number(inv.payments.paid_amount.value) : undefined,
    lastPaymentDate: txs.length ? txs[txs.length - 1].payment_date : undefined,
  };
}

/** Records a payment made outside the PayPal checkout (used by the demo "simulate client payment" button). */
export async function recordInvoicePayment(id: string, amount: number, currency: string, date: string): Promise<void> {
  await pp("POST", `/v2/invoicing/invoices/${id}/payments`, {
    method: "OTHER",
    payment_date: date,
    amount: money(amount, currency),
    note: "Simulated client payment (Paid to Proceed demo mode)",
  });
}

export async function createPayout(opts: {
  receiverEmail: string;
  amount: number;
  currency: string;
  note: string;
  reference: string;
}): Promise<{ batchId: string; status: string }> {
  const res = await pp<{ batch_header: { payout_batch_id: string; batch_status: string } }>("POST", "/v1/payments/payouts", {
    sender_batch_header: {
      sender_batch_id: `ptp_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`,
      email_subject: "You've been paid for your work",
      email_message: opts.note.slice(0, 1000),
    },
    items: [
      {
        recipient_type: "EMAIL",
        amount: { value: opts.amount.toFixed(2), currency: opts.currency },
        receiver: opts.receiverEmail,
        note: opts.note.slice(0, 4000),
        sender_item_id: opts.reference.slice(0, 63),
      },
    ],
  });
  return { batchId: res.batch_header.payout_batch_id, status: res.batch_header.batch_status };
}

export async function getPayoutStatus(batchId: string): Promise<string> {
  const res = await pp<{ batch_header: { batch_status: string } }>("GET", `/v1/payments/payouts/${batchId}`);
  return res.batch_header.batch_status;
}

/** Verifies a webhook delivery with PayPal. Returns false when no webhook id is configured. */
export async function verifyWebhook(headers: Record<string, string | string[] | undefined>, event: unknown): Promise<boolean> {
  if (!config.paypalWebhookId) return false;
  const h = (k: string) => String(headers[k] ?? "");
  const res = await pp<{ verification_status: string }>("POST", "/v1/notifications/verify-webhook-signature", {
    auth_algo: h("paypal-auth-algo"),
    cert_url: h("paypal-cert-url"),
    transmission_id: h("paypal-transmission-id"),
    transmission_sig: h("paypal-transmission-sig"),
    transmission_time: h("paypal-transmission-time"),
    webhook_id: config.paypalWebhookId,
    webhook_event: event,
  });
  return res.verification_status === "SUCCESS";
}
