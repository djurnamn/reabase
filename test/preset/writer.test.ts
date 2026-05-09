import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import YAML from "yaml";
import { updatePresetOwnPlugins, updateComposition } from "../../src/preset/writer.js";
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
