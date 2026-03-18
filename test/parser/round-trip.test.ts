import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  parseRpp,
  serializeRpp,
  detectLineEnding,
} from "../../src/parser/index.js";

const FIXTURES = resolve(import.meta.dirname, "../fixtures");

function readFixture(name: string): string {
  return readFileSync(resolve(FIXTURES, name), "utf-8");
}

describe("round-trip: parse → serialize", () => {
  const fixtures = [
    "minimal.rpp",
    "single-track-with-fx.rpp",
    "multi-track-with-routing.rpp",
    "special-characters.rpp",
  ];

  for (const fixture of fixtures) {
    it(`preserves ${fixture}`, () => {
      const input = readFixture(fixture);
      const lineEnding = detectLineEnding(input);
      const tree = parseRpp(input);
      const output = serializeRpp(tree, { lineEnding });
      expect(output).toBe(input);
    });
  }
});

describe("round-trip with real project file", () => {
  const realFile =
    "/Users/bjorndjurnamn/Documents/REAPER Media/sospodd s01e01 - redigerat/sospodd s01e01 - redigerat.RPP";

  it("parses and re-serializes the full project without data loss", () => {
    let input: string;
    try {
      input = readFileSync(realFile, "utf-8");
    } catch {
      // Skip if the real file doesn't exist (e.g., CI environment)
      return;
    }

    const lineEnding = detectLineEnding(input);
    const tree = parseRpp(input);
    const output = serializeRpp(tree, { lineEnding });
    expect(output).toBe(input);
  });
});
