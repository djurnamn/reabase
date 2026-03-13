import type { FxFingerprint } from "../snapshot/types.js";

export type MergeAction =
  | { type: "keep_base"; fx: FxFingerprint }
  | { type: "use_new_base"; fx: FxFingerprint }
  | { type: "keep_local"; fx: FxFingerprint }
  | { type: "add_local"; fx: FxFingerprint }
  | { type: "add_base"; fx: FxFingerprint }
  | { type: "remove"; pluginName: string; pluginType: string; slotId?: string }
  | {
      type: "conflict";
      local: FxFingerprint;
      base: FxFingerprint;
      reason: string;
    };

export interface MergeResult {
  actions: MergeAction[];
  hasConflicts: boolean;
  /** The resolved chain — only populated for non-conflicting FX. Conflicts are omitted. */
  resolvedChain: FxFingerprint[];
}
