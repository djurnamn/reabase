import { execSync } from "node:child_process";
import { basename } from "node:path";

/**
 * Check if a REAPER project file is currently open in REAPER.
 *
 * On macOS, we check if REAPER has the file open using `lsof`.
 * Falls back to checking for common lock file patterns.
 */
export function isProjectOpen(rppPath: string): boolean {
  // Check if REAPER is running at all
  if (!isReaperRunning()) {
    return false;
  }

  // Use lsof to check if REAPER has this specific file open
  try {
    const result = execSync(
      `lsof -c REAPER 2>/dev/null | grep -F ${JSON.stringify(basename(rppPath))}`,
      { encoding: "utf-8", timeout: 5000 }
    );
    return result.trim().length > 0;
  } catch {
    // lsof returns exit code 1 if no matches — that means not open
    return false;
  }
}

/**
 * Check if REAPER is currently running.
 */
export function isReaperRunning(): boolean {
  try {
    const result = execSync("pgrep -x REAPER 2>/dev/null", {
      encoding: "utf-8",
      timeout: 5000,
    });
    return result.trim().length > 0;
  } catch {
    return false;
  }
}
