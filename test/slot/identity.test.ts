import { describe, it, expect } from "vitest";
import {
  slugifyPluginName,
  generateSlotId,
  assignSlotIds,
} from "../../src/slot/identity.js";
import type { FxFingerprint } from "../../src/snapshot/types.js";

describe("slugifyPluginName", () => {
  it("strips AU prefix and manufacturer suffix", () => {
    expect(slugifyPluginName("AU: T-De-Esser 2 (Techivation)")).toBe(
      "t-de-esser-2"
    );
  });

  it("strips VST3 prefix", () => {
    expect(slugifyPluginName("VST3: Pro-Q 3 (FabFilter)")).toBe("pro-q-3");
  });

  it("strips kHs prefix style", () => {
    expect(slugifyPluginName("AU: kHs Snap Heap (Kilohearts)")).toBe(
      "khs-snap-heap"
    );
  });

  it("handles plugin names with no prefix", () => {
    expect(slugifyPluginName("My Plugin")).toBe("my-plugin");
  });

  it("handles plugin names with no manufacturer suffix", () => {
    expect(slugifyPluginName("AU: Simple EQ")).toBe("simple-eq");
  });

  it("collapses multiple non-alphanumeric chars", () => {
    expect(slugifyPluginName("AU: Some -- Plugin!! (Vendor)")).toBe(
      "some-plugin"
    );
  });

  it("returns 'unknown' for empty result", () => {
    expect(slugifyPluginName("")).toBe("unknown");
  });

  it("handles JS type prefix", () => {
    expect(slugifyPluginName("JS: utility/volume")).toBe("utility-volume");
  });
});

describe("generateSlotId", () => {
  it("returns base slug when no conflicts", () => {
    const existing = new Set<string>();
    expect(
      generateSlotId("AU: T-De-Esser 2 (Techivation)", existing)
    ).toBe("t-de-esser-2");
  });

  it("appends -2 when slug already exists", () => {
    const existing = new Set(["t-de-esser-2"]);
    expect(
      generateSlotId("AU: T-De-Esser 2 (Techivation)", existing)
    ).toBe("t-de-esser-2-2");
  });

  it("appends -3 when both base and -2 exist", () => {
    const existing = new Set(["khs-snap-heap", "khs-snap-heap-2"]);
    expect(
      generateSlotId("AU: kHs Snap Heap (Kilohearts)", existing)
    ).toBe("khs-snap-heap-3");
  });
});

describe("assignSlotIds", () => {
  function makeFx(name: string): FxFingerprint {
    return {
      pluginName: name,
      pluginType: "AU",
      stateHash: "hash",
      slotId: "",
      parameters: {},
    };
  }

  it("assigns unique slot IDs to each plugin", () => {
    const chain = [
      makeFx("AU: T-De-Esser 2 (Techivation)"),
      makeFx("AU: kHs Snap Heap (Kilohearts)"),
    ];

    const result = assignSlotIds(chain);
    expect(result[0].slotId).toBe("t-de-esser-2");
    expect(result[1].slotId).toBe("khs-snap-heap");
  });

  it("deduplicates when same plugin appears multiple times", () => {
    const chain = [
      makeFx("AU: kHs Snap Heap (Kilohearts)"),
      makeFx("AU: kHs Snap Heap (Kilohearts)"),
      makeFx("AU: kHs Snap Heap (Kilohearts)"),
    ];

    const result = assignSlotIds(chain);
    expect(result[0].slotId).toBe("khs-snap-heap");
    expect(result[1].slotId).toBe("khs-snap-heap-2");
    expect(result[2].slotId).toBe("khs-snap-heap-3");
  });

  it("handles empty chain", () => {
    expect(assignSlotIds([])).toEqual([]);
  });

  it("preserves all other fingerprint fields", () => {
    const chain: FxFingerprint[] = [
      {
        pluginName: "AU: EQ (Vendor)",
        pluginType: "AU",
        stateHash: "abc",
        slotId: "",
        parameters: { "0": { name: "gain", value: 0.5 } },
      },
    ];

    const result = assignSlotIds(chain);
    expect(result[0].pluginName).toBe("AU: EQ (Vendor)");
    expect(result[0].pluginType).toBe("AU");
    expect(result[0].stateHash).toBe("abc");
    expect(result[0].parameters).toEqual({ "0": { name: "gain", value: 0.5 } });
  });
});
