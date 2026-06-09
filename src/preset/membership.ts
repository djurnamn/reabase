import type { FxFingerprint } from "../snapshot/types.js";

/**
 * Map every slotId that can appear in a three-way merge to the source — the
 * container preset's own name or an imported preset name — that owns it.
 *
 * Per-source pull needs this because `origin` is NOT populated uniformly
 * across merge action types: `use_new_base` / `add_base` carry the preset's
 * fingerprint (origin set), but `keep_base` / `keep_local` / `merge_params`
 * carry snapshot- or track-derived fingerprints (no origin), and `remove`
 * carries no fingerprint at all. So we attribute by slotId instead.
 *
 * Two inputs because the resolved chain (new base) only knows the slots the
 * preset *currently* contributes — a slot a source *removed* upstream is gone
 * from the resolved chain, and its only surviving record is the snapshot (old
 * base). Snapshots written since per-source support landed carry `origin`;
 * older snapshots don't, so a removed slot off a legacy baseline is left
 * unattributed (it simply won't be scoped to any source). Resolved wins over
 * the snapshot when both know a slot — it's the current truth.
 */
export function buildSlotSourceMap(
  resolvedChain: FxFingerprint[],
  snapshotChain: FxFingerprint[]
): Map<string, string> {
  const map = new Map<string, string>();
  for (const fx of snapshotChain) {
    if (fx.origin) map.set(fx.slotId, fx.origin);
  }
  for (const fx of resolvedChain) {
    if (fx.origin) map.set(fx.slotId, fx.origin);
  }
  return map;
}
