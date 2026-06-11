import { join, resolve } from "node:path";
import { mkdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import YAML from "yaml";
import type { LoadedPreset } from "./types.js";
import type { FxFingerprint } from "../snapshot/types.js";
import { parsePresetFxChain, serializePresetFxChain } from "./rfxchain.js";

/**
 * Persist a preset's own plugins (the `plugins` list and `fxChainFile`)
 * from the given fingerprints. Composition fields — `imports`, `order`,
 * `deactivated`, `excluded` — are preserved verbatim from the existing
 * YAML; they are managed by `updateComposition`, not here.
 *
 * Each fingerprint's `displayName` round-trips into `plugins[].label`. An
 * empty or missing `displayName` clears the label. Slot IDs come from the
 * fingerprint's `slotId` (which the resolver already deduplicates).
 *
 * Writes happen inside the preset's source folder (`_sourceDir`) so a
 * preset that lives in `presets/voices/` keeps its YAML and its
 * `fx/<name>.json` co-located there.
 *
 * Use this for both plain presets and the container's own plugins of a
 * composed preset — they share the same on-disk shape.
 */
export function updatePresetOwnPlugins(
  definition: LoadedPreset,
  ownedFingerprints: FxFingerprint[]
): void {
  const safeFilename = slugifyName(definition.name);
  const fxDirectory = join(definition._sourceDir, "fx");
  mkdirSync(fxDirectory, { recursive: true });

  const fxChainRelPath = definition.fxChainFile ?? `fx/${safeFilename}.json`;
  const fxChainAbsPath = resolve(definition._sourceDir, fxChainRelPath);
  const yamlPath = join(definition._sourceDir, `${safeFilename}.yaml`);

  // Read the existing YAML so we can preserve fields the writer doesn't
  // own (composition fields, description). Falls back to a fresh document
  // when no YAML exists yet (new preset).
  const existing = existsSync(yamlPath)
    ? (YAML.parse(readFileSync(yamlPath, "utf-8")) as Record<string, unknown>)
    : { name: definition.name };

  if (ownedFingerprints.length > 0) {
    writeFileSync(
      fxChainAbsPath,
      serializePresetFxChain(ownedFingerprints),
      "utf-8"
    );
    existing.fxChainFile = fxChainRelPath;
    existing.plugins = ownedFingerprints.map((fp) => {
      const entry: { id: string; label?: string } = { id: fp.slotId };
      if (fp.displayName && fp.displayName.length > 0) {
        entry.label = fp.displayName;
      }
      return entry;
    });
  } else {
    // No owned plugins → drop the fxChainFile/plugins fields entirely.
    delete existing.fxChainFile;
    delete existing.plugins;
  }

  writeFileSync(yamlPath, YAML.stringify(existing), "utf-8");
}

/**
 * Fully remove one of a preset's own plugins — the destructive counterpart
 * to excluding it. Drops the slot from the preset's `plugins` list and the
 * index-aligned entry from its `fxChainFile`, keeping the two in lockstep.
 * When the removed slot was the preset's last own plugin, both `plugins` and
 * `fxChainFile` are dropped from the YAML (mirroring `updatePresetOwnPlugins`'
 * empty case), leaving any composed/import structure intact.
 *
 * Composition fields (`imports`, `order`, `deactivated`, `excluded`) are
 * preserved verbatim here — scrubbing references to the deleted slot is the
 * caller's job (see `deletePlugin` in the bridge), since refs to it can live
 * in *other* presets too. The resolver tolerates any that slip through.
 *
 * Throws if `slotId` is not one of this preset's own plugins — removing a slot
 * that the preset only inherits via an import is meaningless here (delete it
 * from the import that owns it instead).
 */
export function deletePresetOwnPlugin(
  definition: LoadedPreset,
  slotId: string
): void {
  const safeFilename = slugifyName(definition.name);
  const yamlPath = join(definition._sourceDir, `${safeFilename}.yaml`);
  if (!existsSync(yamlPath)) {
    throw new Error(`Preset '${definition.name}' not found at ${yamlPath}`);
  }

  const doc = YAML.parse(readFileSync(yamlPath, "utf-8")) as Record<
    string,
    unknown
  >;
  const plugins = Array.isArray(doc.plugins)
    ? (doc.plugins as { id: string; label?: string }[])
    : [];
  const index = plugins.findIndex((p) => p.id === slotId);
  if (index === -1) {
    throw new Error(
      `Slot '${slotId}' is not one of preset '${definition.name}'s own plugins`
    );
  }

  // Remove the matching entry from the fxChainFile JSON at the same index —
  // `plugins[i]` and the JSON's plugin `i` are parallel (the resolver zips
  // them). Round-trip through parse/serialize so the file keeps the canonical
  // shape the rest of the writer produces.
  const fxChainRel =
    typeof doc.fxChainFile === "string"
      ? doc.fxChainFile
      : definition.fxChainFile;
  if (fxChainRel) {
    const fxChainAbs = resolve(definition._sourceDir, fxChainRel);
    if (existsSync(fxChainAbs)) {
      const chain = parsePresetFxChain(readFileSync(fxChainAbs, "utf-8"));
      if (index < chain.length) {
        chain.splice(index, 1);
      }
      writeFileSync(fxChainAbs, serializePresetFxChain(chain), "utf-8");
    }
  }

  plugins.splice(index, 1);
  if (plugins.length > 0) {
    doc.plugins = plugins;
  } else {
    delete doc.plugins;
    delete doc.fxChainFile;
  }

  writeFileSync(yamlPath, YAML.stringify(doc), "utf-8");
}

/**
 * Set a plain preset's internal plugin order directly — permute its own
 * `plugins` list and the index-aligned `fxChainFile` entries to match `order`.
 * The two arrays are reordered by the SAME permutation so they stay in lockstep
 * (the resolver zips them by index — `plugins[i].id` is the authoritative slot
 * ID for chain entry `i`; see `loadOwnPlugins`).
 *
 * `order` is the preset's own slot IDs in their new sequence and must be
 * exactly the set of `plugins[].id` — no missing, extra, duplicate, or foreign
 * entries. Reordering only permutes existing entries; it never adds or drops a
 * plugin (use `updatePresetOwnPlugins` / `deletePresetOwnPlugin` for those).
 *
 * This is the preset's CANONICAL internal order: used when the preset is
 * assigned to a track standalone, and as the default ordering a composed preset
 * inherits when it imports the preset without pinning those slots in its own
 * `order`. Composition fields (`imports`/`order`/`deactivated`/`excluded`) are
 * preserved verbatim here — a composed preset that pins these slots in its own
 * `order` walks that order and is unaffected; edit it via `updateComposition`.
 *
 * Throws if the preset has no own plugins, or if `order` is not exactly the set
 * of own slot IDs.
 */
export function reorderPresetOwnPlugins(
  definition: LoadedPreset,
  order: string[]
): void {
  const safeFilename = slugifyName(definition.name);
  const yamlPath = join(definition._sourceDir, `${safeFilename}.yaml`);
  if (!existsSync(yamlPath)) {
    throw new Error(`Preset '${definition.name}' not found at ${yamlPath}`);
  }

  const doc = YAML.parse(readFileSync(yamlPath, "utf-8")) as Record<
    string,
    unknown
  >;
  const plugins = Array.isArray(doc.plugins)
    ? (doc.plugins as { id: string; label?: string }[])
    : [];
  if (plugins.length === 0) {
    throw new Error(
      `Preset '${definition.name}' has no own plugins to reorder`
    );
  }

  // `order` must be exactly the preset's own slot IDs — same set, no missing,
  // extra, duplicate, or foreign entries. Reordering permutes; it must never
  // change which plugins the preset owns.
  const ownIds = plugins.map((p) => p.id);
  assertPermutation(definition.name, ownIds, order);

  // Build the permutation: position k draws from the source row whose slot ID
  // is `order[k]`. Apply it to BOTH arrays so `plugins[i]` and the
  // `fxChainFile` entry at `i` stay index-aligned.
  const sourceIndexById = new Map(ownIds.map((id, i) => [id, i] as const));
  const permutation = order.map((id) => sourceIndexById.get(id)!);

  doc.plugins = permutation.map((i) => plugins[i]);

  const fxChainRel =
    typeof doc.fxChainFile === "string"
      ? doc.fxChainFile
      : definition.fxChainFile;
  if (fxChainRel) {
    const fxChainAbs = resolve(definition._sourceDir, fxChainRel);
    if (existsSync(fxChainAbs)) {
      const chain = parsePresetFxChain(readFileSync(fxChainAbs, "utf-8"));
      // Reorder only when the chain is index-aligned with `plugins`. A length
      // mismatch means the files are out of sync (shouldn't happen) — leave the
      // chain untouched rather than reorder against a stale index.
      if (chain.length === plugins.length) {
        const reordered = permutation.map((i) => chain[i]);
        writeFileSync(fxChainAbs, serializePresetFxChain(reordered), "utf-8");
      }
    }
  }

  writeFileSync(yamlPath, YAML.stringify(doc), "utf-8");
}

/**
 * Assert that `order` is a permutation of `ownIds` — exactly the same set, with
 * no missing, extra, duplicate, or foreign entries. Guards a reorder, which
 * must change sequence only, never membership.
 */
function assertPermutation(
  presetName: string,
  ownIds: string[],
  order: string[]
): void {
  const ownSet = new Set(ownIds);
  const seen = new Set<string>();
  for (const id of order) {
    if (!ownSet.has(id)) {
      throw new Error(
        `Reorder of preset '${presetName}' references '${id}', which is not one of its own plugins`
      );
    }
    if (seen.has(id)) {
      throw new Error(
        `Reorder of preset '${presetName}' lists '${id}' more than once`
      );
    }
    seen.add(id);
  }
  if (order.length !== ownIds.length) {
    const missing = ownIds.filter((id) => !seen.has(id));
    throw new Error(
      `Reorder of preset '${presetName}' is missing own plugin(s): ${missing.join(", ")}`
    );
  }
}

/**
 * Edit a composed preset's composition fields — `imports`, `order`,
 * `deactivated`, `excluded` — in one shot. Preserves the preset's own
 * plugins, description, and any fields not passed in.
 *
 * Pass `undefined` to leave a field alone; pass an empty array to clear
 * it. The Lua UI typically sends the full new state of everything it
 * manages so this distinction rarely matters in practice.
 */
export function updateComposition(
  definition: LoadedPreset,
  fields: {
    imports?: string[];
    order?: string[];
    deactivated?: string[];
    excluded?: string[];
  }
): void {
  const safeFilename = slugifyName(definition.name);
  const yamlPath = join(definition._sourceDir, `${safeFilename}.yaml`);
  if (!existsSync(yamlPath)) {
    throw new Error(`Preset '${definition.name}' not found at ${yamlPath}`);
  }

  const doc = YAML.parse(readFileSync(yamlPath, "utf-8")) as Record<string, unknown>;

  applyCompositionField(doc, "imports", fields.imports);
  applyCompositionField(doc, "order", fields.order);
  applyCompositionField(doc, "deactivated", fields.deactivated);
  applyCompositionField(doc, "excluded", fields.excluded);

  writeFileSync(yamlPath, YAML.stringify(doc), "utf-8");
}

function applyCompositionField(
  doc: Record<string, unknown>,
  field: "imports" | "order" | "deactivated" | "excluded",
  value: string[] | undefined
): void {
  if (value === undefined) return;
  if (value.length === 0) {
    delete doc[field];
  } else {
    doc[field] = value;
  }
}

/**
 * Slugify a preset name for use as a filename. Mirrors what the bridge
 * already does in `savePreset` so the writer and the create path agree.
 */
function slugifyName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}
