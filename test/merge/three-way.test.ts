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
});
