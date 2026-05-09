import { join, resolve } from "node:path";
import { mkdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import YAML from "yaml";
import type { LoadedPreset } from "./types.js";
import type { FxFingerprint } from "../snapshot/types.js";
import { serializePresetFxChain } from "./rfxchain.js";

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
