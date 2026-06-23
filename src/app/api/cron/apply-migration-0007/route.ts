// POST /api/cron/apply-migration-0007
// One-shot: apply migration 0007 via Supabase Management API.
// Requires CRON_SECRET + SUPABASE_ACCESS_TOKEN in server env.
import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const secret = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!secret || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const token = process.env.SUPABASE_ACCESS_TOKEN?.trim();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  if (!token) {
    return NextResponse.json(
      { error: "SUPABASE_ACCESS_TOKEN is not configured on the server" },
      { status: 500 }
    );
  }
  if (!url) {
    return NextResponse.json({ error: "NEXT_PUBLIC_SUPABASE_URL missing" }, { status: 500 });
  }

  const ref = new URL(url).hostname.split(".")[0];
  const sqlPath = path.join(process.cwd(), "supabase/migrations/0007_reporting_fields.sql");
  const sql = fs.readFileSync(sqlPath, "utf8");

  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query: sql }),
  });

  const body = await res.text();
  if (!res.ok) {
    return NextResponse.json(
      { error: "migration failed", status: res.status, detail: body },
      { status: 500 }
    );
  }

  return NextResponse.json({ ok: true, message: "Migration 0007 applied", detail: body || null });
}
