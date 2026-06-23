import type { CrmProvider } from "@/types";

/** Normalize a user-entered CRM base URL (strip trailing slash). */
export function normalizeCrmAccountUrl(raw: string | null | undefined): string | null {
  if (!raw?.trim()) return null;
  return raw.trim().replace(/\/+$/, "");
}

/**
 * Build a deep-link to a contact record in the CRM.
 * FUB: {base}/2/people/view/{personId}
 */
export function crmContactUrl(
  crmProvider: CrmProvider,
  crmAccountUrl: string | null | undefined,
  crmContactId: string | null | undefined
): string | null {
  if (!crmContactId?.trim()) return null;
  const base = normalizeCrmAccountUrl(crmAccountUrl);
  if (!base) return null;
  if (crmProvider === "followupboss") {
    return `${base}/2/people/view/${crmContactId.trim()}`;
  }
  // HighLevel contact URLs vary by sub-account; not supported yet.
  return null;
}
