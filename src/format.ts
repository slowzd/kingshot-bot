import type { PowerSnapshot } from "./mightpulse.ts";
import { cumulativeRanking, type WeekStandings } from "./standings.ts";
import { formatUtc, weekFinal } from "./time.ts";

const LIST_SIZE = 10;
const DISCORD_LIMIT = 2000;
const DAILY_QUOTES = [
  "Do not like your place in the leadboard? Work harder then",
  "Power is just a tool, greatness comes from how you wield it.",
  "Strength lies not in numbers, but in unity and strategy.",
];

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
        `**#${index + 1}** ${allianceLabel(standing)} — ${standing.value.toLocaleString("en-US", { maximumFractionDigits: 2 })}`,
    );
}

function weekRange(week: WeekStandings): string {
  const start = new Date(week.weekStart);
  const firstUpdate = new Date(start.getTime() + 60_000);
  return `${formatUtc(firstUpdate)} – ${formatUtc(weekFinal(start))} UTC`;
}

function updatesText(week: WeekStandings): string {
  return `Calculated from ${week.updates} update${week.updates === 1 ? "" : "s"}`;
}

function footer(hour: Date): string {
  return `-# Update ${formatUtc(hour)} UTC`;
}

function dailyQuote(hour: Date): string {
  const date = hour.toISOString().slice(0, 10);
  let hash = 0x811c9dc5;
  for (const character of date) {
    hash = Math.imul(hash ^ character.charCodeAt(0), 0x01000193) >>> 0;
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b) >>> 0;
  hash = (hash ^ (hash >>> 13)) >>> 0;
  return DAILY_QUOTES[hash % DAILY_QUOTES.length];
}

export function dailyMessage(
  snapshot: PowerSnapshot,
  week: WeekStandings,
  hour: Date,
): string {
  return [
    ...powerSection(snapshot),
    "",
    "## Current Average Power Ranking",
    `-# ${weekRange(week)} · ${updatesText(week)}`,
    ...cumulativeLines(week),
    "",
    footer(hour),
    `> ${dailyQuote(hour)}`,
  ].join("\n");
}

export function weeklyFinalMessage(week: WeekStandings): string {
  return [
    "## 🏆 Weekly Cumulative Ranking",
    `-# ${weekRange(week)} · ${updatesText(week)} · New ranking starts Monday 01:01 UTC`,
    "-# Average observed daily power",
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
