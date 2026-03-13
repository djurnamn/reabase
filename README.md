# reabase

Manage REAPER FX chains as reusable, updatable dependencies across projects.

## Motivation

When producing a multi-episode podcast, you often discover better FX chain settings in later episodes that you want to propagate back to earlier ones. Doing this manually is tedious and error-prone — you have to remember which plugins changed, what the settings were, and apply them track-by-track across dozens of project files.

**reabase** brings dependency management to REAPER. Define canonical FX chain presets once, assign them to tracks across projects, and propagate updates — similar to how software packages work. Local track-level tweaks are preserved through a three-way merge, so per-episode adjustments aren't lost when the upstream preset improves.

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

**Parser** (`src/parser/`) — Reads and writes REAPER's `.RPP` project format into an AST. Preserves exact whitespace, line endings, and unrecognized content for lossless round-tripping.

**Snapshot** (`src/snapshot/`) — Captures the current FX chain state of a track as an array of `FxFingerprint` objects. Each fingerprint records the plugin name, type, a SHA-256 hash of its stable state, the raw state blob, and a slot ID. Snapshots are stored as JSON and serve as the "old base" for three-way merges.

**Preset** (`src/preset/`) — Loads YAML preset definitions, resolves inheritance chains (child presets can extend parents with overrides, removals, and additions), and parses `.RfxChain` files. The resolver produces a `ResolvedPreset` with a fully-computed FX chain and a version hash.

**Merge** (`src/merge/`) — Implements a three-way merge algorithm. Given an old snapshot (what was last applied), a new preset (what should be applied), and the current track state (what the user has now), it produces a merge result that preserves local tweaks while applying upstream changes. Conflicts are detected when both sides modified the same plugin differently.

**Slot** (`src/slot/`) — Provides stable identity for FX plugins. Plugins are identified by human-readable slugs derived from their names (e.g., `"AU: T-De-Esser 2 (Techivation)"` becomes `t-de-esser-2`). A slot map stored in REAPER's per-track extended state (`P_EXT`) allows slot IDs to survive plugin reordering.

**Commands** (`src/commands/`) — CLI operations that compose the lower layers: `init`, `status`, `sync`, `compute`, `bridge` (Lua IPC), `apply`, and preset management commands.

**Lua UI** (`lua/`) — A ReaImGui-based interface running inside REAPER that communicates with the CLI via JSON over stdin/stdout pipes.

## Key data types

### FxFingerprint

Represents the state of a single FX plugin instance on a track:

```typescript
{
  pluginName: string;    // "AU: T-De-Esser 2 (Techivation)"
  pluginType: string;    // "AU" | "VST" | "VST3" | "JS" | "DX"
  stateHash: string;     // SHA-256 of stable state content
  stateBlob: string;     // Base64-encoded raw plugin state
  slotId: string;        // Stable identity: "t-de-esser-2"
}
```

