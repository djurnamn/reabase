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
