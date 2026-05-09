import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import YAML from "yaml";
import type {
  PresetDefinition,
  LoadedPreset,
  CategoryInfo,
  PresetLoadResult,
} from "./types.js";

/** Filename reserved for folder-level category metadata. Any folder may
 *  drop one of these in to set its display label; absence is fine and the
 *  loader falls back to the folder name verbatim. */
const CATEGORY_FILENAME = "_category.yaml";

/**
 * Walk a `.reabase/presets/` tree, parsing every preset YAML and every
 * `_category.yaml`. Returns both maps together so callers (resolver,
 * writer, bridge) get everything from one pass.
 *
 * Validation enforced here (per-file shape):
 * - `name` is required and unique across the directory tree.
 * - The retired single-inheritance fields (`extends`, `override`, `add`,
 *   `remove`, `conflicts`) are rejected with a migration hint.
 * - `plugins` requires `fxChainFile` to source plugin data from. Each entry
 *   must have a string `id` and an optional string `label`. IDs are unique
 *   within a `plugins` list.
 * - `imports` is an array of strings, no duplicates, no self-reference.
 * - `order`, `deactivated`, `excluded` entries must be "<source>/<slot>"
 *   with both sides non-empty; duplicates within a list are rejected.
 *
 * After all files are read, cross-preset validation runs:
 * - Every name in `imports` must resolve to a loaded preset.
 * - Imported presets must themselves have no `imports` (nesting disallowed).
 *
 * Slot-level semantic checks (every order/deactivated/excluded entry
 * references a real slot, no slot appears in two sources) live in the
 * resolver — they need `fxChainFile` contents loaded anyway.
 */
export function loadPresets(presetsDirectory: string): PresetLoadResult {
  const presets = new Map<string, LoadedPreset>();
  const categories = new Map<string, CategoryInfo>();

  if (!existsSync(presetsDirectory)) {
    return { presets, categories };
  }

  const rootAbs = resolve(presetsDirectory);
  walkAndLoad(rootAbs, rootAbs, presets, categories);
  validateImportReferences(presets);

  return { presets, categories };
}

function walkAndLoad(
  root: string,
  current: string,
  presets: Map<string, LoadedPreset>,
  categories: Map<string, CategoryInfo>
): void {
  const entries = readdirSync(current, { withFileTypes: true });

  // First, harvest the category metadata for *this* folder if present.
  // Doing it before recursion means the slug → label mapping is in place
  // when nested folders are walked, but the order doesn't actually matter
  // since the maps are flat by slug.
  const slug = categorySlug(root, current);
  let categoryLabel: string | undefined;
  for (const entry of entries) {
    if (entry.isFile() && entry.name === CATEGORY_FILENAME) {
      const parsed = YAML.parse(
        readFileSync(join(current, entry.name), "utf-8")
      ) as Record<string, unknown> | null;
      if (parsed && typeof parsed.label === "string" && parsed.label.length > 0) {
        categoryLabel = parsed.label;
      }
      break;
    }
  }

  let folderHasPresets = false;

  for (const entry of entries) {
    const childPath = join(current, entry.name);

    if (entry.isDirectory()) {
      walkAndLoad(root, childPath, presets, categories);
      continue;
    }
    if (!entry.isFile()) continue;
    if (entry.name === CATEGORY_FILENAME) continue;
    if (!entry.name.endsWith(".yaml") && !entry.name.endsWith(".yml")) continue;

    const content = readFileSync(childPath, "utf-8");
    const parsed = YAML.parse(content) as Record<string, unknown>;

    validatePresetShape(parsed, entry.name);

    const definition = parsed as unknown as PresetDefinition;

    if (presets.has(definition.name)) {
      throw new PresetLoadError(
        `Duplicate preset name '${definition.name}' (${childPath} collides with another preset of the same name)`
      );
    }

    presets.set(definition.name, {
      ...definition,
      _sourceDir: current,
      _categorySlug: slug,
    });
    folderHasPresets = true;
  }

  // Record this folder's category iff it contains presets, OR we explicitly
  // found a label for it. Empty intermediate folders get no entry — they
  // only matter as path components.
  if (folderHasPresets || categoryLabel !== undefined) {
    if (!categories.has(slug)) {
      categories.set(slug, {
        slug,
        label: categoryLabel ?? folderName(current, root),
      });
    } else if (categoryLabel !== undefined) {
      // Folder already had presets registered before we got to its
      // _category.yaml — overwrite the fallback label with the explicit one.
      categories.set(slug, { slug, label: categoryLabel });
    }
  }
}

function categorySlug(root: string, dir: string): string {
  const rel = relative(root, dir);
  if (rel === "" || rel === ".") return "";
  // POSIX-style slug regardless of platform separator. Categories are
  // user-facing strings; backslashes in slugs would surprise on macOS/Linux
  // and round-trip oddly through JSON.
  return rel.split(/[\\/]/).join("/");
}

function folderName(dir: string, root: string): string {
  if (resolve(dir) === resolve(root)) return "";
  return dir.split(/[\\/]/).filter(Boolean).pop() ?? "";
}

