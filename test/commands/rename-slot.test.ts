import { describe, it, expect } from "vitest";
import { renameSlot } from "../../src/commands/bridge.js";
import { serializeSlotMap, buildSlotMap, parseSlotMap } from "../../src/slot/map.js";
import type { FxFingerprint } from "../../src/snapshot/types.js";

/** Helper: build a minimal track chunk with an FX chain and a stored slot
 *  map already wired in. */
function makeTrackChunk(slotMapJson: string): string {
  return `<TRACK {00000000-0000-0000-0000-000000000000}
NAME test
<FXCHAIN
SHOW 0
LASTSEL -1
DOCKED 0
BYPASS 0 0 0
<AU "AU: kHs Filter (Kilohearts)" "Kilohearts: kHs Filter" "" 0 0 0
>
FLOATPOS 0 0 0 0
FXID {00000000-0000-0000-0000-000000000000}
WAK 0 0
>
<EXT
reabase_slot_map ${slotMapJson}
>
>`;
}

describe("renameSlot", () => {
  function chunkWithMap(): string {
    const fp: FxFingerprint = {
      pluginName: "AU: kHs Filter (Kilohearts)",
      pluginType: "AU",
      slotId: "khs-filter",
      stateHash: "hash_v1",
      parameters: {},
    };
    return makeTrackChunk(serializeSlotMap(buildSlotMap([fp])));
  }

  it("sets a label on a slot map entry", () => {
    const result = renameSlot({
      trackChunk: chunkWithMap(),
      slotId: "khs-filter",
      label: "Aggressive low-cut",
    });

    // Pull the slot map back out of the modified chunk and verify.
    const match = result.modifiedChunk.match(/reabase_slot_map\s+(\S+)/);
    const map = parseSlotMap(match![1])!;
    expect(map["khs-filter"].label).toBe("Aggressive low-cut");
  });

  it("clears a label when called with empty string", () => {
    // First, set a label.
    const set = renameSlot({
      trackChunk: chunkWithMap(),
      slotId: "khs-filter",
      label: "Bass cut",
    });

    // Then clear it.
    const cleared = renameSlot({
      trackChunk: set.modifiedChunk,
      slotId: "khs-filter",
      label: "",
    });

    const match = cleared.modifiedChunk.match(/reabase_slot_map\s+(\S+)/);
    const map = parseSlotMap(match![1])!;
    expect(map["khs-filter"].label).toBeUndefined();
  });

  it("throws when the slot map is missing", () => {
    const chunk = `<TRACK {00000000-0000-0000-0000-000000000000}
NAME test
<FXCHAIN
SHOW 0
LASTSEL -1
DOCKED 0
>
>`;
    expect(() =>
      renameSlot({ trackChunk: chunk, slotId: "khs-filter", label: "x" })
    ).toThrow(/no slot map yet/);
  });

  it("throws when the slot is not in the map", () => {
    expect(() =>
      renameSlot({
        trackChunk: chunkWithMap(),
        slotId: "ghost-slot",
        label: "x",
      })
    ).toThrow(/Slot 'ghost-slot' not found/);
  });
});
