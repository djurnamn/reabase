import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import YAML from "yaml";
import { updateChildPreset } from "../../src/preset/writer.js";
import { resolvePreset } from "../../src/preset/resolver.js";
import { loadPresets } from "../../src/preset/loader.js";
import type { PresetDefinition } from "../../src/preset/types.js";
import type { FxFingerprint, ParameterValue } from "../../src/snapshot/types.js";

let tempDir: string;

beforeEach(() => {
  tempDir = join(
    tmpdir(),
    `reabase-writer-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  mkdirSync(join(tempDir, "fx"), { recursive: true });
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

const params: Record<string, ParameterValue> = {
  "0": { name: "x", value: 0.5 },
};

function makeFp(slotId: string, hash: string = "h"): FxFingerprint {
  return {
    pluginName: `AU: ${slotId}`,
    pluginType: "AU",
    pluginParams: ["", "", 0, "", ""],
    slotId,
    parameters: params,
    stateHash: `hash_${hash}`,
  };
}

function writeParentPreset(slotIds: string[]): void {
  const plugins = slotIds.map((id) => ({
    pluginName: `AU: ${id}`,
    pluginType: "AU",
    pluginParams: ["", "", 0, "", ""],
    slotId: id,
    parameters: params,
  }));
  writeFileSync(
    join(tempDir, "fx/parent.json"),
    JSON.stringify(plugins),
    "utf-8"
  );
  writeFileSync(
    join(tempDir, "parent.yaml"),
    YAML.stringify({
      name: "parent",
      fxChainFile: "fx/parent.json",
      plugins: slotIds.map((id) => ({ id })),
    }),
    "utf-8"
  );
}

describe("updateChildPreset", () => {
  it("emits `before:` when an owned plugin sits ahead of all parent slots", () => {
    writeParentPreset(["parent_a"]);

    const childDefinition: PresetDefinition = {
      name: "child",
      extends: "parent",
    };
    const parentChain: FxFingerprint[] = [makeFp("parent_a")];
    // Track chain: child plugin appears BEFORE the parent slot.
    const fullChain: FxFingerprint[] = [makeFp("child_x"), makeFp("parent_a")];

    updateChildPreset(tempDir, childDefinition, parentChain, fullChain, [
      "child_x",
    ]);

    const yaml = YAML.parse(
      readFileSync(join(tempDir, "child.yaml"), "utf-8")
    );
    expect(yaml.add).toEqual([{ id: "child_x", before: "parent_a" }]);
  });

  it("emits `after:` when an owned plugin follows a parent slot", () => {
    writeParentPreset(["parent_a"]);

    const childDefinition: PresetDefinition = {
      name: "child",
      extends: "parent",
    };
    const parentChain: FxFingerprint[] = [makeFp("parent_a")];
    const fullChain: FxFingerprint[] = [makeFp("parent_a"), makeFp("child_x")];

    updateChildPreset(tempDir, childDefinition, parentChain, fullChain, [
      "child_x",
    ]);

    const yaml = YAML.parse(
      readFileSync(join(tempDir, "child.yaml"), "utf-8")
    );
    expect(yaml.add).toEqual([{ id: "child_x", after: "parent_a" }]);
  });

  it("anchors sibling additions to each other when clustered", () => {
    writeParentPreset(["parent_a"]);

    const parentChain: FxFingerprint[] = [makeFp("parent_a")];
    // Two child plugins both before the parent slot.
    const fullChain: FxFingerprint[] = [
      makeFp("child_x"),
      makeFp("child_y"),
      makeFp("parent_a"),
    ];

    updateChildPreset(
      tempDir,
      { name: "child", extends: "parent" },
      parentChain,
      fullChain,
      ["child_x", "child_y"]
    );

    const yaml = YAML.parse(
      readFileSync(join(tempDir, "child.yaml"), "utf-8")
    );
    expect(yaml.add).toEqual([
      { id: "child_x", before: "parent_a" },
      { id: "child_y", after: "child_x" },
    ]);
  });

  it("round-trips: writer output replayed by resolver reproduces the original chain", () => {
    // Parent: [parent_a, parent_b]
    // Track: [child_x, parent_a, child_y, parent_b, child_z]
    // Three children: one before any parent, one between, one at the end.
    writeParentPreset(["parent_a", "parent_b"]);

    // Child preset's fxChainFile must exist for the resolver to load
    // additions from. We pre-create it; updateChildPreset would normally
    // overwrite it.
    writeFileSync(
      join(tempDir, "fx/child.json"),
      JSON.stringify([
        {
          pluginName: "AU: child_x",
          pluginType: "AU",
          pluginParams: ["", "", 0, "", ""],
          slotId: "child_x",
          parameters: params,
        },
        {
          pluginName: "AU: child_y",
          pluginType: "AU",
          pluginParams: ["", "", 0, "", ""],
          slotId: "child_y",
          parameters: params,
        },
        {
          pluginName: "AU: child_z",
          pluginType: "AU",
          pluginParams: ["", "", 0, "", ""],
          slotId: "child_z",
          parameters: params,
        },
      ]),
      "utf-8"
    );

    const parentChain: FxFingerprint[] = [makeFp("parent_a"), makeFp("parent_b")];
    const fullChain: FxFingerprint[] = [
      makeFp("child_x"),
      makeFp("parent_a"),
      makeFp("child_y"),
      makeFp("parent_b"),
      makeFp("child_z"),
    ];

    updateChildPreset(
      tempDir,
      { name: "child", extends: "parent" },
      parentChain,
      fullChain,
      ["child_x", "child_y", "child_z"]
    );

    // Re-load presets from the YAML the writer just produced and resolve.
    const presets = loadPresets(tempDir);
    const resolved = resolvePreset("child", presets, tempDir);

    expect(resolved.fxChain.map((fx) => fx.slotId)).toEqual([
      "child_x",
      "parent_a",
      "child_y",
      "parent_b",
      "child_z",
    ]);
  });
});
