import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import YAML from "yaml";
import { updatePresetOwnPlugins, updateComposition, deletePresetOwnPlugin, reorderPresetOwnPlugins } from "../../src/preset/writer.js";
import { loadPresets } from "../../src/preset/loader.js";
import { resolvePreset } from "../../src/preset/resolver.js";
import type { PresetDefinition, LoadedPreset } from "../../src/preset/types.js";
import type { FxFingerprint, ParameterValue } from "../../src/snapshot/types.js";

let tempDir: string;

beforeEach(() => {
  tempDir = join(tmpdir(), `reabase-writer-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(tempDir, "fx"), { recursive: true });
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

const params: Record<string, ParameterValue> = { "0": { name: "x", value: 0.5 } };

function lp(def: PresetDefinition): LoadedPreset {
  return { ...def, _sourceDir: tempDir, _categorySlug: "" };
}

function makeFp(slotId: string, displayName?: string): FxFingerprint {
  return {
    pluginName: `AU: ${slotId}`,
    pluginType: "AU",
    pluginParams: ["", "", 0, "", ""],
    slotId,
    parameters: params,
    stateHash: `hash_${slotId}`,
    ...(displayName ? { displayName } : {}),
  };
}

describe("updatePresetOwnPlugins", () => {
  it("writes a fresh plain preset's plugins + fxChainFile", () => {
    updatePresetOwnPlugins(
      lp({ name: "voice" }),
      [makeFp("khs-compressor"), makeFp("khs-limiter")]
    );

    const yaml = YAML.parse(readFileSync(join(tempDir, "voice.yaml"), "utf-8"));
    expect(yaml.name).toBe("voice");
    expect(yaml.fxChainFile).toBe("fx/voice.json");
    expect(yaml.plugins).toEqual([{ id: "khs-compressor" }, { id: "khs-limiter" }]);
    expect(existsSync(join(tempDir, "fx/voice.json"))).toBe(true);
  });

  it("propagates displayName onto plugins[].label", () => {
    updatePresetOwnPlugins(
      lp({ name: "voice" }),
      [makeFp("khs-filter", "Aggressive low-cut"), makeFp("khs-filter-2", "High shelf boost")]
    );

    const yaml = YAML.parse(readFileSync(join(tempDir, "voice.yaml"), "utf-8"));
    expect(yaml.plugins).toEqual([
      { id: "khs-filter", label: "Aggressive low-cut" },
      { id: "khs-filter-2", label: "High shelf boost" },
    ]);
  });

  it("preserves composition fields when rewriting an existing composed preset", () => {
    writeFileSync(
      join(tempDir, "voice_character_female.yaml"),
      YAML.stringify({
        name: "voice.character.female",
        description: "voice + character + female",
        imports: ["voice", "role.character", "gender.female"],
        order: ["voice/khs-compressor", "voice.character.female/khs-tilt"],
        deactivated: ["role.character/totape9"],
        excluded: ["gender.female/t-de-esser-2"],
      }),
      "utf-8"
    );

    updatePresetOwnPlugins(
      lp({
        name: "voice.character.female",
        imports: ["voice", "role.character", "gender.female"],
      }),
      [makeFp("khs-tilt", "Subtle tilt")]
    );

    const yaml = YAML.parse(
      readFileSync(join(tempDir, "voice_character_female.yaml"), "utf-8")
    );
    expect(yaml.imports).toEqual(["voice", "role.character", "gender.female"]);
    expect(yaml.order).toEqual([
      "voice/khs-compressor",
      "voice.character.female/khs-tilt",
    ]);
    expect(yaml.deactivated).toEqual(["role.character/totape9"]);
    expect(yaml.excluded).toEqual(["gender.female/t-de-esser-2"]);
    expect(yaml.description).toBe("voice + character + female");
    expect(yaml.plugins).toEqual([{ id: "khs-tilt", label: "Subtle tilt" }]);
    expect(yaml.fxChainFile).toBe("fx/voice_character_female.json");
  });

  it("drops fxChainFile + plugins when ownedFingerprints is empty", () => {
    writeFileSync(
      join(tempDir, "voice.yaml"),
      YAML.stringify({
        name: "voice",
        fxChainFile: "fx/voice.json",
        plugins: [{ id: "khs-compressor" }],
        imports: ["base"],
      }),
      "utf-8"
    );

    updatePresetOwnPlugins(
      lp({
        name: "voice",
        imports: ["base"],
        fxChainFile: "fx/voice.json",
        plugins: [{ id: "khs-compressor" }],
      }),
      []
    );

    const yaml = YAML.parse(readFileSync(join(tempDir, "voice.yaml"), "utf-8"));
    expect(yaml.plugins).toBeUndefined();
    expect(yaml.fxChainFile).toBeUndefined();
    expect(yaml.imports).toEqual(["base"]);
  });

  it("round-trips through loader+resolver", () => {
    updatePresetOwnPlugins(
      lp({ name: "voice" }),
      [
        makeFp("khs-compressor", "Comp"),
        makeFp("khs-limiter"),
      ]
    );

    const { presets } = loadPresets(tempDir);
    const resolved = resolvePreset("voice", presets);
    expect(resolved.fxChain.map((fx) => fx.slotId)).toEqual([
      "khs-compressor",
      "khs-limiter",
    ]);
    expect(resolved.fxChain[0].displayName).toBe("Comp");
    expect(resolved.fxChain[1].displayName).toBeUndefined();
  });
});

describe("reorderPresetOwnPlugins", () => {
  /** Write a plain preset YAML (with an explicit plugins id/label list) + an
   *  index-aligned fxChainFile. Each chain entry carries a distinct param so we
   *  can prove the JSON was permuted, not just the YAML. */
  function writePreset(
    name: string,
    plugins: { id: string; label?: string }[]
  ): void {
    const safe = name.replace(/[^a-z0-9]+/g, "_");
    writeFileSync(
      join(tempDir, `${safe}.yaml`),
      YAML.stringify({
        name,
        fxChainFile: `fx/${safe}.json`,
        plugins,
      }),
      "utf-8"
    );
    writeFileSync(
      join(tempDir, `fx/${safe}.json`),
      JSON.stringify(
        plugins.map((p, i) => ({
          pluginName: `AU: ${p.id}`,
          pluginType: "AU",
          pluginParams: ["", "", 0, "", ""],
          slotId: p.id,
          parameters: { "0": { name: "marker", value: i } },
        })),
        null,
        2
      ),
      "utf-8"
    );
  }

  function readYaml(name: string): Record<string, unknown> {
    const safe = name.replace(/[^a-z0-9]+/g, "_");
    return YAML.parse(readFileSync(join(tempDir, `${safe}.yaml`), "utf-8"));
  }

  function readChain(name: string): { slotId: string; parameters: Record<string, ParameterValue> }[] {
    const safe = name.replace(/[^a-z0-9]+/g, "_");
    return JSON.parse(readFileSync(join(tempDir, `fx/${safe}.json`), "utf-8"));
  }

  it("permutes plugins and the index-aligned fxChainFile consistently", () => {
    writePreset("voice", [{ id: "a" }, { id: "b" }, { id: "c" }]);
    const { presets } = loadPresets(tempDir);

    reorderPresetOwnPlugins(presets.get("voice")!, ["c", "a", "b"]);

    expect(readYaml("voice").plugins).toEqual([
      { id: "c" },
      { id: "a" },
      { id: "b" },
    ]);
    // The fxChainFile entry at each index moved with its plugin — the `marker`
    // param (0=a, 1=b, 2=c originally) proves the JSON rows were permuted, not
    // just relabelled.
    const chain = readChain("voice");
    expect(chain.map((p) => p.slotId)).toEqual(["c", "a", "b"]);
    expect(chain.map((p) => p.parameters["0"].value)).toEqual([2, 0, 1]);
  });

  it("preserves labels on the moved plugins", () => {
    writePreset("voice", [
      { id: "a", label: "Comp" },
      { id: "b", label: "Limiter" },
    ]);
    const { presets } = loadPresets(tempDir);

    reorderPresetOwnPlugins(presets.get("voice")!, ["b", "a"]);

    expect(readYaml("voice").plugins).toEqual([
      { id: "b", label: "Limiter" },
      { id: "a", label: "Comp" },
    ]);
  });

  it("round-trips through loader+resolver in the new order", () => {
    writePreset("voice", [{ id: "a" }, { id: "b" }, { id: "c" }]);
    reorderPresetOwnPlugins(loadPresets(tempDir).presets.get("voice")!, [
      "b",
      "c",
      "a",
    ]);

    const { presets } = loadPresets(tempDir);
    const resolved = resolvePreset("voice", presets);
    expect(resolved.fxChain.map((fx) => fx.slotId)).toEqual(["b", "c", "a"]);
  });

  it("leaves composition fields untouched", () => {
    const safe = "voice";
    writeFileSync(
      join(tempDir, `${safe}.yaml`),
      YAML.stringify({
        name: "voice",
        fxChainFile: `fx/${safe}.json`,
        plugins: [{ id: "a" }, { id: "b" }],
        order: ["voice/a", "voice/b"],
        deactivated: ["voice/b"],
      }),
      "utf-8"
    );
    writeFileSync(
      join(tempDir, `fx/${safe}.json`),
      JSON.stringify(
        ["a", "b"].map((id) => ({
          pluginName: `AU: ${id}`,
          pluginType: "AU",
          pluginParams: ["", "", 0, "", ""],
          slotId: id,
          parameters: params,
        })),
        null,
        2
      ),
      "utf-8"
    );

    reorderPresetOwnPlugins(loadPresets(tempDir).presets.get("voice")!, ["b", "a"]);

    const yaml = readYaml("voice");
    expect(yaml.plugins).toEqual([{ id: "b" }, { id: "a" }]);
    // The preset's OWN order/deactivated lists are verbatim — reorder only
    // touches the plugins list + fxChainFile, never the composition fields.
    expect(yaml.order).toEqual(["voice/a", "voice/b"]);
    expect(yaml.deactivated).toEqual(["voice/b"]);
  });

  it("throws when order omits an own plugin", () => {
    writePreset("voice", [{ id: "a" }, { id: "b" }, { id: "c" }]);
    const { presets } = loadPresets(tempDir);

    expect(() =>
      reorderPresetOwnPlugins(presets.get("voice")!, ["a", "b"])
    ).toThrow(/missing own plugin\(s\): c/);
  });

  it("throws when order references a foreign slot", () => {
    writePreset("voice", [{ id: "a" }, { id: "b" }]);
    const { presets } = loadPresets(tempDir);

    expect(() =>
      reorderPresetOwnPlugins(presets.get("voice")!, ["a", "nope"])
    ).toThrow(/'nope', which is not one of its own plugins/);
  });

  it("throws when order duplicates a slot", () => {
    writePreset("voice", [{ id: "a" }, { id: "b" }]);
    const { presets } = loadPresets(tempDir);

    expect(() =>
      reorderPresetOwnPlugins(presets.get("voice")!, ["a", "a"])
    ).toThrow(/lists 'a' more than once/);
  });

  it("throws when the preset has no own plugins", () => {
    writeFileSync(
      join(tempDir, "comp.yaml"),
      YAML.stringify({ name: "comp" }),
      "utf-8"
    );
    const { presets } = loadPresets(tempDir);

    expect(() =>
      reorderPresetOwnPlugins(presets.get("comp")!, [])
    ).toThrow(/has no own plugins to reorder/);
  });
});

describe("updateComposition", () => {
  function setupPlainPresets(): void {
    writeFileSync(
      join(tempDir, "voice.yaml"),
      YAML.stringify({
        name: "voice",
        fxChainFile: "fx/voice.json",
        plugins: [{ id: "khs-compressor" }],
      }),
      "utf-8"
    );
    writeFileSync(
      join(tempDir, "fx/voice.json"),
      JSON.stringify([
        {
          pluginName: "AU: kHs Compressor (Kilohearts)",
          pluginType: "AU",
          pluginParams: ["", "", 0, "", ""],
          slotId: "khs-compressor",
          parameters: params,
        },
      ]),
      "utf-8"
    );
    writeFileSync(
      join(tempDir, "extra.yaml"),
      YAML.stringify({
        name: "extra",
        fxChainFile: "fx/extra.json",
        plugins: [{ id: "khs-limiter" }],
      }),
      "utf-8"
    );
    writeFileSync(
      join(tempDir, "fx/extra.json"),
      JSON.stringify([
        {
          pluginName: "AU: kHs Limiter (Kilohearts)",
          pluginType: "AU",
          pluginParams: ["", "", 0, "", ""],
          slotId: "khs-limiter",
          parameters: params,
        },
      ]),
      "utf-8"
    );
    writeFileSync(
      join(tempDir, "composed.yaml"),
      YAML.stringify({
        name: "composed",
        imports: ["voice"],
      }),
      "utf-8"
    );
  }

  it("adds an import to a composed preset", () => {
    setupPlainPresets();
    const { presets } = loadPresets(tempDir);

    updateComposition(presets.get("composed")!, { imports: ["voice", "extra"] });

    const yaml = YAML.parse(readFileSync(join(tempDir, "composed.yaml"), "utf-8"));
    expect(yaml.imports).toEqual(["voice", "extra"]);
  });

  it("sets order, deactivated, and excluded in one shot", () => {
    setupPlainPresets();
    const { presets } = loadPresets(tempDir);

    updateComposition(presets.get("composed")!, {
      order: ["voice/khs-compressor"],
      deactivated: ["voice/khs-compressor"],
      excluded: [],
    });

    const yaml = YAML.parse(readFileSync(join(tempDir, "composed.yaml"), "utf-8"));
    expect(yaml.order).toEqual(["voice/khs-compressor"]);
    expect(yaml.deactivated).toEqual(["voice/khs-compressor"]);
    expect(yaml.excluded).toBeUndefined();
  });

  it("leaves untouched fields alone when undefined is passed", () => {
    setupPlainPresets();
    const first = loadPresets(tempDir).presets;

    updateComposition(first.get("composed")!, {
      imports: ["voice", "extra"],
      excluded: ["voice/khs-compressor"],
    });

    // Reload after the first edit so the second call sees the updated YAML.
    const second = loadPresets(tempDir).presets;
    updateComposition(second.get("composed")!, { excluded: [] });

    const yaml = YAML.parse(readFileSync(join(tempDir, "composed.yaml"), "utf-8"));
    expect(yaml.imports).toEqual(["voice", "extra"]);
    expect(yaml.excluded).toBeUndefined();
  });

  it("throws when invoked with a definition whose YAML went missing", () => {
    setupPlainPresets();
    const { presets } = loadPresets(tempDir);
    const composed = presets.get("composed")!;

    // Simulate the YAML disappearing between load and update — surfaces as
    // a clear error rather than silently re-creating the file.
    rmSync(join(tempDir, "composed.yaml"));

    expect(() =>
      updateComposition(composed, { imports: ["voice"] })
    ).toThrow(/Preset 'composed' not found/);
  });
});

describe("deletePresetOwnPlugin", () => {
  /** Write a plain preset YAML + an index-aligned fxChainFile for `slotIds`. */
  function writePreset(name: string, slotIds: string[]): void {
    const safe = name.replace(/[^a-z0-9]+/g, "_");
    writeFileSync(
      join(tempDir, `${safe}.yaml`),
      YAML.stringify({
        name,
        fxChainFile: `fx/${safe}.json`,
        plugins: slotIds.map((id) => ({ id })),
      }),
      "utf-8"
    );
    writeFileSync(
      join(tempDir, `fx/${safe}.json`),
      JSON.stringify(
        slotIds.map((id) => ({
          pluginName: `AU: ${id}`,
          pluginType: "AU",
          pluginParams: ["", "", 0, "", ""],
          slotId: id,
          parameters: params,
        })),
        null,
        2
      ),
      "utf-8"
    );
  }

  function readChainSlotIds(name: string): string[] {
    const safe = name.replace(/[^a-z0-9]+/g, "_");
    const chain = JSON.parse(
      readFileSync(join(tempDir, `fx/${safe}.json`), "utf-8")
    ) as { slotId: string }[];
    return chain.map((p) => p.slotId);
  }

  it("removes the slot from plugins and the index-aligned fxChainFile entry", () => {
    writePreset("voice", ["a", "b", "c"]);
    const { presets } = loadPresets(tempDir);

    deletePresetOwnPlugin(presets.get("voice")!, "b");

    const yaml = YAML.parse(readFileSync(join(tempDir, "voice.yaml"), "utf-8"));
    expect(yaml.plugins).toEqual([{ id: "a" }, { id: "c" }]);
    expect(yaml.fxChainFile).toBe("fx/voice.json");
    // The fxChainFile stays index-aligned — the matching entry is gone too.
    expect(readChainSlotIds("voice")).toEqual(["a", "c"]);
  });

  it("drops plugins + fxChainFile when removing the last own plugin", () => {
    writePreset("solo", ["only"]);
    const { presets } = loadPresets(tempDir);

    deletePresetOwnPlugin(presets.get("solo")!, "only");

    const yaml = YAML.parse(readFileSync(join(tempDir, "solo.yaml"), "utf-8"));
    expect(yaml.plugins).toBeUndefined();
    expect(yaml.fxChainFile).toBeUndefined();
    expect(yaml.name).toBe("solo");
  });

  it("preserves composition fields and other plugins (does not scrub refs)", () => {
    writeFileSync(
      join(tempDir, "voice.yaml"),
      YAML.stringify({
        name: "voice",
        fxChainFile: "fx/voice.json",
        plugins: [{ id: "a" }, { id: "b" }],
        imports: ["base"],
        order: ["voice/a", "voice/b"],
        deactivated: ["voice/b"],
      }),
      "utf-8"
    );
    writeFileSync(
      join(tempDir, "fx/voice.json"),
      JSON.stringify(
        ["a", "b"].map((id) => ({
          pluginName: `AU: ${id}`,
          pluginType: "AU",
          pluginParams: ["", "", 0, "", ""],
          slotId: id,
          parameters: params,
        })),
        null,
        2
      ),
      "utf-8"
    );
    // base import so loadPresets doesn't reject the dangling import.
    writeFileSync(
      join(tempDir, "base.yaml"),
      YAML.stringify({ name: "base" }),
      "utf-8"
    );

    const { presets } = loadPresets(tempDir);
    deletePresetOwnPlugin(presets.get("voice")!, "b");

    const yaml = YAML.parse(readFileSync(join(tempDir, "voice.yaml"), "utf-8"));
    expect(yaml.plugins).toEqual([{ id: "a" }]);
    // The writer leaves composition refs verbatim — scrubbing is the bridge's
    // job. The now-dangling voice/b refs stay until then.
    expect(yaml.imports).toEqual(["base"]);
    expect(yaml.order).toEqual(["voice/a", "voice/b"]);
    expect(yaml.deactivated).toEqual(["voice/b"]);
  });

  it("throws when the slot is not one of the preset's own plugins", () => {
    writePreset("voice", ["a", "b"]);
    const { presets } = loadPresets(tempDir);

    expect(() =>
      deletePresetOwnPlugin(presets.get("voice")!, "nope")
    ).toThrow(/not one of preset 'voice's own plugins/);
  });

  it("round-trips: the resolved chain loses the slot", () => {
    writePreset("voice", ["a", "b", "c"]);
    deletePresetOwnPlugin(loadPresets(tempDir).presets.get("voice")!, "b");

    const { presets } = loadPresets(tempDir);
    const resolved = resolvePreset("voice", presets);
    expect(resolved.fxChain.map((fx) => fx.slotId)).toEqual(["a", "c"]);
  });
});
