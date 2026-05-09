import { describe, it, expect } from "vitest";
import { threeWayMerge } from "../../src/merge/three-way.js";
import type { FxFingerprint } from "../../src/snapshot/types.js";

function makeFx(
  name: string,
  state: string = "default",
  type: string = "AU",
  slotId?: string
): FxFingerprint {
  return {
    pluginName: `${type}: ${name}`,
    pluginType: type,
    stateHash: `hash_${state}`,
    slotId: slotId ?? name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
    parameters: {},
  };
}

/** Build a fingerprint with real per-parameter data so per-param merge can run. */
function makeFxWithParams(
  name: string,
  params: Record<string, number>,
  options?: { type?: string; slotId?: string; stateBlob?: string }
): FxFingerprint {
  const type = options?.type ?? "AU";
  const slotId =
    options?.slotId ??
    name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const parameters: FxFingerprint["parameters"] = {};
  for (const [key, value] of Object.entries(params)) {
    parameters[key] = { name: `param_${key}`, value };
  }
  return {
    pluginName: `${type}: ${name}`,
    pluginType: type,
    stateHash: `hash_${name}_${JSON.stringify(params)}`,
    slotId,
    parameters,
    stateBlob: options?.stateBlob,
  };
}

describe("threeWayMerge", () => {
  describe("no changes", () => {
    it("returns keep_base when nothing changed", () => {
      const chain = [makeFx("EQ"), makeFx("Comp")];
      const result = threeWayMerge(chain, chain, chain);

      expect(result.hasConflicts).toBe(false);
      expect(result.actions).toHaveLength(2);
      expect(result.actions.every((a) => a.type === "keep_base")).toBe(true);
      expect(result.resolvedChain).toHaveLength(2);
    });

    it("handles empty chains", () => {
      const result = threeWayMerge([], [], []);
      expect(result.hasConflicts).toBe(false);
      expect(result.actions).toHaveLength(0);
      expect(result.resolvedChain).toHaveLength(0);
    });
  });

  describe("base-only changes (upstream updates)", () => {
    it("takes new base when only base modified an FX", () => {
      const oldBase = [makeFx("EQ", "v1"), makeFx("Comp", "v1")];
      const newBase = [makeFx("EQ", "v2"), makeFx("Comp", "v1")];
      const local = [makeFx("EQ", "v1"), makeFx("Comp", "v1")];

      const result = threeWayMerge(oldBase, newBase, local);

      expect(result.hasConflicts).toBe(false);
      expect(result.actions[0].type).toBe("use_new_base");
      expect(result.actions[1].type).toBe("keep_base");
      expect(result.resolvedChain[0].stateHash).toBe("hash_v2");
    });

    it("adds FX that base added", () => {
      const oldBase = [makeFx("EQ")];
      const newBase = [makeFx("EQ"), makeFx("HiPass")];
      const local = [makeFx("EQ")];

      const result = threeWayMerge(oldBase, newBase, local);

      expect(result.hasConflicts).toBe(false);
      const addAction = result.actions.find((a) => a.type === "add_base");
      expect(addAction).toBeDefined();
      expect(result.resolvedChain).toHaveLength(2);
    });

    it("removes FX that base removed when local didn't modify", () => {
      const oldBase = [makeFx("EQ"), makeFx("Comp")];
      const newBase = [makeFx("EQ")];
      const local = [makeFx("EQ"), makeFx("Comp")];

      const result = threeWayMerge(oldBase, newBase, local);

      expect(result.hasConflicts).toBe(false);
      expect(result.resolvedChain).toHaveLength(1);
      expect(result.resolvedChain[0].pluginName).toBe("AU: EQ");
    });
  });

  describe("local-only changes", () => {
    it("keeps local when only local modified an FX", () => {
      const oldBase = [makeFx("EQ", "v1")];
      const newBase = [makeFx("EQ", "v1")];
      const local = [makeFx("EQ", "local_tweak")];

      const result = threeWayMerge(oldBase, newBase, local);

      expect(result.hasConflicts).toBe(false);
      expect(result.actions[0].type).toBe("keep_local");
      expect(result.resolvedChain[0].stateHash).toBe("hash_local_tweak");
    });

    it("preserves locally added FX after the base chain", () => {
      const oldBase = [makeFx("EQ")];
      const newBase = [makeFx("EQ")];
      const local = [makeFx("EQ"), makeFx("Extra Reverb")];

      const result = threeWayMerge(oldBase, newBase, local);

      expect(result.hasConflicts).toBe(false);
      const addAction = result.actions.find((a) => a.type === "add_local");
      expect(addAction).toBeDefined();
      expect(result.resolvedChain).toHaveLength(2);
      expect(result.resolvedChain[1].pluginName).toBe("AU: Extra Reverb");
    });

    it("respects local removal when base didn't change", () => {
      const oldBase = [makeFx("EQ"), makeFx("Comp")];
      const newBase = [makeFx("EQ"), makeFx("Comp")];
      const local = [makeFx("EQ")];

      const result = threeWayMerge(oldBase, newBase, local);

      expect(result.hasConflicts).toBe(false);
      expect(result.resolvedChain).toHaveLength(1);
      expect(result.resolvedChain[0].pluginName).toBe("AU: EQ");
      // Should be remove_local, not remove (it's a local change, not upstream)
      const removeAction = result.actions.find((a) => a.type === "remove_local");
      expect(removeAction).toBeDefined();
      if (removeAction?.type === "remove_local") {
        expect(removeAction.fx.pluginName).toBe("AU: Comp");
      }
    });
  });

  describe("both changed (same way = no conflict)", () => {
    it("no conflict when both made the same modification", () => {
      const oldBase = [makeFx("EQ", "v1")];
      const newBase = [makeFx("EQ", "v2")];
      const local = [makeFx("EQ", "v2")];

      const result = threeWayMerge(oldBase, newBase, local);

      expect(result.hasConflicts).toBe(false);
      expect(result.actions[0].type).toBe("keep_local");
      expect(result.resolvedChain[0].stateHash).toBe("hash_v2");
    });
  });

  describe("conflicts", () => {
    it("conflicts when both modified the same FX differently", () => {
      const oldBase = [makeFx("EQ", "v1")];
      const newBase = [makeFx("EQ", "base_v2")];
      const local = [makeFx("EQ", "local_v2")];

      const result = threeWayMerge(oldBase, newBase, local);

      expect(result.hasConflicts).toBe(true);
      expect(result.actions[0].type).toBe("conflict");
      if (result.actions[0].type === "conflict") {
        expect(result.actions[0].reason).toBe(
          "Modified in both base and local"
        );
        expect(result.actions[0].local.stateHash).toBe("hash_local_v2");
        expect(result.actions[0].base.stateHash).toBe("hash_base_v2");
      }
      // Resolved chain includes local version as safe default
      expect(result.resolvedChain[0].stateHash).toBe("hash_local_v2");
    });

    it("conflicts when base removed but local modified", () => {
      const oldBase = [makeFx("EQ", "v1"), makeFx("Comp", "v1")];
      const newBase = [makeFx("EQ", "v1")]; // Comp removed
      const local = [makeFx("EQ", "v1"), makeFx("Comp", "tweaked")]; // Comp modified

      const result = threeWayMerge(oldBase, newBase, local);

      expect(result.hasConflicts).toBe(true);
      const conflict = result.actions.find((a) => a.type === "conflict");
      expect(conflict).toBeDefined();
      if (conflict?.type === "conflict") {
        expect(conflict.reason).toBe("Removed in base but modified locally");
      }
    });

    it("merges disjoint per-parameter edits without conflict (Bug 2)", () => {
      // Local edits param 0 (threshold), upstream edits param 1 (ratio).
      // Plugin-level hashes diverge; per-param merge resolves cleanly.
      const oldBase = [
        makeFxWithParams("Comp", { "0": 0.5, "1": 2.0 }, { stateBlob: "old_blob" }),
      ];
      const newBase = [
        makeFxWithParams("Comp", { "0": 0.5, "1": 4.0 }, { stateBlob: "new_blob" }),
      ];
      const local = [
        makeFxWithParams("Comp", { "0": 0.7, "1": 2.0 }, { stateBlob: "local_blob" }),
      ];

      const result = threeWayMerge(oldBase, newBase, local);

      expect(result.hasConflicts).toBe(false);
      expect(result.actions).toHaveLength(1);
      expect(result.actions[0].type).toBe("merge_params");
      if (result.actions[0].type === "merge_params") {
        // Merged fingerprint should carry both edits and local's blob.
        expect(result.actions[0].fx.parameters["0"].value).toBe(0.7);
        expect(result.actions[0].fx.parameters["1"].value).toBe(4.0);
        expect(result.actions[0].fx.stateBlob).toBe("local_blob");
      }
      expect(result.resolvedChain).toHaveLength(1);
      expect(result.resolvedChain[0].parameters["0"].value).toBe(0.7);
      expect(result.resolvedChain[0].parameters["1"].value).toBe(4.0);
    });

    it("escalates to plugin conflict when even one param truly diverges", () => {
      // Both sides edit the same param (0) to different values → real conflict.
      const oldBase = [
        makeFxWithParams("Comp", { "0": 0.5, "1": 2.0 }),
      ];
      const newBase = [
        makeFxWithParams("Comp", { "0": 0.6, "1": 4.0 }),
      ];
      const local = [
        makeFxWithParams("Comp", { "0": 0.7, "1": 2.0 }),
      ];

      const result = threeWayMerge(oldBase, newBase, local);

      expect(result.hasConflicts).toBe(true);
      expect(result.actions[0].type).toBe("conflict");
    });

    it("treats both-sides-same-param-change as keep_local (no merge_params)", () => {
      // Both moved param 0 to 0.7 → same change, no merge needed.
      const oldBase = [makeFxWithParams("Comp", { "0": 0.5, "1": 2.0 })];
      const newBase = [makeFxWithParams("Comp", { "0": 0.7, "1": 2.0 })];
      const local = [makeFxWithParams("Comp", { "0": 0.7, "1": 2.0 })];

      const result = threeWayMerge(oldBase, newBase, local);

      expect(result.hasConflicts).toBe(false);
      expect(result.actions[0].type).toBe("keep_local");
    });

    it("conflicts when local removed but base modified", () => {
      const oldBase = [makeFx("EQ", "v1"), makeFx("Comp", "v1")];
      const newBase = [makeFx("EQ", "v1"), makeFx("Comp", "improved")]; // Comp modified
      const local = [makeFx("EQ", "v1")]; // Comp removed

      const result = threeWayMerge(oldBase, newBase, local);

      expect(result.hasConflicts).toBe(true);
      const conflict = result.actions.find((a) => a.type === "conflict");
      expect(conflict).toBeDefined();
      if (conflict?.type === "conflict") {
        expect(conflict.reason).toBe("Modified in base but removed locally");
      }
    });
  });

  describe("complex scenarios", () => {
    it("handles the full podcast workflow", () => {
      // Original preset: De-Esser -> EQ -> Comp -> Limiter
      const oldBase = [
        makeFx("De-Esser", "v1"),
        makeFx("EQ", "v1"),
        makeFx("Comp", "v1"),
        makeFx("Limiter", "v1"),
      ];

      // Upstream: added HiPass after De-Esser, improved Comp
      const newBase = [
        makeFx("De-Esser", "v1"),
        makeFx("HiPass", "new"),
        makeFx("EQ", "v1"),
        makeFx("Comp", "v2"),
        makeFx("Limiter", "v1"),
      ];

      // Local: tweaked De-Esser, added extra reverb at end
      const local = [
        makeFx("De-Esser", "bjorn_tweak"),
        makeFx("EQ", "v1"),
        makeFx("Comp", "v1"),
        makeFx("Limiter", "v1"),
        makeFx("Studio Reverb", "bjorn_custom"),
      ];

      const result = threeWayMerge(oldBase, newBase, local);

      expect(result.hasConflicts).toBe(false);

      // Expected resolved chain:
      // De-Esser (local tweak preserved) -> HiPass (from base) -> EQ (unchanged) ->
      // Comp (base improved, local didn't touch) -> Limiter (unchanged) ->
      // Studio Reverb (local addition)
      expect(result.resolvedChain).toHaveLength(6);
      expect(result.resolvedChain[0].stateHash).toBe("hash_bjorn_tweak"); // local De-Esser
      expect(result.resolvedChain[1].pluginName).toBe("AU: HiPass"); // base addition
      expect(result.resolvedChain[2].pluginName).toBe("AU: EQ"); // unchanged
      expect(result.resolvedChain[3].stateHash).toBe("hash_v2"); // base Comp improvement
      expect(result.resolvedChain[4].pluginName).toBe("AU: Limiter"); // unchanged
      expect(result.resolvedChain[5].pluginName).toBe("AU: Studio Reverb"); // local addition
    });

    it("preserves a local reorder when preset content is unchanged", () => {
      const oldBase = [makeFx("A"), makeFx("B"), makeFx("C")];
      const newBase = [makeFx("A"), makeFx("B"), makeFx("C")];
      const local = [makeFx("B"), makeFx("A"), makeFx("C")]; // user moved B first

      const result = threeWayMerge(oldBase, newBase, local);

      expect(result.hasConflicts).toBe(false);
      expect(result.resolvedChain.map((fx) => fx.slotId)).toEqual([
        "b",
        "a",
        "c",
      ]);
    });

    it("anchors a preset addition to its preset-relative neighbour when local has reordered", () => {
      const oldBase = [makeFx("A"), makeFx("B"), makeFx("C")];
      // Preset adds X between B and C — preset order: A, B, X, C
      const newBase = [makeFx("A"), makeFx("B"), makeFx("X"), makeFx("C")];
      const local = [makeFx("B"), makeFx("A"), makeFx("C")]; // user moved B first

      const result = threeWayMerge(oldBase, newBase, local);

      expect(result.hasConflicts).toBe(false);
      // X's preceding preset-neighbour is B; X lands right after B in local.
      expect(result.resolvedChain.map((fx) => fx.slotId)).toEqual([
        "b",
        "x",
        "a",
        "c",
      ]);
    });

    it("preserves local order when preset removes a plugin the user hasn't touched", () => {
      const oldBase = [makeFx("A"), makeFx("B"), makeFx("C")];
      const newBase = [makeFx("A"), makeFx("C")]; // B removed upstream
      const local = [makeFx("B"), makeFx("A"), makeFx("C")];

      const result = threeWayMerge(oldBase, newBase, local);

      expect(result.hasConflicts).toBe(false);
      expect(result.resolvedChain.map((fx) => fx.slotId)).toEqual(["a", "c"]);
    });

    it("applies a preset reorder when local has not reordered", () => {
      const oldBase = [makeFx("A"), makeFx("B"), makeFx("C")];
      const newBase = [makeFx("C"), makeFx("A"), makeFx("B")]; // preset reordered
      const local = [makeFx("A"), makeFx("B"), makeFx("C")]; // matches old

      const result = threeWayMerge(oldBase, newBase, local);

      expect(result.hasConflicts).toBe(false);
      expect(result.resolvedChain.map((fx) => fx.slotId)).toEqual([
        "c",
        "a",
        "b",
      ]);
    });

    it("local order wins when both preset and local reordered differently", () => {
      const oldBase = [makeFx("A"), makeFx("B"), makeFx("C")];
      const newBase = [makeFx("C"), makeFx("B"), makeFx("A")]; // preset reverses
      const local = [makeFx("B"), makeFx("A"), makeFx("C")]; // local picks own order

      const result = threeWayMerge(oldBase, newBase, local);

      expect(result.hasConflicts).toBe(false);
      expect(result.resolvedChain.map((fx) => fx.slotId)).toEqual([
        "b",
        "a",
        "c",
      ]);
    });

    it("preserves the position of a local addition placed mid-chain", () => {
      const oldBase = [makeFx("A"), makeFx("B")];
      const newBase = [makeFx("A"), makeFx("B")];
      const local = [makeFx("A"), makeFx("X"), makeFx("B")]; // X inserted between A and B

      const result = threeWayMerge(oldBase, newBase, local);

      expect(result.hasConflicts).toBe(false);
      expect(result.resolvedChain.map((fx) => fx.slotId)).toEqual([
        "a",
        "x",
        "b",
      ]);
    });

    it("preserves the position of a local addition placed at the front", () => {
      const oldBase = [makeFx("A"), makeFx("B")];
      const newBase = [makeFx("A"), makeFx("B")];
      const local = [makeFx("X"), makeFx("A"), makeFx("B")]; // X at front

      const result = threeWayMerge(oldBase, newBase, local);

      expect(result.hasConflicts).toBe(false);
      // Anchored to following neighbour A → ends up before A.
      expect(result.resolvedChain.map((fx) => fx.slotId)).toEqual([
        "x",
        "a",
        "b",
      ]);
    });

    it("handles duplicate plugins (two instances of same EQ with unique slotIds)", () => {
      const oldBase = [makeFx("EQ", "low_cut", "AU", "eq-low"), makeFx("EQ", "high_shelf", "AU", "eq-high")];
      const newBase = [makeFx("EQ", "low_cut_v2", "AU", "eq-low"), makeFx("EQ", "high_shelf", "AU", "eq-high")];
      const local = [makeFx("EQ", "low_cut", "AU", "eq-low"), makeFx("EQ", "high_shelf_tweaked", "AU", "eq-high")];

      const result = threeWayMerge(oldBase, newBase, local);

      expect(result.hasConflicts).toBe(false);
      expect(result.resolvedChain).toHaveLength(2);
      // First EQ: base updated, local didn't touch -> take new base
      expect(result.resolvedChain[0].stateHash).toBe("hash_low_cut_v2");
      // Second EQ: base didn't change, local tweaked -> keep local
      expect(result.resolvedChain[1].stateHash).toBe("hash_high_shelf_tweaked");
    });
  });

  describe("bypass round-trip", () => {
    function bp(fp: FxFingerprint, bypassed: boolean): FxFingerprint {
      return bypassed ? { ...fp, bypassed: true } : { ...fp, bypassed: undefined };
    }

    it("treats a local bypass toggle as a local edit (keep_local)", () => {
      const old = makeFx("EQ", "v1", "AU", "eq");
      const next = makeFx("EQ", "v1", "AU", "eq");
      const local = bp(makeFx("EQ", "v1", "AU", "eq"), true);

      const result = threeWayMerge([old], [next], [local]);
      expect(result.hasConflicts).toBe(false);
      expect(result.actions[0].type).toBe("keep_local");
      expect(result.resolvedChain[0].bypassed).toBe(true);
    });

    it("treats a preset deactivate as upstream (use_new_base)", () => {
      const old = makeFx("EQ", "v1", "AU", "eq");
      const next = bp(makeFx("EQ", "v1", "AU", "eq"), true);
      const local = makeFx("EQ", "v1", "AU", "eq");

      const result = threeWayMerge([old], [next], [local]);
      expect(result.hasConflicts).toBe(false);
      expect(result.actions[0].type).toBe("use_new_base");
      expect(result.resolvedChain[0].bypassed).toBe(true);
    });

    it("merges disjoint changes: local bypass toggle + upstream param edit", () => {
      const oldFx = makeFxWithParams("Comp", { "0": 0.5 });
      const newFx = makeFxWithParams("Comp", { "0": 0.8 });
      const localFx = bp(makeFxWithParams("Comp", { "0": 0.5 }), true);

      const result = threeWayMerge([oldFx], [newFx], [localFx]);
      expect(result.hasConflicts).toBe(false);
      expect(result.actions[0].type).toBe("merge_params");
      // Merged fingerprint carries upstream's param value AND local's bypass.
      expect(result.resolvedChain[0].parameters["0"].value).toBe(0.8);
      expect(result.resolvedChain[0].bypassed).toBe(true);
    });

    it("no-op when bypass and params match across all three", () => {
      const old = makeFx("EQ", "v1", "AU", "eq");
      const next = makeFx("EQ", "v1", "AU", "eq");
      const local = makeFx("EQ", "v1", "AU", "eq");

      const result = threeWayMerge([old], [next], [local]);
      expect(result.hasConflicts).toBe(false);
      expect(result.actions[0].type).toBe("keep_base");
      expect(result.resolvedChain[0].bypassed).toBeUndefined();
    });

    it("treats both sides toggling bypass in the same direction as keep_local", () => {
      const old = makeFx("EQ", "v1", "AU", "eq");
      const next = bp(makeFx("EQ", "v1", "AU", "eq"), true);
      const local = bp(makeFx("EQ", "v1", "AU", "eq"), true);

      const result = threeWayMerge([old], [next], [local]);
      expect(result.hasConflicts).toBe(false);
      expect(result.actions[0].type).toBe("keep_local");
      expect(result.resolvedChain[0].bypassed).toBe(true);
    });
  });
});
