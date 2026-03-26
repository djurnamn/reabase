import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadPresets, PresetLoadError } from "../../src/preset/loader.js";

let tempDir: string;

beforeEach(() => {
  tempDir = join(tmpdir(), `reabase-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tempDir, { recursive: true });
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function writePresetYaml(filename: string, content: string): void {
  writeFileSync(join(tempDir, filename), content, "utf-8");
}

describe("loadPresets", () => {
  it("loads a single preset from a YAML file", () => {
    writePresetYaml("voice.yaml", `
name: player_voice
description: Base voice chain for players
fxChainFile: fx/voice.rfxchain
`);

    const presets = loadPresets(tempDir);
    expect(presets.size).toBe(1);

    const preset = presets.get("player_voice")!;
    expect(preset.name).toBe("player_voice");
    expect(preset.description).toBe("Base voice chain for players");
    expect(preset.fxChainFile).toBe("fx/voice.rfxchain");
  });

  it("loads multiple presets", () => {
    writePresetYaml("voice.yaml", `
name: player_voice
fxChainFile: fx/voice.rfxchain
`);
    writePresetYaml("ambient.yaml", `
name: ambient
fxChainFile: fx/ambient.rfxchain
`);

    const presets = loadPresets(tempDir);
    expect(presets.size).toBe(2);
    expect(presets.has("player_voice")).toBe(true);
    expect(presets.has("ambient")).toBe(true);
  });

  it("loads preset with extends field", () => {
    writePresetYaml("voice.yaml", `
name: player_voice
fxChainFile: fx/voice.rfxchain
`);
    writePresetYaml("voice_male.yaml", `
name: player_voice_male
extends: player_voice
fxChainFile: fx/voice.rfxchain
overrides:
  "AU::T-De-Esser 2":
    stateFile: fx/de-esser-male.state
`);

    const presets = loadPresets(tempDir);
    expect(presets.size).toBe(2);

    const male = presets.get("player_voice_male")!;
    expect(male.extends).toBe("player_voice");
    expect(male.overrides).toBeDefined();
    expect(male.overrides!["AU::T-De-Esser 2"]).toBeDefined();
  });

  it("loads .yml files too", () => {
    writePresetYaml("voice.yml", `
name: player_voice
fxChainFile: fx/voice.rfxchain
`);

    const presets = loadPresets(tempDir);
    expect(presets.size).toBe(1);
  });

  it("returns empty map for non-existent directory", () => {
    const presets = loadPresets("/tmp/does-not-exist-reabase");
    expect(presets.size).toBe(0);
  });

  it("returns empty map for empty directory", () => {
    const presets = loadPresets(tempDir);
    expect(presets.size).toBe(0);
  });

  it("throws on missing name field", () => {
    writePresetYaml("bad.yaml", `
fxChainFile: fx/voice.rfxchain
`);

    expect(() => loadPresets(tempDir)).toThrow(PresetLoadError);
    expect(() => loadPresets(tempDir)).toThrow("missing required 'name' field");
  });

  it("throws on missing fxChainFile field when no extends", () => {
    writePresetYaml("bad.yaml", `
name: voice
`);

    expect(() => loadPresets(tempDir)).toThrow(PresetLoadError);
    expect(() => loadPresets(tempDir)).toThrow("missing required 'fxChainFile' field");
  });

  it("allows missing fxChainFile when extends is set", () => {
    writePresetYaml("voice.yaml", `
name: player_voice
fxChainFile: fx/voice.rfxchain
`);
    writePresetYaml("voice_variant.yaml", `
name: player_voice_variant
extends: player_voice
`);

    const presets = loadPresets(tempDir);
    expect(presets.size).toBe(2);
    const variant = presets.get("player_voice_variant")!;
    expect(variant.extends).toBe("player_voice");
    expect(variant.fxChainFile).toBeUndefined();
  });

  it("throws on duplicate preset name", () => {
    writePresetYaml("voice1.yaml", `
name: player_voice
fxChainFile: fx/voice.rfxchain
`);
    writePresetYaml("voice2.yaml", `
name: player_voice
fxChainFile: fx/voice2.rfxchain
`);

    expect(() => loadPresets(tempDir)).toThrow(PresetLoadError);
    expect(() => loadPresets(tempDir)).toThrow("Duplicate preset name");
  });

  it("throws on missing extends target", () => {
    writePresetYaml("male.yaml", `
name: player_voice_male
extends: player_voice
fxChainFile: fx/voice.rfxchain
`);

    expect(() => loadPresets(tempDir)).toThrow(PresetLoadError);
    expect(() => loadPresets(tempDir)).toThrow("does not exist");
  });

  it("throws on circular inheritance", () => {
    writePresetYaml("a.yaml", `
name: a
extends: b
fxChainFile: fx/a.rfxchain
`);
    writePresetYaml("b.yaml", `
name: b
extends: a
fxChainFile: fx/b.rfxchain
`);

    expect(() => loadPresets(tempDir)).toThrow(PresetLoadError);
    expect(() => loadPresets(tempDir)).toThrow("Circular inheritance");
  });

  it("ignores non-yaml files", () => {
    writePresetYaml("voice.yaml", `
name: player_voice
fxChainFile: fx/voice.rfxchain
`);
    writeFileSync(join(tempDir, "readme.txt"), "not a preset", "utf-8");
    writeFileSync(join(tempDir, "data.json"), "{}", "utf-8");

    const presets = loadPresets(tempDir);
    expect(presets.size).toBe(1);
  });

  it("throws when override is used without extends", () => {
    writePresetYaml("bad.yaml", `
name: standalone
fxChainFile: fx/voice.rfxchain
override:
  de-esser:
    stateFile: fx/override.state
`);

    expect(() => loadPresets(tempDir)).toThrow(PresetLoadError);
    expect(() => loadPresets(tempDir)).toThrow("'override' but does not extend");
  });

  it("throws when remove is used without extends", () => {
    writePresetYaml("bad.yaml", `
name: standalone
fxChainFile: fx/voice.rfxchain
remove:
  - de-esser
`);

    expect(() => loadPresets(tempDir)).toThrow(PresetLoadError);
    expect(() => loadPresets(tempDir)).toThrow("'remove' but does not extend");
  });

  it("throws when add is used without extends", () => {
    writePresetYaml("bad.yaml", `
name: standalone
fxChainFile: fx/voice.rfxchain
add:
  - id: limiter
`);

    expect(() => loadPresets(tempDir)).toThrow(PresetLoadError);
    expect(() => loadPresets(tempDir)).toThrow("'add' but does not extend");
  });

  it("throws when add entries lack fxChainFile", () => {
    writePresetYaml("parent.yaml", `
name: parent
fxChainFile: fx/parent.rfxchain
`);
    writePresetYaml("child.yaml", `
name: child
extends: parent
add:
  - id: limiter
`);

    expect(() => loadPresets(tempDir)).toThrow(PresetLoadError);
    expect(() => loadPresets(tempDir)).toThrow("no 'fxChainFile' to source them from");
  });

  it("loads preset with plugins list", () => {
    writePresetYaml("voice.yaml", `
name: player_voice
fxChainFile: fx/voice.rfxchain
plugins:
  - id: de-esser
  - id: limiter
`);

    const presets = loadPresets(tempDir);
    const preset = presets.get("player_voice")!;
    expect(preset.plugins).toHaveLength(2);
    expect(preset.plugins![0].id).toBe("de-esser");
    expect(preset.plugins![1].id).toBe("limiter");
  });

  it("loads preset with override, remove, and add", () => {
    writePresetYaml("parent.yaml", `
name: parent
fxChainFile: fx/parent.rfxchain
plugins:
  - id: de-esser
  - id: compressor
`);
    writePresetYaml("child.yaml", `
name: child
extends: parent
fxChainFile: fx/child.rfxchain
override:
  de-esser:
    stateFile: fx/de-esser-override.state
remove:
  - compressor
add:
  - id: limiter
    after: de-esser
`);

    const presets = loadPresets(tempDir);
    const child = presets.get("child")!;
    expect(child.override).toBeDefined();
    expect(child.override!["de-esser"]).toBeDefined();
    expect(child.remove).toEqual(["compressor"]);
    expect(child.add).toHaveLength(1);
    expect(child.add![0].id).toBe("limiter");
    expect(child.add![0].after).toBe("de-esser");
  });
});
