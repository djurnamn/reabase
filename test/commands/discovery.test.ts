import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { findReabaseRoot } from "../../src/utilities/discovery.js";

let tempDir: string;

beforeEach(() => {
  tempDir = join(tmpdir(), `reabase-disc-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tempDir, { recursive: true });
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("findReabaseRoot", () => {
  it("finds .reabase in the current directory", () => {
    const reabasePath = join(tempDir, ".reabase");
    mkdirSync(reabasePath);

    const result = findReabaseRoot(tempDir);
    expect(result).toBe(reabasePath);
  });

  it("finds .reabase in a parent directory", () => {
    const reabasePath = join(tempDir, ".reabase");
    mkdirSync(reabasePath);

    const subDir = join(tempDir, "sub", "deep");
    mkdirSync(subDir, { recursive: true });

    const result = findReabaseRoot(subDir);
    expect(result).toBe(reabasePath);
  });

  it("returns null when no .reabase exists", () => {
    const result = findReabaseRoot(tempDir);
    expect(result).toBeNull();
  });

  it("ignores .reabase files (not directories)", () => {
    const { writeFileSync } = require("node:fs");
    writeFileSync(join(tempDir, ".reabase"), "not a directory", "utf-8");

    const result = findReabaseRoot(tempDir);
    expect(result).toBeNull();
  });
});
