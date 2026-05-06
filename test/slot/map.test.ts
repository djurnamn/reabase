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
    slotId,
    parameters: {},
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

  it("disambiguates two instances of same plugin by Nth-occurrence pairing", () => {
    const chain = [
      makeFx("AU: EQ (Vendor)", "low_v2", "auto-eq"),
      makeFx("AU: EQ (Vendor)", "high_v2", "auto-eq-2"),
    ];

    const slotMap = {
      "eq-low": { pluginType: "AU", pluginName: "AU: EQ (Vendor)", stateHash: "hash_low" },
      "eq-high": { pluginType: "AU", pluginName: "AU: EQ (Vendor)", stateHash: "hash_high" },
    };

    // Both state hashes differ, so pass 2 is used: 1st chain EQ pairs with
    // 1st unused snapshot EQ slot (eq-low), 2nd with eq-high.
    const resolved = resolveSlotIds(chain, slotMap);
    expect(resolved[0].slotId).toBe("eq-low");
    expect(resolved[1].slotId).toBe("eq-high");
  });

  it("keeps duplicate-plugin slot identities stable when an unrelated plugin is inserted before them", () => {
    // Snapshot recorded three EQs at positions 0, 1, 2.
    // User added a Comp at the front and tweaked all three EQs.
    // Closest-by-mapIndex would mis-pair (chain pos 1 → eq-B, pos 2 → eq-C, pos 3 → eq-A)
    // because chain positions no longer line up with snapshot positions.
    // Nth-occurrence pairs chain EQs to snapshot EQs in order: eq-A, eq-B, eq-C.
    const chain = [
      makeFx("AU: Comp (Vendor)", "v1", "auto-comp"),
      makeFx("AU: EQ (Vendor)", "tweaked_a", "auto-eq"),
      makeFx("AU: EQ (Vendor)", "tweaked_b", "auto-eq-2"),
      makeFx("AU: EQ (Vendor)", "tweaked_c", "auto-eq-3"),
    ];

    const slotMap = {
      "eq-A": { pluginType: "AU", pluginName: "AU: EQ (Vendor)", stateHash: "hash_a" },
      "eq-B": { pluginType: "AU", pluginName: "AU: EQ (Vendor)", stateHash: "hash_b" },
      "eq-C": { pluginType: "AU", pluginName: "AU: EQ (Vendor)", stateHash: "hash_c" },
    };

    const resolved = resolveSlotIds(chain, slotMap);
    expect(resolved[0].slotId).toBe("auto-comp"); // unmatched, kept
    expect(resolved[1].slotId).toBe("eq-A");
    expect(resolved[2].slotId).toBe("eq-B");
    expect(resolved[3].slotId).toBe("eq-C");
  });

  it("preserves duplicate-plugin slot identity when only one of two duplicates is tweaked", () => {
    // Two khs-filter instances; the user tweaks the second one.
    // Pass 1 should exact-match the untouched first to filter-A.
    // Pass 2 should pair the remaining chain occurrence to filter-B (the only
    // unused identity-matching slot).
    const chain = [
      makeFx("AU: kHs Filter (Kilohearts)", "a", "auto-khs-filter"),         // unchanged
      makeFx("AU: kHs Filter (Kilohearts)", "b_tweaked", "auto-khs-filter-2"), // tweaked
    ];

    const slotMap = {
      "filter-A": {
        pluginType: "AU",
        pluginName: "AU: kHs Filter (Kilohearts)",
        stateHash: "hash_a",
      },
      "filter-B": {
        pluginType: "AU",
        pluginName: "AU: kHs Filter (Kilohearts)",
        stateHash: "hash_b",
      },
    };

    const resolved = resolveSlotIds(chain, slotMap);
    expect(resolved[0].slotId).toBe("filter-A");
    expect(resolved[1].slotId).toBe("filter-B");
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