function validatePresetShape(
  parsed: Record<string, unknown>,
  filename: string
): void {
  if (typeof parsed.name !== "string" || parsed.name.length === 0) {
    throw new PresetLoadError(
      `Preset file ${filename} is missing required 'name' field`
    );
  }
  const name = parsed.name;

  rejectRetiredField(parsed, "extends", name);
  rejectRetiredField(parsed, "override", name);
  rejectRetiredField(parsed, "add", name);
  rejectRetiredField(parsed, "remove", name);
  rejectRetiredField(parsed, "conflicts", name);

  validatePlugins(parsed, name);
  validateImports(parsed, name);
  validateSlotRefList(parsed, "order", name);
  validateSlotRefList(parsed, "deactivated", name);
  validateSlotRefList(parsed, "excluded", name);

  if (
    parsed.fxChainFile !== undefined &&
    typeof parsed.fxChainFile !== "string"
  ) {
    throw new PresetLoadError(
      `Preset '${name}' has invalid 'fxChainFile' — expected a string path`
    );
  }
}

function validatePlugins(
  parsed: Record<string, unknown>,
  presetName: string
): void {
  if (parsed.plugins === undefined) return;

  if (!Array.isArray(parsed.plugins)) {
    throw new PresetLoadError(
      `Preset '${presetName}' has invalid 'plugins' field — expected an array`
    );
  }

  const seenIds = new Set<string>();
  for (const entry of parsed.plugins) {
    if (!entry || typeof entry !== "object") {
      throw new PresetLoadError(
        `Preset '${presetName}' has a 'plugins' entry that is not an object`
      );
    }
    const e = entry as { id?: unknown; label?: unknown };
    if (typeof e.id !== "string" || e.id.length === 0) {
      throw new PresetLoadError(
        `Preset '${presetName}' has a 'plugins' entry without a string 'id'`
      );
    }
    if (e.label !== undefined && typeof e.label !== "string") {
      throw new PresetLoadError(
        `Preset '${presetName}' has a 'plugins' entry with non-string 'label' for id '${e.id}'`
      );
    }
    if (seenIds.has(e.id)) {
      throw new PresetLoadError(
        `Preset '${presetName}' has duplicate plugin id '${e.id}' in 'plugins'`
      );
    }
    seenIds.add(e.id);
  }

  if (typeof parsed.fxChainFile !== "string") {
    throw new PresetLoadError(
      `Preset '${presetName}' has 'plugins' but no 'fxChainFile' to source them from`
    );
  }
}

function validateImports(
  parsed: Record<string, unknown>,
  presetName: string
): void {
  if (parsed.imports === undefined) return;

  if (!Array.isArray(parsed.imports)) {
    throw new PresetLoadError(
      `Preset '${presetName}' has invalid 'imports' — expected an array of preset names`
    );
  }
  const seen = new Set<string>();
  for (const importName of parsed.imports) {
    if (typeof importName !== "string" || importName.length === 0) {
      throw new PresetLoadError(
        `Preset '${presetName}' has a non-string entry in 'imports'`
      );
    }
    if (importName === presetName) {
      throw new PresetLoadError(
        `Preset '${presetName}' imports itself`
      );
    }
    if (seen.has(importName)) {
      throw new PresetLoadError(
        `Preset '${presetName}' lists '${importName}' in 'imports' twice`
      );
    }
    seen.add(importName);
  }
}

function validateSlotRefList(
  parsed: Record<string, unknown>,
  field: "order" | "deactivated" | "excluded",
  presetName: string
): void {
  const value = parsed[field];
  if (value === undefined) return;

  if (!Array.isArray(value)) {
    throw new PresetLoadError(
      `Preset '${presetName}' has invalid '${field}' — expected an array of "<sourceName>/<slotId>" entries`
    );
  }
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string") {
      throw new PresetLoadError(
        `Preset '${presetName}' has a non-string entry in '${field}'`
      );
    }
    const slashIndex = entry.indexOf("/");
    if (slashIndex <= 0 || slashIndex === entry.length - 1) {
      throw new PresetLoadError(
        `Preset '${presetName}' has malformed '${field}' entry '${entry}' — expected "<sourceName>/<slotId>"`
      );
    }
    if (seen.has(entry)) {
      throw new PresetLoadError(
        `Preset '${presetName}' has duplicate '${field}' entry '${entry}'`
      );
    }
    seen.add(entry);
  }
}

function rejectRetiredField(
  parsed: Record<string, unknown>,
  field: "extends" | "override" | "add" | "remove" | "conflicts",
  presetName: string
): void {
  if (parsed[field] === undefined) return;
  throw new PresetLoadError(
    `Preset '${presetName}' uses retired field '${field}'. ` +
      `Single inheritance has been replaced by composition — use 'imports', ` +
      `'order', 'deactivated', and 'excluded' instead. Same-slot-ID across ` +
      `imports is no longer resolved automatically; rename one source's slot.`
  );
}

function validateImportReferences(
  presets: Map<string, LoadedPreset>
): void {
  for (const [name, preset] of presets) {
    if (!preset.imports) continue;
    for (const importName of preset.imports) {
      const importedDef = presets.get(importName);
      if (!importedDef) {
        throw new PresetLoadError(
          `Preset '${name}' imports '${importName}' which does not exist`
        );
      }
      if (importedDef.imports && importedDef.imports.length > 0) {
        throw new PresetLoadError(
          `Preset '${name}' imports '${importName}', but '${importName}' itself has 'imports' ` +
            `— nesting is disallowed. Refactor '${importName}' into plain mixins, or duplicate it.`
        );
      }
    }
  }
}

export class PresetLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PresetLoadError";
  }
}
