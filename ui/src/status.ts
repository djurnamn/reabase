import type { MergeResult } from "./bridge";

/** Per-plugin status (up-to-date slots have no status — they're absent). */
export type RowStatus = "modified" | "upstream-changes" | "conflict";

export const ROW_STATUS_LABEL: Record<RowStatus, string> = {
  modified: "Modified locally",
  "upstream-changes": "Upstream changes",
  conflict: "Conflict",
};

function statusFromAction(type: string): RowStatus | null {
  switch (type) {
    case "keep_local":
    case "add_local":
    case "remove_local":
      return "modified";
    case "use_new_base":
    case "add_base":
    case "remove":
    case "merge_params":
      return "upstream-changes";
    case "conflict":
      return "conflict";
    default:
      return null; // keep_base → up-to-date
  }
}

/** slotId → per-plugin status from the three-way merge. */
export function rowStatusBySlot(merge: MergeResult | null): Map<string, RowStatus> {
  const map = new Map<string, RowStatus>();
  if (!merge) return map;
  for (const action of merge.actions) {
    const slotId = action.fx?.slotId ?? action.local?.slotId ?? action.slotId;
    if (!slotId) continue;
    const status = statusFromAction(action.type);
    if (status) map.set(slotId, status);
  }
  return map;
}
