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

export interface InspectResult {
  trackName?: string;
  trackGuid?: string;
  preset?: string;
  status: TrackStatus;
  /** What's actually on the track right now. */
  currentChain: FxSlot[];
  /** What the preset says the chain should be; null when there's no preset. */
  resolvedChain: FxSlot[] | null;
  /** Source presets contributing to the resolved chain, in resolution order. */
  sources: string[];
  /** "<source>/<slotId>" entries the preset excludes from the resolved chain. */
  excluded: string[];
  /** Every preset reabase loaded (for the preset picker). */
  presets: PresetSummary[];
  /** Every category the loader saw (for grouping). */
  categories: { slug: string; label: string }[];
}
