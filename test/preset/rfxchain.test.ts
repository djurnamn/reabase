import { describe, it, expect } from "vitest";
import { parseRfxChain, serializeRfxChainFromFingerprints, extractRfxChainContent } from "../../src/preset/rfxchain.js";
import { parseRpp } from "../../src/parser/parse.js";
import { getTracks } from "../../src/parser/helpers.js";
import { captureFxChain } from "../../src/snapshot/capture.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const FIXTURES = resolve(import.meta.dirname, "../fixtures");

function readFixture(name: string): string {
  return readFileSync(resolve(FIXTURES, name), "utf-8");
}

describe("parseRfxChain", () => {
  it("parses an rfxchain with one plugin", () => {
    const rfxContent = [
      "BYPASS 0 0 0",
      '<AU "AU: T-De-Esser 2 (Techivation)" "Techivation: T-De-Esser 2" "" 1635083896 1415869293 1415930728',
      "  6QMAAAAAAAACAAAAAQAAAAAAAAACAAAAAAAAAAIAAAABAAAAAAAAAAIAAAAAAAAAswUAAA==",
      ">",
      "FLOATPOS 0 0 0 0",
      "FXID {07EC70AF-D570-084D-ABA9-825C6F0C365C}",
      "WAK 0 0",
    ].join("\n");

    const chain = parseRfxChain(rfxContent);
    expect(chain).toHaveLength(1);
    expect(chain[0].pluginName).toBe("AU: T-De-Esser 2 (Techivation)");
    expect(chain[0].pluginType).toBe("AU");
    expect(chain[0].stateBlob).toContain("6QMAAAA");
    expect(chain[0].stateHash).toBeTruthy();
  });

  it("parses an rfxchain with multiple plugins", () => {
    const rfxContent = [
      "BYPASS 0 0 0",
      '<AU "AU: T-De-Esser 2 (Techivation)" "Techivation: T-De-Esser 2" "" 1635083896 1415869293 1415930728',
      "  6QMAAAAAAAACAAAAAQAAAAAAAAACAAAAAAAAAAIAAAABAAAAAAAAAAIAAAAAAAAAswUAAA==",
      ">",
      "FLOATPOS 0 0 0 0",
      "FXID {07EC70AF-D570-084D-ABA9-825C6F0C365C}",
      "WAK 0 0",
      "BYPASS 0 0 0",
      '<AU "AU: kHs Limiter (Kilohearts)" "" "" 0 "" ""',
      "  AAAA",
      ">",
      "FLOATPOS 0 0 0 0",
      "FXID {11111111-2222-3333-4444-555555555555}",
      "WAK 0 0",
    ].join("\n");

    const chain = parseRfxChain(rfxContent);
    expect(chain).toHaveLength(2);
    expect(chain[0].pluginName).toBe("AU: T-De-Esser 2 (Techivation)");
    expect(chain[1].pluginName).toBe("AU: kHs Limiter (Kilohearts)");
  });

  it("returns empty array for empty content", () => {
    const chain = parseRfxChain("");
    expect(chain).toHaveLength(0);
  });
});

describe("serializeRfxChainFromFingerprints", () => {
  it("serializes fingerprints to rfxchain format", () => {
    const fingerprints = [
      {
        pluginName: "AU: T-De-Esser 2 (Techivation)",
        pluginType: "AU",
        stateHash: "abc123",
        stateBlob: "6QMAAAAAAAACAAAAAQAAAAAAAAACAAAAAAAAAAIAAAABAAAAAAAAAAIAAAAAAAAAswUAAA==",
        slotId: "t-de-esser-2",
      },
    ];

    const result = serializeRfxChainFromFingerprints(fingerprints);
    expect(result).toContain("BYPASS 0 0 0");
    expect(result).toContain('<AU "AU: T-De-Esser 2 (Techivation)"');
    expect(result).toContain("6QMAAAAAAAACAAAAAQAAAAAAAAACAAAAAAAAAAIAAAABAAAAAAAAAAIAAAAAAAAAswUAAA==");
    expect(result).toContain("FLOATPOS 0 0 0 0");
    expect(result).toContain("FXID {00000000-0000-0000-0000-000000000000}");
    expect(result).toContain("WAK 0 0");
  });

  it("round-trips through parse and serialize", () => {
    const fingerprints = [
      {
        pluginName: "AU: T-De-Esser 2 (Techivation)",
        pluginType: "AU",
        stateHash: "abc123",
        stateBlob: "AAABBBCCC==",
        slotId: "t-de-esser-2",
      },
    ];

    const serialized = serializeRfxChainFromFingerprints(fingerprints);
    const reparsed = parseRfxChain(serialized);

    expect(reparsed).toHaveLength(1);
    expect(reparsed[0].pluginName).toBe("AU: T-De-Esser 2 (Techivation)");
    expect(reparsed[0].pluginType).toBe("AU");
    expect(reparsed[0].stateBlob).toBe("AAABBBCCC==");
  });
});

describe("extractRfxChainContent", () => {
  it("extracts FXCHAIN content from a track", () => {
    const root = parseRpp(readFixture("single-track-with-fx.rpp"));
    const track = getTracks(root)[0];
    const content = extractRfxChainContent(track);

    expect(content).not.toBeNull();
    expect(content).toContain("BYPASS 0 0 0");
    expect(content).toContain("AU: T-De-Esser 2 (Techivation)");
  });

  it("returns null for a track without FXCHAIN", () => {
    const root = parseRpp(readFixture("special-characters.rpp"));
    const tracks = getTracks(root);
    // DÖRR track (second) has no FX chain
    const content = extractRfxChainContent(tracks[1]);
    expect(content).toBeNull();
  });

  it("extract → parse produces identical fingerprints as direct capture", () => {
    const root = parseRpp(readFixture("single-track-with-fx.rpp"));
    const track = getTracks(root)[0];

    // Path 1: capture directly from parsed track
    const directChain = captureFxChain(track);

    // Path 2: extract FXCHAIN content, then parse it back
    const extractedContent = extractRfxChainContent(track);
    expect(extractedContent).not.toBeNull();
    const parsedChain = parseRfxChain(extractedContent!);

    // Both paths must produce identical fingerprints
    expect(parsedChain).toHaveLength(directChain.length);
    for (let i = 0; i < directChain.length; i++) {
      expect(parsedChain[i].pluginName).toBe(directChain[i].pluginName);
      expect(parsedChain[i].pluginType).toBe(directChain[i].pluginType);
      expect(parsedChain[i].stateBlob).toBe(directChain[i].stateBlob);
      expect(parsedChain[i].stateHash).toBe(directChain[i].stateHash);
    }
  });
});
