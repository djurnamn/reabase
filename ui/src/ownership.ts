import type { DjuiColor } from "djui";
import type { FxSlot, InspectResult, SourceComposition } from "./bridge";

/**
 * Ownership + composition model for the plugin table. A slot is owned by exactly
 * one source (a plain preset) — the composed preset's own container or one of
 * its imports — or it's "loose" (on the track but in no preset). Edits
 * (ownership, deactivation, exclusion) are *staged* (save-when-ready); the
 * Staged* maps override the inspect baseline until committed.
 */

/** Source name, or null = loose/local (no preset). */
export type Owner = string | null;

export type StagedOwnership = Map<string, Owner>;
export type StagedDeactivation = Map<string, boolean>;
export type StagedExclusion = Map<string, boolean>;

export interface OwnershipRow {
  slot: FxSlot;
  /** Effective owner (staged override or inspect baseline). */
  owner: Owner;
  /** This slot is excluded per inspect (it came from `excludedChain`). */
  excludedBaseline: boolean;
}

// ─── Owner ─────────────────────────────────────────────────────────

export function inspectOwner(slot: FxSlot): Owner {
  return slot.origin ?? null;
}

export function effectiveOwner(slot: FxSlot, staged: StagedOwnership): Owner {
  return staged.has(slot.slotId)
    ? (staged.get(slot.slotId) as Owner)
    : inspectOwner(slot);
}

// ─── Deactivation (scoped to the tab's preset) ─────────────────────
//
// The composed view edits the composed preset's `deactivated` (reflected in
// `slot.bypassed`); a source tab edits THAT source's own `deactivated` (from its
// `SourceComposition`). They're independent state for the same slot, so the
// staged map is keyed by `<preset>::<slotId>`.

export function deactivationKey(preset: string, slotId: string): string {
  return `${preset}::${slotId}`;
}

function sourceComposition(
  data: InspectResult,
  name: string,
): SourceComposition | undefined {
  return data.sources.find((s) => s.name === name);
}

/** Committed deactivate state of `slot` in `targetPreset`'s scope. */
export function inspectDeactivatedFor(
  data: InspectResult,
  slot: FxSlot,
  targetPreset: string,
): boolean {
  if (targetPreset === data.preset) return !!slot.bypassed; // composed scope
  const comp = sourceComposition(data, targetPreset);
  return comp
    ? comp.deactivated.includes(`${targetPreset}/${slot.slotId}`)
    : false;
}

export function effectiveDeactivatedFor(
  data: InspectResult,
  slot: FxSlot,
  targetPreset: string,
  staged: StagedDeactivation,
): boolean {
  const key = deactivationKey(targetPreset, slot.slotId);
  return staged.has(key)
    ? (staged.get(key) as boolean)
    : inspectDeactivatedFor(data, slot, targetPreset);
}

/** Presets that have any staged deactivation edit. */
export function presetsWithStagedDeactivation(
  staged: StagedDeactivation,
): string[] {
  const presets = new Set<string>();
  for (const key of staged.keys()) presets.add(key.slice(0, key.indexOf("::")));
  return [...presets];
}

// ─── Exclusion ─────────────────────────────────────────────────────

export function effectiveExcluded(
  slotId: string,
  baseline: boolean,
  staged: StagedExclusion,
): boolean {
  return staged.has(slotId) ? (staged.get(slotId) as boolean) : baseline;
}

// ─── Slot sets ─────────────────────────────────────────────────────

/**
 * Every slot to consider: owned (resolved chain) + excluded (still owned, just
 * omitted from the chain) + loose (on the track, in no preset). Flattened —
 * used for ownership payloads and source-tab rows. (The composed view rebuilds
 * its own ordered list so it can place excluded slots in position.)
 */
export function unifiedSlots(data: InspectResult): FxSlot[] {
  const resolved = data.resolvedChain ?? [];
  const excluded = (data.excludedChain ?? []).map((e) => e.fingerprint);
  const ownedIds = new Set([
    ...resolved.map((s) => s.slotId),
    ...excluded.map((s) => s.slotId),
  ]);
  const loose = data.currentChain.filter((s) => !ownedIds.has(s.slotId));
  return [...resolved, ...excluded, ...loose];
}

// ─── Colors ────────────────────────────────────────────────────────

export function importSources(data: InspectResult): string[] {
  return data.sources.map((s) => s.name).filter((name) => name !== data.preset);
}

export function ownableSources(data: InspectResult): string[] {
  const names = data.sources.map((s) => s.name);
  return [...new Set([data.preset, ...names].filter((s): s is string => !!s))];
}

const ACCENT_ORDINALS = [
  "primary",
  "secondary",
  "tertiary",
  "quaternary",
  "quinary",
  "senary",
  "septenary",
  "octonary",
] as const;

