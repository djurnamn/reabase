import { copyFileSync, existsSync } from "node:fs";

/**
 * Create a timestamped backup of a file.
 * Returns the backup file path.
 *
 * Format: filename.RPP.bak.2026-03-12T120000
 */
export function createBackup(filePath: string): string {
  if (!existsSync(filePath)) {
    throw new Error(`Cannot backup: file does not exist: ${filePath}`);
  }

  const timestamp = new Date()
    .toISOString()
    .replace(/[:.]/g, "")
    .slice(0, 15);
  const backupPath = `${filePath}.bak.${timestamp}`;

  copyFileSync(filePath, backupPath);
  return backupPath;
}
