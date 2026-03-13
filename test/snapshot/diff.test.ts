import { describe, it, expect } from "vitest";
import { diffFxChains } from "../../src/snapshot/diff.js";
import type { FxFingerprint } from "../../src/snapshot/types.js";

function makeFx(name: string, state: string = "default", slotId?: string): FxFingerprint {
  return {
    pluginName: `AU: ${name}`,
    pluginType: "AU",
    stateHash: `hash_${state}`,
    stateBlob: `blob_${state}`,
    slotId: slotId ?? name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
  };
}

describe("diffFxChains", () => {
  it("reports no changes for identical chains", () => {
    const chain = [makeFx("EQ"), makeFx("Comp")];
    const diff = diffFxChains(chain, chain);

    expect(diff).toHaveLength(2);
    expect(diff.every((d) => d.type === "unchanged")).toBe(true);
  });

  it("detects modified FX", () => {
    const old = [makeFx("EQ", "v1")];
    const updated = [makeFx("EQ", "v2")];
    const diff = diffFxChains(old, updated);

    expect(diff).toHaveLength(1);
    expect(diff[0].type).toBe("modified");
    if (diff[0].type === "modified") {
      expect(diff[0].oldFx.stateHash).toBe("hash_v1");
      expect(diff[0].newFx.stateHash).toBe("hash_v2");
    }
  });

  it("detects added FX", () => {
    const old = [makeFx("EQ")];
    const updated = [makeFx("EQ"), makeFx("Comp")];
    const diff = diffFxChains(old, updated);

    expect(diff).toHaveLength(2);
    expect(diff[0].type).toBe("unchanged");
    expect(diff[1].type).toBe("added");
  });

  it("detects removed FX", () => {
    const old = [makeFx("EQ"), makeFx("Comp")];
    const updated = [makeFx("EQ")];
    const diff = diffFxChains(old, updated);

    expect(diff).toHaveLength(2);
    expect(diff[0].type).toBe("unchanged");
    expect(diff[1].type).toBe("removed");
  });

  it("handles duplicate plugins positionally", () => {
    const old = [makeFx("EQ", "low"), makeFx("EQ", "high")];
    const updated = [makeFx("EQ", "low_v2"), makeFx("EQ", "high")];
    const diff = diffFxChains(old, updated);

    expect(diff).toHaveLength(2);
    expect(diff[0].type).toBe("modified"); // first EQ changed
    expect(diff[1].type).toBe("unchanged"); // second EQ unchanged
  });

  it("handles empty chains", () => {
    expect(diffFxChains([], [])).toEqual([]);
    expect(diffFxChains([makeFx("EQ")], [])).toHaveLength(1);
    expect(diffFxChains([makeFx("EQ")], [])[0].type).toBe("removed");
    expect(diffFxChains([], [makeFx("EQ")])).toHaveLength(1);
    expect(diffFxChains([], [makeFx("EQ")])[0].type).toBe("added");
  });
});
