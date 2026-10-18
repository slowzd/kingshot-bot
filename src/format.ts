import type { PowerSnapshot } from "./mightpulse.ts";
import { cumulativeRanking, type WeekStandings } from "./standings.ts";
import { formatUtc, weekFinal } from "./time.ts";

const LIST_SIZE = 10;
const DISCORD_LIMIT = 2000;

function escapeMarkdown(text: string): string {
  return text.replace(/[\\*_~`|[\]()<>:#-]/g, "\\$&");
}

function allianceLabel(alliance: { tag: string; name: string }): string {
  const tag = alliance.tag ? `[${escapeMarkdown(alliance.tag)}] ` : "";
  return `${tag}${escapeMarkdown(alliance.name)}`;
}

function powerSection(snapshot: PowerSnapshot): string[] {
  return [
    `## Today's Alliance Power - Top ${LIST_SIZE}`,
    ...snapshot.alliances
      .slice(0, LIST_SIZE)
      .map(
        (alliance) =>
          `**#${alliance.rank}** ${allianceLabel(alliance)} — ${alliance.power.toLocaleString("en-US")}`,
      ),
  ];
}

function cumulativeLines(week: WeekStandings): string[] {
  return cumulativeRanking(week)
    .slice(0, LIST_SIZE)
    .map(
      (standing, index) =>
        `**#${index + 1}** ${allianceLabel(standing)} — ${standing.value.toLocaleString("en-US", { maximumFractionDigits: 2 })} ${week.version === 1 ? "pts" : "avg power"}`,
    );
}

function weekRange(week: WeekStandings): string {
  const start = new Date(week.weekStart);
  const firstUpdate = new Date(start.getTime() + 60_000);
  return `${formatUtc(firstUpdate)} – ${formatUtc(weekFinal(start))} UTC`;
}

function updatesText(week: WeekStandings): string {
  return `${week.updates} daily update${week.updates === 1 ? "" : "s"}`;
}

function footer(snapshot: PowerSnapshot, hour: Date): string {
  return `-# Update ${formatUtc(hour)} UTC`;
}

export function dailyMessage(
  snapshot: PowerSnapshot,
  week: WeekStandings,
  hour: Date,
): string {
  return [
    ...powerSection(snapshot),
    "",
    "## Daily Cumulative Ranking",
    `-# ${weekRange(week)} · ${updatesText(week)} · ${week.version === 1 ? "less pts = better rank" : "Average observed daily power; highest wins"}`,
    ...cumulativeLines(week),
    "",
    footer(snapshot, hour),
  ].join("\n");
}

export function weeklyFinalMessage(week: WeekStandings): string {
  return [
    "## 🏆 Weekly Cumulative Ranking",
    `-# ${weekRange(week)} · ${updatesText(week)} · New ranking starts Monday 01:01 UTC`,
    ...(week.version === 2 ? ["-# Average observed daily power"] : []),
    ...cumulativeLines(week),
  ].join("\n");
}

export function splitMessage(message: string): string[] {
  const parts: string[] = [];
  let current = "";
  for (const line of message.split("\n")) {
    if (line.length > DISCORD_LIMIT)
      throw new Error("A leaderboard line exceeds Discord's message limit.");
    if (current && current.length + 1 + line.length > DISCORD_LIMIT) {
      parts.push(current);
      current = line;
    } else {
      current = current ? `${current}\n${line}` : line;
    }
  }
  if (current) parts.push(current);
  return parts;
}
