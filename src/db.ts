/**
 * Postgres access for the quality layer. Everything here is raw SQL through
 * drizzle's `sql` tag on a postgres-js connection, so the tables in `sql/`
 * are the whole contract. Tests swap the executor with `setDb`.
 */
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";

export type Exec = { execute: (q: unknown) => Promise<unknown> };

let db: Exec | null = null;

export function setDb(exec: Exec | null) {
  db = exec;
}

export async function tdb() {
  if (!db) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    db = drizzle(postgres(url, { max: 5 })) as unknown as Exec;
  }
  return { d: db, sql };
}

export function rowsOf(res: unknown): Record<string, unknown>[] {
  if (Array.isArray(res)) return res as Record<string, unknown>[];
  const rows = (res as { rows?: unknown })?.rows;
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
}

export function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

export function iso(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(String(v).replace(" ", "T").replace(/\+00$/, "Z"));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
