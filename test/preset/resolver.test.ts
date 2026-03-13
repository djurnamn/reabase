import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolvePreset } from "../../src/preset/resolver.js";
import type { PresetDefinition } from "../../src/preset/types.js";

let tempDir: string;

beforeEach(() => {
  tempDir = join(tmpdir(), `reabase-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(tempDir, "fx"), { recursive: true });
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

/** Write a minimal RfxChain file with one plugin.
 *  State blobs must look like base64 (contain non-alpha chars like = or /)
 *  so the parser treats them as raw lines rather than structs.
 */
function writeRfxChain(filename: string, pluginName: string, stateBlob: string): void {
  const content = [
    "BYPASS 0 0 0",
    `<AU "${pluginName}" "" "" 0 "" ""`,
    `  ${stateBlob}`,
    ">",
    "FLOATPOS 0 0 0 0",
    "FXID {00000000-0000-0000-0000-000000000000}",
    "WAK 0 0",
  ].join("\n");
  writeFileSync(join(tempDir, filename), content, "utf-8");
}

function writeStateFile(filename: string, stateBlob: string): void {
  writeFileSync(join(tempDir, filename), stateBlob, "utf-8");
}

describe("resolvePreset", () => {
  it("resolves a simple preset with no inheritance", () => {
    writeRfxChain("fx/voice.rfxchain", "AU: T-De-Esser 2 (Techivation)", "AAAA/AA==");

    const presets = new Map<string, PresetDefinition>([
      ["player_voice", {
        name: "player_voice",
        fxChainFile: "fx/voice.rfxchain",
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

  it("resolves a preset with single-level inheritance", () => {
    writeRfxChain("fx/voice.rfxchain", "AU: T-De-Esser 2 (Techivation)", "AAAA/AA==");
    writeStateFile("fx/de-esser-male.state", "BBBB/BB==");

    const presets = new Map<string, PresetDefinition>([
      ["player_voice", {
        name: "player_voice",
        fxChainFile: "fx/voice.rfxchain",
      }],
      ["player_voice_male", {
        name: "player_voice_male",
        extends: "player_voice",
        overrides: {
          "AU::AU: T-De-Esser 2 (Techivation)": {
            stateFile: "fx/de-esser-male.state",
          },
        },
      }],
    ]);

    const resolved = resolvePreset("player_voice_male", presets, tempDir);
    expect(resolved.name).toBe("player_voice_male");
    expect(resolved.inheritanceChain).toEqual(["player_voice", "player_voice_male"]);
    expect(resolved.fxChain).toHaveLength(1);
    // The state blob should be overridden
    expect(resolved.fxChain[0].stateBlob).toBe("BBBB/BB==");
  });

  it("produces different version hashes for different chains", () => {
    writeRfxChain("fx/voice.rfxchain", "AU: T-De-Esser 2 (Techivation)", "AAAA/AA==");
    writeStateFile("fx/de-esser-male.state", "BBBB/BB==");

    const presets = new Map<string, PresetDefinition>([
      ["player_voice", {
        name: "player_voice",
        fxChainFile: "fx/voice.rfxchain",
      }],
      ["player_voice_male", {
        name: "player_voice_male",
        extends: "player_voice",
        overrides: {
          "AU::AU: T-De-Esser 2 (Techivation)": {
            stateFile: "fx/de-esser-male.state",
          },
        },
      }],
    ]);

    const base = resolvePreset("player_voice", presets, tempDir);
    const male = resolvePreset("player_voice_male", presets, tempDir);

    expect(base.version).not.toBe(male.version);
  });

  it("resolves multi-level inheritance", () => {
    writeRfxChain("fx/voice.rfxchain", "AU: T-De-Esser 2 (Techivation)", "AAAA/AA==");
    writeStateFile("fx/de-esser-male.state", "BBBB/BB==");
    writeStateFile("fx/de-esser-deep.state", "CCCC/CC==");

    const presets = new Map<string, PresetDefinition>([
      ["voice_base", {
        name: "voice_base",
        fxChainFile: "fx/voice.rfxchain",
      }],
      ["player_voice", {
        name: "player_voice",
        extends: "voice_base",
        overrides: {
          "AU::AU: T-De-Esser 2 (Techivation)": {
            stateFile: "fx/de-esser-male.state",
          },
        },
      }],
      ["player_voice_special", {
        name: "player_voice_special",
        extends: "player_voice",
        overrides: {
          "AU::AU: T-De-Esser 2 (Techivation)": {
            stateFile: "fx/de-esser-deep.state",
          },
        },
      }],
    ]);

    const resolved = resolvePreset("player_voice_special", presets, tempDir);
    expect(resolved.inheritanceChain).toEqual(["voice_base", "player_voice", "player_voice_special"]);
    // Final override wins
    expect(resolved.fxChain[0].stateBlob).toBe("CCCC/CC==");
  });

  it("throws for unknown preset name", () => {
    const presets = new Map<string, PresetDefinition>();
    expect(() => resolvePreset("nope", presets, tempDir)).toThrow("not found");
  });

  it("preserves plugins without overrides", () => {
    // RfxChain with two plugins
    const content = [
      "BYPASS 0 0 0",
      '<AU "AU: T-De-Esser 2 (Techivation)" "" "" 0 "" ""',
      "  AAAA/AA==",
      ">",
      "FLOATPOS 0 0 0 0",
      "FXID {00000000-0000-0000-0000-000000000000}",
      "WAK 0 0",
      "BYPASS 0 0 0",
      '<AU "AU: kHs Limiter (Kilohearts)" "" "" 0 "" ""',
      "  XXXX/XX==",
      ">",
      "FLOATPOS 0 0 0 0",
      "FXID {11111111-1111-1111-1111-111111111111}",
      "WAK 0 0",
    ].join("\n");
    writeFileSync(join(tempDir, "fx/multi.rfxchain"), content, "utf-8");
    writeStateFile("fx/limiter-override.state", "YYYY/YY==");

    const presets = new Map<string, PresetDefinition>([
      ["base", {
        name: "base",
        fxChainFile: "fx/multi.rfxchain",
      }],
      ["variant", {
        name: "variant",
        extends: "base",
        overrides: {
          "AU::AU: kHs Limiter (Kilohearts)": {
            stateFile: "fx/limiter-override.state",
          },
        },
      }],
    ]);

    const resolved = resolvePreset("variant", presets, tempDir);
    expect(resolved.fxChain).toHaveLength(2);
    // De-Esser should be unchanged
    expect(resolved.fxChain[0].stateBlob).toContain("AAAA/AA==");
    // Limiter should be overridden
    expect(resolved.fxChain[1].stateBlob).toBe("YYYY/YY==");
  });

  it("appends child fxChainFile plugins after parent chain", () => {
    writeRfxChain("fx/parent.rfxchain", "AU: T-De-Esser 2 (Techivation)", "AAAA/AA==");
    writeRfxChain("fx/child_additions.rfxchain", "AU: kHs Limiter (Kilohearts)", "LLLL/LL==");

    const presets = new Map<string, PresetDefinition>([
      ["parent", {
        name: "parent",
        fxChainFile: "fx/parent.rfxchain",
      }],
      ["child", {
        name: "child",
        extends: "parent",
        fxChainFile: "fx/child_additions.rfxchain",
      }],
    ]);

    const resolved = resolvePreset("child", presets, tempDir);
    expect(resolved.fxChain).toHaveLength(2);
    expect(resolved.fxChain[0].pluginName).toBe("AU: T-De-Esser 2 (Techivation)");
    expect(resolved.fxChain[1].pluginName).toBe("AU: kHs Limiter (Kilohearts)");
  });

  it("resolves child with extends but no fxChainFile (pure inheritance)", () => {
    writeRfxChain("fx/parent.rfxchain", "AU: T-De-Esser 2 (Techivation)", "AAAA/AA==");

    const presets = new Map<string, PresetDefinition>([
      ["parent", {
        name: "parent",
        fxChainFile: "fx/parent.rfxchain",
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
    writeRfxChain("fx/voice.rfxchain", "AU: T-De-Esser 2 (Techivation)", "AAAA/AA==");

    const presets = new Map<string, PresetDefinition>([
      ["player_voice", {
        name: "player_voice",
        fxChainFile: "fx/voice.rfxchain",
        plugins: [{ id: "de-esser" }],
      }],
    ]);

    const resolved = resolvePreset("player_voice", presets, tempDir);
    expect(resolved.fxChain[0].slotId).toBe("de-esser");
  });

  it("auto-generates slotIds when no plugins list", () => {
    writeRfxChain("fx/voice.rfxchain", "AU: T-De-Esser 2 (Techivation)", "AAAA/AA==");

    const presets = new Map<string, PresetDefinition>([
      ["player_voice", {
        name: "player_voice",
        fxChainFile: "fx/voice.rfxchain",
      }],
    ]);

    const resolved = resolvePreset("player_voice", presets, tempDir);
    expect(resolved.fxChain[0].slotId).toBe("t-de-esser-2");
  });

  it("applies slot-based override by slotId", () => {
    writeRfxChain("fx/voice.rfxchain", "AU: T-De-Esser 2 (Techivation)", "AAAA/AA==");
    writeStateFile("fx/de-esser-male.state", "BBBB/BB==");

    const presets = new Map<string, PresetDefinition>([
      ["player_voice", {
        name: "player_voice",
        fxChainFile: "fx/voice.rfxchain",
        plugins: [{ id: "de-esser" }],
      }],
      ["player_voice_male", {
        name: "player_voice_male",
        extends: "player_voice",
        override: {
          "de-esser": {
            stateFile: "fx/de-esser-male.state",
          },
        },
      }],
    ]);

    const resolved = resolvePreset("player_voice_male", presets, tempDir);
    expect(resolved.fxChain[0].stateBlob).toBe("BBBB/BB==");
    expect(resolved.fxChain[0].slotId).toBe("de-esser");
  });

  it("removes slots by slotId", () => {
    const content = [
      "BYPASS 0 0 0",
      '<AU "AU: T-De-Esser 2 (Techivation)" "" "" 0 "" ""',
      "  AAAA/AA==",
      ">",
      "FLOATPOS 0 0 0 0",
      "FXID {00000000-0000-0000-0000-000000000000}",
      "WAK 0 0",
      "BYPASS 0 0 0",
      '<AU "AU: kHs Limiter (Kilohearts)" "" "" 0 "" ""',
      "  XXXX/XX==",
      ">",
      "FLOATPOS 0 0 0 0",
      "FXID {11111111-1111-1111-1111-111111111111}",
      "WAK 0 0",
    ].join("\n");
    writeFileSync(join(tempDir, "fx/multi.rfxchain"), content, "utf-8");

    const presets = new Map<string, PresetDefinition>([
      ["base", {
        name: "base",
        fxChainFile: "fx/multi.rfxchain",
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
    writeRfxChain("fx/parent.rfxchain", "AU: T-De-Esser 2 (Techivation)", "AAAA/AA==");
    writeRfxChain("fx/child_add.rfxchain", "AU: kHs Limiter (Kilohearts)", "LLLL/LL==");

    const presets = new Map<string, PresetDefinition>([
      ["parent", {
        name: "parent",
        fxChainFile: "fx/parent.rfxchain",
        plugins: [{ id: "de-esser" }],
      }],
      ["child", {
        name: "child",
        extends: "parent",
        fxChainFile: "fx/child_add.rfxchain",
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
    writeRfxChain("fx/voice.rfxchain", "AU: T-De-Esser 2 (Techivation)", "AAAA/AA==");

    const presets = new Map<string, PresetDefinition>([
      ["player_voice", {
        name: "player_voice",
        fxChainFile: "fx/voice.rfxchain",
      }],
    ]);

    const resolved = resolvePreset("player_voice", presets, tempDir);
    expect(resolved.fxChain[0].origin).toBe("player_voice");
  });

  it("sets origin to overriding preset for overridden plugins", () => {
    writeRfxChain("fx/voice.rfxchain", "AU: T-De-Esser 2 (Techivation)", "AAAA/AA==");
    writeStateFile("fx/de-esser-male.state", "BBBB/BB==");

    const presets = new Map<string, PresetDefinition>([
      ["voice_base", {
        name: "voice_base",
        fxChainFile: "fx/voice.rfxchain",
        plugins: [{ id: "de-esser" }],
      }],
      ["player_voice", {
        name: "player_voice",
        extends: "voice_base",
        override: {
          "de-esser": {
            stateFile: "fx/de-esser-male.state",
          },
        },
      }],
    ]);

    const resolved = resolvePreset("player_voice", presets, tempDir);
    expect(resolved.fxChain[0].origin).toBe("player_voice");
  });

  it("preserves root origin for non-overridden plugins", () => {
    const content = [
      "BYPASS 0 0 0",
      '<AU "AU: T-De-Esser 2 (Techivation)" "" "" 0 "" ""',
      "  AAAA/AA==",
      ">",
      "FLOATPOS 0 0 0 0",
      "FXID {00000000-0000-0000-0000-000000000000}",
      "WAK 0 0",
      "BYPASS 0 0 0",
      '<AU "AU: kHs Limiter (Kilohearts)" "" "" 0 "" ""',
      "  XXXX/XX==",
      ">",
      "FLOATPOS 0 0 0 0",
      "FXID {11111111-1111-1111-1111-111111111111}",
      "WAK 0 0",
    ].join("\n");
    writeFileSync(join(tempDir, "fx/multi.rfxchain"), content, "utf-8");
    writeStateFile("fx/limiter-override.state", "YYYY/YY==");

    const presets = new Map<string, PresetDefinition>([
      ["base", {
        name: "base",
        fxChainFile: "fx/multi.rfxchain",
        plugins: [{ id: "de-esser" }, { id: "limiter" }],
      }],
      ["variant", {
        name: "variant",
        extends: "base",
        override: {
          "limiter": {
            stateFile: "fx/limiter-override.state",
          },
        },
      }],
    ]);

    const resolved = resolvePreset("variant", presets, tempDir);
    expect(resolved.fxChain[0].origin).toBe("base");
    expect(resolved.fxChain[1].origin).toBe("variant");
  });

  it("sets origin to child for added plugins", () => {
    writeRfxChain("fx/parent.rfxchain", "AU: T-De-Esser 2 (Techivation)", "AAAA/AA==");
    writeRfxChain("fx/child_add.rfxchain", "AU: kHs Limiter (Kilohearts)", "LLLL/LL==");

    const presets = new Map<string, PresetDefinition>([
      ["parent", {
        name: "parent",
        fxChainFile: "fx/parent.rfxchain",
        plugins: [{ id: "de-esser" }],
      }],
      ["child", {
        name: "child",
        extends: "parent",
        fxChainFile: "fx/child_add.rfxchain",
        add: [{ id: "limiter", after: "de-esser" }],
      }],
    ]);

    const resolved = resolvePreset("child", presets, tempDir);
    expect(resolved.fxChain[0].origin).toBe("parent");
    expect(resolved.fxChain[1].origin).toBe("child");
  });

  it("appends added slots at end when no after specified", () => {
    writeRfxChain("fx/parent.rfxchain", "AU: T-De-Esser 2 (Techivation)", "AAAA/AA==");
    writeRfxChain("fx/child_add.rfxchain", "AU: kHs Limiter (Kilohearts)", "LLLL/LL==");

    const presets = new Map<string, PresetDefinition>([
      ["parent", {
        name: "parent",
        fxChainFile: "fx/parent.rfxchain",
        plugins: [{ id: "de-esser" }],
      }],
      ["child", {
        name: "child",
        extends: "parent",
        fxChainFile: "fx/child_add.rfxchain",
        add: [{ id: "limiter" }],
      }],
    ]);

    const resolved = resolvePreset("child", presets, tempDir);
    expect(resolved.fxChain).toHaveLength(2);
    expect(resolved.fxChain[0].slotId).toBe("de-esser");
    expect(resolved.fxChain[1].slotId).toBe("limiter");
  });
});
