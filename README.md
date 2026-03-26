# reabase

Manage REAPER FX chains as reusable, updatable dependencies across projects.

## Motivation

As developers, we're used to DRY principles — extract common logic, reference it as a dependency, update it in one place. But in a DAW, presets are a starting point, not a living reference. Once you apply a preset to a track and tweak it, the connection is lost. There's no way to push an improved EQ curve to every track that uses it, or pull upstream changes without overwriting your local adjustments.

**reabase** brings dependency management to REAPER. Define canonical FX chain presets, assign them to tracks across projects, and propagate updates — like a package manager for your signal chains. Local track-level tweaks are preserved through a three-way merge, so per-track adjustments aren't lost when the upstream preset improves.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  REAPER (Lua UI)                                        │
│  lua/reabase.lua ──── lua/lib/bridge.lua ─── JSON IPC ──┼─┐
└─────────────────────────────────────────────────────────┘ │
                                                            ▼
┌─────────────────────────────────────────────────────────────┐
│  CLI (TypeScript)                    src/cli.ts             │
│  ┌─────────────┐  ┌────────────┐  ┌─────────────┐           │
│  │  Commands   │  │  Commands  │  │  Commands   │           │
│  │  sync       │  │  status    │  │  bridge     │           │
│  │  init       │  │  compute   │  │  apply      │           │
│  └─────┬───────┘  └─────┬──────┘  └─────┬───────┘           │
│        │                │               │                   │
│  ┌─────▼────────────────▼───────────────▼───────┐           │
│  │              Logic Layer                     │           │
│  │  ┌───────────┐ ┌──────────┐ ┌──────────────┐ │           │
│  │  │ snapshot/ │ │  merge/  │ │   preset/    │ │           │
│  │  │ capture   │ │ three-   │ │  loader      │ │           │
│  │  │ diff      │ │ way      │ │  resolver    │ │           │
│  │  │ store     │ │          │ │  rfxchain    │ │           │
│  │  └───────────┘ └──────────┘ └──────────────┘ │           │
│  │  ┌──────────┐                                │           │
│  │  │  slot/   │                                │           │
│  │  │ identity │                                │           │
│  │  │ map      │                                │           │
│  │  └──────────┘                                │           │
│  └─────────────────────┬────────────────────────┘           │
│                        │                                    │
│  ┌─────────────────────▼────────────────────────┐           │
│  │            Parser Layer                      │           │
│  │  src/parser/ — RPP parse/serialize           │           │
│  │  (round-trip fidelity)                       │           │
│  └──────────────────────────────────────────────┘           │
└─────────────────────────────────────────────────────────────┘
```

### Layer responsibilities

**Parser** (`src/parser/`) — Reads and writes REAPER's `.RPP` project format into an AST. Preserves exact whitespace, line endings, and unrecognized content for lossless round-tripping. Base64 blob lines (plugin state) are classified as raw data using a length heuristic to distinguish them from RPP struct tokens.

**Snapshot** (`src/snapshot/`) — Captures the current FX chain state of a track as an array of `FxFingerprint` objects. Each fingerprint records the plugin name, type, parameters (for hashing), the raw state blob (for restoration), and a slot ID. Snapshots are stored as JSON and serve as the "old base" for three-way merges.

**Preset** (`src/preset/`) — Loads YAML preset definitions, resolves inheritance chains (child presets can extend parents with overrides, removals, and additions), and parses JSON preset files. The resolver produces a `ResolvedPreset` with a fully-computed FX chain and a version hash.

**Merge** (`src/merge/`) — Implements a three-way merge algorithm. Given an old snapshot (what was last applied), a new preset (what should be applied), and the current track state (what the user has now), it produces a merge result that preserves local tweaks while applying upstream changes. Conflicts are detected when both sides modified the same plugin differently.

**Slot** (`src/slot/`) — Provides stable identity for FX plugins. Plugins are identified by human-readable slugs derived from their names (e.g., `"AU: T-De-Esser 2 (Techivation)"` becomes `t-de-esser-2`). A slot map stored in REAPER's per-track extended state (`P_EXT`) allows slot IDs to survive plugin reordering.

**Commands** (`src/commands/`) — CLI operations that compose the lower layers: `init`, `status`, `sync`, `compute`, `bridge` (Lua IPC), `apply`, and preset management commands.

**Lua UI** (`lua/`) — A ReaImGui-based interface running inside REAPER that communicates with the CLI via JSON over stdin/stdout pipes.

## Key data types

### FxFingerprint

Represents the state of a single FX plugin instance on a track:

```typescript
{
  pluginName: string;      // "AU: T-De-Esser 2 (Techivation)"
  pluginType: string;      // "AU" | "VST" | "VST3" | "JS" | "DX"
  stateHash: string;       // SHA-256 of parameter values (rounded to 6dp)
  parameters: Record<string, ParameterValue>;  // {name, value} per param index
  stateBlob?: string;      // Base64-encoded raw plugin state (for full restoration)
  slotId: string;          // Stable identity: "t-de-esser-2"
}
```

The `stateHash` is computed from parameter values (deterministic). The `stateBlob` is used for full state restoration (including AU modular plugin configurations like Snap Heap module routing).

### Snapshot

A point-in-time record of a track's FX chain, stored as JSON in `.reabase/snapshots/`:

```typescript
{
  version: 1;
  trackGuid: string;
  trackName: string;
  preset: string;           // Which preset was applied
  presetVersion: string;    // Hash of the resolved preset at capture time
  capturedAt: string;
  fxChain: FxFingerprint[];
}
```

### PresetDefinition

A YAML file in `.reabase/presets/` defining an FX chain template:

```yaml
# Root preset
name: player_voice
fxChainFile: fx/player_voice.json
plugins:
  - id: de-esser
  - id: creative-multiband
  - id: corrective-multiband
  - id: limiter
