import { describe, it, expect } from "vitest";
import {
  buildSlotMap,
  serializeSlotMap,
  parseSlotMap,
  resolveSlotIds,
} from "../../src/slot/map.js";
import type { FxFingerprint } from "../../src/snapshot/types.js";

function makeFx(
  name: string,
  state: string,
  slotId: string,
  type: string = "AU"
): FxFingerprint {
  return {
    pluginName: name,
    pluginType: type,
    stateHash: `hash_${state}`,
    stateBlob: `blob_${state}`,
    slotId,
  };
}

describe("buildSlotMap", () => {
  it("builds a map from a chain", () => {
    const chain = [
      makeFx("AU: EQ (Vendor)", "v1", "eq"),
      makeFx("AU: Comp (Vendor)", "v1", "comp"),
    ];

    const map = buildSlotMap(chain);
    expect(Object.keys(map)).toEqual(["eq", "comp"]);
    expect(map["eq"].pluginName).toBe("AU: EQ (Vendor)");
    expect(map["eq"].stateHash).toBe("hash_v1");
  });

  it("handles empty chain", () => {
    expect(buildSlotMap([])).toEqual({});
  });
});

describe("serializeSlotMap / parseSlotMap", () => {
  it("round-trips through serialize and parse", () => {
    const chain = [makeFx("AU: EQ (Vendor)", "v1", "eq")];
    const map = buildSlotMap(chain);
    const json = serializeSlotMap(map);
    const parsed = parseSlotMap(json);

    expect(parsed).toEqual(map);
  });

  it("parseSlotMap returns null for invalid JSON", () => {
    expect(parseSlotMap("not json")).toBeNull();
  });

  it("parseSlotMap returns null for non-object JSON", () => {
    expect(parseSlotMap('"string"')).toBeNull();
    expect(parseSlotMap("null")).toBeNull();
    expect(parseSlotMap("42")).toBeNull();
  });
});

describe("resolveSlotIds", () => {
  it("assigns slotIds via exact match (identity + stateHash)", () => {
    const chain = [
      makeFx("AU: EQ (Vendor)", "v1", "auto-eq"),
      makeFx("AU: Comp (Vendor)", "v1", "auto-comp"),
    ];

    const slotMap = {
      "eq": { pluginType: "AU", pluginName: "AU: EQ (Vendor)", stateHash: "hash_v1" },
      "comp": { pluginType: "AU", pluginName: "AU: Comp (Vendor)", stateHash: "hash_v1" },
    };

    const resolved = resolveSlotIds(chain, slotMap);
    expect(resolved[0].slotId).toBe("eq");
    expect(resolved[1].slotId).toBe("comp");
  });

  it("assigns slotIds via identity match when stateHash differs", () => {
    const chain = [
      makeFx("AU: EQ (Vendor)", "v2", "auto-eq"), // state changed
    ];

    const slotMap = {
      "eq": { pluginType: "AU", pluginName: "AU: EQ (Vendor)", stateHash: "hash_v1" },
    };

    const resolved = resolveSlotIds(chain, slotMap);
    expect(resolved[0].slotId).toBe("eq");
  });

  it("keeps auto-generated slotId for unmatched plugins", () => {
    const chain = [
      makeFx("AU: New Plugin (Vendor)", "v1", "new-plugin"),
    ];

    const slotMap = {
      "eq": { pluginType: "AU", pluginName: "AU: EQ (Vendor)", stateHash: "hash_v1" },
    };

    const resolved = resolveSlotIds(chain, slotMap);
    expect(resolved[0].slotId).toBe("new-plugin");
  });

  it("handles reordered plugins", () => {
    // Plugins were reordered in REAPER
    const chain = [
      makeFx("AU: Comp (Vendor)", "v1", "auto-comp"),
      makeFx("AU: EQ (Vendor)", "v1", "auto-eq"),
    ];

    const slotMap = {
      "eq": { pluginType: "AU", pluginName: "AU: EQ (Vendor)", stateHash: "hash_v1" },
      "comp": { pluginType: "AU", pluginName: "AU: Comp (Vendor)", stateHash: "hash_v1" },
    };

    const resolved = resolveSlotIds(chain, slotMap);
    expect(resolved[0].slotId).toBe("comp");
    expect(resolved[1].slotId).toBe("eq");
  });

  it("disambiguates two instances of same plugin by closest position", () => {
    const chain = [
      makeFx("AU: EQ (Vendor)", "low_v2", "auto-eq"),
      makeFx("AU: EQ (Vendor)", "high_v2", "auto-eq-2"),
    ];

    const slotMap = {
      "eq-low": { pluginType: "AU", pluginName: "AU: EQ (Vendor)", stateHash: "hash_low" },
      "eq-high": { pluginType: "AU", pluginName: "AU: EQ (Vendor)", stateHash: "hash_high" },
    };

    // Both state hashes differ, so pass 2 is used — closest position wins
    const resolved = resolveSlotIds(chain, slotMap);
    expect(resolved[0].slotId).toBe("eq-low");
    expect(resolved[1].slotId).toBe("eq-high");
  });

  it("handles empty slot map", () => {
    const chain = [makeFx("AU: EQ (Vendor)", "v1", "eq")];
    const resolved = resolveSlotIds(chain, {});
    expect(resolved[0].slotId).toBe("eq");
  });

  it("handles empty chain", () => {
    const resolved = resolveSlotIds([], { "eq": { pluginType: "AU", pluginName: "AU: EQ (Vendor)", stateHash: "hash_v1" } });
    expect(resolved).toEqual([]);
  });
});
