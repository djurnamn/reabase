import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { inspectTrack, applyChunk, setPreset, savePreset, snapshotTrack, deletePreset, revertPlugin, updatePresets } from "../../src/commands/bridge.js";
import { resolve } from "node:path";

const FIXTURES = resolve(import.meta.dirname, "../fixtures");

function readFixture(name: string): string {
  return readFileSync(resolve(FIXTURES, name), "utf-8");
}

let tempDir: string;
let reabasePath: string;

beforeEach(() => {
  tempDir = join(tmpdir(), `reabase-bridge-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  reabasePath = join(tempDir, ".reabase");
  mkdirSync(join(reabasePath, "presets", "fx"), { recursive: true });
  mkdirSync(join(reabasePath, "snapshots"), { recursive: true });
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

/** Write a preset YAML and its rfxchain file */
function writePreset(
  name: string,
  rfxChainContent: string,
  options?: { extends?: string; description?: string }
): void {
  writeFileSync(
    join(reabasePath, "presets", `${name}.yaml`),
    [
      `name: ${name}`,
      options?.description ? `description: ${options.description}` : null,
      options?.extends ? `extends: ${options.extends}` : null,
      `fxChainFile: fx/${name}.rfxchain`,
    ]
      .filter(Boolean)
      .join("\n") + "\n",
    "utf-8"
  );

  writeFileSync(
    join(reabasePath, "presets", "fx", `${name}.rfxchain`),
    rfxChainContent,
    "utf-8"
  );
}

// A minimal track chunk as SWS would return it
const TRACK_CHUNK_NO_ROLE = `<TRACK {66595AAC-8084-8049-8F26-93FAE19A27C6}
  NAME BJÖRN
  PEAKCOL 17236731
  BEAT -1
  AUTOMODE 0
  VOLPAN 1 0 -1 -1 1
  MUTESOLO 0 0 0
  ISBUS 0 0
  NCHAN 6
  FX 1
  TRACKID {66595AAC-8084-8049-8F26-93FAE19A27C6}
  MAINSEND 1 0
>`;

const TRACK_CHUNK_WITH_ROLE = `<TRACK {66595AAC-8084-8049-8F26-93FAE19A27C6}
  NAME BJÖRN
  PEAKCOL 17236731
  BEAT -1
  AUTOMODE 0
  VOLPAN 1 0 -1 -1 1
  MUTESOLO 0 0 0
  ISBUS 0 0
  NCHAN 6
  FX 1
  TRACKID {66595AAC-8084-8049-8F26-93FAE19A27C6}
  MAINSEND 1 0
  <FXCHAIN
    SHOW 0
    LASTSEL -1
    DOCKED 0
    BYPASS 0 0 0
    <AU "AU: T-De-Esser 2 (Techivation)" "Techivation: T-De-Esser 2" "" 1635083896 1415869293 1415930728
      6QMAAAAAAAACAAAAAQAAAAAAAAACAAAAAAAAAAIAAAABAAAAAAAAAAIAAAAAAAAAswUAAA==
    >
    FLOATPOS 0 0 0 0
    FXID {07EC70AF-D570-084D-ABA9-825C6F0C365C}
    WAK 0 0
  >
  <EXT
    reabase_preset player_voice
  >
>`;

describe("inspectTrack", () => {
  it("reports no-preset when track has no preset assigned", () => {
    const result = inspectTrack(TRACK_CHUNK_NO_ROLE, reabasePath);
    expect(result.trackName).toBe("BJÖRN");
    expect(result.trackGuid).toBe("{66595AAC-8084-8049-8F26-93FAE19A27C6}");
    expect(result.preset).toBeUndefined();
    expect(result.status).toBe("no-preset");
    expect(result.merge).toBeNull();
  });

  it("lists available presets", () => {
    const rfxContent = [
      "BYPASS 0 0 0",
      '<AU "AU: T-De-Esser 2 (Techivation)" "" "" 0 "" ""',
      "  6QMAAAAAAAACAAAAAQAAAAAAAAACAAAAAAAAAAIAAAABAAAAAAAAAAIAAAAAAAAAswUAAA==",
      ">",
      "FLOATPOS 0 0 0 0",
      "FXID {00000000-0000-0000-0000-000000000000}",
      "WAK 0 0",
    ].join("\n");

    writePreset("player_voice", rfxContent, { description: "Base voice" });

    const result = inspectTrack(TRACK_CHUNK_NO_ROLE, reabasePath);
    expect(result.presets).toHaveLength(1);
    expect(result.presets[0].name).toBe("player_voice");
    expect(result.presets[0].description).toBe("Base voice");
  });

  it("reports no-snapshot for track with role but no prior sync", () => {
    const rfxContent = [
      "BYPASS 0 0 0",
      '<AU "AU: T-De-Esser 2 (Techivation)" "" "" 0 "" ""',
      "  6QMAAAAAAAACAAAAAQAAAAAAAAACAAAAAAAAAAIAAAABAAAAAAAAAAIAAAAAAAAAswUAAA==",
      ">",
      "FLOATPOS 0 0 0 0",
      "FXID {00000000-0000-0000-0000-000000000000}",
      "WAK 0 0",
    ].join("\n");

    writePreset("player_voice", rfxContent);

    const result = inspectTrack(TRACK_CHUNK_WITH_ROLE, reabasePath);
    expect(result.preset).toBe("player_voice");
    expect(result.status).toBe("no-snapshot");
    expect(result.merge).not.toBeNull();
  });

  it("reports unresolvable-preset for unknown role", () => {
    const result = inspectTrack(TRACK_CHUNK_WITH_ROLE, reabasePath);
    expect(result.status).toBe("unresolvable-preset");
  });

  it("includes inheritanceChain and resolvedChain when preset is assigned", () => {
    const rfxContent = [
      "BYPASS 0 0 0",
      '<AU "AU: T-De-Esser 2 (Techivation)" "" "" 0 "" ""',
      "  6QMAAAAAAAACAAAAAQAAAAAAAAACAAAAAAAAAAIAAAABAAAAAAAAAAIAAAAAAAAAswUAAA==",
      ">",
      "FLOATPOS 0 0 0 0",
      "FXID {00000000-0000-0000-0000-000000000000}",
      "WAK 0 0",
    ].join("\n");

    writePreset("player_voice", rfxContent);

    const result = inspectTrack(TRACK_CHUNK_WITH_ROLE, reabasePath);
    expect(result.inheritanceChain).toEqual(["player_voice"]);
    expect(result.resolvedChain).not.toBeNull();
    expect(result.resolvedChain!).toHaveLength(1);
    expect(result.resolvedChain![0].pluginName).toBe("AU: T-De-Esser 2 (Techivation)");
    expect(result.resolvedChain![0].origin).toBe("player_voice");
  });

  it("returns empty inheritanceChain and null resolvedChain for no-preset", () => {
    const result = inspectTrack(TRACK_CHUNK_NO_ROLE, reabasePath);
    expect(result.inheritanceChain).toEqual([]);
    expect(result.resolvedChain).toBeNull();
  });

  it("returns empty inheritanceChain and null resolvedChain for unresolvable preset", () => {
    const result = inspectTrack(TRACK_CHUNK_WITH_ROLE, reabasePath);
    expect(result.status).toBe("unresolvable-preset");
    expect(result.inheritanceChain).toEqual([]);
    expect(result.resolvedChain).toBeNull();
  });

  it("captures current FX chain from track chunk", () => {
    const result = inspectTrack(TRACK_CHUNK_WITH_ROLE, reabasePath);
    expect(result.currentChain).toHaveLength(1);
    expect(result.currentChain[0].pluginName).toBe(
      "AU: T-De-Esser 2 (Techivation)"
    );
  });
});

describe("applyChunk", () => {
  it("applies a resolved FX chain to a track chunk", () => {
    const resolvedChain = [
      {
        pluginName: "AU: kHs Limiter (Kilohearts)",
        pluginType: "AU",
        stateHash: "abc",
        stateBlob: "LIMITERSTATE==",
        slotId: "khs-limiter",
      },
    ];

    const result = applyChunk({
      trackChunk: TRACK_CHUNK_WITH_ROLE,
      resolvedChain,
    });

    expect(result.modifiedChunk).toContain("<TRACK");
    expect(result.modifiedChunk).toContain("kHs Limiter");
    expect(result.modifiedChunk).toContain("LIMITERSTATE==");
    // Original De-Esser should be gone
    expect(result.modifiedChunk).not.toContain("T-De-Esser 2");
  });

  it("preserves non-FX track properties", () => {
    const resolvedChain = [
      {
        pluginName: "AU: EQ (Generic)",
        pluginType: "AU",
        stateHash: "abc",
        stateBlob: "EQSTATE==",
        slotId: "eq",
      },
    ];

    const result = applyChunk({
      trackChunk: TRACK_CHUNK_WITH_ROLE,
      resolvedChain,
    });

    expect(result.modifiedChunk).toContain("NAME BJÖRN");
    expect(result.modifiedChunk).toContain("PEAKCOL 17236731");
    expect(result.modifiedChunk).toContain("reabase_preset");
  });
});

describe("setPreset", () => {
  it("sets preset on a track without existing preset", () => {
    const result = setPreset({
      trackChunk: TRACK_CHUNK_NO_ROLE,
      preset: "ambient",
    });

    expect(result.modifiedChunk).toContain("reabase_preset");
    expect(result.modifiedChunk).toContain("ambient");
  });

  it("changes existing preset", () => {
    const result = setPreset({
      trackChunk: TRACK_CHUNK_WITH_ROLE,
      preset: "narrator",
    });

    expect(result.modifiedChunk).toContain("narrator");
    expect(result.modifiedChunk).not.toContain("player_voice");
  });
});

describe("savePreset", () => {
  it("saves entire FX chain when no selectedPlugins", () => {
    const result = savePreset(
      { trackChunk: TRACK_CHUNK_WITH_ROLE, presetName: "full_chain" },
      reabasePath
    );

    expect(result.success).toBe(true);
    expect(result.presetName).toBe("full_chain");
    expect(result.fxChainFile).toBe("fx/full_chain.rfxchain");

    // Check YAML was written
    const yaml = readFileSync(join(reabasePath, "presets", "full_chain.yaml"), "utf-8");
    expect(yaml).toContain("name: full_chain");
    expect(yaml).toContain("fxChainFile: fx/full_chain.rfxchain");

    // Check rfxchain was written
    const rfx = readFileSync(join(reabasePath, "presets", "fx", "full_chain.rfxchain"), "utf-8");
    expect(rfx).toContain("T-De-Esser 2");
  });

  it("saves only selected plugins when selectedPlugins provided", () => {
    const result = savePreset(
      { trackChunk: TRACK_CHUNK_WITH_ROLE, presetName: "partial", selectedPlugins: [0] },
      reabasePath
    );

    expect(result.success).toBe(true);
    expect(result.fxChainFile).toBe("fx/partial.rfxchain");

    const rfx = readFileSync(join(reabasePath, "presets", "fx", "partial.rfxchain"), "utf-8");
    expect(rfx).toContain("T-De-Esser 2");
  });

  it("saves with extendsPreset in YAML", () => {
    // First create a parent preset
    writePreset("parent_voice", [
      "BYPASS 0 0 0",
      '<AU "AU: T-De-Esser 2 (Techivation)" "" "" 0 "" ""',
      "  AAAA/AA==",
      ">",
      "FLOATPOS 0 0 0 0",
      "FXID {00000000-0000-0000-0000-000000000000}",
      "WAK 0 0",
    ].join("\n"));

    const result = savePreset(
      {
        trackChunk: TRACK_CHUNK_WITH_ROLE,
        presetName: "child_voice",
        selectedPlugins: [0],
        extendsPreset: "parent_voice",
      },
      reabasePath
    );

    expect(result.success).toBe(true);

    const yaml = readFileSync(join(reabasePath, "presets", "child_voice.yaml"), "utf-8");
    expect(yaml).toContain("extends: parent_voice");
    expect(yaml).toContain("fxChainFile:");
  });

  it("saves pure extends (no additions) when selectedPlugins is empty", () => {
    writePreset("parent_voice", [
      "BYPASS 0 0 0",
      '<AU "AU: T-De-Esser 2 (Techivation)" "" "" 0 "" ""',
      "  AAAA/AA==",
      ">",
      "FLOATPOS 0 0 0 0",
      "FXID {00000000-0000-0000-0000-000000000000}",
      "WAK 0 0",
    ].join("\n"));

    const result = savePreset(
      {
        trackChunk: TRACK_CHUNK_WITH_ROLE,
        presetName: "pure_child",
        selectedPlugins: [],
        extendsPreset: "parent_voice",
      },
      reabasePath
    );

    expect(result.success).toBe(true);
    expect(result.fxChainFile).toBeUndefined();

    const yaml = readFileSync(join(reabasePath, "presets", "pure_child.yaml"), "utf-8");
    expect(yaml).toContain("extends: parent_voice");
    expect(yaml).not.toContain("fxChainFile");
  });

  it("returns exists:true when preset with same slug already exists", () => {
    // Save once
    savePreset(
      { trackChunk: TRACK_CHUNK_WITH_ROLE, presetName: "dupe_test" },
      reabasePath
    );

    // Save again with same name — should fail with exists:true
    const result = savePreset(
      { trackChunk: TRACK_CHUNK_WITH_ROLE, presetName: "dupe_test" },
      reabasePath
    );

    expect(result.success).toBe(false);
    expect(result.exists).toBe(true);
  });

  it("overwrites when overwrite flag is set", () => {
    savePreset(
      { trackChunk: TRACK_CHUNK_WITH_ROLE, presetName: "overwrite_test" },
      reabasePath
    );

    const result = savePreset(
      { trackChunk: TRACK_CHUNK_WITH_ROLE, presetName: "overwrite_test", overwrite: true },
      reabasePath
    );

    expect(result.success).toBe(true);
    expect(result.exists).toBeUndefined();
  });
});

describe("deletePreset", () => {
  it("deletes an existing preset", () => {
    savePreset(
      { trackChunk: TRACK_CHUNK_WITH_ROLE, presetName: "to_delete" },
      reabasePath
    );

    const result = deletePreset({ presetName: "to_delete" }, reabasePath);
    expect(result.success).toBe(true);
    expect(result.deleted).toBe(true);

    // Files should be gone
    expect(() =>
      readFileSync(join(reabasePath, "presets", "to_delete.yaml"))
    ).toThrow();
  });

  it("returns deleted:false for non-existent preset", () => {
    const result = deletePreset({ presetName: "does_not_exist" }, reabasePath);
    expect(result.success).toBe(false);
    expect(result.deleted).toBe(false);
  });
});

describe("roundtrip: save → assign → snapshot → inspect", () => {
  it("chunk survives serialize → parse roundtrip", () => {
    // setPreset serializes and the result should be re-parseable
    const { modifiedChunk } = setPreset({
      trackChunk: TRACK_CHUNK_WITH_ROLE,
      preset: "test_preset",
    });

    // Should be re-parseable (this would fail with the old trackEnd bug)
    const result2 = setPreset({
      trackChunk: modifiedChunk,
      preset: "another_preset",
    });

    expect(result2.modifiedChunk).toContain("another_preset");
    expect(result2.modifiedChunk).toContain("<TRACK");
    expect(result2.modifiedChunk).toContain("NAME BJÖRN");
  });

  it("applyChunk output survives re-parse", () => {
    const resolvedChain = [
      {
        pluginName: "AU: kHs Limiter (Kilohearts)",
        pluginType: "AU",
        stateHash: "abc",
        stateBlob: "LIMITERSTATE==",
        slotId: "khs-limiter",
      },
    ];

    const { modifiedChunk } = applyChunk({
      trackChunk: TRACK_CHUNK_WITH_ROLE,
      resolvedChain,
    });

    // The modified chunk should survive another roundtrip
    const result2 = applyChunk({
      trackChunk: modifiedChunk,
      resolvedChain,
    });

    expect(result2.modifiedChunk).toContain("kHs Limiter");
  });

  it("save preset then inspect shows up-to-date with multi-line state blob", () => {
    // Track with a realistic multi-line state blob (like real AU plugins)
    const MULTILINE_CHUNK = `<TRACK {AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE}
  NAME TEST
  PEAKCOL 17236731
  BEAT -1
  AUTOMODE 0
  VOLPAN 1 0 -1 -1 1
  MUTESOLO 0 0 0
  ISBUS 0 0
  NCHAN 6
  FX 1
  TRACKID {AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE}
  MAINSEND 1 0
  <FXCHAIN
    SHOW 0
    LASTSEL -1
    DOCKED 0
    BYPASS 0 0 0
    <AU "AU: kHs Delay (Kilohearts)" "Kilohearts: kHs Delay" "" 1635083896 1802724460 543901811
      6QMAAAAAAAACAAAAAQAAAAAAAAACAAAAAAAAAAIAAAABAAAAAAAAAAIAAAAAAAAAFAUAADw/eG1sIHZlcnNpb249IjEuMCIgZW5jb2Rpbmc9IlVURi04Ij8+
      MS4wIj4KPGRpY3Q+Cgk8a2V5PmRhdGE8L2tleT4KCTxkYXRhPgoJVUVzREJCUUFDQWdJQUtXZ2JGd0FBQUFB
      aGRHVXVhbk52YmxCTEJRWUFBQUFBQVFBQkFEZ0FBQUFZQWdBQQoJQUFBPQoJPC9kYXRhPgo=
    >
    FLOATPOS 0 0 0 0
    FXID {07EC70AF-D570-084D-ABA9-825C6F0C365C}
    WAK 0 0
  >
>`;

    // 1. Save the track's FX chain as a new preset
    savePreset(
      { trackChunk: MULTILINE_CHUNK, presetName: "multiline_test" },
      reabasePath
    );

    // 2. Assign the preset
    const { modifiedChunk: chunkWithPreset } = setPreset({
      trackChunk: MULTILINE_CHUNK,
      preset: "multiline_test",
    });

    // 3. Snapshot
    const snapResult = snapshotTrack(
      { trackChunk: chunkWithPreset, preset: "multiline_test" },
      reabasePath
    );
    expect(snapResult.success).toBe(true);

    // 4. Inspect the snapshotted chunk — should be up-to-date
    const inspectResult = inspectTrack(snapResult.modifiedChunk, reabasePath);
    expect(inspectResult.status).toBe("up-to-date");
  });

  it("save preset then inspect shows up-to-date (no false conflict)", () => {
    // 1. Save the track's FX chain as a new preset (full chain, raw fidelity)
    savePreset(
      { trackChunk: TRACK_CHUNK_WITH_ROLE, presetName: "my_preset" },
      reabasePath
    );

    // 2. Assign the preset to the track
    const { modifiedChunk: chunkWithPreset } = setPreset({
      trackChunk: TRACK_CHUNK_WITH_ROLE,
      preset: "my_preset",
    });

    // 3. Snapshot (creates baseline)
    const snapResult = snapshotTrack(
      { trackChunk: chunkWithPreset, preset: "my_preset" },
      reabasePath
    );

    expect(snapResult.success).toBe(true);

    // 4. Inspect should show up-to-date (NOT conflict)
    const inspectResult = inspectTrack(snapResult.modifiedChunk, reabasePath);

    expect(inspectResult.preset).toBe("my_preset");
    expect(inspectResult.status).toBe("up-to-date");
  });
});

describe("revertPlugin", () => {
  it("reverts a modified plugin back to preset state", () => {
    const rfxContent = [
      "BYPASS 0 0 0",
      '<AU "AU: T-De-Esser 2 (Techivation)" "" "" 0 "" ""',
      "  6QMAAAAAAAACAAAAAQAAAAAAAAACAAAAAAAAAAIAAAABAAAAAAAAAAIAAAAAAAAAswUAAA==",
      ">",
      "FLOATPOS 0 0 0 0",
      "FXID {00000000-0000-0000-0000-000000000000}",
      "WAK 0 0",
    ].join("\n");

    writePreset("player_voice", rfxContent);

    // Save and snapshot first to establish baseline
    const { modifiedChunk: assigned } = setPreset({
      trackChunk: TRACK_CHUNK_WITH_ROLE,
      preset: "player_voice",
    });

    const snapResult = snapshotTrack(
      { trackChunk: assigned, preset: "player_voice" },
      reabasePath
    );

    // Now revert the de-esser plugin
    const result = revertPlugin(
      { trackChunk: snapResult.modifiedChunk, slotId: "t-de-esser-2" },
      reabasePath
    );

    expect(result.modifiedChunk).toContain("T-De-Esser 2");
    expect(result.modifiedChunk).toContain("<TRACK");
  });

  it("throws for unknown slotId", () => {
    const rfxContent = [
      "BYPASS 0 0 0",
      '<AU "AU: T-De-Esser 2 (Techivation)" "" "" 0 "" ""',
      "  6QMAAAAAAAACAAAAAQAAAAAAAAACAAAAAAAAAAIAAAABAAAAAAAAAAIAAAAAAAAAswUAAA==",
      ">",
      "FLOATPOS 0 0 0 0",
      "FXID {00000000-0000-0000-0000-000000000000}",
      "WAK 0 0",
    ].join("\n");

    writePreset("player_voice", rfxContent);

    const { modifiedChunk: assigned } = setPreset({
      trackChunk: TRACK_CHUNK_WITH_ROLE,
      preset: "player_voice",
    });

    const snapResult = snapshotTrack(
      { trackChunk: assigned, preset: "player_voice" },
      reabasePath
    );

    expect(() =>
      revertPlugin(
        { trackChunk: snapResult.modifiedChunk, slotId: "nonexistent" },
        reabasePath
      )
    ).toThrow("not found");
  });
});

describe("updatePresets", () => {
  it("updates a root preset with current track state", () => {
    const rfxContent = [
      "BYPASS 0 0 0",
      '<AU "AU: T-De-Esser 2 (Techivation)" "" "" 0 "" ""',
      "  6QMAAAAAAAACAAAAAQAAAAAAAAACAAAAAAAAAAIAAAABAAAAAAAAAAIAAAAAAAAAswUAAA==",
      ">",
      "FLOATPOS 0 0 0 0",
      "FXID {00000000-0000-0000-0000-000000000000}",
      "WAK 0 0",
    ].join("\n");

    writePreset("player_voice", rfxContent);

    const { modifiedChunk: assigned } = setPreset({
      trackChunk: TRACK_CHUNK_WITH_ROLE,
      preset: "player_voice",
    });

    const snapResult = snapshotTrack(
      { trackChunk: assigned, preset: "player_voice" },
      reabasePath
    );

    const result = updatePresets(
      {
        trackChunk: snapResult.modifiedChunk,
        ownership: { player_voice: ["t-de-esser-2"] },
        released: [],
      },
      reabasePath
    );

    expect(result.success).toBe(true);
    expect(result.updatedPresets).toContain("player_voice");
    expect(result.modifiedChunk).toContain("<TRACK");

    // Check that the preset YAML was updated
    const yaml = readFileSync(join(reabasePath, "presets", "player_voice.yaml"), "utf-8");
    expect(yaml).toContain("name: player_voice");
    expect(yaml).toContain("plugins:");
  });
});
