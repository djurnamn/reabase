import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createBackup } from "../../src/utilities/backup.js";

let tempDir: string;

beforeEach(() => {
  tempDir = join(tmpdir(), `reabase-bak-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tempDir, { recursive: true });
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("createBackup", () => {
  it("creates a backup file with timestamp suffix", () => {
    const original = join(tempDir, "project.RPP");
    writeFileSync(original, "test content", "utf-8");

    const backupPath = createBackup(original);
    expect(existsSync(backupPath)).toBe(true);
    expect(backupPath).toMatch(/project\.RPP\.bak\.\d{4}-\d{2}-\d{2}T\d{4}/);
  });

  it("preserves file content in the backup", () => {
    const original = join(tempDir, "project.RPP");
    const content = "<REAPER_PROJECT\n  TEMPO 120\n>";
    writeFileSync(original, content, "utf-8");

    const backupPath = createBackup(original);
    expect(readFileSync(backupPath, "utf-8")).toBe(content);
  });

  it("throws if the source file does not exist", () => {
    expect(() => createBackup(join(tempDir, "nope.RPP"))).toThrow("does not exist");
  });
});
