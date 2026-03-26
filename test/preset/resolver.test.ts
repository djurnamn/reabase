import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolvePreset } from "../../src/preset/resolver.js";
import type { PresetDefinition } from "../../src/preset/types.js";
import type { ParameterValue } from "../../src/snapshot/types.js";

let tempDir: string;

beforeEach(() => {
  tempDir = join(tmpdir(), `reabase-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(tempDir, "fx"), { recursive: true });
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

/** Write a JSON preset file with one plugin. */
function writePresetJson(
  filename: string,
  pluginName: string,
  parameters: Record<string, ParameterValue>,
  slotId?: string
): void {
  const plugin = {
    pluginName,
    pluginType: "AU",
    pluginParams: ["", "", 0, "", ""],
    slotId: slotId ?? "auto",
    parameters,
  };
  writeFileSync(join(tempDir, filename), JSON.stringify([plugin]), "utf-8");
}

/** Write a JSON parameter override file. */
function writeStateFile(filename: string, parameters: Record<string, ParameterValue>): void {
  writeFileSync(join(tempDir, filename), JSON.stringify(parameters), "utf-8");
}

const paramsA: Record<string, ParameterValue> = {
  "0": { name: "threshold", value: 0.5 },
};

const paramsB: Record<string, ParameterValue> = {
  "0": { name: "threshold", value: 0.8 },
};

const paramsC: Record<string, ParameterValue> = {
  "0": { name: "threshold", value: 0.3 },
};

const paramsLimiter: Record<string, ParameterValue> = {
  "0": { name: "ceiling", value: -1.0 },
};

const paramsLimiterOverride: Record<string, ParameterValue> = {
  "0": { name: "ceiling", value: -3.0 },
};

describe("resolvePreset", () => {
  it("resolves a simple preset with no inheritance", () => {
    writePresetJson("fx/voice.json", "AU: T-De-Esser 2 (Techivation)", paramsA);

    const presets = new Map<string, PresetDefinition>([
      ["player_voice", {
        name: "player_voice",
        fxChainFile: "fx/voice.json",
      }],
    ]);

    const resolved = resolvePreset("player_voice", presets, tempDir);
    expect(resolved.name).toBe("player_voice");
    expect(resolved.inheritanceChain).toEqual(["player_voice"]);
    expect(resolved.fxChain).toHaveLength(1);
    expect(resolved.fxChain[0].pluginName).toBe("AU: T-De-Esser 2 (Techivation)");
    expect(resolved.version).toBeTruthy();
    expect(resolved.version).toHaveLength(12);
  });

  it("resolves a preset with single-level inheritance and slot override", () => {
    writePresetJson("fx/voice.json", "AU: T-De-Esser 2 (Techivation)", paramsA, "t-de-esser-2");
    writeStateFile("fx/de-esser-male.json", paramsB);

    const presets = new Map<string, PresetDefinition>([
      ["player_voice", {
        name: "player_voice",
        fxChainFile: "fx/voice.json",
        plugins: [{ id: "de-esser" }],
      }],
      ["player_voice_male", {
        name: "player_voice_male",
        extends: "player_voice",
        override: {
          "de-esser": {
            stateFile: "fx/de-esser-male.json",
          },
        },
      }],
    ]);

    const resolved = resolvePreset("player_voice_male", presets, tempDir);
    expect(resolved.name).toBe("player_voice_male");
    expect(resolved.inheritanceChain).toEqual(["player_voice", "player_voice_male"]);
    expect(resolved.fxChain).toHaveLength(1);
    // The parameters should be overridden
    expect(resolved.fxChain[0].parameters).toEqual(paramsB);
  });

  it("produces different version hashes for different chains", () => {
    writePresetJson("fx/voice.json", "AU: T-De-Esser 2 (Techivation)", paramsA, "t-de-esser-2");
    writeStateFile("fx/de-esser-male.json", paramsB);

    const presets = new Map<string, PresetDefinition>([
      ["player_voice", {
        name: "player_voice",
        fxChainFile: "fx/voice.json",
        plugins: [{ id: "de-esser" }],
      }],
      ["player_voice_male", {
        name: "player_voice_male",
        extends: "player_voice",
        override: {
          "de-esser": {
            stateFile: "fx/de-esser-male.json",
          },
        },
      }],
    ]);

    const base = resolvePreset("player_voice", presets, tempDir);
    const male = resolvePreset("player_voice_male", presets, tempDir);

    expect(base.version).not.toBe(male.version);
  });

  it("resolves multi-level inheritance", () => {
    writePresetJson("fx/voice.json", "AU: T-De-Esser 2 (Techivation)", paramsA, "t-de-esser-2");
    writeStateFile("fx/de-esser-male.json", paramsB);
    writeStateFile("fx/de-esser-deep.json", paramsC);

    const presets = new Map<string, PresetDefinition>([
      ["voice_base", {
        name: "voice_base",
        fxChainFile: "fx/voice.json",
        plugins: [{ id: "de-esser" }],
      }],
      ["player_voice", {
        name: "player_voice",
        extends: "voice_base",
        override: {
          "de-esser": {
            stateFile: "fx/de-esser-male.json",
          },
        },
      }],
      ["player_voice_special", {
        name: "player_voice_special",
        extends: "player_voice",
        override: {
          "de-esser": {
            stateFile: "fx/de-esser-deep.json",
          },
        },
      }],
    ]);

    const resolved = resolvePreset("player_voice_special", presets, tempDir);
    expect(resolved.inheritanceChain).toEqual(["voice_base", "player_voice", "player_voice_special"]);
    // Final override wins
    expect(resolved.fxChain[0].parameters).toEqual(paramsC);
  });

  it("throws for unknown preset name", () => {
    const presets = new Map<string, PresetDefinition>();
    expect(() => resolvePreset("nope", presets, tempDir)).toThrow("not found");
  });

  it("preserves plugins without overrides", () => {
    // JSON preset with two plugins
    const plugins = [
      {
        pluginName: "AU: T-De-Esser 2 (Techivation)",
        pluginType: "AU",
        pluginParams: ["", "", 0, "", ""],
        slotId: "t-de-esser-2",
        parameters: paramsA,
      },
      {
        pluginName: "AU: kHs Limiter (Kilohearts)",
        pluginType: "AU",
        pluginParams: ["", "", 0, "", ""],
        slotId: "khs-limiter",
        parameters: paramsLimiter,
      },
    ];
    writeFileSync(join(tempDir, "fx/multi.json"), JSON.stringify(plugins), "utf-8");
    writeStateFile("fx/limiter-override.json", paramsLimiterOverride);

    const presets = new Map<string, PresetDefinition>([
      ["base", {
        name: "base",
        fxChainFile: "fx/multi.json",
        plugins: [{ id: "de-esser" }, { id: "limiter" }],
      }],
      ["variant", {
        name: "variant",
        extends: "base",
        override: {
          "limiter": {
            stateFile: "fx/limiter-override.json",
          },
        },
      }],
    ]);

    const resolved = resolvePreset("variant", presets, tempDir);
    expect(resolved.fxChain).toHaveLength(2);
    // De-Esser should be unchanged
    expect(resolved.fxChain[0].parameters).toEqual(paramsA);
    // Limiter should be overridden
    expect(resolved.fxChain[1].parameters).toEqual(paramsLimiterOverride);
  });

  it("appends child fxChainFile plugins after parent chain", () => {
    writePresetJson("fx/parent.json", "AU: T-De-Esser 2 (Techivation)", paramsA);
    writePresetJson("fx/child_additions.json", "AU: kHs Limiter (Kilohearts)", paramsLimiter);

    const presets = new Map<string, PresetDefinition>([
      ["parent", {
        name: "parent",
        fxChainFile: "fx/parent.json",
      }],
      ["child", {
        name: "child",
        extends: "parent",
        fxChainFile: "fx/child_additions.json",
      }],
    ]);

    const resolved = resolvePreset("child", presets, tempDir);
    expect(resolved.fxChain).toHaveLength(2);
    expect(resolved.fxChain[0].pluginName).toBe("AU: T-De-Esser 2 (Techivation)");
    expect(resolved.fxChain[1].pluginName).toBe("AU: kHs Limiter (Kilohearts)");
  });

  it("resolves child with extends but no fxChainFile (pure inheritance)", () => {
    writePresetJson("fx/parent.json", "AU: T-De-Esser 2 (Techivation)", paramsA);

    const presets = new Map<string, PresetDefinition>([
      ["parent", {
        name: "parent",
        fxChainFile: "fx/parent.json",
      }],
      ["child", {
        name: "child",
        extends: "parent",
      }],
    ]);

    const resolved = resolvePreset("child", presets, tempDir);
    expect(resolved.fxChain).toHaveLength(1);
    expect(resolved.fxChain[0].pluginName).toBe("AU: T-De-Esser 2 (Techivation)");
  });

  it("assigns slotIds from root plugins list", () => {
    writePresetJson("fx/voice.json", "AU: T-De-Esser 2 (Techivation)", paramsA);

    const presets = new Map<string, PresetDefinition>([
      ["player_voice", {
        name: "player_voice",
        fxChainFile: "fx/voice.json",
        plugins: [{ id: "de-esser" }],
      }],
    ]);

    const resolved = resolvePreset("player_voice", presets, tempDir);
    expect(resolved.fxChain[0].slotId).toBe("de-esser");
  });

  it("auto-generates slotIds when no plugins list", () => {
    writePresetJson("fx/voice.json", "AU: T-De-Esser 2 (Techivation)", paramsA);

    const presets = new Map<string, PresetDefinition>([
      ["player_voice", {
        name: "player_voice",
        fxChainFile: "fx/voice.json",
      }],
    ]);

    const resolved = resolvePreset("player_voice", presets, tempDir);
    expect(resolved.fxChain[0].slotId).toBe("t-de-esser-2");
  });

  it("applies slot-based override by slotId", () => {
    writePresetJson("fx/voice.json", "AU: T-De-Esser 2 (Techivation)", paramsA);
    writeStateFile("fx/de-esser-male.json", paramsB);

    const presets = new Map<string, PresetDefinition>([
      ["player_voice", {
        name: "player_voice",
        fxChainFile: "fx/voice.json",
        plugins: [{ id: "de-esser" }],
      }],
      ["player_voice_male", {
        name: "player_voice_male",
        extends: "player_voice",
        override: {
          "de-esser": {
            stateFile: "fx/de-esser-male.json",
          },
        },
      }],
    ]);

    const resolved = resolvePreset("player_voice_male", presets, tempDir);
    expect(resolved.fxChain[0].parameters).toEqual(paramsB);
    expect(resolved.fxChain[0].slotId).toBe("de-esser");
  });

  it("removes slots by slotId", () => {
    const plugins = [
      {
        pluginName: "AU: T-De-Esser 2 (Techivation)",
        pluginType: "AU",
        pluginParams: ["", "", 0, "", ""],
        slotId: "t-de-esser-2",
        parameters: paramsA,
      },
      {
        pluginName: "AU: kHs Limiter (Kilohearts)",
        pluginType: "AU",
        pluginParams: ["", "", 0, "", ""],
        slotId: "khs-limiter",
        parameters: paramsLimiter,
      },
    ];
    writeFileSync(join(tempDir, "fx/multi.json"), JSON.stringify(plugins), "utf-8");

    const presets = new Map<string, PresetDefinition>([
      ["base", {
        name: "base",
        fxChainFile: "fx/multi.json",
        plugins: [{ id: "de-esser" }, { id: "limiter" }],
      }],
      ["variant", {
        name: "variant",
        extends: "base",
        remove: ["limiter"],
      }],
    ]);

    const resolved = resolvePreset("variant", presets, tempDir);
    expect(resolved.fxChain).toHaveLength(1);
    expect(resolved.fxChain[0].slotId).toBe("de-esser");
  });

  it("adds slots with insertion point", () => {
    writePresetJson("fx/parent.json", "AU: T-De-Esser 2 (Techivation)", paramsA);
    writePresetJson("fx/child_add.json", "AU: kHs Limiter (Kilohearts)", paramsLimiter);

    const presets = new Map<string, PresetDefinition>([
      ["parent", {
        name: "parent",
        fxChainFile: "fx/parent.json",
        plugins: [{ id: "de-esser" }],
      }],
      ["child", {
        name: "child",
        extends: "parent",
        fxChainFile: "fx/child_add.json",
        add: [{ id: "limiter", after: "de-esser" }],
      }],
    ]);

    const resolved = resolvePreset("child", presets, tempDir);
    expect(resolved.fxChain).toHaveLength(2);
    expect(resolved.fxChain[0].slotId).toBe("de-esser");
    expect(resolved.fxChain[1].slotId).toBe("limiter");
    expect(resolved.fxChain[1].pluginName).toBe("AU: kHs Limiter (Kilohearts)");
  });

  it("sets origin to root preset for root plugins", () => {
    writePresetJson("fx/voice.json", "AU: T-De-Esser 2 (Techivation)", paramsA);

    const presets = new Map<string, PresetDefinition>([
      ["player_voice", {
        name: "player_voice",
        fxChainFile: "fx/voice.json",
      }],
    ]);

    const resolved = resolvePreset("player_voice", presets, tempDir);
    expect(resolved.fxChain[0].origin).toBe("player_voice");
  });

  it("sets origin to overriding preset for overridden plugins", () => {
    writePresetJson("fx/voice.json", "AU: T-De-Esser 2 (Techivation)", paramsA);
    writeStateFile("fx/de-esser-male.json", paramsB);

    const presets = new Map<string, PresetDefinition>([
      ["voice_base", {
        name: "voice_base",
        fxChainFile: "fx/voice.json",
        plugins: [{ id: "de-esser" }],
      }],
      ["player_voice", {
        name: "player_voice",
        extends: "voice_base",
        override: {
          "de-esser": {
            stateFile: "fx/de-esser-male.json",
          },
        },
      }],
    ]);

    const resolved = resolvePreset("player_voice", presets, tempDir);
    expect(resolved.fxChain[0].origin).toBe("player_voice");
  });

  it("preserves root origin for non-overridden plugins", () => {
    const plugins = [
      {
        pluginName: "AU: T-De-Esser 2 (Techivation)",
        pluginType: "AU",
        pluginParams: ["", "", 0, "", ""],
        slotId: "t-de-esser-2",
        parameters: paramsA,
      },
      {
        pluginName: "AU: kHs Limiter (Kilohearts)",
        pluginType: "AU",
        pluginParams: ["", "", 0, "", ""],
        slotId: "khs-limiter",
        parameters: paramsLimiter,
      },
    ];
    writeFileSync(join(tempDir, "fx/multi.json"), JSON.stringify(plugins), "utf-8");
    writeStateFile("fx/limiter-override.json", paramsLimiterOverride);

    const presets = new Map<string, PresetDefinition>([
      ["base", {
        name: "base",
        fxChainFile: "fx/multi.json",
        plugins: [{ id: "de-esser" }, { id: "limiter" }],
      }],
      ["variant", {
        name: "variant",
        extends: "base",
        override: {
          "limiter": {
            stateFile: "fx/limiter-override.json",
          },
        },
      }],
    ]);

    const resolved = resolvePreset("variant", presets, tempDir);
    expect(resolved.fxChain[0].origin).toBe("base");
    expect(resolved.fxChain[1].origin).toBe("variant");
  });

  it("sets origin to child for added plugins", () => {
    writePresetJson("fx/parent.json", "AU: T-De-Esser 2 (Techivation)", paramsA);
    writePresetJson("fx/child_add.json", "AU: kHs Limiter (Kilohearts)", paramsLimiter);

    const presets = new Map<string, PresetDefinition>([
      ["parent", {
        name: "parent",
        fxChainFile: "fx/parent.json",
        plugins: [{ id: "de-esser" }],
      }],
      ["child", {
        name: "child",
        extends: "parent",
        fxChainFile: "fx/child_add.json",
        add: [{ id: "limiter", after: "de-esser" }],
      }],
    ]);

    const resolved = resolvePreset("child", presets, tempDir);
    expect(resolved.fxChain[0].origin).toBe("parent");
    expect(resolved.fxChain[1].origin).toBe("child");
  });

  it("appends added slots at end when no after specified", () => {
    writePresetJson("fx/parent.json", "AU: T-De-Esser 2 (Techivation)", paramsA);
    writePresetJson("fx/child_add.json", "AU: kHs Limiter (Kilohearts)", paramsLimiter);

    const presets = new Map<string, PresetDefinition>([
      ["parent", {
        name: "parent",
        fxChainFile: "fx/parent.json",
        plugins: [{ id: "de-esser" }],
      }],
      ["child", {
        name: "child",
        extends: "parent",
        fxChainFile: "fx/child_add.json",
        add: [{ id: "limiter" }],
      }],
    ]);

    const resolved = resolvePreset("child", presets, tempDir);
    expect(resolved.fxChain).toHaveLength(2);
    expect(resolved.fxChain[0].slotId).toBe("de-esser");
    expect(resolved.fxChain[1].slotId).toBe("limiter");
  });
});
