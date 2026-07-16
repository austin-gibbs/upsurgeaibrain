// =====================================================================
// Inbound line routing.
//
// Each business inbound line (the number a caller DIALS) belongs to one
// representative. When an inbound call is answered by the concierge agent,
// the post-call assignment + follow-up task must land on the rep who owns
// the line that was dialed — not a fixed pair of users.
//
// The map is keyed by E.164 dialed number → rep display name. Phone numbers
// are globally unique, so a single flat map is collision-free across
// workspaces. `pickAssigneeForLine` matches that rep name against the CRM's
// user list (case-insensitive substring, same convention as the rest of the
// inbound handler) and returns the CRM user to assign/task.
// =====================================================================
import type { CrmUser } from "@/lib/crm/types";

/** One inbound line: the rep who owns it and (optionally) an emergency cell. */
export interface InboundLineRep {
  /** Rep display name — matched (case-insensitive substring) against CRM users. */
  repName: string;
  /** Human-readable role, for logs/notes. */
  role?: string;
}

/**
 * E.164 dialed-number → owning rep. Add a line here when a rep gets a
 * dedicated inbound number. Keys MUST be normalized E.164 (see toE164).
 *
 * Nil Patel Realty lines (2026-07):
 */
export const INBOUND_LINE_ROUTING: Record<string, InboundLineRep> = {
  "+16782571251": { repName: "Nil Patel", role: "Owner" },
  "+16789168797": { repName: "Jori Garcia", role: "Executive Assistant / Operations / Transaction Coordinator" },
  "+14704314727": { repName: "Rudi Mauch", role: "Client Acquisition and Service (listing to closing)" },
  "+14707064491": { repName: "Sergio Saballos", role: "Lead Generator" },
  "+16785626887": { repName: "Danny Triplin", role: "Property Manager / Licensed Buyers Agent" },
};

/**
 * Coerce a raw phone into E.164. Mirrors the FUB adapter's normalizer so a
 * dialed number in any common US shape (already-E.164, 10-digit, 1+10) maps to
 * the same key we store above. Returns null for unknown shapes.
 */
export function toE164(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("+")) return "+" + trimmed.slice(1).replace(/\D/g, "");
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

/** The rep who owns the dialed line, or null when the number isn't mapped. */
export function resolveLineRep(
  toNumber: string | null | undefined
): InboundLineRep | null {
  const e164 = toE164(toNumber);
  if (!e164) return null;
  return INBOUND_LINE_ROUTING[e164] ?? null;
}

/**
 * Resolve the CRM user to assign/task for the dialed line. Returns null when
 * the line is unmapped OR the owning rep has no matching CRM user (so the
 * caller can fall back to default behavior). Match is case-insensitive
 * substring on the rep name, consistent with the inbound handler's existing
 * user matching.
 */
export function pickAssigneeForLine(
  toNumber: string | null | undefined,
  users: CrmUser[]
): CrmUser | null {
  const rep = resolveLineRep(toNumber);
  if (!rep) return null;
  const target = rep.repName.trim().toLowerCase();
  // Prefer a full-name match; fall back to first-name substring so "Nil Patel"
  // still resolves a CRM user stored as "Nil P." etc.
  const firstName = target.split(/\s+/)[0];
  return (
    users.find((u) => u.name?.toLowerCase().includes(target)) ??
    users.find((u) => u.name?.toLowerCase().includes(firstName)) ??
    null
  );
}
