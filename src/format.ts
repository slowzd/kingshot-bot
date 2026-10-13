import type { PowerSnapshot } from "./mightpulse.ts";
import { cumulativeRanking, type WeekStandings } from "./standings.ts";
import { formatUtc, postTime, weekFinalHour } from "./time.ts";

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
    `## Alliance Power — Kingdom ${snapshot.kingdom} Top ${LIST_SIZE}`,
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
        `**#${index + 1}** ${allianceLabel(standing)} — ${standing.points.toLocaleString("en-US")} pts`,
    );
}

function weekRange(week: WeekStandings): string {
  const start = new Date(week.weekStart);
  return `${formatUtc(postTime(start))} – ${formatUtc(postTime(weekFinalHour(start)))} UTC`;
}

function updatesText(week: WeekStandings): string {
  return `${week.updates} hourly update${week.updates === 1 ? "" : "s"}`;
}

function footer(snapshot: PowerSnapshot, hour: Date): string {
  return `-# Update ${formatUtc(postTime(hour))} UTC · Source: Mightpulse`;
}

export function hourlyMessage(
  snapshot: PowerSnapshot,
  week: WeekStandings,
  hour: Date,
): string {
  return [
    ...powerSection(snapshot),
    "",
    "## Cumulative Power Ranking",
    `-# ${weekRange(week)} · ${updatesText(week)} · Points = rank held each hour · Lowest wins`,
    ...cumulativeLines(week),
    "",
    footer(snapshot, hour),
  ].join("\n");
}

export function weeklyFinalMessage(
  week: WeekStandings,
  snapshot?: PowerSnapshot,
  hour?: Date,
): string {
  const final = [
    "## 🏆 Weekly Final — Cumulative Power Ranking",
    `-# ${weekRange(week)} · ${updatesText(week)} · Lowest wins · New ranking starts Monday 01:01 UTC`,
    ...cumulativeLines(week),
  ];
  if (!snapshot || !hour) return final.join("\n");
  return [
    ...powerSection(snapshot),
    "",
    ...final,
    "",
    footer(snapshot, hour),
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
