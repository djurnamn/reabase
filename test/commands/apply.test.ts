import { describe, it, expect } from "vitest";
import { parseRpp } from "../../src/parser/parse.js";
import { serializeRpp } from "../../src/parser/serialize.js";
import { getTracks, getFxChain, getFxPlugins, getFxPluginName } from "../../src/parser/helpers.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { applyResolvedChainToTrack } from "../../src/commands/apply.js";
import type { FxFingerprint } from "../../src/snapshot/types.js";

const FIXTURES = resolve(import.meta.dirname, "../fixtures");

function readFixture(name: string): string {
  return readFileSync(resolve(FIXTURES, name), "utf-8");
}

function makeFx(name: string, type: string, state: string, slotId?: string): FxFingerprint {
  return {
    pluginName: name,
    pluginType: type,
    stateHash: `hash_${state}`,
    slotId: slotId ?? name.toLowerCase().replace(/^[a-z0-9]+:\s*/i, "").replace(/\s*\([^)]*\)\s*$/, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
    parameters: {},
  };
}

describe("applyResolvedChainToTrack", () => {
  it("replaces the FX chain on a track with existing FX", () => {
    const root = parseRpp(readFixture("single-track-with-fx.rpp"));
    const track = getTracks(root)[0];

    const newChain = [
      makeFx("AU: kHs Limiter (Kilohearts)", "AU", "LIMITERBLOB"),
    ];

    applyResolvedChainToTrack(track, newChain);

    const fxChain = getFxChain(track)!;
    expect(fxChain).toBeDefined();

    const plugins = getFxPlugins(fxChain);
    expect(plugins).toHaveLength(1);
    expect(getFxPluginName(plugins[0])).toBe("AU: kHs Limiter (Kilohearts)");
  });

  it("preserves FXCHAIN header properties (SHOW, LASTSEL, DOCKED)", () => {
    const root = parseRpp(readFixture("single-track-with-fx.rpp"));
    const track = getTracks(root)[0];

    const newChain = [
      makeFx("AU: kHs Limiter (Kilohearts)", "AU", "LIMITERBLOB"),
    ];

    applyResolvedChainToTrack(track, newChain);

    const fxChain = getFxChain(track)!;
    const showChild = fxChain.children.find(
      (c) => c.kind === "struct" && c.token === "SHOW"
    );
    const lastselChild = fxChain.children.find(
      (c) => c.kind === "struct" && c.token === "LASTSEL"
    );
    const dockedChild = fxChain.children.find(
      (c) => c.kind === "struct" && c.token === "DOCKED"
    );

    expect(showChild).toBeDefined();
    expect(lastselChild).toBeDefined();
    expect(dockedChild).toBeDefined();
  });

  it("creates FXCHAIN block when track has none", () => {
    const root = parseRpp(readFixture("special-characters.rpp"));
    const tracks = getTracks(root);
    // DÖRR track has no FX chain
    const track = tracks[1];

    expect(getFxChain(track)).toBeUndefined();

    const newChain = [
      makeFx("AU: EQ (Generic)", "AU", "EQBLOB"),
    ];

    applyResolvedChainToTrack(track, newChain);

    const fxChain = getFxChain(track)!;
    expect(fxChain).toBeDefined();
    const plugins = getFxPlugins(fxChain);
    expect(plugins).toHaveLength(1);
  });

  it("does nothing when resolved chain is empty and track has no FXCHAIN", () => {
    const root = parseRpp(readFixture("special-characters.rpp"));
    const tracks = getTracks(root);
    const track = tracks[1];
    const childCountBefore = track.children.length;

    applyResolvedChainToTrack(track, []);

    expect(track.children.length).toBe(childCountBefore);
  });

  it("replaces multiple plugins", () => {
    const root = parseRpp(readFixture("single-track-with-fx.rpp"));
    const track = getTracks(root)[0];

    const newChain = [
      makeFx("AU: EQ (Generic)", "AU", "EQBLOB"),
      makeFx("AU: Compressor (Generic)", "AU", "COMPBLOB"),
      makeFx("AU: Limiter (Generic)", "AU", "LIMBLOB"),
    ];

    applyResolvedChainToTrack(track, newChain);

    const plugins = getFxPlugins(getFxChain(track)!);
    expect(plugins).toHaveLength(3);
    expect(getFxPluginName(plugins[0])).toBe("AU: EQ (Generic)");
    expect(getFxPluginName(plugins[1])).toBe("AU: Compressor (Generic)");
    expect(getFxPluginName(plugins[2])).toBe("AU: Limiter (Generic)");
  });

  it("includes AU component identifiers in the plugin opening line", () => {
    const root = parseRpp(readFixture("single-track-with-fx.rpp"));
    const track = getTracks(root)[0];

    const newChain: FxFingerprint[] = [
      {
        pluginName: "AU: kHs Bitcrush (Kilohearts)",
        pluginType: "AU",
        stateHash: "hash_test",
        slotId: "khs-bitcrush",
        pluginParams: ["Kilohearts: kHs Bitcrush", "", 1635083896, 1802723939, 543901811],
        parameters: {},
      },
    ];

    applyResolvedChainToTrack(track, newChain);

    // Serialize and verify the AU opening line has all component identifiers
    const wrapper = { kind: "node" as const, token: "REAPER_PROJECT", params: [], children: [track] };
    const serialized = serializeRpp(wrapper);
    expect(serialized).toContain('"AU: kHs Bitcrush (Kilohearts)" "Kilohearts: kHs Bitcrush"');
    expect(serialized).toContain("1635083896");
    expect(serialized).toContain("1802723939");
    expect(serialized).toContain("543901811");
  });
});
