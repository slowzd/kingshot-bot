export async function sendDiscordMessage(
  token: string,
  channelId: string,
  content: string,
): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
      signal: AbortSignal.timeout(30_000),
    });
    if (response.ok) {
      const message = await response.json() as { id: string };
      return message.id;
    }
    if (response.status === 429 && attempt < 4) {
      const body = await response.json().catch(() => ({})) as { retry_after?: number };
      await new Promise((resolve) => setTimeout(resolve, Math.ceil((body.retry_after ?? 1) * 1000)));
      continue;
    }
    const hints: Record<number, string> = {
      401: " Check DISCORD_TOKEN.",
      403: " Give the bot View Channel and Send Messages permissions in that channel.",
      404: " Check DISCORD_CHANNEL_ID.",
    };
    throw new Error(`Discord rejected the message: HTTP ${response.status}.${hints[response.status] ?? ""}`);
  }
}
