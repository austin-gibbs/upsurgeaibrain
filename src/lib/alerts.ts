// Push-based ops alerts (Slack incoming webhook).

export async function sendOpsAlert(text: string): Promise<boolean> {
  const url = process.env.ALERT_SLACK_WEBHOOK_URL?.trim();
  if (!url) {
    console.warn("[alerts] ALERT_SLACK_WEBHOOK_URL not set:", text);
    return false;
  }

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
