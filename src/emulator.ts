import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import sharp from "sharp";
import Tesseract from "tesseract.js";

const DEFAULT_ADB_PATH = "C:\\Program Files\\BlueStacks_nxt\\HD-Adb.exe";
const adbPath = process.env.ADB_PATH || DEFAULT_ADB_PATH;

export interface InGameAlliance {
  rank: number;
  tag: string;
  name: string;
  power: string;
  members?: string;
}

/**
 * Executes an ADB command using BlueStacks HD-Adb.
 */
export function runAdb(args: string[]): Buffer {
  return execFileSync(adbPath, args, { maxBuffer: 10 * 1024 * 1024 });
}

/**
 * Checks connected devices in ADB.
 */
export function getConnectedDevice(): string | null {
  const output = runAdb(["devices"]).toString("utf-8");
  const lines = output.trim().split(/\r?\n/).slice(1);
  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    if (parts.length >= 2 && parts[1] === "device") {
      return parts[0];
    }
  }
  return null;
}

/**
 * Captures screenshot from BlueStacks via ADB and saves to destination.
 */
export async function captureScreenshot(savePath: string): Promise<string> {
  const device = getConnectedDevice();
  const args = device ? ["-s", device, "exec-out", "screencap", "-p"] : ["exec-out", "screencap", "-p"];
  
  const buffer = runAdb(args);
  const dir = path.dirname(savePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(savePath, buffer);
  return savePath;
}

/**
 * Parses raw OCR text into leaderboard rows.
 */
export function parseLeaderboardText(ocrText: string): InGameAlliance[] {
  const lines = ocrText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const alliances: InGameAlliance[] = [];

  for (const line of lines) {
    // Matches tags like [WIN] or [WRS] or [SAO| followed by alliance name and power (e.g. 3,436,505,285 or 1,974,097.646)
    const match = line.match(/(?:\[|\()([A-Za-z0-9]{2,6})(?:\]|\)|\|)\s*([A-Za-z0-9_\-\s]+?)\s+([\d,.;/~]{7,18}|\d+(?:\.\d+)?\s*[KMBT])/i);
    if (match) {
      const tag = match[1].trim();
      let name = match[2].trim().replace(/^\||\|$/g, "");
      let power = match[3]
        .trim()
        .replace(/[/;~]/g, "")
        .replace(/\./g, ",");

      alliances.push({
        rank: alliances.length + 1,
        tag,
        name,
        power,
      });
    }
  }

  // Deduplicate by tag if scanned twice due to OCR overlap (like the bottom pinned rank)
  const seenTags = new Set<string>();
  const uniqueAlliances: InGameAlliance[] = [];
  for (const a of alliances) {
    const key = a.tag.toUpperCase();
    if (!seenTags.has(key)) {
      seenTags.add(key);
      uniqueAlliances.push({
        ...a,
        rank: uniqueAlliances.length + 1,
      });
    }
  }

  return uniqueAlliances;
}

/**
 * Crops the image to the alliance text column (tag, name, power) and enhances contrast for crisp OCR.
 */
async function preprocessLeaderboardImage(inputPath: string, outputPath: string): Promise<string> {
  const metadata = await sharp(inputPath).metadata();
  const width = metadata.width || 1080;
  const height = metadata.height || 1920;

  // Kingshot leaderboard layout:
  // Left side has the ranking medals and shield icons.
  // The actual text (tag, name, power) starts at x = 32% and goes to 95%.
  // Vertically, the list is from y = 12% down to 85%.
  const cropLeft = Math.round(width * 0.32);
  const cropWidth = Math.round(width * 0.63);
  const cropTop = Math.round(height * 0.12);
  const cropHeight = Math.round(height * 0.73);

  await sharp(inputPath)
    .extract({ left: cropLeft, top: cropTop, width: cropWidth, height: cropHeight })
    .grayscale()
    .linear(1.5, -30) // boost contrast to separate text clearly from background cards
    .toFile(outputPath);

  return outputPath;
}

/**
 * Checks if the current emulator screen is showing the Alliance Leaderboard.
 */
export async function isLeaderboardScreen(screenshotPath: string): Promise<boolean> {
  const meta = await sharp(screenshotPath).metadata();
  const width = meta.width || 900;
  const height = meta.height || 1600;

  // Header banner: top 0% to 8%, centered
  const cropLeft = Math.round(width * 0.1);
  const cropWidth = Math.round(width * 0.8);
  const cropTop = 0;
  const cropHeight = Math.round(height * 0.08);

  const headerPath = path.resolve(`snapshots/header-check-${Date.now()}.png`);
  try {
    await sharp(screenshotPath)
      .extract({ left: cropLeft, top: cropTop, width: cropWidth, height: cropHeight })
      .grayscale()
      .toFile(headerPath);

    const { data } = await Tesseract.recognize(headerPath, "eng");
    fs.unlink(headerPath, () => {});
    return /Alliance\s*Power|Leaderboard/i.test(data.text);
  } catch (err) {
    if (fs.existsSync(headerPath)) fs.unlink(headerPath, () => {});
    return false;
  }
}

/**
 * Captures the screen and runs OCR to extract alliance rankings.
 */
export async function extractFromEmulator(existingScreenshotPath?: string): Promise<{
  alliances: InGameAlliance[];
  rawText: string;
  screenshotPath: string;
}> {
  const screenshotPath =
    existingScreenshotPath || path.resolve(`snapshots/bluestacks-capture-${Date.now()}.png`);
  if (!existingScreenshotPath) {
    await captureScreenshot(screenshotPath);
  }

  const meta = await sharp(screenshotPath).metadata();
  const width = meta.width || 900;
  const height = meta.height || 1600;

  // The 7 visible cards on the Kingshot Alliance Leaderboard screen:
  const rowStarts = [0.125, 0.228, 0.331, 0.434, 0.537, 0.640, 0.743];
  const rowHeight = Math.round(height * 0.098);
  const cropLeft = Math.round(width * 0.32);
  const cropWidth = Math.round(width * 0.63);

  const alliances: InGameAlliance[] = [];
  const rawLines: string[] = [];

  for (let i = 0; i < rowStarts.length; i++) {
    const top = Math.round(height * rowStarts[i]);
    const slicePath = path.resolve(`snapshots/row-slice-${Date.now()}-${i + 1}.png`);
    try {
      await sharp(screenshotPath)
        .extract({ left: cropLeft, top, width: cropWidth, height: rowHeight })
        .grayscale()
        .linear(1.5, -30)
        .toFile(slicePath);

      const { data } = await Tesseract.recognize(slicePath, "eng");
      const text = data.text.trim();
      rawLines.push(text);

      const match = text.match(/(?:\[|\()([A-Za-z0-9]{2,6})(?:\]|\)|\|)\s*([A-Za-z0-9_\-\s]+?)\s+([\d,.;/~]{7,18}|\d+(?:\.\d+)?\s*[KMBT])/i);
      if (match) {
        const tag = match[1].trim();
        let name = match[2].trim().replace(/^\||\|$/g, "");
        let power = match[3]
          .trim()
          .replace(/[/;~]/g, "")
          .replace(/\./g, ",");

        alliances.push({
          rank: i + 1,
          tag,
          name,
          power,
        });
      }

      // Clean up slice file
      fs.unlink(slicePath, () => {});
    } catch (err) {
      console.warn(`Failed reading row ${i + 1}:`, err);
    }
  }

  return { alliances, rawText: rawLines.join("\n"), screenshotPath };
}
