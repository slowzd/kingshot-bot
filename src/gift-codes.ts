import fs from "node:fs";
import path from "node:path";
import type { APIEmbed } from "discord.js";

export interface GiftCode {
  code: string;
  expiresAt: string | null;
}

interface GiftCodeState {
  version: 1;
  channelId: string;
  codes: GiftCode[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function codeText(value: unknown): string {
  if (
    typeof value !== "string" || !value.trim() || value.trim().length > 100
    || /[\s`\u0000-\u001f\u007f]/.test(value.trim())
  ) throw new Error("Invalid gift code.");
  return value.trim();
}

function expiryDate(value: unknown): string | null {
  if (value === null) return null;
  if (
    typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value)
    || !Number.isFinite(Date.parse(value))
    || new Date(`${value.slice(0, 10)}T00:00:00Z`).toISOString().slice(0, 10) !== value.slice(0, 10)
  ) throw new Error("Invalid gift-code expiry date.");
  return new Date(value).toISOString();
}

function canonicalCodes(value: unknown): GiftCode[] {
  if (!Array.isArray(value)) throw new Error("Invalid gift-code list.");
  const codes = new Map<string, GiftCode>();
  for (const row of value) {
    if (!isRecord(row)) throw new Error("Invalid gift-code entry.");
    const code = { code: codeText(row.code), expiresAt: expiryDate(row.expiresAt) };
    const previous = codes.get(code.code);
    if (previous && previous.expiresAt !== code.expiresAt) {
      throw new Error(`Conflicting expiry dates for gift code ${code.code}.`);
    }
    codes.set(code.code, code);
  }
  return [...codes.values()].sort((a, b) => a.code < b.code ? -1 : a.code > b.code ? 1 : 0);
}

export async function fetchActiveGiftCodes(now: Date): Promise<GiftCode[]> {
  if (!Number.isFinite(now.getTime())) throw new Error("Invalid gift-code check time.");
  const response = await fetch("https://kingshot-atlas.onrender.com/api/v1/player-link/gift-codes", {
    headers: { Accept: "application/json", "User-Agent": "kingshot-stratforge-bot/1.0" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Kingshot Atlas gift-code request failed: HTTP ${response.status}.`);
  const data: unknown = await response.json();
  if (!isRecord(data) || !Array.isArray(data.codes) || typeof data.source !== "string" || !data.source.trim()) {
    throw new Error("Kingshot Atlas returned an invalid gift-code response.");
  }
  const codes: GiftCode[] = [];
  for (const row of data.codes) {
    if (!isRecord(row) || typeof row.is_expired !== "boolean") {
      throw new Error("Kingshot Atlas returned an invalid gift-code entry.");
    }
    const code = { code: codeText(row.code), expiresAt: expiryDate(row.expire_date) };
    if (!row.is_expired && (code.expiresAt === null || Date.parse(code.expiresAt) > now.getTime())) {
      codes.push(code);
    }
  }
  return canonicalCodes(codes);
}

function loadCodeState(file: string): GiftCodeState | null {
  let contents: string;
  try {
    contents = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
  const data: unknown = JSON.parse(contents);
  if (
    !isRecord(data) || data.version !== 1
    || typeof data.channelId !== "string" || !/^\d{17,20}$/.test(data.channelId)
  ) throw new Error(`Invalid gift-code state in ${file}.`);
  return { version: 1, channelId: data.channelId, codes: canonicalCodes(data.codes) };
}

export function giftCodesMessage(codes: GiftCode[]): { embeds: APIEmbed[] } {
  const description = codes.length
    ? codes.map(({ code, expiresAt }) =>
      `\`${code}\`${expiresAt ? `\nExpires <t:${Math.floor(Date.parse(expiresAt) / 1000)}:f>` : ""}`,
    ).join("\n\n")
    : "No active gift codes are currently listed by Kingshot Atlas.";
  const embed: APIEmbed = {
    title: "\u{1f381} Kingshot | Active Gift Codes",
    description,
    color: 0x9B59B6,
    fields: [
      { name: "\u200b", value: "\u200b", inline: false },
      {
        name: "\u{1f7e3} Redeem on Android",
        value: "Open Kingshot \u2192 Profile \u2192 Settings \u2192 Gift Code.\nPaste a code and tap **Redeem**.",
        inline: false,
      },
      { name: "\u200b", value: "\u200b", inline: false },
      {
        name: "\u{1f7e3} Redeem on iOS",
        value: "Use the [official Kingshot redemption website](https://ks-giftcode.centurygame.com/).\nRewards arrive in your in-game mailbox.",
        inline: false,
      },
      { name: "\u200b", value: "\u200b", inline: false },
      {
        name: "\u{1f4da} Source",
        value: "[Kingshot Atlas gift codes](https://ks-atlas.com/tools/gift-codes)\nA new message is posted only when the active-code list or expiry details change.",
        inline: false,
      },
    ],
    footer: { text: "Eternity Kingshot Bot | Gift-code updates" },
  };
  const size = (embed.title?.length ?? 0) + description.length + (embed.footer?.text.length ?? 0)
    + (embed.fields ?? []).reduce((total, field) => total + field.name.length + field.value.length, 0);
  if (description.length > 4096 || size > 6000) throw new Error("Gift-code list exceeds Discord embed limits.");
  return { embeds: [embed] };
}

export async function runGiftCodeUpdate(run: {
  channelId: string;
  stateFile: string;
  fetchCodes: () => Promise<GiftCode[]>;
  send: (message: { embeds: APIEmbed[] }) => Promise<void>;
  dryRun?: boolean;
}): Promise<{ status: "posted" | "previewed" | "unchanged"; count: number }> {
  if (!/^\d{17,20}$/.test(run.channelId)) throw new Error("Invalid Discord codes channel ID.");
  const previous = loadCodeState(run.stateFile);
  const codes = canonicalCodes(await run.fetchCodes());
  if (previous?.channelId === run.channelId && JSON.stringify(previous.codes) === JSON.stringify(codes)) {
    return { status: "unchanged", count: codes.length };
  }
  await run.send(giftCodesMessage(codes));
  if (run.dryRun) return { status: "previewed", count: codes.length };
  const state: GiftCodeState = { version: 1, channelId: run.channelId, codes };
  fs.mkdirSync(path.dirname(run.stateFile), { recursive: true });
  const temporary = `${run.stateFile}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`);
  fs.renameSync(temporary, run.stateFile);
  return { status: "posted", count: codes.length };
}
