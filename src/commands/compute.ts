import type { FxFingerprint } from "../snapshot/types.js";
import { threeWayMerge } from "../merge/three-way.js";
import type { MergeResult } from "../merge/types.js";

/**
 * Input for the compute command.
 * This is what the Lua UI sends via JSON.
 */
export interface ComputeInput {
  /** Current FX chain state of the track */
  currentChain: FxFingerprint[];
  /** Snapshot of what was last applied (old base) */
  oldBase: FxFingerprint[];
  /** Current resolved preset (new base) */
  newBase: FxFingerprint[];
}

/**
 * Output of the compute command.
 * This is what the Lua UI receives via JSON.
 */
export interface ComputeOutput {
  merge: MergeResult;
}

/**
 * Pure computation: three-way merge without any side effects.
 * Used by the Lua UI via `reabase compute` CLI command.
 */
export function compute(input: ComputeInput): ComputeOutput {
  const merge = threeWayMerge(input.oldBase, input.newBase, input.currentChain);
  return { merge };
}
