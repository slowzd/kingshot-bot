import { escapeMarkdown } from "discord.js";
import { fetchAllianceSnapshot, type AllianceSnapshot } from "./rankings.js";
import {
  addHourlyRanking,
  loadCumulativeRanking,
  saveCumulativeRanking,
  type CumulativeRanking,
} from "./cumulative-ranking.js";

export function formatLeaderboard(
  snapshot: AllianceSnapshot,
  cumulative: CumulativeRanking,
): string {
  const topAlliances = snapshot.alliances.slice(0, 10);
  const lines = topAlliances.map((alliance) => {
    const tag = alliance.tag ? `[${escapeMarkdown(alliance.tag)}] ` : "";
    return `#${alliance.rank} ${tag}${escapeMarkdown(alliance.name)} | Power: ${alliance.power}`;
  });
  const cumulativeAlliances = cumulative.updates === 0
    ? topAlliances.map((alliance) => ({ ...alliance, total: alliance.rank }))
    : [...cumulative.alliances]
      .sort((a, b) => a.total - b.total || a.id - b.id);
  const cumulativeLines = cumulativeAlliances
    .map((alliance, index) => {
      const tag = alliance.tag ? `[${escapeMarkdown(alliance.tag)}] ` : "";
      return `#${index + 1} ${tag}${escapeMarkdown(alliance.name)} | Cumulative rank: ${alliance.total}`;
    });
  const cumulativeSection = `**Cumulative Power**\n*${cumulative.updates} hourly updates · Lower is better · Resets Monday 00:01 UTC*\n${cumulativeLines.join("\n") || "No hourly updates counted this week."}`;
  const capturedTime = snapshot.capturedAt.toISOString().slice(0, 16).replace("T", " ");
  const message = `**Leaderboard — Kingdom ${snapshot.kingdom} Top ${topAlliances.length} Alliances**\n${lines.join("\n")}\n\n${cumulativeSection}\n\n*API snapshot captured at ${capturedTime} UTC · Source: Mightpulse*`;
  if (message.split("\n").some((line) => line.length > 2000)) {
    throw new Error("A leaderboard line exceeds Discord's 2,000-character message limit.");
  }
  return message;
}

export function splitLeaderboardMessages(message: string): string[] {
  const messages: string[] = [];
  let current = "";
  for (const line of message.split("\n")) {
    if (line.length > 2000) {
      throw new Error("A leaderboard line exceeds Discord's 2,000-character message limit.");
    }
    if (current.length + 1 + line.length > 2000) {
      messages.push(current);
      current = line;
    } else {
      current = current ? `${current}\n${line}` : line;
    }
  }
  if (current) messages.push(current);
  return messages;
}

let pendingPost: Promise<void> = Promise.resolve();

export function publishLeaderboard(
  kingdom: number,
  send: (message: string) => Promise<void>,
  scheduledAt?: Date,
): Promise<void> {
  const post = pendingPost.then(async () => {
    const now = scheduledAt ?? new Date();
    const snapshot = await fetchAllianceSnapshot(kingdom);
    const previous = loadCumulativeRanking(kingdom, now);
    const cumulative = scheduledAt ? addHourlyRanking(previous, snapshot, now) : previous;
    const message = formatLeaderboard(snapshot, cumulative);
    for (const part of splitLeaderboardMessages(message)) {
      await send(part);
    }
    if (cumulative === previous) return;
    try {
      saveCumulativeRanking(cumulative);
    } catch (error) {
      throw new Error(
        "The leaderboard was sent, but saving its cumulative ranking failed.",
        { cause: error },
      );
    }
  });
  // Keep later posts running after a failure; the caller still receives the error.
  pendingPost = post.then(() => {}, () => {});
  return post;
}
