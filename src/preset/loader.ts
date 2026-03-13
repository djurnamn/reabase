import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import YAML from "yaml";
import type { PresetDefinition } from "./types.js";

/**
 * Load all preset definitions from a .reabase/presets/ directory.
 * Reads all .yaml files and parses them as PresetDefinition objects.
 */
export function loadPresets(
  presetsDirectory: string
): Map<string, PresetDefinition> {
  const presets = new Map<string, PresetDefinition>();

  if (!existsSync(presetsDirectory)) {
    return presets;
  }

  const files = readdirSync(presetsDirectory).filter((f) =>
    f.endsWith(".yaml") || f.endsWith(".yml")
  );

  for (const file of files) {
    const filePath = join(presetsDirectory, file);
    const content = readFileSync(filePath, "utf-8");
    const parsed = YAML.parse(content) as PresetDefinition;

    if (!parsed.name) {
      throw new PresetLoadError(
        `Preset file ${file} is missing required 'name' field`
      );
    }
    if (!parsed.fxChainFile && !parsed.extends) {
      throw new PresetLoadError(
        `Preset '${parsed.name}' is missing required 'fxChainFile' field (required when not extending another preset)`
      );
    }
    if (presets.has(parsed.name)) {
      throw new PresetLoadError(
        `Duplicate preset name '${parsed.name}' in ${file}`
      );
    }

    // Validate: override/remove/add require extends
    if (!parsed.extends) {
      if (parsed.override) {
        throw new PresetLoadError(
          `Preset '${parsed.name}' has 'override' but does not extend another preset`
        );
      }
      if (parsed.remove) {
        throw new PresetLoadError(
          `Preset '${parsed.name}' has 'remove' but does not extend another preset`
        );
      }
      if (parsed.add) {
        throw new PresetLoadError(
          `Preset '${parsed.name}' has 'add' but does not extend another preset`
        );
      }
    }

    // Validate: add entries require fxChainFile
    if (parsed.add && parsed.add.length > 0 && !parsed.fxChainFile) {
      throw new PresetLoadError(
        `Preset '${parsed.name}' has 'add' entries but no 'fxChainFile' to source them from`
      );
    }

    // Validate: add entries must have an id
    if (parsed.add) {
      for (const entry of parsed.add) {
        if (!entry.id) {
          throw new PresetLoadError(
            `Preset '${parsed.name}' has an 'add' entry without an 'id'`
          );
        }
      }
    }

    // Validate: plugins entries must have an id
    if (parsed.plugins) {
      for (const entry of parsed.plugins) {
        if (!entry.id) {
          throw new PresetLoadError(
            `Preset '${parsed.name}' has a 'plugins' entry without an 'id'`
          );
        }
      }
    }

    presets.set(parsed.name, parsed);
  }

  // Validate inheritance references
  for (const [name, preset] of presets) {
    if (preset.extends && !presets.has(preset.extends)) {
      throw new PresetLoadError(
        `Preset '${name}' extends '${preset.extends}' which does not exist`
      );
    }
  }

  // Check for circular inheritance
  for (const [name] of presets) {
    detectCircularInheritance(name, presets);
  }

  return presets;
}

function detectCircularInheritance(
  name: string,
  presets: Map<string, PresetDefinition>
): void {
  const visited = new Set<string>();
  let current: string | undefined = name;

  while (current) {
    if (visited.has(current)) {
      throw new PresetLoadError(
        `Circular inheritance detected: ${[...visited, current].join(" -> ")}`
      );
    }
    visited.add(current);
    current = presets.get(current)?.extends;
  }
}

export class PresetLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PresetLoadError";
  }
}