The `stateHash` is computed after normalizing the state blob to strip non-deterministic metadata. See [State blob normalization](#state-blob-normalization) below.

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
fxChainFile: fx/player_voice.rfxchain
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
    stateFile: fx/multiband-male.state
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
- **remove** — plugin removed by one side, unchanged by the other
- **conflict** — both sides changed differently (requires resolution)

### 3. Execution

After user confirmation:
1. Apply the merge result to each track's RPP chunk
2. Write a new snapshot
3. Update the slot map in the track's `P_EXT`
4. Back up the project file before writing

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

## State blob normalization

Plugin state blobs stored in RPP files contain non-deterministic metadata that changes on every REAPER serialization, even when plugin parameters haven't changed. Without normalization, hashes would be unstable and every poll would report false modifications.

The normalize module (`src/snapshot/normalize.ts`) dispatches to type-specific handlers that strip host metadata before hashing:

### AU (Audio Unit)

AU state blobs are structured as:

```
[52-byte binary header from Apple's AU hosting layer]
[plist XML containing <dict> with keys: version, type, subtype, manufacturer, name, data]
```

The binary header and plist wrapper contain non-deterministic metadata (timestamps, counters) that Apple's AU hosting layer changes on every serialization. The normalizer extracts only the inner `<data>` payload.

The `<data>` content format is vendor-specific. A pattern handler pipeline processes known inner formats:

- **ZIP timestamps** — Some plugins (e.g., Kilohearts) store state as a ZIP archive containing `state.json`. The ZIP local file header has modification timestamps at bytes 10-13 that increment on every serialization. The handler zeros these out.

### VST2

REAPER wraps VST2 plugin chunks with host-specific metadata:

```
[8-byte REAPER header (routing/channel config)]
[plugin chunk from effGetChunk]
[8 trailing bytes (host metadata)]
```

The normalizer strips the header and trailer to hash only the plugin's own chunk data. The chunk format is entirely plugin-defined and opaque to hosts.

### VST3

VST3 plugins have a dual-component architecture. REAPER stores both states concatenated:

```
[4 bytes: IComponent state length (LE int32)]
[4 bytes: separator (typically 0x01000000)]
[IComponent state — DSP/parameter data]
[IEditController state — GUI-only data]
```

The IEditController state can change without any parameter modification (e.g., scrolling a plugin window). The normalizer extracts only the IComponent state for hashing.

### JS (JSFX/EEL)

JS plugins store state as plain text key-value pairs, which are deterministic. No normalization needed.

### Adding new handlers

When encountering a new non-deterministic format:

1. Identify which plugin type produces it
2. Add or extend the base handler for that type in `normalize.ts`
3. For type-specific inner formats (like AU's ZIP archives), add a pattern handler to the type's handler pipeline

## Project structure

```
src/
├── cli.ts                   # CLI entry point (commander)
├── commands/                # Command implementations
│   ├── init.ts              #   Initialize .reabase directory
│   ├── status.ts            #   Report sync status across projects
│   ├── sync.ts              #   Plan and execute preset updates
│   ├── compute.ts           #   Pure three-way merge (JSON in/out)
│   ├── bridge.ts            #   Lua UI IPC (inspect, snapshot, apply, save-preset)
│   └── apply.ts             #   Apply resolved chain to track RPP chunk
├── parser/                  # RPP file format
│   ├── parse.ts             #   Text → AST
│   ├── serialize.ts         #   AST → text
│   ├── helpers.ts           #   Track/FX chain query utilities
│   └── types.ts             #   RppNode, RppStruct, RppChild
├── preset/                  # Preset definitions
│   ├── types.ts             #   PresetDefinition, ResolvedPreset
│   ├── loader.ts            #   Load & validate YAML files
│   ├── resolver.ts          #   Resolve inheritance chains
│   └── rfxchain.ts          #   Parse/serialize .RfxChain format
├── snapshot/                # FX state capture
│   ├── types.ts             #   FxFingerprint, Snapshot
│   ├── capture.ts           #   Extract fingerprints from RPP
│   ├── normalize.ts         #   State blob normalization per plugin type
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
    └── json.lua             # JSON parsing

test/                        # Vitest test suite (mirrors src/)
```

## Setup

```bash
npm install
npm run build        # Compile CLI to dist/
npm run test         # Run tests (watch mode)
npm run test:run     # Run tests once
```

The CLI is not yet published. During development, use the `tsx` dev script:

```bash
npx tsx src/cli.ts <command>
```

See [WORKAROUNDS.md](WORKAROUNDS.md) for temporary environment setup notes.

## Configuration

### .reabase directory

Created by `reabase init` in your project root:

```
.reabase/
├── config.yaml           # Project configuration
├── presets/              # Preset YAML definitions + .RfxChain files
└── snapshots/            # Per-project, per-track snapshot JSON files
    └── <project>/
        └── <track>.json
```

### Track metadata

reabase stores two values in REAPER's per-track extended state (`P_EXT`):

- `reabase_preset` — the name of the assigned preset
- `reabase_slot_map` — JSON blob mapping slot IDs to plugin signatures

## License

MIT