export function accentForOwner(
  owner: Owner,
  accentSources: string[],
): DjuiColor | undefined {
  if (!owner) return undefined;
  const index = accentSources.indexOf(owner);
  if (index === -1) return undefined; // container / self → default
  return `accent-${ACCENT_ORDINALS[index % ACCENT_ORDINALS.length]}`;
}

// ─── Rows ──────────────────────────────────────────────────────────

/**
 * Rows for a tab. The composed view (`composedView`, `ownerSource = data.preset`)
 * shows the whole chain in composed order with **excluded slots spliced in at
 * their position** (grayed-in-place). An import tab is focused: its own plugins
 * (brought-over last), then loose, then — with `showOthers` — the rest.
 * Exclusion is composed-scope, so import tabs don't mark `excludedBaseline`.
 */
export function buildRows(
  data: InspectResult,
  ownerSource: string | null,
  composedView: boolean,
  staged: StagedOwnership,
  showOthers: boolean,
): OwnershipRow[] {
  if (composedView) {
    const resolved = data.resolvedChain ?? [];
    const excluded = [...(data.excludedChain ?? [])].sort(
      (a, b) => a.position - b.position,
    );
    const rows: OwnershipRow[] = [];
    let ei = 0;
    for (let i = 0; i <= resolved.length; i++) {
      while (ei < excluded.length && excluded[ei].position === i) {
        const fp = excluded[ei].fingerprint;
        rows.push({ slot: fp, owner: effectiveOwner(fp, staged), excludedBaseline: true });
        ei++;
      }
      if (i < resolved.length) {
        const s = resolved[i];
        rows.push({ slot: s, owner: effectiveOwner(s, staged), excludedBaseline: false });
      }
    }
    const ownedIds = new Set([
      ...resolved.map((s) => s.slotId),
      ...excluded.map((e) => e.fingerprint.slotId),
    ]);
    for (const s of data.currentChain.filter((s) => !ownedIds.has(s.slotId))) {
      rows.push({ slot: s, owner: effectiveOwner(s, staged), excludedBaseline: false });
    }
    return rows;
  }

  const rows = unifiedSlots(data).map((slot): OwnershipRow => ({
    slot,
    owner: effectiveOwner(slot, staged),
    excludedBaseline: false,
  }));
  const here = rows.filter((r) => r.owner === ownerSource);
  return [
    ...here.filter((r) => inspectOwner(r.slot) === ownerSource),
    ...here.filter((r) => inspectOwner(r.slot) !== ownerSource),
    ...rows.filter((r) => r.owner == null),
    ...(showOthers ? rows.filter((r) => r.owner != null && r.owner !== ownerSource) : []),
  ];
}

// ─── Commit payloads ───────────────────────────────────────────────

export function ownershipPayload(
  data: InspectResult,
  staged: StagedOwnership,
): { ownership: Record<string, string[]>; released: string[] } {
  const ownership: Record<string, string[]> = {};
  for (const source of ownableSources(data)) ownership[source] = [];
  const released: string[] = [];

  for (const slot of unifiedSlots(data)) {
    const owner = effectiveOwner(slot, staged);
    if (owner && owner in ownership) ownership[owner].push(slot.slotId);
    else if (!owner && inspectOwner(slot) != null) released.push(slot.slotId);
  }
  return { ownership, released };
}

/**
 * A preset's full `deactivated` list as `<source>/<slotId>`. For the composed
 * preset it's every owned slot deactivated in the composed scope; for a source
 * preset it's that source's own slots deactivated in its own scope.
 */
export function deactivatedListForPreset(
  data: InspectResult,
  preset: string,
  stagedOwnership: StagedOwnership,
  stagedDeactivation: StagedDeactivation,
): string[] {
  const isComposed = preset === data.preset;
  const entries: string[] = [];
  for (const slot of unifiedSlots(data)) {
    const owner = effectiveOwner(slot, stagedOwnership);
    if (isComposed) {
      if (!owner) continue;
      if (effectiveDeactivatedFor(data, slot, preset, stagedDeactivation)) {
        entries.push(`${owner}/${slot.slotId}`);
      }
    } else {
      if (owner !== preset) continue; // only this source's own plugins
      if (effectiveDeactivatedFor(data, slot, preset, stagedDeactivation)) {
        entries.push(`${preset}/${slot.slotId}`);
      }
    }
  }
  return entries;
}

/** The composed preset's full `excluded` list as `<source>/<slotId>`. */
export function excludedPayload(
  data: InspectResult,
  stagedOwnership: StagedOwnership,
  stagedExclusion: StagedExclusion,
): string[] {
  const entries: string[] = [];
  const consider = (slot: FxSlot, baseline: boolean) => {
    if (effectiveExcluded(slot.slotId, baseline, stagedExclusion)) {
      const owner = effectiveOwner(slot, stagedOwnership);
      if (owner) entries.push(`${owner}/${slot.slotId}`);
    }
  };
  for (const slot of data.resolvedChain ?? []) consider(slot, false);
  for (const e of data.excludedChain ?? []) consider(e.fingerprint, true);
  return entries;
}
