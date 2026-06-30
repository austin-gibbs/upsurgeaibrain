// Pure poll enrollment-sync helpers (unit-tested; used by poller.ts).
import type { Contact } from "@/types";
import type { CrmContact } from "@/lib/crm/types";

export interface MergedContactRow {
  workspace_id: string;
  crm_contact_id: string;
  full_name: string | null;
  email: string | null;
  phones: string[];
  tags: string[];
  attempt_count: number;
  last_called_on: string | null;
  next_eligible_on: string | null;
  is_terminal: boolean;
  terminal_outcome: Contact["terminal_outcome"];
}

/** Remove one enroll tag from a local tags array (no-op when absent). */
export function stripEnrollTagFromTags(tags: string[], enrollTag: string): string[] {
  return tags.filter((t) => t !== enrollTag);
}

/**
 * Build upsert rows from CRM scan + existing cache, preserving cadence state.
 */
export function buildMergedContactRows(
  crmContacts: CrmContact[],
  existingByCrmId: Map<string, Contact>,
  workspaceId: string
): MergedContactRow[] {
  return crmContacts.map((c) => {
    const existing = existingByCrmId.get(c.id);
    return {
      workspace_id: workspaceId,
      crm_contact_id: c.id,
      full_name: c.fullName,
      email: c.email,
      phones: c.phones,
      tags: c.tags,
      attempt_count: existing?.attempt_count ?? 0,
      last_called_on: existing?.last_called_on ?? null,
      next_eligible_on: existing?.next_eligible_on ?? null,
      is_terminal: existing?.is_terminal ?? false,
      terminal_outcome: existing?.terminal_outcome ?? null,
    };
  });
}

/** CRM contact ids returned by the latest enroll-tag scan. */
export function enrolledCrmIds(crmContacts: CrmContact[]): Set<string> {
  return new Set(crmContacts.map((c) => c.id));
}