```

```yaml
# Child preset with inheritance
name: player_voice_male
extends: player_voice
override:
  creative-multiband:
    stateFile: fx/multiband-male.json
remove:
  - corrective-multiband
add:
  - id: exciter
    after: de-esser
```

## How sync works

### 1. Status check (`reabase status`)

For each track in your REAPER projects that has a `reabase_preset` ext state:

1. Load the last snapshot (what was applied)
2. Resolve the current preset definition (applying inheritance)
3. Capture the track's current FX chain from the RPP file
4. Diff snapshot vs. current → local changes
5. Diff snapshot vs. preset → upstream changes
6. Report: `up-to-date` | `modified` | `upstream-changes` | `conflict`

### 2. Sync planning (`reabase sync`)

For each out-of-date track, run a three-way merge:

```
old base (snapshot)    new base (preset)    local (current track)
        \                    |                    /
         └──────── three-way merge ──────────────┘
                         │
                    MergeResult
```

Each plugin gets one of these actions:
- **keep_base** — unchanged everywhere
- **use_new_base** — only the preset changed, take the update
- **keep_local** — only the track changed, preserve the tweak
- **add_base** — new plugin added by preset
- **add_local** — new plugin added locally
- **remove** — plugin removed upstream, unchanged locally
- **remove_local** — plugin removed locally, unchanged in preset
- **conflict** — both sides changed differently (requires resolution)

### 3. Execution

After user confirmation:
1. Apply the merge result to each track's RPP chunk (including state blobs)
2. Apply parameters on top via `TrackFX_SetParam` (safety net)
3. Write a new snapshot
4. Update the slot map in the track's `P_EXT`
5. Back up the project file before writing

## State management

### Hybrid blob + params approach

Plugin state is captured and stored in two complementary forms:

- **Parameters** (`TrackFX_GetParam`) — Primary comparison/hashing mechanism. Values are rounded to 6 decimal places for float stability. Deterministic across instances.
- **State blobs** (from RPP chunk) — Full state restoration via `SetTrackStateChunk`. Preserves internal plugin state not exposed via parameters (e.g., Snap Heap module routing, multiband configurations). Also used as a secondary change detection: normalized blob comparison catches hidden state changes that parameter hashing misses.

**Change detection** uses both: parameter hash differences are detected first; if params match, normalized blob comparison detects internal state changes (module configurations, routing).

**State restoration** is tiered: parameter revert is attempted first (instant, no plugin recreation). If blobs still differ after param revert, full blob restoration is used (temp track + `TrackFX_CopyToTrack`).

**Blob normalization** (`src/snapshot/normalize.ts`) strips non-deterministic host metadata per plugin type (AU plist wrappers, VST2 header/trailer, VST3 IEditController state) and vendor-specific non-deterministic data (ZIP archive timestamps) before comparison. The pattern handler system is extensible for additional vendor formats.

## Slot ID system

### The problem

REAPER identifies FX plugins only by position in the chain. When a track has two instances of the same plugin (e.g., two EQs for different purposes), there's no built-in way to tell them apart. Reordering plugins in REAPER's UI changes their indices, breaking any position-based matching.

### The solution

Each plugin gets a **slot ID** — a human-readable slug derived from its name:

```
"AU: T-De-Esser 2 (Techivation)"  →  t-de-esser-2
"AU: kHs Snap Heap (Kilohearts)"   →  khs-snap-heap
```

Duplicates get numeric suffixes: `khs-snap-heap`, `khs-snap-heap-2`, etc.

A **slot map** stored in REAPER's `P_EXT` persists these assignments. On capture, a three-pass matching algorithm reassigns slot IDs:

1. **Exact match** — same plugin identity AND same state hash → use stored slot ID
2. **Identity match** — same plugin, different state (user tweaked it) → assign by closest position
3. **No match** — new unmanaged plugin → auto-generate a slot ID

This means diffs, merges, and preset inheritance all operate on stable identities rather than fragile positional indices.

## Project structure

```
src/
├── cli.ts                   # CLI entry point (commander)
├── commands/                # Command implementations
│   ├── init.ts              #   Initialize .reabase directory
│   ├── status.ts            #   Report sync status across projects
│   ├── sync.ts              #   Plan and execute preset updates
│   ├── compute.ts           #   Pure three-way merge (JSON in/out)
│   ├── bridge.ts            #   Lua UI IPC (inspect, snapshot, apply, save-preset, etc.)
│   └── apply.ts             #   Apply resolved chain to track RPP chunk
├── parser/                  # RPP file format
│   ├── parse.ts             #   Text → AST (with base64 blob detection)
│   ├── serialize.ts         #   AST → text
│   ├── helpers.ts           #   Track/FX chain query utilities
│   └── types.ts             #   RppNode, RppStruct, RppChild
├── preset/                  # Preset definitions
│   ├── types.ts             #   PresetDefinition, ResolvedPreset
│   ├── loader.ts            #   Load & validate YAML files
│   ├── resolver.ts          #   Resolve inheritance chains
│   ├── writer.ts            #   Write preset updates (root & child)
│   └── rfxchain.ts          #   Parse/serialize JSON preset format
├── snapshot/                # FX state capture
│   ├── types.ts             #   FxFingerprint, ParameterValue, Snapshot
│   ├── capture.ts           #   Extract fingerprints + hash parameters
│   ├── normalize.ts         #   Blob normalization for stable comparison
│   ├── diff.ts              #   Compare two FX chains
│   └── store.ts             #   Read/write snapshot JSON
├── merge/                   # Conflict resolution
│   ├── three-way.ts         #   Core merge algorithm
│   └── types.ts             #   MergeAction, MergeResult
├── slot/                    # Stable plugin identity
│   ├── identity.ts          #   Slug generation, deduplication
│   └── map.ts               #   Slot map storage and resolution
└── utilities/               # Helpers
    ├── discovery.ts         #   Find .reabase directory
    ├── files.ts             #   Recursive file discovery
    ├── backup.ts            #   Project file backup
    └── reaper-detect.ts     #   REAPER process detection

