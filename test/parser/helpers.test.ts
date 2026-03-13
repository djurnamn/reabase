import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  parseRpp,
  getTracks,
  getTrackName,
  getTrackGuid,
  getTrackFolderDepth,
  getFxChain,
  getFxPlugins,
  getFxPluginName,
  getFxPluginType,
  getFxId,
  getFxStateBlob,
  getFxBypass,
  getAuxReceives,
  getExtState,
  setExtState,
  findChildNode,
} from "../../src/parser/index.js";

const FIXTURES = resolve(import.meta.dirname, "../fixtures");

function readFixture(name: string): string {
  return readFileSync(resolve(FIXTURES, name), "utf-8");
}

describe("track helpers", () => {
  const root = parseRpp(readFixture("multi-track-with-routing.rpp"));
  const tracks = getTracks(root);

  it("getTracks returns all tracks", () => {
    expect(tracks.length).toBe(5);
  });

  it("getTrackName returns the track name", () => {
    expect(getTrackName(tracks[0])).toBe("RÖSTER");
    expect(getTrackName(tracks[1])).toBe("BJÖRN");
    expect(getTrackName(tracks[2])).toBe("SARA");
  });

  it("getTrackGuid returns the GUID", () => {
    expect(getTrackGuid(tracks[0])).toBe(
      "{671234FF-7BC7-B845-9501-56DE16B1DDFA}"
    );
  });

  it("getTrackFolderDepth identifies folder tracks", () => {
    // RÖSTER: ISBUS 1 1 (opens folder)
    const roster = getTrackFolderDepth(tracks[0]);
    expect(roster?.depthChange).toBe(1);

    // BJÖRN: ISBUS 0 0 (regular track)
    const bjorn = getTrackFolderDepth(tracks[1]);
    expect(bjorn?.depthChange).toBe(0);

    // SARA: ISBUS 2 -1 (closes folder)
    const sara = getTrackFolderDepth(tracks[2]);
    expect(sara?.depthChange).toBe(-1);
  });
});

describe("FX chain helpers", () => {
  const root = parseRpp(readFixture("single-track-with-fx.rpp"));
  const track = getTracks(root)[0];
  const fxChain = getFxChain(track)!;

  it("getFxChain returns the FX chain", () => {
    expect(fxChain).toBeDefined();
    expect(fxChain.token).toBe("FXCHAIN");
  });

  it("getFxPlugins returns plugin nodes", () => {
    const plugins = getFxPlugins(fxChain);
    expect(plugins.length).toBe(1);
    expect(plugins[0].token).toBe("AU");
  });

  it("getFxPluginName returns the display name", () => {
    const plugins = getFxPlugins(fxChain);
    expect(getFxPluginName(plugins[0])).toBe(
      "AU: T-De-Esser 2 (Techivation)"
    );
  });

  it("getFxPluginType returns the plugin type", () => {
    const plugins = getFxPlugins(fxChain);
    expect(getFxPluginType(plugins[0])).toBe("AU");
  });

  it("getFxId returns the FXID GUID", () => {
    expect(getFxId(fxChain, 0)).toBe(
      "{07EC70AF-D570-084D-ABA9-825C6F0C365C}"
    );
  });

  it("getFxStateBlob returns base64 data", () => {
    const plugins = getFxPlugins(fxChain);
    const blob = getFxStateBlob(plugins[0]);
    expect(blob).toContain("6QMAAAA");
  });

  it("getFxBypass returns the bypass state", () => {
    const bypass = getFxBypass(fxChain, 0);
    expect(bypass).toBeDefined();
    expect(bypass?.token).toBe("BYPASS");
    expect(bypass?.params).toEqual([0, 0, 0]);
  });
});

describe("routing helpers", () => {
  const root = parseRpp(readFixture("multi-track-with-routing.rpp"));
  const tracks = getTracks(root);

  it("getAuxReceives returns routing info", () => {
    const vinbar = tracks[4]; // VINBAR track with AUXRECV
    const receives = getAuxReceives(vinbar);

    expect(receives.length).toBe(1);
    expect(receives[0].sourceTrackIndex).toBe(0);
    expect(receives[0].volume).toBe(1);
  });

  it("returns empty array for tracks without routing", () => {
    const bjorn = tracks[1];
    const receives = getAuxReceives(bjorn);
    expect(receives).toEqual([]);
  });
});

describe("ext state helpers", () => {
  const root = parseRpp(readFixture("special-characters.rpp"));
  const tracks = getTracks(root);
  const track = tracks[0]; // FLICKA MED SOLROS

  it("getExtState reads from EXT blocks in items", () => {
    const item = findChildNode(track, "ITEM")!;
    const value = getExtState(item, "nvk_take_source_type_v2");
    expect(value).toBe("WAVE");
  });

  it("getExtState returns undefined for missing keys", () => {
    const item = findChildNode(track, "ITEM")!;
    const value = getExtState(item, "nonexistent_key");
    expect(value).toBeUndefined();
  });

  it("setExtState creates an EXT block if needed", () => {
    // Use a track without an EXT block
    const dorrTrack = tracks[1]; // DÖRR
    setExtState(dorrTrack, "reabase_preset", "test_role");

    const value = getExtState(dorrTrack, "reabase_preset");
    expect(value).toBe("test_role");
  });

  it("setExtState updates existing values", () => {
    const dorrTrack = tracks[1];
    setExtState(dorrTrack, "reabase_preset", "updated_role");

    const value = getExtState(dorrTrack, "reabase_preset");
    expect(value).toBe("updated_role");
  });
});
