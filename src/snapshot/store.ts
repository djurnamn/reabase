import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Snapshot } from "./types.js";

/**
 * Read a snapshot from a JSON file.
 * Returns null if the file doesn't exist.
 */
export function readSnapshot(filePath: string): Snapshot | null {
  try {
    const content = readFileSync(filePath, "utf-8");
    return JSON.parse(content) as Snapshot;
  } catch {
    return null;
  }
}

/**
 * Write a snapshot to a JSON file.
 * Creates parent directories if they don't exist.
 */
export function writeSnapshot(filePath: string, snapshot: Snapshot): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(snapshot, null, 2) + "\n", "utf-8");
}
