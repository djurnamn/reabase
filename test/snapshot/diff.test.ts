import { describe, it, expect } from "vitest";
import { diffFxChains, chainsReordered } from "../../src/snapshot/diff.js";
import type { FxFingerprint } from "../../src/snapshot/types.js";

function makeFx(name: string, state: string = "default", slotId?: string): FxFingerprint {
  return {
    pluginName: `AU: ${name}`,
    pluginType: "AU",
    stateHash: `hash_${state}`,
    slotId: slotId ?? name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
    parameters: { "0": { name: "param", value: state === "default" ? 0.5 : 0.8 } },
  };
}

describe("diffFxChains", () => {
  it("reports no changes for identical chains", () => {
    const chain = [makeFx("EQ"), makeFx("Comp")];
    const diff = diffFxChains(chain, chain);

    expect(diff.actions).toHaveLength(2);
    expect(diff.actions.every((d) => d.type === "unchanged")).toBe(true);
    expect(diff.reordered).toBe(false);
  });

  it("detects modified FX", () => {
    const old = [makeFx("EQ", "v1")];
    const updated = [makeFx("EQ", "v2")];
    const diff = diffFxChains(old, updated);

    expect(diff.actions).toHaveLength(1);
    expect(diff.actions[0].type).toBe("modified");
    if (diff.actions[0].type === "modified") {
      expect(diff.actions[0].oldFx.stateHash).toBe("hash_v1");
      expect(diff.actions[0].newFx.stateHash).toBe("hash_v2");
    }
    expect(diff.reordered).toBe(false);
  });

  it("detects added FX", () => {
    const old = [makeFx("EQ")];
    const updated = [makeFx("EQ"), makeFx("Comp")];
    const diff = diffFxChains(old, updated);

    expect(diff.actions).toHaveLength(2);
    expect(diff.actions[0].type).toBe("unchanged");
    expect(diff.actions[1].type).toBe("added");
    expect(diff.reordered).toBe(false);
  });

  it("detects removed FX", () => {
    const old = [makeFx("EQ"), makeFx("Comp")];
    const updated = [makeFx("EQ")];
    const diff = diffFxChains(old, updated);

    expect(diff.actions).toHaveLength(2);
    expect(diff.actions[0].type).toBe("unchanged");
    expect(diff.actions[1].type).toBe("removed");
    expect(diff.reordered).toBe(false);
  });

  it("handles duplicate plugins positionally", () => {
    const old = [makeFx("EQ", "low"), makeFx("EQ", "high")];
    const updated = [makeFx("EQ", "low_v2"), makeFx("EQ", "high")];
    const diff = diffFxChains(old, updated);

    expect(diff.actions).toHaveLength(2);
    expect(diff.actions[0].type).toBe("modified"); // first EQ changed
    expect(diff.actions[1].type).toBe("unchanged"); // second EQ unchanged
    expect(diff.reordered).toBe(false);
  });

  it("handles empty chains", () => {
    const empty = diffFxChains([], []);
    expect(empty.actions).toEqual([]);
    expect(empty.reordered).toBe(false);

    const removedOnly = diffFxChains([makeFx("EQ")], []);
    expect(removedOnly.actions).toHaveLength(1);
    expect(removedOnly.actions[0].type).toBe("removed");

    const addedOnly = diffFxChains([], [makeFx("EQ")]);
    expect(addedOnly.actions).toHaveLength(1);
    expect(addedOnly.actions[0].type).toBe("added");
  });

  it("flags pure reorder when slot set is identical", () => {
    const old = [makeFx("A"), makeFx("B"), makeFx("C")];
    const updated = [makeFx("B"), makeFx("A"), makeFx("C")];
    const diff = diffFxChains(old, updated);

    expect(diff.actions.every((d) => d.type === "unchanged")).toBe(true);
    expect(diff.reordered).toBe(true);
  });

  it("flags reorder independently of additions", () => {
    const old = [makeFx("A"), makeFx("B")];
    const updated = [makeFx("B"), makeFx("A"), makeFx("X")]; // reordered + added
    const diff = diffFxChains(old, updated);

    expect(diff.reordered).toBe(true);
    expect(diff.actions.some((d) => d.type === "added")).toBe(true);
  });

  it("does not flag reorder when only added/removed slots break the position match", () => {
    const old = [makeFx("A"), makeFx("B"), makeFx("C")];
    const updated = [makeFx("A"), makeFx("X"), makeFx("B"), makeFx("C")]; // X inserted, A/B/C in same relative order
    const diff = diffFxChains(old, updated);

    expect(diff.reordered).toBe(false);
    expect(diff.actions.some((d) => d.type === "added")).toBe(true);
  });
});

describe("chainsReordered", () => {
  it("returns false for identical chains", () => {
    const chain = [makeFx("A"), makeFx("B")];
    expect(chainsReordered(chain, chain)).toBe(false);
  });

  it("returns true when shared slots are in different order", () => {
    const a = [makeFx("A"), makeFx("B"), makeFx("C")];
    const b = [makeFx("C"), makeFx("B"), makeFx("A")];
    expect(chainsReordered(a, b)).toBe(true);
  });

  it("returns false when one chain has additional slots but shared slots stay in order", () => {
    const a = [makeFx("A"), makeFx("B")];
    const b = [makeFx("A"), makeFx("X"), makeFx("B"), makeFx("Y")];
    expect(chainsReordered(a, b)).toBe(false);
  });

  it("returns true when shared slots are reordered even with additions", () => {
    const a = [makeFx("A"), makeFx("B")];
    const b = [makeFx("X"), makeFx("B"), makeFx("A")];
    expect(chainsReordered(a, b)).toBe(true);
  });

  it("returns false for empty chains", () => {
    expect(chainsReordered([], [])).toBe(false);
    expect(chainsReordered([makeFx("A")], [])).toBe(false);
    expect(chainsReordered([], [makeFx("A")])).toBe(false);
  });
});
