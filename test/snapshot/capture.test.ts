import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseRpp, getTracks } from "../../src/parser/index.js";
import { captureFxChain, hashParameters, enrichWithParameters } from "../../src/snapshot/capture.js";
import type { ParameterValue } from "../../src/snapshot/types.js";

const FIXTURES = resolve(import.meta.dirname, "../fixtures");

function readFixture(name: string): string {
  return readFileSync(resolve(FIXTURES, name), "utf-8");
}

describe("captureFxChain", () => {
  it("captures plugin name, type, and pluginParams from a track with one FX", () => {
    const root = parseRpp(readFixture("single-track-with-fx.rpp"));
    const track = getTracks(root)[0];
    const chain = captureFxChain(track);

    expect(chain).toHaveLength(1);
    expect(chain[0].pluginName).toBe("AU: T-De-Esser 2 (Techivation)");
    expect(chain[0].pluginType).toBe("AU");
    expect(chain[0].pluginParams).toBeDefined();
    expect(chain[0].pluginParams).toContain("Techivation: T-De-Esser 2");
  });

  it("returns empty stateHash and empty parameters (structural only)", () => {
    const root = parseRpp(readFixture("single-track-with-fx.rpp"));
    const track = getTracks(root)[0];
    const chain = captureFxChain(track);

    expect(chain).toHaveLength(1);
    expect(chain[0].stateHash).toBe("");
    expect(chain[0].parameters).toEqual({});
  });

  it("returns empty array for track without FX chain", () => {
    const root = parseRpp(readFixture("special-characters.rpp"));
    const tracks = getTracks(root);
    // DÖRR track (second track) has no FX chain
    const dorrTrack = tracks[1];
    const chain = captureFxChain(dorrTrack);

    expect(chain).toHaveLength(0);
  });

  it("captures multiple FX from a multi-track project", () => {
    const root = parseRpp(readFixture("multi-track-with-routing.rpp"));
    const tracks = getTracks(root);

    // RÖSTER has a Limiter
    const rosterChain = captureFxChain(tracks[0]);
    expect(rosterChain).toHaveLength(1);
    expect(rosterChain[0].pluginName).toContain("kHs Limiter");
    expect(rosterChain[0].stateHash).toBe("");
    expect(rosterChain[0].parameters).toEqual({});

    // BJÖRN has a De-Esser
    const bjornChain = captureFxChain(tracks[1]);
    expect(bjornChain).toHaveLength(1);
    expect(bjornChain[0].pluginName).toContain("T-De-Esser 2");
    expect(bjornChain[0].stateHash).toBe("");
    expect(bjornChain[0].parameters).toEqual({});
  });
});

describe("hashParameters", () => {
  it("produces deterministic hashes for identical params", () => {
    const params: Record<string, ParameterValue> = {
      "0": { name: "Threshold", value: -18 },
      "1": { name: "Ratio", value: 4 },
      "2": { name: "Attack", value: 10 },
    };

    const hash1 = hashParameters(params);
    const hash2 = hashParameters(params);

    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(64); // SHA-256 hex
  });

  it("produces different hashes for different parameter values", () => {
    const params1: Record<string, ParameterValue> = {
      "0": { name: "Threshold", value: -18 },
      "1": { name: "Ratio", value: 4 },
    };

    const params2: Record<string, ParameterValue> = {
      "0": { name: "Threshold", value: -24 },
      "1": { name: "Ratio", value: 8 },
    };

    expect(hashParameters(params1)).not.toBe(hashParameters(params2));
  });

  it("returns empty string for empty params", () => {
    expect(hashParameters({})).toBe("");
  });
});

describe("enrichWithParameters", () => {
  it("merges parameter data and computes stateHash", () => {
    const root = parseRpp(readFixture("single-track-with-fx.rpp"));
    const track = getTracks(root)[0];
    const chain = captureFxChain(track);

    const parameterData: Record<string, ParameterValue>[] = [
      {
        "0": { name: "Threshold", value: -18 },
        "1": { name: "Ratio", value: 4 },
        "2": { name: "Attack", value: 10 },
      },
    ];

    const enriched = enrichWithParameters(chain, parameterData);

    expect(enriched).toHaveLength(1);
    // Structural fields preserved
    expect(enriched[0].pluginName).toBe("AU: T-De-Esser 2 (Techivation)");
    expect(enriched[0].pluginType).toBe("AU");
    expect(enriched[0].slotId).toBe(chain[0].slotId);
    // Parameters merged in
    expect(enriched[0].parameters).toEqual(parameterData[0]);
    // stateHash computed from parameters
    expect(enriched[0].stateHash).toBe(hashParameters(parameterData[0]));
    expect(enriched[0].stateHash).toHaveLength(64);
  });

  it("leaves parameters empty and stateHash blank when parameterData is missing for an FX", () => {
    const root = parseRpp(readFixture("multi-track-with-routing.rpp"));
    const tracks = getTracks(root);
    const chain = captureFxChain(tracks[0]); // RÖSTER has 1 FX

    // Pass an empty array — no parameter data for any FX
    const enriched = enrichWithParameters(chain, []);

    expect(enriched).toHaveLength(1);
    expect(enriched[0].parameters).toEqual({});
    expect(enriched[0].stateHash).toBe("");
  });
});
