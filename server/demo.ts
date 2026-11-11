import { projectFromPlan } from "./agent.js";
import type { ContractPlan } from "./ai.js";
import { addDays, isoDate, log, now } from "./store.js";
import type { Project } from "./types.js";

export const SAMPLE_CONTRACT = `FREELANCE SERVICES AGREEMENT

Between: Ananya Rao, independent product designer & developer, Bengaluru, India ("Freelancer")
And: Harbor & Pine Physiotherapy LLC, Seattle, Washington, USA ("Client"), contact: Dana Whitfield, Practice Manager

1. PROJECT
Freelancer will redesign the Client's website and add online appointment booking so patients can book without calling.

2. MILESTONES & PAYMENT (USD, paid via PayPal invoice)
Milestone 1 - Discovery & Design: USD 1,200
  Deliverables: patient journey map, sitemap, high-fidelity mockups for Home, Services and Book Appointment pages (desktop + mobile).
  Accepted when: Client has reviewed mockups for all three pages in both breakpoints; one round of revisions incorporated.
Milestone 2 - Build: USD 2,400
  Deliverables: responsive website built from the approved design, clinician profiles (up to 12), online booking with intake form.
  Accepted when: site runs on a staging URL, all pages pass a mobile check, a test booking completes end to end and reaches the front desk.
Milestone 3 - Launch & Handover: USD 900
  Deliverables: production launch, analytics set-up, 45-minute recorded training session for front-desk staff, handover document.
  Accepted when: site is live on the Client's domain, training is delivered, handover document is shared.

Each invoice is payable within 7 days. Work on the next milestone begins once the previous invoice is paid.

3. SUBCONTRACTORS
Freelancer will engage Meera Iyer (illustrator) for custom exercise illustrations in Milestone 1; Meera receives 25% of
Milestone 1. Kabir Shah (QA tester) will test the booking flow in Milestone 2 and receives 10% of Milestone 2.

4. GENERAL
Client owns the final deliverables after full payment. Either party may end this agreement with 14 days' written notice.
`;

const PLAN: ContractPlan = {
  projectName: "Harbor & Pine website + online booking",
  summary: "Website redesign with online appointment booking for a Seattle physiotherapy clinic, billed in three PayPal-invoiced milestones.",
  freelancerName: "Ananya Rao",
  freelancerLocation: "Bengaluru, India",
  clientCompany: "Harbor & Pine Physiotherapy",
  clientContactName: "Dana",
  clientEmail: "",
  currency: "USD",
  startDate: "",
  paymentTermsDays: 7,
  milestones: [
    {
      name: "Discovery & Design",
      amount: 1200,
      deliverables: ["Patient journey map", "Sitemap", "Hi-fi mockups: Home, Services, Book Appointment (desktop + mobile)"],
      acceptanceCriteria: [
        "Mockups exist for Home, Services and Book Appointment pages",
        "Each mockup has both desktop and mobile versions",
        "Client has reviewed the mockups",
        "One round of revisions has been incorporated",
      ],
      tasks: [
        { name: "Discovery call & journey map", durationDays: 2 },
        { name: "Sitemap & wireframes", durationDays: 3 },
        { name: "High-fidelity mockups", durationDays: 4 },
      ],
    },
    {
      name: "Build",
      amount: 2400,
      deliverables: ["Responsive site from approved design", "Clinician profiles (up to 12)", "Online booking with intake form"],
      acceptanceCriteria: [
        "Site runs on a staging URL",
        "All pages pass a mobile check",
        "A test booking completes end to end and reaches the front desk",
      ],
      tasks: [
        { name: "Front-end build", durationDays: 6 },
        { name: "Booking flow & intake form", durationDays: 5 },
        { name: "QA pass", durationDays: 2 },
      ],
    },
    {
      name: "Launch & Handover",
      amount: 900,
      deliverables: ["Production launch", "Analytics set-up", "Recorded front-desk training", "Handover document"],
      acceptanceCriteria: ["Site is live on the client's domain", "Training session delivered", "Handover document shared"],
      tasks: [
        { name: "Launch & analytics", durationDays: 2 },
        { name: "Training & handover", durationDays: 2 },
      ],
    },
  ],
  subcontractors: [
    { name: "Meera Iyer", role: "Illustrator", milestoneIndex: 0, percent: 25 },
    { name: "Kabir Shah", role: "QA tester", milestoneIndex: 1, percent: 10 },
  ],
  risks: ["No late-payment fee is defined.", "\"Client has reviewed\" has no deadline - review could stall payment."],
};

export const SAMPLE_SUBMISSION = `Milestone 1 is ready for review.
- Figma file: https://figma.example/harbor-pine-v2 (Home, Services, Book Appointment - each with desktop 1440px and mobile 390px frames)
- Patient journey map and sitemap are on pages 1-2 of the file.
- Dana reviewed the first draft on our call on Tuesday and asked for calmer colours and a "Book now" button above the fold; both changes are in v2.
- Meera's exercise illustrations are used on the Services page.`;

/** Seeds the demo project so that Milestone 1's design work finishes today. */
export function demoProject(): Project {
  const p = projectFromPlan(PLAN);
  const m1Days = PLAN.milestones[0].tasks.reduce((s, t) => s + t.durationDays, 0);
  p.startDate = addDays(isoDate(now()), -m1Days);
  p.activity = [];
  log(p, "agent", "Read the contract and built 3 payment-gated phases worth USD 4,500.");
  for (const r of PLAN.risks) log(p, "agent", `Payment risk spotted: ${r}`);
  return p;
}
