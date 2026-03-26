import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import YAML from "yaml";
import { init } from "../../src/commands/init.js";

let tempDir: string;

beforeEach(() => {
  tempDir = join(tmpdir(), `reabase-init-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tempDir, { recursive: true });
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("init", () => {
  it("creates .reabase directory structure", () => {
    const { reabasePath } = init(tempDir);

    expect(existsSync(reabasePath)).toBe(true);
    expect(existsSync(join(reabasePath, "presets"))).toBe(true);
    expect(existsSync(join(reabasePath, "presets", "fx"))).toBe(true);
    expect(existsSync(join(reabasePath, "snapshots"))).toBe(true);
    expect(existsSync(join(reabasePath, "config.yaml"))).toBe(true);
  });

  it("writes a valid config.yaml", () => {
    const { reabasePath } = init(tempDir);

    const content = readFileSync(join(reabasePath, "config.yaml"), "utf-8");
    const config = YAML.parse(content);
    expect(config.version).toBe(1);
  });

  it("returns the correct reabase path", () => {
    const { reabasePath } = init(tempDir);
    expect(reabasePath).toBe(join(tempDir, ".reabase"));
  });

  it("throws if .reabase already exists", () => {
    init(tempDir);
    expect(() => init(tempDir)).toThrow("already exists");
  });
});
