// All tests in this file are skipped during phase 2 of the composition
// rollout. They test the retired single-inheritance bridge surface
// (extends/override/add/remove + unlinkOverride/linkAsOverride). Phase 3
// rewrites bridge.ts on top of the composition resolver and replaces these
// tests with the equivalent behaviors under the new schema.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { inspectTrack, applyChunk, setPreset, savePreset, snapshotTrack, deletePreset, revertPlugin, updatePresets, unlinkOverride, linkAsOverride } from "../../src/commands/bridge.js";
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

/** Write a preset YAML and its JSON preset file */
function writePreset(
  name: string,
  jsonContent: object[],
  options?: { extends?: string; description?: string }
): void {
  writeFileSync(
    join(reabasePath, "presets", `${name}.yaml`),
    [
      `name: ${name}`,
      options?.description ? `description: ${options.description}` : null,
      options?.extends ? `extends: ${options.extends}` : null,
      `fxChainFile: fx/${name}.json`,
    ]
      .filter(Boolean)
      .join("\n") + "\n",
    "utf-8"
  );

  writeFileSync(
    join(reabasePath, "presets", "fx", `${name}.json`),
    JSON.stringify(jsonContent, null, 2),
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

describe.skip("inspectTrack", () => {
  it("reports no-preset when track has no preset assigned", () => {
    const result = inspectTrack(TRACK_CHUNK_NO_ROLE, reabasePath);
    expect(result.trackName).toBe("BJÖRN");
    expect(result.trackGuid).toBe("{66595AAC-8084-8049-8F26-93FAE19A27C6}");
    expect(result.preset).toBeUndefined();
    expect(result.status).toBe("no-preset");
    expect(result.merge).toBeNull();
  });

  it("lists available presets", () => {
    const presetPlugins = [
      {
        pluginName: "AU: T-De-Esser 2 (Techivation)",
        pluginType: "AU",
        slotId: "t-de-esser-2",
        parameters: {},
      },
    ];

    writePreset("player_voice", presetPlugins, { description: "Base voice" });

    const result = inspectTrack(TRACK_CHUNK_NO_ROLE, reabasePath);
    expect(result.presets).toHaveLength(1);
    expect(result.presets[0].name).toBe("player_voice");
    expect(result.presets[0].description).toBe("Base voice");
  });

  it("reports no-snapshot for track with role but no prior sync", () => {
    const presetPlugins = [
      {
        pluginName: "AU: T-De-Esser 2 (Techivation)",
        pluginType: "AU",
        slotId: "t-de-esser-2",
        parameters: {},
      },
    ];

    writePreset("player_voice", presetPlugins);

    const result = inspectTrack(TRACK_CHUNK_WITH_ROLE, reabasePath);
    expect(result.preset).toBe("player_voice");
    expect(result.status).toBe("no-snapshot");
    expect(result.merge).not.toBeNull();
  });

  it("reports unresolvable-preset for unknown role", () => {
    const result = inspectTrack(TRACK_CHUNK_WITH_ROLE, reabasePath);
    expect(result.status).toBe("unresolvable-preset");
  });

  it("flags blob-only changes per-plugin as keep_local (Bug 4)", () => {
    // Reproducer for Bug 4: a plugin whose params haven't changed but
    // whose state blob has (e.g., RS5K loading a different sample).
    // Track-level status was already correct via the blob fallback; this
    // pins the per-plugin action so the UI row also surfaces "Modified
    // locally" instead of "Unchanged".
    const params = { "0": { name: "p", value: 0.5 } };

    const ORIGINAL_BLOB_CHUNK = `<TRACK {AAAAAAAA-1111-2222-3333-444444444444}
  NAME RS5K_TEST
  PEAKCOL 17236731
  BEAT -1
  AUTOMODE 0
  VOLPAN 1 0 -1 -1 1
  MUTESOLO 0 0 0
  ISBUS 0 0
  NCHAN 6
  FX 1
  TRACKID {AAAAAAAA-1111-2222-3333-444444444444}
  MAINSEND 1 0
  <FXCHAIN
    SHOW 0
    LASTSEL -1
    DOCKED 0
    BYPASS 0 0 0
    <AU "AU: ReaSamplOMatic5000 (Cockos)" "Cockos: ReaSamplOMatic5000" "" 0 "" ""
      U0FNUExFLU9SSUdJTkFMLUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUE=
    >
    FLOATPOS 0 0 0 0
    FXID {07EC70AF-D570-084D-ABA9-825C6F0C365C}
    WAK 0 0
  >
  <EXT
    reabase_preset rs5k_test
  >
>`;

    writePreset("rs5k_test", [
      { pluginName: "AU: ReaSamplOMatic5000 (Cockos)", pluginType: "AU", slotId: "reasamplomatic5000", parameters: params },
    ]);

    const snap = snapshotTrack(
      { trackChunk: ORIGINAL_BLOB_CHUNK, preset: "rs5k_test", fxParameters: [params] },
      reabasePath
    );
    expect(snap.success).toBe(true);

    // Same chunk but the plugin block's blob differs (sample swap).
    // Params (fxParameters) stay the same so stateHash matches — the only
    // signal of change is the stateBlob.
    const SAMPLE_SWAP_CHUNK = snap.modifiedChunk.replace(
      "U0FNUExFLU9SSUdJTkFMLUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUE=",
      "U0FNUExFLU5FV1NTU1NTU1NTU1NTU1NTU1NTU1NTU1NTU1NTU1NTU1NTU1NTU1NTU1NTU1NTU1NTU1NTU1NTU1NTU1NTU1NTU1NTU1NTU1NTU1NTU1NTU1NTU1NTU1NTU1NTU1M="
    );

    const result = inspectTrack(SAMPLE_SWAP_CHUNK, reabasePath, [params]);
    expect(result.status).toBe("modified");
    expect(result.merge).not.toBeNull();
    const samplerAction = result.merge!.actions.find(
      (a) => "fx" in a && a.fx?.slotId === "reasamplomatic5000"
    );
    expect(samplerAction).toBeDefined();
    expect(samplerAction!.type).toBe("keep_local");
  });

  it("preserves local tweak as divergence after merge_params apply (Bug 2 followup)", () => {
    // Reproducer for the apply-path half of Bug 2: when local tweaks one
    // param and the preset bumps a different one, threeWayMerge produces
    // a merge_params action with merged params. The fix has two halves:
    //   1. Apply the merged params to the track (Lua side).
    //   2. Snapshot using the PRESET's params for that slot, not the
    //      merged track params, so the local tweak remains visible as a
    //      local divergence on the next inspect (rather than getting
    //      baked into the baseline and then clobbered by use_new_base
    //      next sync — which is what the user observed).
    // This test exercises (2): the TS roundtrip that mirrors what Lua
    // does after the apply runs.
    const presetParams = { "0": { name: "threshold", value: 0.6 }, "1": { name: "ratio", value: 0.4 } };
    const localParamsBefore = { "0": { name: "threshold", value: 0.5 }, "1": { name: "ratio", value: 0.32 } };
    // After per-parameter merge: preset's threshold (0.6) + local's ratio (0.32).
    const mergedParams = { "0": { name: "threshold", value: 0.6 }, "1": { name: "ratio", value: 0.32 } };

    const TWO_PARAM_CHUNK = `<TRACK {AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE}
  NAME COMP_TEST
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
    <AU "AU: TestComp (TestVendor)" "TestVendor: TestComp" "" 0 "" ""
    >
    FLOATPOS 0 0 0 0
    FXID {07EC70AF-D570-084D-ABA9-825C6F0C365C}
    WAK 0 0
  >
  <EXT
    reabase_preset comp_test
  >
>`;

    // Initial preset has the original (pre-edit) params; both sides will
    // diverge from these so the merge fires per-parameter.
    const originalParams = { "0": { name: "threshold", value: 0.5 }, "1": { name: "ratio", value: 0.4 } };
    writePreset("comp_test", [
      { pluginName: "AU: TestComp (TestVendor)", pluginType: "AU", slotId: "testcomp", parameters: originalParams },
    ]);

    // Snapshot the track at the original preset state.
    const initialSnap = snapshotTrack(
      { trackChunk: TWO_PARAM_CHUNK, preset: "comp_test", fxParameters: [originalParams] },
      reabasePath
    );
    expect(initialSnap.success).toBe(true);

    // Upstream: preset bumps ratio to 0.4 (oh wait that's same — change to make it diverge).
    // Use presetParams which has threshold=0.6 (changed from 0.5).
    writeFileSync(
      join(reabasePath, "presets", "fx", "comp_test.json"),
      JSON.stringify([
        { pluginName: "AU: TestComp (TestVendor)", pluginType: "AU", slotId: "testcomp", parameters: presetParams },
      ], null, 2),
      "utf-8"
    );
    // Local: user has tweaked ratio (0.4 → 0.32) but kept threshold at 0.5.
    // Inspect should produce a merge_params action.
    const beforeApply = inspectTrack(initialSnap.modifiedChunk, reabasePath, [localParamsBefore]);
    expect(beforeApply.merge!.actions[0].type).toBe("merge_params");

    // Now mirror what Lua does after apply: resnapshot, but for the
    // merge_params slot pass the PRESET's params instead of the live merged
    // params. (In the real flow, Lua applies merged params to the track via
    // TrackFX_SetParam first; here we skip that since we're testing only
    // the snapshot baseline override.)
    const resnap = snapshotTrack(
      { trackChunk: initialSnap.modifiedChunk, preset: "comp_test", fxParameters: [presetParams] },
      reabasePath
    );
    expect(resnap.success).toBe(true);

    // The track itself still carries the merged state (ratio=local, threshold=preset);
    // re-inspecting with those params must report status "modified" so the
    // local ratio tweak is visible — and the action must be keep_local, not
    // use_new_base, so a subsequent sync wouldn't clobber it.
    const afterApply = inspectTrack(resnap.modifiedChunk, reabasePath, [mergedParams]);
    expect(afterApply.status).toBe("modified");
    const compAction = afterApply.merge!.actions.find(
      (a) => "fx" in a && a.fx?.slotId === "testcomp"
    );
    expect(compAction).toBeDefined();
    expect(compAction!.type).toBe("keep_local");
  });

  it("per-plugin revert clears that row's status while preserving other tweaks (revert_plugin followup)", () => {
    // Reproducer: track has two plugins, both tweaked locally. User clicks
    // the per-plugin "Revert to preset state" button on plugin A. The Lua
    // revert_plugin flow applies preset params to A via TrackFX_SetParam,
    // then writes a snapshot whose params equal the PRESET's params for
    // every preset-managed slot — clean baseline. Result: A resolves to
    // keep_base (Up to date), B remains keep_local (Modified locally).
    // Without the snapshot rewrite, A would still report keep_local because
    // the stale snapshot baseline carries A's old tweak.
    const presetA = { "0": { name: "p", value: 0.5 } };
    const presetB = { "0": { name: "p", value: 0.5 } };
    const tweakedA = { "0": { name: "p", value: 0.9 } };
    const tweakedB = { "0": { name: "p", value: 0.7 } };

    const TWO_PLUGIN_CHUNK = `<TRACK {AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE}
  NAME REVERT_TEST
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
    <AU "AU: PluginA (Vendor)" "Vendor: PluginA" "" 0 "" ""
    >
    FLOATPOS 0 0 0 0
    FXID {00000000-0000-0000-0000-AAAAAAAAAAAA}
    WAK 0 0
    BYPASS 0 0 0
    <AU "AU: PluginB (Vendor)" "Vendor: PluginB" "" 0 "" ""
    >
    FLOATPOS 0 0 0 0
    FXID {00000000-0000-0000-0000-BBBBBBBBBBBB}
    WAK 0 0
  >
  <EXT
    reabase_preset revert_test
  >
>`;

    writePreset("revert_test", [
      { pluginName: "AU: PluginA (Vendor)", pluginType: "AU", slotId: "plugina", parameters: presetA },
      { pluginName: "AU: PluginB (Vendor)", pluginType: "AU", slotId: "pluginb", parameters: presetB },
    ]);

    // First snapshot: capture the chunk while BOTH plugins are tweaked.
    // This is the realistic state for the bug — the user has been working
    // and the snapshot has drifted off the clean preset baseline.
    const snapWithTweaks = snapshotTrack(
      { trackChunk: TWO_PLUGIN_CHUNK, preset: "revert_test", fxParameters: [tweakedA, tweakedB] },
      reabasePath
    );
    expect(snapWithTweaks.success).toBe(true);

    // Mirror Lua revert_plugin: apply preset params to A, leave B tweaked,
    // and write a fresh snapshot using preset's params for ALL preset slots
    // (the capture_fx_parameters_as_preset_baseline equivalent).
    const resnap = snapshotTrack(
      { trackChunk: snapWithTweaks.modifiedChunk, preset: "revert_test", fxParameters: [presetA, presetB] },
      reabasePath
    );
    expect(resnap.success).toBe(true);

    // The track itself: A reverted to preset, B still tweaked.
    const result = inspectTrack(resnap.modifiedChunk, reabasePath, [presetA, tweakedB]);

    expect(result.status).toBe("modified");
    const aAction = result.merge!.actions.find((a) => "fx" in a && a.fx?.slotId === "plugina");
    const bAction = result.merge!.actions.find((a) => "fx" in a && a.fx?.slotId === "pluginb");
    expect(aAction?.type).toBe("keep_base");
    expect(bAction?.type).toBe("keep_local");
  });

  it("auto-baselines a duplicated preset-bound track when slot map matches (Bug 1)", () => {
    // Reproducer for Bug 1: a track is duplicated in REAPER, so its P_EXT
    // (reabase_preset, reabase_slot_map) and FX chain are copied verbatim
    // — but reabase has no snapshot at the new GUID. Without the fix, status
    // returns "no-snapshot" and the UI exposes a destructive "Apply preset
    // changes" button that clobbers the chain.
    // After the fix: when slot-map state hashes match the current chain,
    // status is "up-to-date" and a snapshot is auto-captured at the new GUID.
    const params = { "0": { name: "p", value: 0.5 } };

    writePreset("player_voice", [
      { pluginName: "AU: T-De-Esser 2 (Techivation)", pluginType: "AU", slotId: "t-de-esser-2", parameters: params },
    ]);

    // Step 1: snapshot the source track at its original GUID.
    const sourceSnap = snapshotTrack(
      { trackChunk: TRACK_CHUNK_WITH_ROLE, preset: "player_voice", fxParameters: [params] },
      reabasePath
    );
    expect(sourceSnap.success).toBe(true);

    // Step 2: simulate REAPER's track duplication — same chunk, same slot
    // map (carried via P_EXT), same preset, but a fresh GUID.
    const dupGuid = "{99999999-EEEE-FFFF-0000-111122223333}";
    const duplicatedChunk = sourceSnap.modifiedChunk
      .replace(/\{66595AAC-8084-8049-8F26-93FAE19A27C6\}/g, dupGuid);

    // Step 3: inspect the duplicate. With the Bug 1 fix this should be
    // up-to-date and a fresh snapshot file should appear at the new GUID.
    const dupGuidKey = dupGuid.replace(/[{}]/g, "").toLowerCase();
    const dupSnapshotPath = join(reabasePath, "snapshots", `${dupGuidKey}.json`);
    expect(existsSync(dupSnapshotPath)).toBe(false);

    const result = inspectTrack(duplicatedChunk, reabasePath, [params]);

    expect(result.status).toBe("up-to-date");
    expect(existsSync(dupSnapshotPath)).toBe(true);
  });

  it("includes inheritanceChain and resolvedChain when preset is assigned", () => {
    const presetPlugins = [
      {
        pluginName: "AU: T-De-Esser 2 (Techivation)",
        pluginType: "AU",
        slotId: "t-de-esser-2",
        parameters: {},
      },
    ];

    writePreset("player_voice", presetPlugins);

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

  it("detects reordered plugins as modified", () => {
    // Two-plugin track: Delay then Bitcrush
    const TWO_PLUGIN_CHUNK = `<TRACK {AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE}
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
    <AU "AU: kHs Delay (Kilohearts)" "" "" 0 "" ""
      AAAA==
    >
    FLOATPOS 0 0 0 0
    FXID {07EC70AF-D570-084D-ABA9-825C6F0C365C}
    WAK 0 0
    BYPASS 0 0 0
    <AU "AU: kHs Bitcrush (Kilohearts)" "" "" 0 "" ""
      BBBB==
    >
    FLOATPOS 0 0 0 0
    FXID {11111111-2222-3333-4444-555555555555}
    WAK 0 0
  >
  <EXT
    reabase_preset order_test
  >
>`;

    // Same plugins but swapped: Bitcrush then Delay
    const SWAPPED_CHUNK = `<TRACK {AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE}
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
    <AU "AU: kHs Bitcrush (Kilohearts)" "" "" 0 "" ""
      BBBB==
    >
    FLOATPOS 0 0 0 0
    FXID {11111111-2222-3333-4444-555555555555}
    WAK 0 0
    BYPASS 0 0 0
    <AU "AU: kHs Delay (Kilohearts)" "" "" 0 "" ""
      AAAA==
    >
    FLOATPOS 0 0 0 0
    FXID {07EC70AF-D570-084D-ABA9-825C6F0C365C}
    WAK 0 0
  >
  <EXT
    reabase_preset order_test
  >
>`;

    // Write preset with Delay then Bitcrush order
    const params = { "0": { name: "p", value: 0.5 } };
    writePreset("order_test", [
      { pluginName: "AU: kHs Delay (Kilohearts)", pluginType: "AU", slotId: "khs-delay", parameters: params },
      { pluginName: "AU: kHs Bitcrush (Kilohearts)", pluginType: "AU", slotId: "khs-bitcrush", parameters: params },
    ]);

    // Snapshot with original order (Delay, Bitcrush)
    const fxParams = [params, params];
    const snap = snapshotTrack(
      { trackChunk: TWO_PLUGIN_CHUNK, preset: "order_test", fxParameters: fxParams },
      reabasePath
    );
    expect(snap.success).toBe(true);

    // Inspect with swapped order — should detect as modified
    const result = inspectTrack(SWAPPED_CHUNK, reabasePath, fxParams);
    expect(result.status).toBe("modified");
  });

  it("flags upstream-only reorder as upstream-changes (Bug 3)", () => {
    // Reproducer for Bug 3 propagation half: when the preset has reordered
    // its plugins relative to a track's snapshot, but plugin params are
    // unchanged, the track must be flagged as "upstream-changes" so the
    // sync loop in update_and_sync_project propagates the reorder.
    // Previously, status returned "up-to-date" because the upstream-reorder
    // detection was gated behind hasUpstreamStateChanges.
    const TWO_PLUGIN_CHUNK = `<TRACK {AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE}
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
    <AU "AU: kHs Delay (Kilohearts)" "" "" 0 "" ""
      AAAA==
    >
    FLOATPOS 0 0 0 0
    FXID {07EC70AF-D570-084D-ABA9-825C6F0C365C}
    WAK 0 0
    BYPASS 0 0 0
    <AU "AU: kHs Bitcrush (Kilohearts)" "" "" 0 "" ""
      BBBB==
    >
    FLOATPOS 0 0 0 0
    FXID {11111111-2222-3333-4444-555555555555}
    WAK 0 0
  >
  <EXT
    reabase_preset reorder_only
  >
>`;

    const params = { "0": { name: "p", value: 0.5 } };
    const fxParams = [params, params];

    // Initial preset with order: Delay, Bitcrush
    writePreset("reorder_only", [
      { pluginName: "AU: kHs Delay (Kilohearts)", pluginType: "AU", slotId: "khs-delay", parameters: params },
      { pluginName: "AU: kHs Bitcrush (Kilohearts)", pluginType: "AU", slotId: "khs-bitcrush", parameters: params },
    ]);

    // Snapshot the track in the original order (matches preset)
    const snap = snapshotTrack(
      { trackChunk: TWO_PLUGIN_CHUNK, preset: "reorder_only", fxParameters: fxParams },
      reabasePath
    );
    expect(snap.success).toBe(true);

    // Confirm pre-reorder baseline is up-to-date
    const before = inspectTrack(snap.modifiedChunk, reabasePath, fxParams);
    expect(before.status).toBe("up-to-date");

    // Simulate upstream reorder: rewrite the preset with swapped order
    // and SAME params (pure reorder, no state change).
    writeFileSync(
      join(reabasePath, "presets", "fx", "reorder_only.json"),
      JSON.stringify([
        { pluginName: "AU: kHs Bitcrush (Kilohearts)", pluginType: "AU", slotId: "khs-bitcrush", parameters: params },
        { pluginName: "AU: kHs Delay (Kilohearts)", pluginType: "AU", slotId: "khs-delay", parameters: params },
      ], null, 2),
      "utf-8"
    );

    // Track B-equivalent inspect: track unchanged, preset reordered.
    // Must be flagged as upstream-changes so the sync loop processes it.
    const after = inspectTrack(snap.modifiedChunk, reabasePath, fxParams);
    expect(after.status).toBe("upstream-changes");
    expect(after.merge).not.toBeNull();
    // Resolved chain should reflect the new preset order
    expect(after.merge!.resolvedChain.map((fx) => fx.slotId)).toEqual([
      "khs-bitcrush",
      "khs-delay",
    ]);

    // Roundtrip: apply the resolved chain, re-snapshot, then re-inspect.
    // This mirrors what update_and_sync_project does for an other-track in
    // the structural-apply branch (apply_chunk → apply_chunk_and_parameters
    // → bridge.snapshot). Status must return to "up-to-date" — anything
    // else means the apply or snapshot path is corrupting state.
    const applied = applyChunk({
      trackChunk: snap.modifiedChunk,
      resolvedChain: after.merge!.resolvedChain,
    });
    const resnap = snapshotTrack(
      { trackChunk: applied.modifiedChunk, preset: "reorder_only", fxParameters: fxParams },
      reabasePath
    );
    expect(resnap.success).toBe(true);
    const final = inspectTrack(resnap.modifiedChunk, reabasePath, fxParams);
    expect(final.status).toBe("up-to-date");
  });
});

describe.skip("applyChunk", () => {
  it("applies a resolved FX chain to a track chunk", () => {
    const resolvedChain = [
      {
        pluginName: "AU: kHs Limiter (Kilohearts)",
        pluginType: "AU",
        stateHash: "abc",
        slotId: "khs-limiter",
        parameters: {},
      },
    ];

    const result = applyChunk({
      trackChunk: TRACK_CHUNK_WITH_ROLE,
      resolvedChain,
    });

    expect(result.modifiedChunk).toContain("<TRACK");
    expect(result.modifiedChunk).toContain("kHs Limiter");
    // Original De-Esser should be gone
    expect(result.modifiedChunk).not.toContain("T-De-Esser 2");
    // Should return parameter maps
    expect(result.parameterMaps).toHaveLength(1);
    expect(result.parameterMaps[0]).toEqual({});
  });

  it("preserves non-FX track properties", () => {
    const resolvedChain = [
      {
        pluginName: "AU: EQ (Generic)",
        pluginType: "AU",
        stateHash: "abc",
        slotId: "eq",
        parameters: {},
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

describe.skip("setPreset", () => {
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

describe.skip("savePreset", () => {
  it("saves entire FX chain when no selectedPlugins", () => {
    const result = savePreset(
      { trackChunk: TRACK_CHUNK_WITH_ROLE, presetName: "full_chain" },
      reabasePath
    );

    expect(result.success).toBe(true);
    expect(result.presetName).toBe("full_chain");
    expect(result.fxChainFile).toBe("fx/full_chain.json");

    // Check YAML was written
    const yaml = readFileSync(join(reabasePath, "presets", "full_chain.yaml"), "utf-8");
    expect(yaml).toContain("name: full_chain");
    expect(yaml).toContain("fxChainFile: fx/full_chain.json");

    // Check JSON preset was written
    const json = readFileSync(join(reabasePath, "presets", "fx", "full_chain.json"), "utf-8");
    const parsed = JSON.parse(json);
    expect(parsed).toBeInstanceOf(Array);
    expect(parsed[0].pluginName).toContain("T-De-Esser 2");
  });

  it("saves only selected plugins when selectedPlugins provided", () => {
    const result = savePreset(
      { trackChunk: TRACK_CHUNK_WITH_ROLE, presetName: "partial", selectedPlugins: [0] },
      reabasePath
    );

    expect(result.success).toBe(true);
    expect(result.fxChainFile).toBe("fx/partial.json");

    const json = readFileSync(join(reabasePath, "presets", "fx", "partial.json"), "utf-8");
    const parsed = JSON.parse(json);
    expect(parsed).toBeInstanceOf(Array);
    expect(parsed[0].pluginName).toContain("T-De-Esser 2");
  });

  it("saves with extendsPreset in YAML", () => {
    // First create a parent preset
    writePreset("parent_voice", [
      {
        pluginName: "AU: T-De-Esser 2 (Techivation)",
        pluginType: "AU",
        slotId: "t-de-esser-2",
        parameters: {},
      },
    ]);

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
      {
        pluginName: "AU: T-De-Esser 2 (Techivation)",
        pluginType: "AU",
        slotId: "t-de-esser-2",
        parameters: {},
      },
    ]);

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

describe.skip("deletePreset", () => {
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

describe.skip("roundtrip: save → assign → snapshot → inspect", () => {
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
        slotId: "khs-limiter",
        parameters: {},
      },
    ];

    const result = applyChunk({
      trackChunk: TRACK_CHUNK_WITH_ROLE,
      resolvedChain,
    });

    // The modified chunk should survive another roundtrip
    const result2 = applyChunk({
      trackChunk: result.modifiedChunk,
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

  it("partial selection save → assign → snapshot → inspect shows up-to-date", () => {
    // Track with 2 plugins, user saves only the first as a preset
    const TWO_PLUGIN_CHUNK = `<TRACK {AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE}
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
      6QMAAAAAAAACAAAAAQAAAAAAAAACAAAAAAAAAAIAAAABAAAAAAAAAAIAAAAAAAAAFAUAADw/eG1s
      aGRHVXVhbk52YmxCTEJRWUFBQUFBQVFBQkFEZ0FBQUFZQWdBQQoJQUFBPQo=
    >
    FLOATPOS 0 0 0 0
    FXID {07EC70AF-D570-084D-ABA9-825C6F0C365C}
    WAK 0 0
    BYPASS 0 0 0
    <AU "AU: kHs Bitcrush (Kilohearts)" "Kilohearts: kHs Bitcrush" "" 1635083896 1802723939 543901811
      6QMAAAAAAAACAAAAAQAAAAAAAAACAAAAAAAAAAIAAAABAAAAAAAAAAIAAAAAAAAA6gQAADw/eG1s
      aGRHVXVhbk52YmxCTEJRWUFBQUFBQVFBQkFEZ0FBQUFZQWdBQQoJQUFBPQo=
    >
    FLOATPOS 0 0 0 0
    FXID {11111111-2222-3333-4444-555555555555}
    WAK 0 0
  >
>`;

    // 1. Save only the first plugin (index 0) as a preset
    const saveResult = savePreset(
      { trackChunk: TWO_PLUGIN_CHUNK, presetName: "parent_preset", selectedPlugins: [0] },
      reabasePath
    );
    expect(saveResult.success).toBe(true);

    // 2. Assign the preset
    const { modifiedChunk: chunkWithPreset } = setPreset({
      trackChunk: TWO_PLUGIN_CHUNK,
      preset: "parent_preset",
    });

    // 3. Snapshot
    const snapResult = snapshotTrack(
      { trackChunk: chunkWithPreset, preset: "parent_preset" },
      reabasePath
    );
    expect(snapResult.success).toBe(true);

    // 4. Inspect should show modified (unmanaged plugins on the track are local deviations)
    const inspectResult = inspectTrack(snapResult.modifiedChunk, reabasePath);
    expect(inspectResult.status).toBe("modified");
  });
});

describe.skip("roundtrip: two-track sync flow", () => {
  it("propagates upstream preset changes from track A to track B via updatePresets", () => {
    // Two tracks with different GUIDs, both carrying the same AU plugin
    const TRACK_A_CHUNK = `<TRACK {11111111-AAAA-BBBB-CCCC-111111111111}
  NAME TRACK_A
  PEAKCOL 17236731
  BEAT -1
  AUTOMODE 0
  VOLPAN 1 0 -1 -1 1
  MUTESOLO 0 0 0
  ISBUS 0 0
  NCHAN 6
  FX 1
  TRACKID {11111111-AAAA-BBBB-CCCC-111111111111}
  MAINSEND 1 0
  <FXCHAIN
    SHOW 0
    LASTSEL -1
    DOCKED 0
    BYPASS 0 0 0
    <AU "AU: kHs Delay (Kilohearts)" "Kilohearts: kHs Delay" "" 1635083896 1802724460 543901811
      6QMAAAAAAAACAAAAAQAAAAAAAAACAAAAAAAAAAIAAAABAAAAAAAAAAIAAAAAAAAAFAUAADw/
      eG1sIHZlcnNpb249IjEuMCIgZW5jb2Rpbmc9IlVURi04Ij8+CjxkZWxheT4KICA8cGFy
      YW1zPgogICAgPHRpbWU+MC41PC90aW1lPgogICAgPGZlZWRiYWNrPjAuMzwvZmVlZGJh
      Y2s+CiAgPC9wYXJhbXM+CjwvZGVsYXk+Cg==
    >
    FLOATPOS 0 0 0 0
    FXID {AAAA1111-2222-3333-4444-AAAAAAAAAAAA}
    WAK 0 0
  >
>`;

    const TRACK_B_CHUNK = `<TRACK {22222222-DDDD-EEEE-FFFF-222222222222}
  NAME TRACK_B
  PEAKCOL 17236731
  BEAT -1
  AUTOMODE 0
  VOLPAN 1 0 -1 -1 1
  MUTESOLO 0 0 0
  ISBUS 0 0
  NCHAN 6
  FX 1
  TRACKID {22222222-DDDD-EEEE-FFFF-222222222222}
  MAINSEND 1 0
  <FXCHAIN
    SHOW 0
    LASTSEL -1
    DOCKED 0
    BYPASS 0 0 0
    <AU "AU: kHs Delay (Kilohearts)" "Kilohearts: kHs Delay" "" 1635083896 1802724460 543901811
      6QMAAAAAAAACAAAAAQAAAAAAAAACAAAAAAAAAAIAAAABAAAAAAAAAAIAAAAAAAAAFAUAADw/
      eG1sIHZlcnNpb249IjEuMCIgZW5jb2Rpbmc9IlVURi04Ij8+CjxkZWxheT4KICA8cGFy
      YW1zPgogICAgPHRpbWU+MC41PC90aW1lPgogICAgPGZlZWRiYWNrPjAuMzwvZmVlZGJh
      Y2s+CiAgPC9wYXJhbXM+CjwvZGVsYXk+Cg==
    >
    FLOATPOS 0 0 0 0
    FXID {BBBB1111-2222-3333-4444-BBBBBBBBBBBB}
    WAK 0 0
  >
>`;

    // Step 1: Save the plugin from track A as a preset
    const saveResult = savePreset(
      { trackChunk: TRACK_A_CHUNK, presetName: "shared_delay" },
      reabasePath
    );
    expect(saveResult.success).toBe(true);

    // Step 2: Assign the preset to both tracks
    const { modifiedChunk: trackAWithPreset } = setPreset({
      trackChunk: TRACK_A_CHUNK,
      preset: "shared_delay",
    });
    const { modifiedChunk: trackBWithPreset } = setPreset({
      trackChunk: TRACK_B_CHUNK,
      preset: "shared_delay",
    });

    // Step 3: Snapshot both tracks
    const snapA = snapshotTrack(
      { trackChunk: trackAWithPreset, preset: "shared_delay" },
      reabasePath
    );
    expect(snapA.success).toBe(true);

    const snapB = snapshotTrack(
      { trackChunk: trackBWithPreset, preset: "shared_delay" },
      reabasePath
    );
    expect(snapB.success).toBe(true);

    // Verify both tracks are up-to-date before any modifications
    const inspectABefore = inspectTrack(snapA.modifiedChunk, reabasePath);
    expect(inspectABefore.status).toBe("up-to-date");
    const inspectBBefore = inspectTrack(snapB.modifiedChunk, reabasePath);
    expect(inspectBBefore.status).toBe("up-to-date");

    // Step 4: Simulate upstream change by directly rewriting the preset's
    // JSON file with modified parameters. In the real flow, Lua captures
    // parameters via TrackFX_GetParam and updatePresets writes them to the
    // preset file. Here we simulate the end result: the preset file now has
    // different parameter values than when both tracks were snapshotted.
    const modifiedPresetContent = JSON.stringify([
      {
        pluginName: "AU: kHs Delay (Kilohearts)",
        pluginType: "AU",
        slotId: "khs-delay",
        parameters: {
          "0": { name: "Time", value: 0.8 },
          "1": { name: "Feedback", value: 0.6 },
        },
      },
    ], null, 2);
    writeFileSync(
      join(reabasePath, "presets", "fx", "shared_delay.json"),
      modifiedPresetContent,
      "utf-8"
    );

    // Step 5: Inspect track B — it should show "upstream-changes"
    // because the preset file was updated but track B still
    // has the old snapshot (with empty parameters)
    const inspectBAfterUpdate = inspectTrack(snapB.modifiedChunk, reabasePath);
    expect(inspectBAfterUpdate.status).toBe("upstream-changes");
    expect(inspectBAfterUpdate.merge).not.toBeNull();
    expect(inspectBAfterUpdate.merge!.resolvedChain.length).toBeGreaterThan(0);

    // The merge's resolved chain should carry the updated parameters from the preset
    const mergedDelay = inspectBAfterUpdate.merge!.resolvedChain.find(
      (fx) => fx.pluginName.includes("kHs Delay")
    );
    expect(mergedDelay).toBeDefined();
    expect(mergedDelay!.parameters["0"]).toEqual({ name: "Time", value: 0.8 });

    // Note: Full resolution back to "up-to-date" requires Lua to apply the
    // parameters via TrackFX_SetParam and re-capture them before snapshotting.
    // That end-to-end flow is tested at the Lua integration level.
  });
});

describe.skip("revertPlugin", () => {
  it("reverts a modified plugin back to preset state", () => {
    const presetPlugins = [
      {
        pluginName: "AU: T-De-Esser 2 (Techivation)",
        pluginType: "AU",
        slotId: "t-de-esser-2",
        parameters: {},
      },
    ];

    writePreset("player_voice", presetPlugins);

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

    // revertPlugin now returns parameterMap and pluginIndex, NOT modifiedChunk
    expect(result.parameterMap).toBeDefined();
    expect(result.pluginIndex).toBe(0);
  });

  it("throws for unknown slotId", () => {
    const presetPlugins = [
      {
        pluginName: "AU: T-De-Esser 2 (Techivation)",
        pluginType: "AU",
        slotId: "t-de-esser-2",
        parameters: {},
      },
    ];

    writePreset("player_voice", presetPlugins);

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

describe.skip("updatePresets", () => {
  it("updates a root preset with current track state", () => {
    const presetPlugins = [
      {
        pluginName: "AU: T-De-Esser 2 (Techivation)",
        pluginType: "AU",
        slotId: "t-de-esser-2",
        parameters: {},
      },
    ];

    writePreset("player_voice", presetPlugins);

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

describe.skip("unlinkOverride", () => {
  const params1 = { "0": { name: "drive", value: 0.3 } };
  const params2 = { "0": { name: "drive", value: 0.8 } };

  function setupParentChildWithOverride() {
    // Parent preset: one Bitcrush plugin
    writeFileSync(
      join(reabasePath, "presets", "parent.yaml"),
      "name: parent\nfxChainFile: fx/parent.json\nplugins:\n  - id: bitcrush\n",
      "utf-8"
    );
    writeFileSync(
      join(reabasePath, "presets", "fx", "parent.json"),
      JSON.stringify([{
        pluginName: "AU: kHs Bitcrush (Kilohearts)",
        pluginType: "AU",
        slotId: "bitcrush",
        parameters: params1,
      }], null, 2),
      "utf-8"
    );

    // Child preset: overrides parent's bitcrush slot with different params
    writeFileSync(
      join(reabasePath, "presets", "fx", "child_bitcrush.json"),
      JSON.stringify(params2, null, 2),
      "utf-8"
    );
    writeFileSync(
      join(reabasePath, "presets", "child.yaml"),
      "name: child\nextends: parent\noverride:\n  bitcrush:\n    stateFile: fx/child_bitcrush.json\n",
      "utf-8"
    );
  }

  it("converts an override into a separate addition", () => {
    setupParentChildWithOverride();

    // Create a track with the child preset assigned and a slot map
    const TRACK = `<TRACK {CCCCCCCC-DDDD-EEEE-FFFF-111111111111}
  NAME TEST
  PEAKCOL 17236731
  BEAT -1
  AUTOMODE 0
  VOLPAN 1 0 -1 -1 1
  MUTESOLO 0 0 0
  ISBUS 0 0
  NCHAN 6
  FX 1
  TRACKID {CCCCCCCC-DDDD-EEEE-FFFF-111111111111}
  MAINSEND 1 0
  <FXCHAIN
    SHOW 0
    LASTSEL -1
    DOCKED 0
    BYPASS 0 0 0
    <AU "AU: kHs Bitcrush (Kilohearts)" "" "" 0 "" ""
      AAAA==
    >
    FLOATPOS 0 0 0 0
    FXID {07EC70AF-D570-084D-ABA9-825C6F0C365C}
    WAK 0 0
  >
  <EXT
    reabase_preset child
  >
>`;

    // First snapshot to establish slot map
    const snap = snapshotTrack(
      { trackChunk: TRACK, preset: "child", fxParameters: [params2] },
      reabasePath
    );

    const result = unlinkOverride(
      { trackChunk: snap.modifiedChunk, slotId: "bitcrush", fxParameters: [params2] },
      reabasePath
    );

    expect(result.success).toBe(true);
    expect(result.newSlotId).not.toBe("bitcrush");
    expect(result.modifiedChunk).toContain("<TRACK");

    // Child YAML should no longer have override, should have add
    const childYaml = readFileSync(join(reabasePath, "presets", "child.yaml"), "utf-8");
    expect(childYaml).not.toContain("override:");
    expect(childYaml).toContain("add:");
    expect(childYaml).toContain(result.newSlotId);
  });

  it("throws for slotId not in any override", () => {
    setupParentChildWithOverride();

    const TRACK = `<TRACK {CCCCCCCC-DDDD-EEEE-FFFF-111111111111}
  NAME TEST
  TRACKID {CCCCCCCC-DDDD-EEEE-FFFF-111111111111}
  MAINSEND 1 0
  <EXT
    reabase_preset child
  >
>`;

    expect(() =>
      unlinkOverride({ trackChunk: TRACK, slotId: "nonexistent" }, reabasePath)
    ).toThrow("not found");
  });
});

describe.skip("linkAsOverride", () => {
  const params1 = { "0": { name: "drive", value: 0.3 } };
  const params2 = { "0": { name: "drive", value: 0.8 } };

  function setupParentChildWithAddition() {
    // Parent preset: one Bitcrush
    writeFileSync(
      join(reabasePath, "presets", "parent.yaml"),
      "name: parent\nfxChainFile: fx/parent.json\nplugins:\n  - id: bitcrush\n",
      "utf-8"
    );
    writeFileSync(
      join(reabasePath, "presets", "fx", "parent.json"),
      JSON.stringify([{
        pluginName: "AU: kHs Bitcrush (Kilohearts)",
        pluginType: "AU",
        slotId: "bitcrush",
        parameters: params1,
      }], null, 2),
      "utf-8"
    );

    // Child preset: adds a second Bitcrush (as a separate addition)
    writeFileSync(
      join(reabasePath, "presets", "child.yaml"),
      "name: child\nextends: parent\nfxChainFile: fx/child.json\nadd:\n  - id: bitcrush-2\n    after: bitcrush\n",
      "utf-8"
    );
    writeFileSync(
      join(reabasePath, "presets", "fx", "child.json"),
      JSON.stringify([{
        pluginName: "AU: kHs Bitcrush (Kilohearts)",
        pluginType: "AU",
        slotId: "bitcrush-2",
        parameters: params2,
      }], null, 2),
      "utf-8"
    );
  }

  it("converts an addition into an override of a parent slot", () => {
    setupParentChildWithAddition();

    const TRACK = `<TRACK {CCCCCCCC-DDDD-EEEE-FFFF-222222222222}
  NAME TEST
  PEAKCOL 17236731
  BEAT -1
  AUTOMODE 0
  VOLPAN 1 0 -1 -1 1
  MUTESOLO 0 0 0
  ISBUS 0 0
  NCHAN 6
  FX 1
  TRACKID {CCCCCCCC-DDDD-EEEE-FFFF-222222222222}
  MAINSEND 1 0
  <FXCHAIN
    SHOW 0
    LASTSEL -1
    DOCKED 0
    BYPASS 0 0 0
    <AU "AU: kHs Bitcrush (Kilohearts)" "" "" 0 "" ""
      AAAA==
    >
    FLOATPOS 0 0 0 0
    FXID {07EC70AF-D570-084D-ABA9-825C6F0C365C}
    WAK 0 0
    BYPASS 0 0 0
    <AU "AU: kHs Bitcrush (Kilohearts)" "" "" 0 "" ""
      BBBB==
    >
    FLOATPOS 0 0 0 0
    FXID {11111111-2222-3333-4444-555555555555}
    WAK 0 0
  >
  <EXT
    reabase_preset child
  >
>`;

    const result = linkAsOverride(
      {
        trackChunk: TRACK,
        childSlotId: "bitcrush-2",
        parentSlotId: "bitcrush",
        fxParameters: [params1, params2],
      },
      reabasePath
    );

    expect(result.success).toBe(true);
    expect(result.modifiedChunk).toContain("<TRACK");
    // Should have 1 plugin now (override replaces, doesn't add)
    expect(result.parameterMaps).toHaveLength(1);

    // Child YAML should have override, not add
    const childYaml = readFileSync(join(reabasePath, "presets", "child.yaml"), "utf-8");
    expect(childYaml).toContain("override:");
    expect(childYaml).toContain("bitcrush:");
    expect(childYaml).not.toContain("add:");
  });

  it("throws for mismatched plugin types", () => {
    // Parent: Bitcrush, Child adds: Delay
    writeFileSync(
      join(reabasePath, "presets", "parent.yaml"),
      "name: parent\nfxChainFile: fx/parent.json\nplugins:\n  - id: bitcrush\n",
      "utf-8"
    );
    writeFileSync(
      join(reabasePath, "presets", "fx", "parent.json"),
      JSON.stringify([{
        pluginName: "AU: kHs Bitcrush (Kilohearts)",
        pluginType: "AU",
        slotId: "bitcrush",
        parameters: params1,
      }], null, 2),
      "utf-8"
    );
    writeFileSync(
      join(reabasePath, "presets", "child.yaml"),
      "name: child\nextends: parent\nfxChainFile: fx/child.json\nadd:\n  - id: delay\n    after: bitcrush\n",
      "utf-8"
    );
    writeFileSync(
      join(reabasePath, "presets", "fx", "child.json"),
      JSON.stringify([{
        pluginName: "AU: kHs Delay (Kilohearts)",
        pluginType: "AU",
        slotId: "delay",
        parameters: params2,
      }], null, 2),
      "utf-8"
    );

    const TRACK = `<TRACK {CCCCCCCC-DDDD-EEEE-FFFF-333333333333}
  NAME TEST
  TRACKID {CCCCCCCC-DDDD-EEEE-FFFF-333333333333}
  MAINSEND 1 0
  <EXT
    reabase_preset child
  >
>`;

    expect(() =>
      linkAsOverride(
        { trackChunk: TRACK, childSlotId: "delay", parentSlotId: "bitcrush" },
        reabasePath
      )
    ).toThrow("plugin types differ");
  });
});
