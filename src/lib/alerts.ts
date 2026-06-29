// Push-based ops alerts (Slack incoming webhook).

/**
 * Post plain text to a specific Slack incoming-webhook URL.
 * Each incoming webhook is bound to one channel, so callers pass the URL
 * for the channel they want (ops alerts vs. the #client-services report).
 */
export async function postSlackWebhook(url: string, text: string): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) {
      console.error(`[alerts] Slack webhook returned ${res.status}`);
      return false;
    }
    return true;
  } catch (e) {
    console.error("[alerts] failed to send:", e instanceof Error ? e.message : e);
    return false;
  }
}

export async function sendOpsAlert(text: string): Promise<boolean> {
  const url = process.env.ALERT_SLACK_WEBHOOK_URL?.trim();
  if (!url) {
    console.warn("[alerts] ALERT_SLACK_WEBHOOK_URL not set:", text);
    return false;
  }
  return postSlackWebhook(url, text);
}
