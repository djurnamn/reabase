import { existsSync, statSync } from "node:fs";
import { resolve, dirname, parse as parsePath } from "node:path";

const REABASE_DIR = ".reabase";

/**
 * Find the nearest .reabase/ directory by walking up from the given path.
 * Similar to how git finds .git/.
 *
 * @param startPath - File or directory path to start searching from
 * @returns Absolute path to the .reabase/ directory, or null if not found
 */
export function findReabaseRoot(startPath: string): string | null {
  let current = resolve(startPath);

  // If startPath is a file, start from its directory
  try {
    if (!statSync(current).isDirectory()) {
      current = dirname(current);
    }
  } catch {
    current = dirname(current);
  }

  const { root } = parsePath(current);

  while (current !== root) {
    const candidate = resolve(current, REABASE_DIR);
    try {
      if (existsSync(candidate) && statSync(candidate).isDirectory()) {
        return candidate;
      }
    } catch {
      // statSync failed, keep searching
    }
    current = dirname(current);
  }

  return null;
}
