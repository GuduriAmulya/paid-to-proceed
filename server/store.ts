import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { config } from "./config.js";
import type { ActivityEvent, DB, Project } from "./types.js";

const file = path.resolve(config.dataFile);
let db: DB = load();

function load(): DB {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as DB;
  } catch {
    return { clockOffsetDays: 0, projects: [] };
  }
}

export function save(): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(db, null, 2));
}

export function getDb(): DB {
  return db;
}

export function resetDb(next: DB): void {
  db = next;
  save();
}

export function uid(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(5).toString("hex")}`;
}

/** The app's "now", shifted by the demo clock so overdue flows can be shown live. */
export function now(): Date {
  return new Date(Date.now() + db.clockOffsetDays * 86_400_000);
}

export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function addDays(dateIso: string, days: number): string {
  const d = new Date(dateIso + (dateIso.length === 10 ? "T00:00:00Z" : ""));
  d.setUTCDate(d.getUTCDate() + days);
  return isoDate(d);
}

export function daysBetween(aIso: string, bIso: string): number {
  const a = Date.parse(aIso.slice(0, 10) + "T00:00:00Z");
  const b = Date.parse(bIso.slice(0, 10) + "T00:00:00Z");
  return Math.round((b - a) / 86_400_000);
}

export function getProject(id: string): Project {
  const p = db.projects.find((x) => x.id === id);
  if (!p) throw Object.assign(new Error(`Project ${id} not found`), { status: 404 });
  return p;
}

export function log(project: Project, kind: ActivityEvent["kind"], text: string): void {
  project.activity.unshift({ id: uid("evt"), at: now().toISOString(), kind, text });
  project.activity = project.activity.slice(0, 200);
}
