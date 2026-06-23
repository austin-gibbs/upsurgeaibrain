// Health checks for the stuck-call reconciler — logs warnings when the webhook
// path is degraded and reconcile becomes the primary writeback mechanism.
import type { SupabaseClient } from "@supabase/supabase-js";

const RECONCILE_SHARE_THRESHOLD = 0.1; // 10%

export async function logReconcileHealthWarning(
  supabase: SupabaseClient,
  reconciledThisSweep: number
): Promise<void> {
  if (reconciledThisSweep <= 0) return;

  console.warn(
    `[reconcile] WARNING: ${reconciledThisSweep} call(s) finalized via reconcile sweep — ` +
      "real-time webhook may be failing. Verify RETELL_WEBHOOK_SECRET and " +
      "CREDENTIALS_ENCRYPTION_KEY are set on Vercel (must match worker/Railway)."
  );

  const oneHourAgo = new Date(Date.now() - 60 * 60_000).toISOString();
  const { count: total } = await supabase
    .from("calls")
    .select("id", { count: "exact", head: true })
    .eq("status", "completed")
    .gte("completed_at", oneHourAgo);

  const { count: viaReconcile } = await supabase
    .from("calls")
    .select("id", { count: "exact", head: true })
    .eq("status", "completed")
    .eq("finalized_by", "reconcile")
    .gte("completed_at", oneHourAgo);

  if (!total || total === 0 || viaReconcile == null) return;

  const share = viaReconcile / total;
  if (share > RECONCILE_SHARE_THRESHOLD) {
    console.warn(
      `[reconcile] HEALTH ALERT: ${(share * 100).toFixed(0)}% of calls in the last hour ` +
        `finalized via reconcile (${viaReconcile}/${total}) — webhook path degraded`
    );
  }
}