lua/
├── reabase.lua              # ReaImGui UI script
└── lib/
    ├── bridge.lua           # CLI invocation & JSON IPC
    ├── json.lua             # JSON encoder/decoder
    └── icons.lua            # Lucide icon rendering

test/                        # Vitest test suite (mirrors src/)
```

## Setup

```bash
npm install
npm run build        # Compile CLI to dist/
npm run test         # Run tests (watch mode)
npm run test:run     # Run tests once
```

The CLI is not yet published. During development, install locally:

```bash
npm run build && npm link
```

The Lua bridge auto-detects the CLI binary location. Override with `REABASE_CLI_PATH` environment variable if needed (macOS GUI apps don't inherit shell PATH).

## Configuration

### .reabase directory

Created by `reabase init` in your project root:

```
.reabase/
├── config.yaml           # Project configuration
├── presets/              # Preset YAML definitions + JSON FX chain files
└── snapshots/            # Per-track snapshot JSON files
    └── <track-guid>.json
```

### Track metadata

reabase stores two values in REAPER's per-track extended state (`P_EXT`):

- `reabase_preset` — the name of the assigned preset
- `reabase_slot_map` — base64-encoded JSON mapping slot IDs to plugin signatures

## Known limitations

- **RPP file sync** — the `sync` and `status` CLI commands operate on RPP files directly without a running REAPER instance. They can detect structural changes but may miss parameter-level modifications (which require `TrackFX_GetParam`).
- **Blob normalization coverage** — hidden state change detection relies on normalized blob comparison. Plugins with non-deterministic serialization beyond the built-in handlers (AU plist, VST2 wrapper, VST3 IEditController, ZIP timestamps) may produce false positives. Custom pattern handlers can be added — see below.

### Extending blob normalization

If a plugin produces false "modified" detections due to non-deterministic serialization, you can add a pattern handler. Handlers inspect the inner plugin state data (after host metadata is stripped) and return a normalized version:

```typescript
import { auPatternHandlers } from "reabase/snapshot";

// Example: neutralize a hypothetical session counter at byte 8
auPatternHandlers.push((data: Buffer) => {
  // Return null if this handler doesn't recognize the format
  if (data.length < 16 || data[0] !== 0x42) return null;

  // Zero out the non-deterministic bytes
  const copy = Buffer.from(data);
  copy[8] = 0;
  copy[9] = 0;
  return copy.toString("base64");
});
```

Built-in handlers:
- **ZIP timestamps** — zeros modification time/date in both local file headers and central directory entries (covers Kilohearts plugins like Snap Heap, Compactor, etc.)

## License

MIT
