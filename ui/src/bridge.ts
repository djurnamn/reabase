/**
 * Wire types for the reabase Lua bridge (`lua/reabase_webview.lua`). Mirrors
 * `InspectOutput` in `src/commands/bridge.ts` on the backend, carrying only
 * the fields the UI reads. Intentionally NOT imported from the backend
 * package — the UI is decoupled and only ever sees JSON over the bridge.
 */

export type TrackStatus =
  | "up-to-date"
  | "modified"
  | "upstream-changes"
  | "conflict"
  | "no-snapshot"
  | "unresolvable-preset"
  | "no-preset"
  | null;

/** One slot in a resolved/current FX chain (subset of the backend's
 *  FxFingerprint — just what the UI displays). */
export interface FxSlot {
  slotId: string;
  /** Resolved display name (track-local label > preset label > plugin name). */
  displayName?: string;
  pluginName?: string;
  /** "AU" | "VST" | "VST3" | … */
  pluginType?: string;
  /** Which source contributed this slot, in a composed preset. */
  origin?: string;
  /** Bypassed in REAPER (preset `deactivated`, or a local bypass). */
  bypassed?: boolean;
}

export interface PresetSummary {
  name: string;
  description?: string;
  imports?: string[];
  category: { slug: string; label: string };
}

/**
 * One contributing source of the resolved preset, carrying that source's OWN
 * composition fields verbatim — distinct from the composed resolution. The UI
 * reads the entry for a source tab to render/edit that source's standalone
 * deactivate/exclude/order. Entries are the source's own `<source>/<slotId>`
 * refs; empty arrays when unset. Mirrors `SourceComposition` on the backend.
 */
export interface SourceComposition {
  name: string;
  /** This source's own plugins in CANONICAL order (its `plugins`/`fxChainFile`
   *  order — what `reorder-preset-plugins` permutes), so a source tab can order
   *  its own rows independently of the composed resolution. */
  slotIds: string[];
  deactivated: string[];
  excluded: string[];
  order: string[];
}

/** An excluded slot (omitted from the resolved chain) with where it belongs. */
export interface ExcludedSlot {
  fingerprint: FxSlot;
  /** Insert index into `resolvedChain` — how many resolved slots precede it. */
  position: number;
}

/** One plugin's three-way-merge action (the subset the row status reads). */
export interface MergeAction {
  type:
    | "keep_base"
    | "keep_local"
    | "use_new_base"
    | "merge_params"
    | "add_base"
    | "add_local"
    | "remove"
    | "remove_local"
    | "conflict";
  fx?: FxSlot;
  /** Present on `conflict`. */
  local?: FxSlot;
  /** Present on `remove`. */
  slotId?: string;
}

export interface MergeResult {
  actions: MergeAction[];
  hasConflicts: boolean;
}

export interface InspectResult {
  trackName?: string;
  trackGuid?: string;
  preset?: string;
  status: TrackStatus;
  /** What's actually on the track right now. */
  currentChain: FxSlot[];
  /** What the preset says the chain should be; null when there's no preset. */
  resolvedChain: FxSlot[] | null;
  /** Excluded slots (not in the resolved chain) with their position, so the UI
   *  can render them grayed-in-place and offer un-exclude. */
  excludedChain: ExcludedSlot[];
  /** Three-way-merge result — drives per-plugin status. Null when no preset/
   *  no baseline to compare against. */
  merge: MergeResult | null;
  /** Source presets contributing to the resolved chain, in resolution order.
   *  Each carries its OWN composition fields (see `SourceComposition`) so a
   *  source tab can render/edit its standalone state independently. */
  sources: SourceComposition[];
  /** "<source>/<slotId>" entries the preset excludes from the resolved chain. */
  excluded: string[];
  /** Every preset reabase loaded (for the preset picker). */
  presets: PresetSummary[];
  /** Every category the loader saw (for grouping). */
  categories: { slug: string; label: string }[];
}
