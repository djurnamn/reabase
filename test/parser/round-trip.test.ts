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

describe("round-trip with real-world project", () => {
  it("preserves a multi-track project with FX, routing, folders, and media items", () => {
    const input = readFixture("round-trip-real.rpp");
    const lineEnding = detectLineEnding(input);
    const tree = parseRpp(input);
    const output = serializeRpp(tree, { lineEnding });
    expect(output).toBe(input);
  });
});
