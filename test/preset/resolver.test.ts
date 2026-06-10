import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolvePreset } from "../../src/preset/resolver.js";
import type { PresetDefinition, LoadedPreset } from "../../src/preset/types.js";
import type { ParameterValue } from "../../src/snapshot/types.js";

let tempDir: string;

beforeEach(() => {
  tempDir = join(tmpdir(), `reabase-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(tempDir, "fx"), { recursive: true });
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

interface PluginSpec {
  pluginName: string;
  parameters: Record<string, ParameterValue>;
  slotId?: string;
}

function writeFxChainFile(filename: string, plugins: PluginSpec[]): void {
  const content = plugins.map((p) => ({
    pluginName: p.pluginName,
    pluginType: "AU",
    pluginParams: ["", "", 0, "", ""],
    slotId: p.slotId ?? "auto",
    parameters: p.parameters,
  }));
  writeFileSync(join(tempDir, filename), JSON.stringify(content), "utf-8");
}

/** Build a LoadedPreset from a YAML-shape PresetDefinition. The resolver
 *  reads `_sourceDir` to resolve fxChainFile paths; these tests dump
 *  fxChainFile JSONs directly under tempDir, so that's the source dir.
 *  `_categorySlug` is empty (preset lives at the root). */
function lp(def: PresetDefinition): LoadedPreset {
  return { ...def, _sourceDir: tempDir, _categorySlug: "" };
}

const paramsA: Record<string, ParameterValue> = { "0": { name: "x", value: 0.5 } };
const paramsB: Record<string, ParameterValue> = { "0": { name: "x", value: 0.8 } };
const paramsC: Record<string, ParameterValue> = { "0": { name: "x", value: 0.3 } };

describe("resolvePreset — plain presets", () => {
  it("resolves a preset with own plugins and no imports", () => {
    writeFxChainFile("fx/voice.json", [
      { pluginName: "AU: kHs Compressor (Kilohearts)", parameters: paramsA },
    ]);

    const presets = new Map<string, LoadedPreset>([
      ["voice", lp({ name: "voice", fxChainFile: "fx/voice.json", plugins: [{ id: "khs-compressor" }] })],
    ]);

    const resolved = resolvePreset("voice", presets);
    expect(resolved.name).toBe("voice");
    expect(resolved.sources).toEqual(["voice"]);
    expect(resolved.fxChain).toHaveLength(1);
    expect(resolved.fxChain[0].slotId).toBe("khs-compressor");
    expect(resolved.fxChain[0].origin).toBe("voice");
    expect(resolved.fxChain[0].bypassed).toBeUndefined();
    expect(resolved.excluded).toEqual([]);
    expect(resolved.version).toHaveLength(12);
  });

  it("auto-generates slotIds when no plugins list is provided", () => {
    writeFxChainFile("fx/voice.json", [
      { pluginName: "AU: T-De-Esser 2 (Techivation)", parameters: paramsA },
    ]);

    const presets = new Map<string, LoadedPreset>([
      ["voice", lp({ name: "voice", fxChainFile: "fx/voice.json" })],
    ]);

    const resolved = resolvePreset("voice", presets);
    expect(resolved.fxChain[0].slotId).toBe("t-de-esser-2");
  });

  it("propagates plugin labels onto FxFingerprint.displayName", () => {
    writeFxChainFile("fx/filters.json", [
      { pluginName: "AU: kHs Filter (Kilohearts)", parameters: paramsA },
      { pluginName: "AU: kHs Filter (Kilohearts)", parameters: paramsB },
    ]);

    const presets = new Map<string, LoadedPreset>([
      ["filters", lp({
        name: "filters",
        fxChainFile: "fx/filters.json",
        plugins: [
          { id: "khs-filter", label: "Aggressive low-cut" },
          { id: "khs-filter-2", label: "High shelf boost" },
        ],
      })],
    ]);

    const resolved = resolvePreset("filters", presets);
    expect(resolved.fxChain[0].displayName).toBe("Aggressive low-cut");
    expect(resolved.fxChain[1].displayName).toBe("High shelf boost");
  });

  it("leaves displayName undefined when no label is set", () => {
    writeFxChainFile("fx/voice.json", [
      { pluginName: "AU: kHs Compressor (Kilohearts)", parameters: paramsA },
    ]);
    const presets = new Map<string, LoadedPreset>([
      ["voice", lp({ name: "voice", fxChainFile: "fx/voice.json", plugins: [{ id: "c" }] })],
    ]);

    const resolved = resolvePreset("voice", presets);
    expect(resolved.fxChain[0].displayName).toBeUndefined();
  });

  it("throws for an unknown preset name", () => {
    const presets = new Map<string, LoadedPreset>();
    expect(() => resolvePreset("nope", presets)).toThrow(/not found/);
  });

  it("treats an empty preset (no plugins, no imports) as an empty chain", () => {
    const presets = new Map<string, LoadedPreset>([
      ["empty", lp({ name: "empty" })],
    ]);
    const resolved = resolvePreset("empty", presets);
    expect(resolved.sources).toEqual([]);
    expect(resolved.fxChain).toEqual([]);
    expect(resolved.excluded).toEqual([]);
  });
});

describe("resolvePreset — composition", () => {
  function setupBasicMixins(): Map<string, LoadedPreset> {
    writeFxChainFile("fx/voice.json", [
      { pluginName: "AU: kHs Compressor (Kilohearts)", parameters: paramsA },
    ]);
    writeFxChainFile("fx/role.character.json", [
      { pluginName: "AU: kHs Filter 1 (Kilohearts)", parameters: paramsA },
      { pluginName: "AU: TOTape9 (Kilohearts)", parameters: paramsB },
    ]);
    writeFxChainFile("fx/gender.female.json", [
      { pluginName: "AU: kHs Filter Lowcut (Kilohearts)", parameters: paramsA },
      { pluginName: "AU: T-De-Esser 2 (Techivation)", parameters: paramsB },
    ]);

    return new Map<string, LoadedPreset>([
      ["voice", lp({
        name: "voice",
        fxChainFile: "fx/voice.json",
        plugins: [{ id: "khs-compressor" }],
      })],
      ["role.character", lp({
        name: "role.character",
        fxChainFile: "fx/role.character.json",
        plugins: [{ id: "khs-filter-1" }, { id: "totape9" }],
      })],
      ["gender.female", lp({
        name: "gender.female",
        fxChainFile: "fx/gender.female.json",
        plugins: [{ id: "khs-filter-lowcut" }, { id: "t-de-esser-2" }],
      })],
    ]);
  }

  it("uses default order when `order` is absent (sources concatenated, container first)", () => {
    const presets = setupBasicMixins();
    presets.set("voice.character.female", lp({
      name: "voice.character.female",
      imports: ["voice", "role.character", "gender.female"],
    }));

    const resolved = resolvePreset("voice.character.female", presets);
    expect(resolved.sources).toEqual(["voice", "role.character", "gender.female"]);
    expect(resolved.fxChain.map((fx) => fx.slotId)).toEqual([
      "khs-compressor",
      "khs-filter-1",
      "totape9",
      "khs-filter-lowcut",
      "t-de-esser-2",
    ]);
  });

  it("places container's own plugins first in default order", () => {
    const presets = setupBasicMixins();
    writeFxChainFile("fx/own.json", [
      { pluginName: "AU: kHs Tilt (Kilohearts)", parameters: paramsC },
    ]);
    presets.set("voice.character.female", lp({
      name: "voice.character.female",
      imports: ["voice", "role.character"],
      fxChainFile: "fx/own.json",
      plugins: [{ id: "khs-tilt" }],
    }));

    const resolved = resolvePreset("voice.character.female", presets);
    expect(resolved.sources).toEqual(["voice.character.female", "voice", "role.character"]);
    expect(resolved.fxChain.map((fx) => fx.slotId)).toEqual([
      "khs-tilt",
      "khs-compressor",
      "khs-filter-1",
      "totape9",
    ]);
  });

  it("respects an explicit `order` field", () => {
    const presets = setupBasicMixins();
    presets.set("voice.character.female", lp({
      name: "voice.character.female",
      imports: ["voice", "role.character", "gender.female"],
      order: [
        "voice/khs-compressor",
        "gender.female/khs-filter-lowcut",
        "role.character/khs-filter-1",
        "role.character/totape9",
        "gender.female/t-de-esser-2",
      ],
    }));

    const resolved = resolvePreset("voice.character.female", presets);
    expect(resolved.fxChain.map((fx) => fx.slotId)).toEqual([
      "khs-compressor",
      "khs-filter-lowcut",
      "khs-filter-1",
      "totape9",
      "t-de-esser-2",
    ]);
    expect(resolved.fxChain.map((fx) => fx.origin)).toEqual([
      "voice",
      "gender.female",
      "role.character",
      "role.character",
      "gender.female",
    ]);
  });

  it("appends drift slots at the end when `order` does not mention them", () => {
    const presets = setupBasicMixins();
    presets.set("voice.female", lp({
      name: "voice.female",
      imports: ["voice", "gender.female"],
      order: ["voice/khs-compressor"],
    }));

    const resolved = resolvePreset("voice.female", presets);
    expect(resolved.fxChain.map((fx) => fx.slotId)).toEqual([
      "khs-compressor",
      "khs-filter-lowcut",
      "t-de-esser-2",
    ]);
  });

  it("throws on an order entry referencing an unknown source", () => {
    const presets = setupBasicMixins();
    presets.set("composed", lp({
      name: "composed",
      imports: ["voice"],
      order: ["typo/khs-compressor"],
    }));

    expect(() => resolvePreset("composed", presets)).toThrow(
      /unknown source 'typo'/
    );
  });

  it("throws on an order entry referencing an unknown slot in a known source", () => {
    const presets = setupBasicMixins();
    presets.set("composed", lp({
      name: "composed",
      imports: ["voice"],
      order: ["voice/missing-slot"],
    }));

    expect(() => resolvePreset("composed", presets)).toThrow(
      /references slot 'missing-slot'/
    );
  });
});

describe("resolvePreset — same-slot-ID across sources is rejected", () => {
  it("throws when two imports define the same slotId", () => {
    writeFxChainFile("fx/a.json", [
      { pluginName: "AU: kHs Compressor (Kilohearts)", parameters: paramsA },
    ]);
    writeFxChainFile("fx/b.json", [
      { pluginName: "AU: kHs Compressor (Kilohearts)", parameters: paramsB },
    ]);
    const presets = new Map<string, LoadedPreset>([
      ["voice", lp({ name: "voice", fxChainFile: "fx/a.json", plugins: [{ id: "khs-compressor" }] })],
      ["alt", lp({ name: "alt", fxChainFile: "fx/b.json", plugins: [{ id: "khs-compressor" }] })],
      ["composed", lp({ name: "composed", imports: ["voice", "alt"] })],
    ]);

    expect(() => resolvePreset("composed", presets)).toThrow(
      /slot 'khs-compressor' is defined in both 'voice' and 'alt'/
    );
  });

  it("throws when the container and an import define the same slotId", () => {
    writeFxChainFile("fx/imported.json", [
      { pluginName: "AU: kHs Compressor (Kilohearts)", parameters: paramsA },
    ]);
    writeFxChainFile("fx/container.json", [
      { pluginName: "AU: kHs Compressor (Kilohearts)", parameters: paramsB },
    ]);
    const presets = new Map<string, LoadedPreset>([
      ["mixin", lp({
        name: "mixin",
        fxChainFile: "fx/imported.json",
        plugins: [{ id: "khs-compressor" }],
      })],
      ["composed", lp({
        name: "composed",
        imports: ["mixin"],
        fxChainFile: "fx/container.json",
        plugins: [{ id: "khs-compressor" }],
      })],
    ]);

    expect(() => resolvePreset("composed", presets)).toThrow(
      /slot 'khs-compressor' is defined in both/
    );
  });
});

describe("resolvePreset — excluded", () => {
  function setupTwoSlotComposed(extras: Partial<PresetDefinition> = {}): Map<string, LoadedPreset> {
    writeFxChainFile("fx/voice.json", [
      { pluginName: "AU: kHs Compressor (Kilohearts)", parameters: paramsA },
      { pluginName: "AU: kHs Limiter (Kilohearts)", parameters: paramsB },
    ]);
    return new Map<string, LoadedPreset>([
      ["voice", lp({
        name: "voice",
        fxChainFile: "fx/voice.json",
        plugins: [{ id: "khs-compressor" }, { id: "khs-limiter" }],
      })],
      ["composed", lp({
        name: "composed",
        imports: ["voice"],
        ...extras,
      })],
    ]);
  }

  it("filters excluded slots out of the resolved chain", () => {
    const presets = setupTwoSlotComposed({ excluded: ["voice/khs-limiter"] });

    const resolved = resolvePreset("composed", presets);
    expect(resolved.fxChain.map((fx) => fx.slotId)).toEqual(["khs-compressor"]);
    expect(resolved.excluded).toEqual(["voice/khs-limiter"]);
  });

  it("preserves visual position via `order` even when excluded", () => {
    const presets = setupTwoSlotComposed({
      order: ["voice/khs-compressor", "voice/khs-limiter"],
      excluded: ["voice/khs-limiter"],
    });

    const resolved = resolvePreset("composed", presets);
    expect(resolved.fxChain.map((fx) => fx.slotId)).toEqual(["khs-compressor"]);
    expect(resolved.excluded).toEqual(["voice/khs-limiter"]);
  });

  it("rejects an excluded entry referencing a slot that doesn't exist", () => {
    const presets = setupTwoSlotComposed({ excluded: ["voice/missing"] });

    expect(() => resolvePreset("composed", presets)).toThrow(
      /'excluded' entry 'voice\/missing' references slot 'missing'/
    );
  });

  it("rejects an excluded entry pointing at a source that isn't loaded", () => {
    const presets = setupTwoSlotComposed({ excluded: ["typo/khs-limiter"] });

    expect(() => resolvePreset("composed", presets)).toThrow(
      /'excluded' entry 'typo\/khs-limiter' references unknown source 'typo'/
    );
  });
});

describe("resolvePreset — excludedChain", () => {
  // Three slots so positions are unambiguous: A, B, C.
  function setupThreeSlotComposed(extras: Partial<PresetDefinition> = {}): Map<string, LoadedPreset> {
    writeFxChainFile("fx/voice.json", [
      { pluginName: "AU: kHs Compressor (Kilohearts)", parameters: paramsA },
      { pluginName: "AU: kHs Limiter (Kilohearts)", parameters: paramsB },
      { pluginName: "AU: kHs Gain (Kilohearts)", parameters: paramsC },
    ]);
    return new Map<string, LoadedPreset>([
      ["voice", lp({
        name: "voice",
        fxChainFile: "fx/voice.json",
        plugins: [{ id: "a" }, { id: "b" }, { id: "c" }],
      })],
      ["composed", lp({
        name: "composed",
        imports: ["voice"],
        order: ["voice/a", "voice/b", "voice/c"],
        ...extras,
      })],
    ]);
  }

  it("surfaces an excluded slot with its origin and insert-index position", () => {
    const presets = setupThreeSlotComposed({ excluded: ["voice/b"] });

    const resolved = resolvePreset("composed", presets);
    // Absent from the apply target...
    expect(resolved.fxChain.map((fx) => fx.slotId)).toEqual(["a", "c"]);
    // ...but surfaced with detail + position (one resolved slot, "a", precedes it).
    expect(resolved.excludedChain).toHaveLength(1);
    expect(resolved.excludedChain[0].fingerprint.slotId).toBe("b");
    expect(resolved.excludedChain[0].fingerprint.origin).toBe("voice");
    expect(resolved.excludedChain[0].position).toBe(1);
  });

  it("positions a leading excluded slot at index 0", () => {
    const presets = setupThreeSlotComposed({ excluded: ["voice/a"] });

    const resolved = resolvePreset("composed", presets);
    expect(resolved.fxChain.map((fx) => fx.slotId)).toEqual(["b", "c"]);
    expect(resolved.excludedChain[0].fingerprint.slotId).toBe("a");
    expect(resolved.excludedChain[0].position).toBe(0);
  });

  it("positions a trailing excluded slot past the last resolved slot", () => {
    const presets = setupThreeSlotComposed({ excluded: ["voice/c"] });

    const resolved = resolvePreset("composed", presets);
    expect(resolved.fxChain.map((fx) => fx.slotId)).toEqual(["a", "b"]);
    expect(resolved.excludedChain[0].fingerprint.slotId).toBe("c");
    expect(resolved.excludedChain[0].position).toBe(2);
  });

  it("gives two adjacent excluded slots the same insert-index, in order", () => {
    const presets = setupThreeSlotComposed({ excluded: ["voice/b", "voice/c"] });

    const resolved = resolvePreset("composed", presets);
    expect(resolved.fxChain.map((fx) => fx.slotId)).toEqual(["a"]);
    // Both follow the single resolved slot "a", and keep their order.
    expect(resolved.excludedChain.map((e) => [e.fingerprint.slotId, e.position])).toEqual([
      ["b", 1],
      ["c", 1],
    ]);
  });

  it("splices back to its original position when re-included (position is stable)", () => {
    const excludedPresets = setupThreeSlotComposed({ excluded: ["voice/b"] });
    const excluded = resolvePreset("composed", excludedPresets);

    // Reconstruct the visual chain by splicing the excluded slot back in.
    const visual = [...excluded.fxChain.map((fx) => fx.slotId)];
    for (const e of excluded.excludedChain) {
      visual.splice(e.position, 0, e.fingerprint.slotId);
    }
    expect(visual).toEqual(["a", "b", "c"]);

    // Re-including (removing from `excluded`) lands "b" back at the same index.
    const includedPresets = setupThreeSlotComposed();
    const included = resolvePreset("composed", includedPresets);
    expect(included.fxChain.map((fx) => fx.slotId)).toEqual(["a", "b", "c"]);
    expect(included.excludedChain).toEqual([]);
    expect(included.fxChain[excluded.excludedChain[0].position].slotId).toBe("b");
  });

  it("surfaces excluded slots under the default order (no explicit `order`)", () => {
    const presets = setupThreeSlotComposed({ order: undefined, excluded: ["voice/b"] });

    const resolved = resolvePreset("composed", presets);
    expect(resolved.fxChain.map((fx) => fx.slotId)).toEqual(["a", "c"]);
    expect(resolved.excludedChain[0].fingerprint.slotId).toBe("b");
    expect(resolved.excludedChain[0].position).toBe(1);
  });

  it("is empty when nothing is excluded", () => {
    const resolved = resolvePreset("composed", setupThreeSlotComposed());
    expect(resolved.excludedChain).toEqual([]);
  });
});

describe("resolvePreset — deactivated", () => {
  function setupOneSlotComposed(extras: Partial<PresetDefinition> = {}): Map<string, LoadedPreset> {
    writeFxChainFile("fx/voice.json", [
      { pluginName: "AU: kHs Compressor (Kilohearts)", parameters: paramsA },
    ]);
    return new Map<string, LoadedPreset>([
      ["voice", lp({
        name: "voice",
        fxChainFile: "fx/voice.json",
        plugins: [{ id: "khs-compressor" }],
      })],
      ["composed", lp({
        name: "composed",
        imports: ["voice"],
        ...extras,
      })],
    ]);
  }

  it("tags deactivated slots with bypassed=true and keeps them in the chain", () => {
    const presets = setupOneSlotComposed({ deactivated: ["voice/khs-compressor"] });

    const resolved = resolvePreset("composed", presets);
    expect(resolved.fxChain).toHaveLength(1);
    expect(resolved.fxChain[0].slotId).toBe("khs-compressor");
    expect(resolved.fxChain[0].bypassed).toBe(true);
  });

  it("does NOT tag bypassed=true on a deactivated slot that is also excluded", () => {
    const presets = setupOneSlotComposed({
      deactivated: ["voice/khs-compressor"],
      excluded: ["voice/khs-compressor"],
    });

    const resolved = resolvePreset("composed", presets);
    expect(resolved.fxChain).toHaveLength(0);
    expect(resolved.excluded).toEqual(["voice/khs-compressor"]);
  });

  it("rejects a deactivated entry referencing a slot that doesn't exist", () => {
    const presets = setupOneSlotComposed({ deactivated: ["voice/missing"] });

    expect(() => resolvePreset("composed", presets)).toThrow(
      /'deactivated' entry 'voice\/missing' references slot 'missing'/
    );
  });
});

describe("resolvePreset — versioning", () => {
  it("produces different version hashes for differently-resolved chains", () => {
    writeFxChainFile("fx/a.json", [
      { pluginName: "AU: kHs Compressor (Kilohearts)", parameters: paramsA },
    ]);
    writeFxChainFile("fx/b.json", [
      { pluginName: "AU: kHs Compressor (Kilohearts)", parameters: paramsB },
    ]);

    const presets = new Map<string, LoadedPreset>([
      ["a", lp({ name: "a", fxChainFile: "fx/a.json", plugins: [{ id: "c-a" }] })],
      ["b", lp({ name: "b", fxChainFile: "fx/b.json", plugins: [{ id: "c-b" }] })],
    ]);

    expect(resolvePreset("a", presets).version).not.toBe(
      resolvePreset("b", presets).version
    );
  });

  it("produces a different version hash when a slot is deactivated", () => {
    writeFxChainFile("fx/voice.json", [
      { pluginName: "AU: kHs Compressor (Kilohearts)", parameters: paramsA },
    ]);
    const base = new Map<string, LoadedPreset>([
      ["voice", lp({ name: "voice", fxChainFile: "fx/voice.json", plugins: [{ id: "khs-compressor" }] })],
      ["composed", lp({ name: "composed", imports: ["voice"] })],
    ]);
    const v1 = resolvePreset("composed", base).version;

    base.set("composed", lp({
      name: "composed",
      imports: ["voice"],
      deactivated: ["voice/khs-compressor"],
    }));
    const v2 = resolvePreset("composed", base).version;

    expect(v1).not.toBe(v2);
  });
});
