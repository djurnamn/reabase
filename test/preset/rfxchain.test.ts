import { describe, it, expect } from "vitest";
import { parsePresetFxChain, serializePresetFxChain } from "../../src/preset/rfxchain.js";
import type { FxFingerprint } from "../../src/snapshot/types.js";

describe("parsePresetFxChain", () => {
  it("parses a JSON preset with one plugin", () => {
    const json = JSON.stringify([
      {
        pluginName: "AU: T-De-Esser 2 (Techivation)",
        pluginType: "AU",
        slotId: "t-de-esser-2",
        parameters: {
          "0": { name: "Threshold", value: 0.5 },
          "1": { name: "Amount", value: 0.3 },
        },
      },
    ]);

    const chain = parsePresetFxChain(json);
    expect(chain).toHaveLength(1);
    expect(chain[0].pluginName).toBe("AU: T-De-Esser 2 (Techivation)");
    expect(chain[0].pluginType).toBe("AU");
    expect(chain[0].slotId).toBe("t-de-esser-2");
    expect(chain[0].stateHash).toBe("");
  });

  it("parses captures pluginParams", () => {
    const json = JSON.stringify([
      {
        pluginName: "AU: T-De-Esser 2 (Techivation)",
        pluginType: "AU",
        slotId: "t-de-esser-2",
        pluginParams: ["Techivation: T-De-Esser 2", "", 1635083896, 1415869293, 1415930728],
        parameters: {
          "0": { name: "Threshold", value: 0.5 },
        },
      },
    ]);

    const chain = parsePresetFxChain(json);
    expect(chain[0].pluginParams).toBeDefined();
    expect(chain[0].pluginParams).toContain("Techivation: T-De-Esser 2");
    expect(chain[0].pluginParams).toContain(1635083896);
    expect(chain[0].pluginParams).toContain(1415869293);
    expect(chain[0].pluginParams).toContain(1415930728);
  });

  it("parses multiple plugins", () => {
    const json = JSON.stringify([
      {
        pluginName: "AU: T-De-Esser 2 (Techivation)",
        pluginType: "AU",
        slotId: "t-de-esser-2",
        parameters: {
          "0": { name: "Threshold", value: 0.5 },
        },
      },
      {
        pluginName: "AU: kHs Limiter (Kilohearts)",
        pluginType: "AU",
        slotId: "khs-limiter",
        parameters: {
          "0": { name: "Ceiling", value: -1.0 },
          "1": { name: "Release", value: 0.2 },
        },
      },
    ]);

    const chain = parsePresetFxChain(json);
    expect(chain).toHaveLength(2);
    expect(chain[0].pluginName).toBe("AU: T-De-Esser 2 (Techivation)");
    expect(chain[1].pluginName).toBe("AU: kHs Limiter (Kilohearts)");
  });

  it("parses empty array", () => {
    const chain = parsePresetFxChain("[]");
    expect(chain).toHaveLength(0);
  });
});

describe("serializePresetFxChain", () => {
  it("serializes fingerprints to JSON", () => {
    const fingerprints: FxFingerprint[] = [
      {
        pluginName: "AU: T-De-Esser 2 (Techivation)",
        pluginType: "AU",
        stateHash: "abc123",
        slotId: "t-de-esser-2",
        parameters: {
          "0": { name: "Threshold", value: 0.5 },
          "1": { name: "Amount", value: 0.3 },
        },
      },
    ];

    const result = serializePresetFxChain(fingerprints);
    const parsed = JSON.parse(result);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].pluginName).toBe("AU: T-De-Esser 2 (Techivation)");
    expect(parsed[0].pluginType).toBe("AU");
    expect(parsed[0].slotId).toBe("t-de-esser-2");
    expect(parsed[0].parameters["0"]).toEqual({ name: "Threshold", value: 0.5 });
    expect(parsed[0].parameters["1"]).toEqual({ name: "Amount", value: 0.3 });
    // stateHash should not be serialized into the preset
    expect(parsed[0].stateHash).toBeUndefined();
  });

  it("round-trips through serialize and parse", () => {
    const fingerprints: FxFingerprint[] = [
      {
        pluginName: "AU: T-De-Esser 2 (Techivation)",
        pluginType: "AU",
        stateHash: "abc123",
        slotId: "t-de-esser-2",
        parameters: {
          "0": { name: "Threshold", value: 0.5 },
          "1": { name: "Amount", value: 0.3 },
        },
      },
    ];

    const serialized = serializePresetFxChain(fingerprints);
    const reparsed = parsePresetFxChain(serialized);

    expect(reparsed).toHaveLength(1);
    expect(reparsed[0].pluginName).toBe("AU: T-De-Esser 2 (Techivation)");
    expect(reparsed[0].pluginType).toBe("AU");
    expect(reparsed[0].slotId).toBe("t-de-esser-2");
    expect(reparsed[0].parameters).toEqual({
      "0": { name: "Threshold", value: 0.5 },
      "1": { name: "Amount", value: 0.3 },
    });
  });

  it("round-trips with pluginParams (AU component identifiers)", () => {
    const fingerprints: FxFingerprint[] = [
      {
        pluginName: "AU: T-De-Esser 2 (Techivation)",
        pluginType: "AU",
        stateHash: "abc123",
        slotId: "t-de-esser-2",
        pluginParams: ["Techivation: T-De-Esser 2", "", 1635083896, 1415869293, 1415930728],
        parameters: {
          "0": { name: "Threshold", value: 0.5 },
        },
      },
    ];

    const serialized = serializePresetFxChain(fingerprints);
    expect(serialized).toContain('"Techivation: T-De-Esser 2"');
    expect(serialized).toContain("1635083896");

    const reparsed = parsePresetFxChain(serialized);
    expect(reparsed[0].pluginParams).toBeDefined();
    expect(reparsed[0].pluginParams).toContain("Techivation: T-De-Esser 2");
    expect(reparsed[0].pluginParams).toContain(1635083896);
    expect(reparsed[0].pluginParams).toContain(1415869293);
    expect(reparsed[0].pluginParams).toContain(1415930728);
  });
});
