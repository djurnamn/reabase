import { useCallback, useState } from "react";
import type {
  Owner,
  StagedDeactivation,
  StagedExclusion,
  StagedOwnership,
} from "./ownership";

/** The staged state + stagers the plugin table needs (not clear/count). */
export interface TableEdits {
  ownership: StagedOwnership;
  deactivation: StagedDeactivation;
  exclusion: StagedExclusion;
  stageOwnership: (slotId: string, owner: Owner, original: Owner) => void;
  stageDeactivation: (slotId: string, value: boolean, original: boolean) => void;
  stageExclusion: (slotId: string, value: boolean, original: boolean) => void;
}

/**
 * Staged (uncommitted) composition edits — the save-when-ready buffer. Setting a
 * value back to its inspect baseline clears the edit, so toggling a control back
 * is an implicit per-plugin revert. Holds ownership (attach/bring-over),
 * deactivation, and exclusion.
 */
export function useStagedEdits() {
  const [ownership, setOwnership] = useState<StagedOwnership>(new Map());
  const [deactivation, setDeactivation] = useState<StagedDeactivation>(new Map());
  const [exclusion, setExclusion] = useState<StagedExclusion>(new Map());

  const stageOwnership = useCallback(
    (slotId: string, owner: Owner, original: Owner) => {
      setOwnership((prev) => toggleMap(prev, slotId, owner, original));
    },
    [],
  );

  const stageDeactivation = useCallback(
    (slotId: string, value: boolean, original: boolean) => {
      setDeactivation((prev) => toggleMap(prev, slotId, value, original));
    },
    [],
  );

  const stageExclusion = useCallback(
    (slotId: string, value: boolean, original: boolean) => {
      setExclusion((prev) => toggleMap(prev, slotId, value, original));
    },
    [],
  );

  const clear = useCallback(() => {
    setOwnership(new Map());
    setDeactivation(new Map());
    setExclusion(new Map());
  }, []);

  const count = ownership.size + deactivation.size + exclusion.size;

  return {
    ownership,
    deactivation,
    exclusion,
    stageOwnership,
    stageDeactivation,
    stageExclusion,
    clear,
    count,
  };
}

/** Set `slotId` to `value`, or drop it when `value` returns to `original`. */
function toggleMap<V>(prev: Map<string, V>, slotId: string, value: V, original: V) {
  const next = new Map(prev);
  if (value === original) next.delete(slotId);
  else next.set(slotId, value);
  return next;
}
