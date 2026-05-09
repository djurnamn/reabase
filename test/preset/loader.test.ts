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
  describe("basic loading", () => {
    it("loads a plain preset (plugins + fxChainFile only)", () => {
      writePresetYaml(
        "voice.yaml",
        `
name: voice
description: Base voice chain
fxChainFile: fx/voice.json
plugins:
  - id: khs-compressor
`
      );

      const { presets } = loadPresets(tempDir);
      expect(presets.size).toBe(1);

      const voice = presets.get("voice")!;
      expect(voice.name).toBe("voice");
      expect(voice.description).toBe("Base voice chain");
      expect(voice.fxChainFile).toBe("fx/voice.json");
      expect(voice.plugins).toEqual([{ id: "khs-compressor" }]);
    });

    it("loads a plugin entry with a label", () => {
      writePresetYaml(
        "voice.yaml",
        `
name: voice
fxChainFile: fx/voice.json
plugins:
  - id: khs-filter-1
    label: Aggressive low-cut
  - id: khs-filter-2
    label: High shelf boost
`
      );

      const voice = loadPresets(tempDir).presets.get("voice")!;
      expect(voice.plugins).toEqual([
        { id: "khs-filter-1", label: "Aggressive low-cut" },
        { id: "khs-filter-2", label: "High shelf boost" },
      ]);
    });

    it("loads multiple presets in one directory", () => {
      writePresetYaml("voice.yaml", `name: voice\nfxChainFile: fx/voice.json\nplugins: [{id: c}]\n`);
      writePresetYaml("ambient.yaml", `name: ambient\nfxChainFile: fx/ambient.json\nplugins: [{id: r}]\n`);

      const { presets } = loadPresets(tempDir);
      expect(presets.size).toBe(2);
      expect(presets.has("voice")).toBe(true);
      expect(presets.has("ambient")).toBe(true);
    });

    it("loads .yml files alongside .yaml", () => {
      writePresetYaml("voice.yml", `name: voice\nfxChainFile: fx/voice.json\nplugins: [{id: c}]\n`);
      expect(loadPresets(tempDir).presets.size).toBe(1);
    });

    it("returns empty map for non-existent directory", () => {
      expect(loadPresets("/tmp/does-not-exist-reabase-2026").presets.size).toBe(0);
    });

    it("returns empty map for empty directory", () => {
      expect(loadPresets(tempDir).presets.size).toBe(0);
    });

    it("ignores non-YAML files", () => {
      writePresetYaml("voice.yaml", `name: voice\nfxChainFile: fx/voice.json\nplugins: [{id: c}]\n`);
      writeFileSync(join(tempDir, "readme.txt"), "not a preset", "utf-8");
      writeFileSync(join(tempDir, "data.json"), "{}", "utf-8");
      expect(loadPresets(tempDir).presets.size).toBe(1);
    });
  });

  describe("composed presets", () => {
    it("loads a composed preset with imports and order", () => {
      writePresetYaml("voice.yaml", `name: voice\nfxChainFile: fx/voice.json\nplugins: [{id: c}]\n`);
      writePresetYaml("gender.female.yaml", `name: gender.female\nfxChainFile: fx/female.json\nplugins: [{id: lowcut}]\n`);
      writePresetYaml(
        "voice.female.yaml",
        `
name: voice.female
imports:
  - voice
  - gender.female
order:
  - voice/c
  - gender.female/lowcut
`
      );

      const composed = loadPresets(tempDir).presets.get("voice.female")!;
      expect(composed.imports).toEqual(["voice", "gender.female"]);
      expect(composed.order).toEqual(["voice/c", "gender.female/lowcut"]);
    });

    it("loads deactivated and excluded lists", () => {
      writePresetYaml("voice.yaml", `name: voice\nfxChainFile: fx/voice.json\nplugins: [{id: c}, {id: limiter}]\n`);
      writePresetYaml(
        "tweaked.yaml",
        `
name: tweaked
imports: [voice]
order:
  - voice/c
  - voice/limiter
deactivated:
  - voice/c
excluded:
  - voice/limiter
`
      );

      const tweaked = loadPresets(tempDir).presets.get("tweaked")!;
      expect(tweaked.deactivated).toEqual(["voice/c"]);
      expect(tweaked.excluded).toEqual(["voice/limiter"]);
    });

    it("allows the same slot in both deactivated and excluded (independent flags)", () => {
      writePresetYaml("voice.yaml", `name: voice\nfxChainFile: fx/voice.json\nplugins: [{id: c}]\n`);
      writePresetYaml(
        "tweaked.yaml",
        `
name: tweaked
imports: [voice]
deactivated:
  - voice/c
excluded:
  - voice/c
`
      );

      const tweaked = loadPresets(tempDir).presets.get("tweaked")!;
      expect(tweaked.deactivated).toEqual(["voice/c"]);
      expect(tweaked.excluded).toEqual(["voice/c"]);
    });
  });

  describe("retired schema rejection", () => {
    it("rejects 'extends' with migration hint", () => {
      writePresetYaml("voice.yaml", `name: voice\nfxChainFile: fx/voice.json\nplugins: [{id: c}]\n`);
      writePresetYaml("legacy.yaml", `name: legacy\nextends: voice\n`);

      expect(() => loadPresets(tempDir)).toThrow(PresetLoadError);
      expect(() => loadPresets(tempDir)).toThrow(/retired field 'extends'/);
      expect(() => loadPresets(tempDir)).toThrow(/composition/);
    });

    it("rejects 'override'", () => {
      writePresetYaml("legacy.yaml", `name: legacy\nfxChainFile: fx/x.json\nplugins: [{id: c}]\noverride:\n  c:\n    stateFile: fx/c.json\n`);
      expect(() => loadPresets(tempDir)).toThrow(/retired field 'override'/);
    });

    it("rejects 'add'", () => {
      writePresetYaml("legacy.yaml", `name: legacy\nfxChainFile: fx/x.json\nplugins: [{id: c}]\nadd:\n  - id: foo\n`);
      expect(() => loadPresets(tempDir)).toThrow(/retired field 'add'/);
    });

    it("rejects 'remove'", () => {
      writePresetYaml("legacy.yaml", `name: legacy\nfxChainFile: fx/x.json\nplugins: [{id: c}]\nremove:\n  - foo\n`);
      expect(() => loadPresets(tempDir)).toThrow(/retired field 'remove'/);
    });

    it("rejects 'conflicts'", () => {
      writePresetYaml("legacy.yaml", `name: legacy\nconflicts:\n  c:\n    use: voice\n`);
      expect(() => loadPresets(tempDir)).toThrow(/retired field 'conflicts'/);
    });
  });

  describe("required-field validation", () => {
    it("rejects a preset with no name", () => {
      writePresetYaml("bad.yaml", `fxChainFile: fx/voice.json\nplugins: [{id: c}]\n`);
      expect(() => loadPresets(tempDir)).toThrow(/missing required 'name' field/);
    });

    it("rejects 'plugins' without 'fxChainFile'", () => {
      writePresetYaml("bad.yaml", `name: bad\nplugins: [{id: c}]\n`);
      expect(() => loadPresets(tempDir)).toThrow(/no 'fxChainFile'/);
    });

    it("rejects a 'plugins' entry without 'id'", () => {
      writePresetYaml("bad.yaml", `name: bad\nfxChainFile: fx/x.json\nplugins:\n  - label: missing id\n`);
      expect(() => loadPresets(tempDir)).toThrow(/'plugins' entry without a string 'id'/);
    });

    it("rejects a 'plugins' entry with non-string label", () => {
      writePresetYaml("bad.yaml", `name: bad\nfxChainFile: fx/x.json\nplugins:\n  - id: c\n    label: 42\n`);
      expect(() => loadPresets(tempDir)).toThrow(/non-string 'label'/);
    });

    it("rejects duplicate plugin ids in the same plugins list", () => {
      writePresetYaml("bad.yaml", `name: bad\nfxChainFile: fx/x.json\nplugins: [{id: c}, {id: c}]\n`);
      expect(() => loadPresets(tempDir)).toThrow(/duplicate plugin id 'c'/);
    });

    it("allows a preset with imports and no own plugins", () => {
      writePresetYaml("voice.yaml", `name: voice\nfxChainFile: fx/voice.json\nplugins: [{id: c}]\n`);
      writePresetYaml("composed.yaml", `name: composed\nimports: [voice]\n`);

      const composed = loadPresets(tempDir).presets.get("composed")!;
      expect(composed.fxChainFile).toBeUndefined();
      expect(composed.plugins).toBeUndefined();
    });

    it("allows an empty preset (no plugins, no imports)", () => {
      writePresetYaml("empty.yaml", `name: empty\ndescription: still in development\n`);
      expect(loadPresets(tempDir).presets.size).toBe(1);
    });
  });

  describe("uniqueness", () => {
    it("rejects duplicate preset names across files", () => {
      writePresetYaml("a.yaml", `name: voice\nfxChainFile: fx/a.json\nplugins: [{id: c}]\n`);
      writePresetYaml("b.yaml", `name: voice\nfxChainFile: fx/b.json\nplugins: [{id: c}]\n`);
      expect(() => loadPresets(tempDir)).toThrow(/Duplicate preset name/);
    });
  });

  describe("imports validation", () => {
    it("rejects an import to a non-existent preset", () => {
      writePresetYaml("composed.yaml", `name: composed\nimports: [missing]\n`);
      expect(() => loadPresets(tempDir)).toThrow(/imports 'missing' which does not exist/);
    });

    it("rejects nested imports (composed importing composed)", () => {
      writePresetYaml("voice.yaml", `name: voice\nfxChainFile: fx/voice.json\nplugins: [{id: c}]\n`);
      writePresetYaml("inner.yaml", `name: inner\nimports: [voice]\n`);
      writePresetYaml("outer.yaml", `name: outer\nimports: [inner]\n`);
      expect(() => loadPresets(tempDir)).toThrow(/nesting is disallowed/);
    });

    it("rejects self-imports", () => {
      writePresetYaml("loop.yaml", `name: loop\nimports: [loop]\n`);
      expect(() => loadPresets(tempDir)).toThrow(/imports itself/);
    });

    it("rejects duplicate entries within the imports list", () => {
      writePresetYaml("voice.yaml", `name: voice\nfxChainFile: fx/voice.json\nplugins: [{id: c}]\n`);
      writePresetYaml("dup.yaml", `name: dup\nimports: [voice, voice]\n`);
      expect(() => loadPresets(tempDir)).toThrow(/lists 'voice' in 'imports' twice/);
    });

    it("rejects a non-array imports field", () => {
      writePresetYaml("bad.yaml", `name: bad\nimports: voice\n`);
      expect(() => loadPresets(tempDir)).toThrow(/expected an array of preset names/);
    });
  });

  describe("order / deactivated / excluded shape", () => {
    it("rejects an entry without a slash", () => {
      writePresetYaml("bad.yaml", `name: bad\norder:\n  - just-a-slot\n`);
      expect(() => loadPresets(tempDir)).toThrow(/malformed 'order' entry/);
    });

    it("rejects an entry with empty source name", () => {
      writePresetYaml("bad.yaml", `name: bad\norder:\n  - /khs-compressor\n`);
      expect(() => loadPresets(tempDir)).toThrow(/malformed 'order' entry/);
    });

    it("rejects an entry with empty slot id", () => {
      writePresetYaml("bad.yaml", `name: bad\norder:\n  - voice/\n`);
      expect(() => loadPresets(tempDir)).toThrow(/malformed 'order' entry/);
    });

    it("rejects duplicate order entries", () => {
      writePresetYaml("bad.yaml", `name: bad\norder:\n  - voice/c\n  - voice/c\n`);
      expect(() => loadPresets(tempDir)).toThrow(/duplicate 'order' entry/);
    });

    it("rejects duplicate deactivated entries", () => {
      writePresetYaml("bad.yaml", `name: bad\ndeactivated:\n  - voice/c\n  - voice/c\n`);
      expect(() => loadPresets(tempDir)).toThrow(/duplicate 'deactivated' entry/);
    });

    it("rejects duplicate excluded entries", () => {
      writePresetYaml("bad.yaml", `name: bad\nexcluded:\n  - voice/c\n  - voice/c\n`);
      expect(() => loadPresets(tempDir)).toThrow(/duplicate 'excluded' entry/);
    });

    it("rejects non-array order/deactivated/excluded", () => {
      writePresetYaml("bad-order.yaml", `name: bad-order\norder: voice/c\n`);
      expect(() => loadPresets(tempDir)).toThrow(/expected an array of/);
    });
  });

  describe("folders + categories", () => {
    function writeNested(relPath: string, content: string): void {
      const fullPath = join(tempDir, relPath);
      mkdirSync(join(fullPath, ".."), { recursive: true });
      writeFileSync(fullPath, content, "utf-8");
    }

    it("recurses into subdirectories and assigns category slugs", () => {
      writeNested(
        "voices/voice.yaml",
        `name: voice\nfxChainFile: fx/voice.json\nplugins: [{id: c}]\n`
      );
      writeNested(
        "ambiences/living_room.yaml",
        `name: Living Room\nfxChainFile: fx/lr.json\nplugins: [{id: r}]\n`
      );

      const { presets } = loadPresets(tempDir);
      expect(presets.get("voice")!._categorySlug).toBe("voices");
      expect(presets.get("Living Room")!._categorySlug).toBe("ambiences");
    });

    it("attaches _sourceDir to each loaded preset", () => {
      writeNested(
        "voices/voice.yaml",
        `name: voice\nfxChainFile: fx/voice.json\nplugins: [{id: c}]\n`
      );

      const { presets } = loadPresets(tempDir);
      expect(presets.get("voice")!._sourceDir).toBe(join(tempDir, "voices"));
    });

    it("nested folders get hierarchical slugs", () => {
      writeNested(
        "voices/mixins/voice.yaml",
        `name: voice\nfxChainFile: fx/voice.json\nplugins: [{id: c}]\n`
      );

      const { presets } = loadPresets(tempDir);
      expect(presets.get("voice")!._categorySlug).toBe("voices/mixins");
    });

    it("uses _category.yaml label when present", () => {
      writeNested(
        "voices/_category.yaml",
        `label: Voice presets\n`
      );
      writeNested(
        "voices/voice.yaml",
        `name: voice\nfxChainFile: fx/voice.json\nplugins: [{id: c}]\n`
      );

      const { categories } = loadPresets(tempDir);
      expect(categories.get("voices")!.label).toBe("Voice presets");
    });

    it("falls back to the folder name verbatim when _category.yaml is absent", () => {
      writeNested(
        "voices/voice.yaml",
        `name: voice\nfxChainFile: fx/voice.json\nplugins: [{id: c}]\n`
      );

      const { categories } = loadPresets(tempDir);
      expect(categories.get("voices")!.label).toBe("voices");
    });

    it("a preset directly under presets/ has empty category slug", () => {
      writePresetYaml(
        "voice.yaml",
        `name: voice\nfxChainFile: fx/voice.json\nplugins: [{id: c}]\n`
      );

      const { presets, categories } = loadPresets(tempDir);
      expect(presets.get("voice")!._categorySlug).toBe("");
      // Root-level category gets an entry too, with empty label fallback.
      expect(categories.has("")).toBe(true);
    });

    it("rejects duplicate preset names across different folders", () => {
      writeNested(
        "voices/voice.yaml",
        `name: voice\nfxChainFile: fx/a.json\nplugins: [{id: c}]\n`
      );
      writeNested(
        "ambiences/voice.yaml",
        `name: voice\nfxChainFile: fx/b.json\nplugins: [{id: c}]\n`
      );

      expect(() => loadPresets(tempDir)).toThrow(/Duplicate preset name/);
    });

    it("does NOT load _category.yaml as a preset", () => {
      writeNested(
        "voices/_category.yaml",
        `label: Voice presets\n`
      );
      writeNested(
        "voices/voice.yaml",
        `name: voice\nfxChainFile: fx/voice.json\nplugins: [{id: c}]\n`
      );

      const { presets } = loadPresets(tempDir);
      expect(presets.size).toBe(1);
      expect(presets.has("voice")).toBe(true);
    });
  });
});
