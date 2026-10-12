import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export const sessionPath = fileURLToPath(
  new URL("../.auth/stratforge.json", import.meta.url),
);

export async function getSessionPath(): Promise<string | undefined> {
  try {
    await access(sessionPath);
    return sessionPath;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}
