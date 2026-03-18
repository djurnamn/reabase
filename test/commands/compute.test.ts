import { describe, it, expect } from "vitest";
import { compute } from "../../src/commands/compute.js";
import type { ComputeInput } from "../../src/commands/compute.js";
import type { FxFingerprint } from "../../src/snapshot/types.js";

function makeFx(name: string, state: string, slotId?: string): FxFingerprint {
  return {
    pluginName: name,
    pluginType: "AU",
    stateHash: `hash_${state}`,
    slotId: slotId ?? name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
    parameters: {},
  };
}

describe("compute", () => {
  it("returns no changes when all three sides are identical", () => {
    const chain = [makeFx("EQ", "AAA")];
    const input: ComputeInput = {
      oldBase: chain,
      newBase: chain,
      currentChain: chain,
    };

    const result = compute(input);
    expect(result.merge.hasConflicts).toBe(false);
    expect(result.merge.resolvedChain).toHaveLength(1);
  });

  it("detects upstream additions", () => {
    const oldBase = [makeFx("EQ", "AAA")];
    const newBase = [makeFx("EQ", "AAA"), makeFx("Limiter", "BBB")];
    const current = [makeFx("EQ", "AAA")];

    const result = compute({ oldBase, newBase, currentChain: current });
    expect(result.merge.hasConflicts).toBe(false);
    expect(result.merge.resolvedChain).toHaveLength(2);
    expect(result.merge.resolvedChain[1].pluginName).toBe("Limiter");
  });

  it("detects conflicts when both sides modify the same plugin", () => {
    const oldBase = [makeFx("EQ", "AAA")];
    const newBase = [makeFx("EQ", "BBB")]; // upstream changed
    const current = [makeFx("EQ", "CCC")]; // local changed differently

    const result = compute({ oldBase, newBase, currentChain: current });
    expect(result.merge.hasConflicts).toBe(true);
  });

  it("preserves local additions", () => {
    const oldBase = [makeFx("EQ", "AAA")];
    const newBase = [makeFx("EQ", "AAA")]; // no upstream changes
    const current = [makeFx("EQ", "AAA"), makeFx("Reverb", "DDD")];

    const result = compute({ oldBase, newBase, currentChain: current });
    expect(result.merge.hasConflicts).toBe(false);
    expect(result.merge.resolvedChain).toHaveLength(2);
    expect(result.merge.resolvedChain[1].pluginName).toBe("Reverb");
  });

  it("handles first sync with empty old base", () => {
    const oldBase: FxFingerprint[] = [];
    const newBase = [makeFx("EQ", "AAA"), makeFx("Comp", "BBB")];
    const current: FxFingerprint[] = [];

    const result = compute({ oldBase, newBase, currentChain: current });
    expect(result.merge.hasConflicts).toBe(false);
    expect(result.merge.resolvedChain).toHaveLength(2);
  });
});
