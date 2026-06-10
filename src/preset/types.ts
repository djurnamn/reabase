import type { FxFingerprint } from "../snapshot/types.js";

/**
 * One entry in a preset's `plugins` list. The `id` is the stable machine
 * identity — derived from the plugin name, deduplicated across the chain.
 * The `label` is the user-facing display name. Labels are mutable; slot IDs
 * are not, so renaming a label never breaks `order` / `deactivated` /
 * `excluded` references.
 */
export interface PluginEntry {
  id: string;
  label?: string;
}

/**
 * A preset definition as stored in a YAML file.
 *
 * Composition model: a preset has any combination of own plugins (`plugins`
 * + `fxChainFile`), imported presets (`imports`), an explicit merged
 * ordering (`order`), per-slot deactivation flags (`deactivated`), and
 * per-slot exclusion flags (`excluded`). Imported presets cannot themselves
 * have imports — nesting is disallowed.
 *
 * Slot identity: every slot in the resolved chain is unique. Same slotId in
 * two different sources (the container or any import) is a load error —
 * fix it by renaming one of the sources' slots.
 */
export interface PresetDefinition {
  /** Unique name, e.g. "voice.character.female". */
  name: string;
  /** Optional human-readable description. */
  description?: string;
  /** Path (relative to the presets/ directory) to the JSON FX chain file
   *  for the container's own plugins. Required when `plugins` is set. */
  fxChainFile?: string;
  /** The container's own plugins. Position maps to the plugin in
   *  `fxChainFile` at the same index. */
  plugins?: PluginEntry[];
  /** Names of presets to import. Order in this list is the default ordering
   *  used when `order` is absent. Imported presets must themselves have no
   *  `imports` (nesting disallowed). */
  imports?: string[];
  /** Flat sequence of "<sourceName>/<slotId>" entries. Defines the visual
   *  order of every slot the composed preset cares about — including ones
   *  that are deactivated or excluded — so that toggling an excluded slot
   *  back in restores it at its original position. When absent, the
   *  resolver falls back to a default order: each import's internal order
   *  in imports-list order, with the container's own plugins first.
   *  Source names are either the container's own `name` or an entry from
   *  `imports`. */
  order?: string[];
  /** "<sourceName>/<slotId>" entries the composed preset wants bypassed in
   *  REAPER. Slot stays in the resolved chain at its `order` position; the
   *  apply layer marks it bypassed. Independent of `excluded` — a slot can
   *  be both, and re-including a deactivated slot restores the bypassed
   *  state. */
  deactivated?: string[];
  /** "<sourceName>/<slotId>" entries the composed preset wants omitted from
   *  the REAPER chain entirely. Slot stays in `order` so the visual
   *  position is preserved across exclude/re-include cycles, but the
   *  resolved chain skips it. */
  excluded?: string[];
}

/**
 * A preset as returned by the loader. Wraps the YAML-shape PresetDefinition
 * with loader-derived metadata: where the YAML lives on disk (so the
 * resolver can resolve `fxChainFile` and the writer knows where to write
 * back), and which category it belongs to (for UI grouping).
 *
 * The underscore prefix on these fields marks "loader-set, not in YAML."
 * The YAML schema itself doesn't carry these — they're derived from the
 * filesystem layout at load time.
 */
export interface LoadedPreset extends PresetDefinition {
  /** Absolute path to the directory containing this preset's YAML.
   *  `fxChainFile` paths are relative to this directory. */
  _sourceDir: string;
  /** Category slug — relative path from the presets/ root, e.g. "voices",
   *  "voices/mixins", or "" for a preset directly in presets/. */
  _categorySlug: string;
}

/**
 * Folder-level metadata, parsed from a `_category.yaml` file in any
 * subdirectory under presets/. Currently just a label; the schema can grow
 * additively (description, ordering, icon) without breaking existing files.
 */
export interface CategoryInfo {
  /** Slug — relative path from the presets/ root, matching the directory. */
  slug: string;
  /** User-facing label. Falls back to the folder name verbatim when no
   *  `_category.yaml` is present. */
  label: string;
}

/**
 * Bundled output of `loadPresets`. Both maps are returned together so
 * a single tree walk produces everything callers need.
 */
export interface PresetLoadResult {
  /** Keyed by preset name. Names are globally unique across all folders. */
  presets: Map<string, LoadedPreset>;
  /** Keyed by category slug. Includes every folder that contains at least
   *  one preset (even those without an explicit `_category.yaml`). */
  categories: Map<string, CategoryInfo>;
}

/**
 * An excluded slot, surfaced so the UI can render it grayed-in-place and
 * offer to un-exclude it. The slot is NOT in the resolved chain (excluded
 * slots never go on the track); this carries everything needed to draw it
 * back into the visual chain at its intended position.
 */
export interface ExcludedSlot {
  /** The excluded slot's fingerprint, with `origin` set to the source that
   *  contributed it. Bypassed is NOT set here — exclusion supersedes
   *  deactivation for chain inclusion. */
  fingerprint: FxFingerprint;
  /** Insert-index into the resolved chain: the number of resolved
   *  (non-excluded) slots that precede this slot in `order`. The UI splices
   *  the excluded slot in at this index to render it grayed-in-place. Stable
   *  across exclude/re-include because `order` preserves the slot's position. */
  position: number;
}

/**
 * A fully resolved preset with its composition applied.
 */
export interface ResolvedPreset {
  /** The preset name. */
  name: string;
  /** All sources that contributed to this preset, in resolution order:
   *  the container's own `name` (when it has own plugins) followed by each
   *  entry from `imports`. The Lua UI uses this to render per-source tabs
   *  and to color-code rows by `origin`. */
  sources: string[];
  /** The resolved FX chain — slots not excluded, in `order`-defined
   *  position. Each fingerprint's `origin` is set to the source that
   *  contributed it, and `bypassed` is set when the slot was listed in the
   *  preset's `deactivated`. */
  fxChain: FxFingerprint[];
  /** "<sourceName>/<slotId>" entries the preset has explicitly excluded
   *  from the resolved chain. Surfaced for the UI so it can render them
   *  grayed-out at their `order` position. Empty when the preset has no
   *  excluded slots. */
  excluded: string[];
  /** The excluded slots with their fingerprints and intended positions.
   *  Parallel to `excluded` (which keeps the bare refs for back-compat), but
   *  carries the detail and position the UI needs to render them
   *  grayed-in-place and offer un-exclude. Empty when nothing is excluded. */
  excludedChain: ExcludedSlot[];
  /** Hash of the resolved chain for versioning. */
  version: string;
}
