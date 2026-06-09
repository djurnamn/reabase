// Per-source (per-tab) pull: pulling upstream changes for ONE source of a
// composed preset, independently of the other sources. See
// HANDOFF-PER-SOURCE-SYNC.md for the design.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import YAML from "yaml";
import {
  inspectTrack,
  snapshotTrack,
  applyChunk,
  pullSource,
} from "../../src/commands/bridge.js";
import { buildSlotSourceMap } from "../../src/preset/membership.js";
import type { ParameterValue } from "../../src/snapshot/types.js";

let tempDir: string;
let reabasePath: string;

beforeEach(() => {
  tempDir = join(
    tmpdir(),
    `reabase-pull-source-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  reabasePath = join(tempDir, ".reabase");
  mkdirSync(join(reabasePath, "presets", "fx"), { recursive: true });
  mkdirSync(join(reabasePath, "snapshots"), { recursive: true });
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

// ─── fixtures ────────────────────────────────────────────────────

type Params = Record<string, ParameterValue>;

interface PluginSpec {
  pluginName: string;
  pluginType: string;
  slotId: string;
  fxid: string;
}

const EQ: PluginSpec = {
  pluginName: "AU: EQ (Vendor)",
  pluginType: "AU",
  slotId: "eq-band",
  fxid: "{00000000-0000-0000-0000-AAAAAAAAAAAA}",
};
const DEESS: PluginSpec = {
  pluginName: "AU: DeEss (Vendor)",
  pluginType: "AU",
  slotId: "de-esser",
  fxid: "{00000000-0000-0000-0000-BBBBBBBBBBBB}",
};

const eqOld: Params = { "0": { name: "gain", value: 0.5 } };
const eqNew: Params = { "0": { name: "gain", value: 0.8 } };
const eqLocalConflict: Params = { "0": { name: "gain", value: 0.3 } };
const deessOld: Params = { "0": { name: "thresh", value: 0.5 } };
const deessNew: Params = { "0": { name: "thresh", value: 0.8 } };
const deessLocal: Params = { "0": { name: "thresh", value: 0.3 } };

/** Write a plain preset (one plugin) with an explicit slotId. */
function writePlainPreset(
  name: string,
  plugin: PluginSpec,
  params: Params
): void {
  writeFileSync(
    join(reabasePath, "presets", `${name}.yaml`),
    YAML.stringify({
      name,
      fxChainFile: `fx/${name}.json`,
      plugins: [{ id: plugin.slotId }],
    }),
    "utf-8"
  );
  writeFileSync(
    join(reabasePath, "presets", "fx", `${name}.json`),
    JSON.stringify(
      [
        {
          pluginName: plugin.pluginName,
          pluginType: plugin.pluginType,
          slotId: plugin.slotId,
          parameters: params,
        },
      ],
      null,
      2
    ),
    "utf-8"
  );
}

/** Rewrite a plain preset's fx chain file (simulates an upstream push). */
function rewritePresetParams(
  name: string,
  plugin: PluginSpec,
  params: Params
): void {
  writeFileSync(
    join(reabasePath, "presets", "fx", `${name}.json`),
    JSON.stringify(
      [
        {
          pluginName: plugin.pluginName,
          pluginType: plugin.pluginType,
          slotId: plugin.slotId,
          parameters: params,
        },
      ],
      null,
      2
    ),
    "utf-8"
  );
}

/** Write a composed preset importing the given sources. */
function writeComposedPreset(name: string, imports: string[]): void {
  writeFileSync(
    join(reabasePath, "presets", `${name}.yaml`),
    YAML.stringify({ name, imports }),
    "utf-8"
  );
}

/** Build a track chunk with the given plugins, in order. */
function trackChunk(guid: string, preset: string, plugins: PluginSpec[]): string {
  const blocks = plugins
    .map(
      (p) => `    BYPASS 0 0 0
    <${p.pluginType} "${p.pluginName}" "" "" 0 "" ""
    >
    FLOATPOS 0 0 0 0
    FXID ${p.fxid}
    WAK 0 0`
    )
    .join("\n");

  return `<TRACK ${guid}
  NAME TEST
  PEAKCOL 17236731
  BEAT -1
  AUTOMODE 0
  VOLPAN 1 0 -1 -1 1
  MUTESOLO 0 0 0
  ISBUS 0 0
  NCHAN 6
  FX 1
  TRACKID ${guid}
  MAINSEND 1 0
  <FXCHAIN
    SHOW 0
    LASTSEL -1
    DOCKED 0
${blocks}
  >
  <EXT
    reabase_preset ${preset}
  >
>`;
}

const GUID = "{AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE}";

function actionFor(merge: NonNullable<ReturnType<typeof inspectTrack>["merge"]>, slotId: string) {
  return merge.actions.find((a) => "fx" in a && a.fx?.slotId === slotId);
}

/**
 * Set up `voice` = imports [eq, deess], snapshot the track at a clean
 * baseline, and return the snapshotted chunk (with slot map). The optional
 * upstream params rewrite each source's preset file AFTER the baseline so the
 * track is "behind".
 */
function setupBaseline(): string {
  writePlainPreset("eq", EQ, eqOld);
  writePlainPreset("deess", DEESS, deessOld);
  writeComposedPreset("voice", ["eq", "deess"]);

  const chunk = trackChunk(GUID, "voice", [EQ, DEESS]);
  const snap = snapshotTrack(
    { trackChunk: chunk, preset: "voice", fxParameters: [eqOld, deessOld] },
    reabasePath
  );
  expect(snap.success).toBe(true);

  // Sanity: clean baseline reads up-to-date.
  const before = inspectTrack(snap.modifiedChunk, reabasePath, [eqOld, deessOld]);
  expect(before.status).toBe("up-to-date");

  return snap.modifiedChunk;
}

// ─── tests ───────────────────────────────────────────────────────

describe("buildSlotSourceMap", () => {
  it("attributes resolved slots and snapshot-only (removed) slots", () => {
    const map = buildSlotSourceMap(
      [
        { slotId: "a", origin: "eq" } as any,
        { slotId: "b", origin: "deess" } as any,
      ],
      [
        { slotId: "a", origin: "eq" } as any,
        { slotId: "gone", origin: "deess" } as any, // removed upstream — snapshot-only
      ]
    );
    expect(map.get("a")).toBe("eq");
    expect(map.get("b")).toBe("deess");
    expect(map.get("gone")).toBe("deess");
  });

  it("lets the resolved chain win over the snapshot for the same slot", () => {
    const map = buildSlotSourceMap(
      [{ slotId: "a", origin: "new-source" } as any],
      [{ slotId: "a", origin: "old-source" } as any]
    );
    expect(map.get("a")).toBe("new-source");
  });
});

describe("pullSource", () => {
  it("pulls one source, leaving the other source's upstream change pending", () => {
    const baseChunk = setupBaseline();

    // Both sources change upstream.
    rewritePresetParams("eq", EQ, eqNew);
    rewritePresetParams("deess", DEESS, deessNew);

    // Both pending before the pull.
    const pending = inspectTrack(baseChunk, reabasePath, [eqOld, deessOld]);
    expect(pending.status).toBe("upstream-changes");
    expect(actionFor(pending.merge!, "eq-band")!.type).toBe("use_new_base");
    expect(actionFor(pending.merge!, "de-esser")!.type).toBe("use_new_base");

    // Pull ONLY the eq source.
    const pull = pullSource(
      { trackChunk: baseChunk, source: "eq", fxParameters: [eqOld, deessOld] },
      reabasePath
    );
    expect(pull.pulledSlots).toEqual(["eq-band"]);
    expect(pull.conflicts).toEqual([]);

    // Mirror the Lua flow: apply (pull already produced the chunk) then a
    // scoped re-snapshot over the pulled slots. eq is now at eqNew on track.
    const resnap = snapshotTrack(
      {
        trackChunk: pull.modifiedChunk,
        preset: "voice",
        fxParameters: [eqNew, deessOld],
        rebaselineSlots: pull.pulledSlots,
      },
      reabasePath
    );
    expect(resnap.success).toBe(true);

    // eq is up-to-date; deess is STILL behind.
    const after = inspectTrack(resnap.modifiedChunk, reabasePath, [eqNew, deessOld]);
    expect(after.status).toBe("upstream-changes");
    expect(actionFor(after.merge!, "eq-band")!.type).toBe("keep_base");
    expect(actionFor(after.merge!, "de-esser")!.type).toBe("use_new_base");
  });

  it("preserves a local edit on another source when pulling", () => {
    const baseChunk = setupBaseline();

    // Only eq changes upstream; deess is edited LOCALLY (track-side).
    rewritePresetParams("eq", EQ, eqNew);

    const pull = pullSource(
      { trackChunk: baseChunk, source: "eq", fxParameters: [eqOld, deessLocal] },
      reabasePath
    );
    expect(pull.pulledSlots).toEqual(["eq-band"]);
    expect(pull.conflicts).toEqual([]);

    // The deess slot's parameter map in the output still carries the local
    // edit — it was written back verbatim, not pulled or reverted.
    expect(pull.parameterMaps[1]).toEqual(deessLocal);
    // And eq's map carries the pulled upstream value.
    expect(pull.parameterMaps[0]).toEqual(eqNew);

    const resnap = snapshotTrack(
      {
        trackChunk: pull.modifiedChunk,
        preset: "voice",
        fxParameters: [eqNew, deessLocal],
        rebaselineSlots: pull.pulledSlots,
      },
      reabasePath
    );

    const after = inspectTrack(resnap.modifiedChunk, reabasePath, [eqNew, deessLocal]);
    // eq pulled (up-to-date); deess local edit survives as a local change.
    expect(actionFor(after.merge!, "eq-band")!.type).toBe("keep_base");
    expect(actionFor(after.merge!, "de-esser")!.type).toBe("keep_local");
  });

  it("surfaces a conflict on the pulled source instead of clobbering", () => {
    const baseChunk = setupBaseline();

    // eq changes upstream AND is edited locally to a DIFFERENT value on the
    // same param — an unmergeable conflict.
    rewritePresetParams("eq", EQ, eqNew);

    const pull = pullSource(
      {
        trackChunk: baseChunk,
        source: "eq",
        fxParameters: [eqLocalConflict, deessOld],
      },
      reabasePath
    );

    // The conflicting slot is surfaced, NOT pulled.
    expect(pull.conflicts).toEqual(["eq-band"]);
    expect(pull.pulledSlots).toEqual([]);
    // The local edit is left intact on the track (not clobbered to eqNew).
    expect(pull.parameterMaps[0]).toEqual(eqLocalConflict);
  });

  it("rejects a source that isn't part of the preset", () => {
    const baseChunk = setupBaseline();
    expect(() =>
      pullSource(
        { trackChunk: baseChunk, source: "not-a-source", fxParameters: [eqOld, deessOld] },
        reabasePath
      )
    ).toThrow(/not a source/);
  });

  it("errors when the track has no snapshot yet", () => {
    writePlainPreset("eq", EQ, eqOld);
    writePlainPreset("deess", DEESS, deessOld);
    writeComposedPreset("voice", ["eq", "deess"]);
    const chunk = trackChunk(GUID, "voice", [EQ, DEESS]);
    expect(() =>
      pullSource(
        { trackChunk: chunk, source: "eq", fxParameters: [eqOld, deessOld] },
        reabasePath
      )
    ).toThrow(/no snapshot/);
  });

  it("whole-track snapshot still re-baselines every source (no regression)", () => {
    const baseChunk = setupBaseline();

    rewritePresetParams("eq", EQ, eqNew);
    rewritePresetParams("deess", DEESS, deessNew);

    // Whole-track pull: apply the full resolved chain, then an UNSCOPED
    // snapshot — both sources should come up-to-date.
    const pending = inspectTrack(baseChunk, reabasePath, [eqOld, deessOld]);
    const applied = applyChunk({
      trackChunk: baseChunk,
      resolvedChain: pending.merge!.resolvedChain,
    });
    const resnap = snapshotTrack(
      {
        trackChunk: applied.modifiedChunk,
        preset: "voice",
        fxParameters: [eqNew, deessNew],
      },
      reabasePath
    );

    const after = inspectTrack(resnap.modifiedChunk, reabasePath, [eqNew, deessNew]);
    expect(after.status).toBe("up-to-date");
  });
});
