import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import YAML from "yaml";

const DEFAULT_CONFIG = {
  version: 1,
};

/**
 * Initialize a .reabase/ directory at the given path.
 */
export function init(targetDirectory: string): { reabasePath: string } {
  const reabasePath = resolve(targetDirectory, ".reabase");

  if (existsSync(reabasePath)) {
    throw new Error(
      `.reabase/ already exists at ${reabasePath}. Nothing to initialize.`
    );
  }

  mkdirSync(join(reabasePath, "presets", "fx"), { recursive: true });
  mkdirSync(join(reabasePath, "snapshots"), { recursive: true });

  writeFileSync(
    join(reabasePath, "config.yaml"),
    YAML.stringify(DEFAULT_CONFIG),
    "utf-8"
  );

  return { reabasePath };
}
