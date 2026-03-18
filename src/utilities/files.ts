import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Recursively find all .RPP files under a directory.
 * Skips hidden directories (starting with '.') and backup files.
 */
export function findRppFiles(directory: string): string[] {
  const results: string[] = [];

  try {
    const entries = readdirSync(directory);
    for (const entry of entries) {
      if (entry.startsWith(".")) continue;

      const fullPath = join(directory, entry);
      try {
        const stat = statSync(fullPath);
        if (stat.isDirectory()) {
          results.push(...findRppFiles(fullPath));
        } else if (
          entry.toLowerCase().endsWith(".rpp") &&
          !entry.includes(".RPP-bak") &&
          !entry.includes(".rpp-bak")
        ) {
          results.push(fullPath);
        }
      } catch {
        // Permission errors, broken symlinks, etc.
      }
    }
  } catch {
    // Directory not readable
  }

  return results;
}
