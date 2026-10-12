import "dotenv/config";
import { chromium } from "playwright";
import { getSessionPath } from "./session.js";

export type Alliance = {
  rank: number;
  name: string;
  tag: string;
  power: string | null;
  realPower: string | null;
  members: string | null;
};

export async function collect(kingdomNumber: number): Promise<{
  rows: Alliance[];
  section: string;
  title: string;
}> {
  const sessionCookie = process.env.STRATFORGE_SESSION_TOKEN?.trim();
  const browser = await chromium.launch({
    headless: process.env.HEADLESS !== "false",
  });

  try {
    const storageState = await getSessionPath();

    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      storageState: storageState || undefined,
    });

    if (sessionCookie) {
      await context.addCookies([
        {
          name: "__Secure-better-auth.session_token",
          value: sessionCookie,
          url: "https://stratforge.tools",
          secure: true,
          httpOnly: true,
          sameSite: "Lax",
        },
      ]);
    }

    const page = await context.newPage();
    let content = "";
    let section = "";

    if (sessionCookie) {
      const dashboardUrl = `https://stratforge.tools/dashboard/kingshot/tools/rankings/${kingdomNumber}`;
      await page.goto(dashboardUrl, { waitUntil: "domcontentloaded", timeout: 30000 });

      try {
        const alliancesTab = page.getByRole("tab", { name: "Alliances" }).or(page.getByText("Alliances", { exact: true })).first();
        await alliancesTab.waitFor({ timeout: 10000 });
        await alliancesTab.click();
        await page.waitForTimeout(2000);
      } catch (err) {
        console.warn("Could not switch to Alliances tab on dashboard, trying current content", err);
      }

      content = await page.locator("body").innerText();
      section = content.split(/Alliances\s*\n\d+\s+shown/i)[1]?.split(/Top players|Kingdom champions|Full leaderboards|Players\s*\n/i)[0]
        || content.split(/Top alliances/i)[1]?.split(/Top players|Kingdom champions|Full leaderboards/i)[0]
        || "";
    }

    if (!section) {
      const publicUrl = `https://stratforge.tools/k/${kingdomNumber}`;
      await page.goto(publicUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page
        .getByText("Top alliances", { exact: true })
        .first()
        .waitFor({ timeout: 15000 });
      await page.waitForTimeout(1000);
      content = await page.locator("body").innerText();
      section =
        content
          .split(/Top alliances/i)[1]
          ?.split(/Top players|Kingdom champions|Full leaderboards/i)[0] || "";
    }

    const rows: Alliance[] = [];
    const matches = [
      ...section.matchAll(
        /(?:^|\n)#(\d+)\s*([\s\S]*?)(?=\n#\d+\s|\n\+\s*\d+\s+more\b|$)/g,
      ),
    ];

    for (const match of matches) {
      const rank = Number(match[1]);
      const block = match[2];
      const identity = block.match(/^\s*([^\r\n]+)\s*\r?\n\s*\[([^\]\r\n]+)\]/);
      if (!identity) continue;
      const name = identity[1].trim();
      const tag = identity[2].trim();
      const power =
        block.match(/([\d,.]+\s*[KMBT]|\u2014)\s*POWER\b/i)?.[1]?.trim() || null;
      const realPower =
        block.match(/([\d,.]+\s*[KMBT]|\u2014)\s*Real power\b/i)?.[1]?.trim() ||
        block.match(/Combat power\s*([\d,.]+\s*[KMBT]|\u2014)/i)?.[1]?.trim() ||
        null;
      const members = block.match(/(\d+\/\d+)\s*MEMBERS\b/i)?.[1] || null;
      if (name && tag && Number.isInteger(rank)) {
        rows.push({
          rank,
          name,
          tag,
          power: power === "—" ? null : power,
          realPower: realPower === "—" ? null : realPower,
          members,
        });
      }
    }

    return { rows, section, title: await page.title() };
  } finally {
    await browser.close();
  }
}
