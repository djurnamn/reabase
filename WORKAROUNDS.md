# Workarounds and known limitations

## REAPER limitation: SetTrackStateChunk cannot load AU plugin state

**Status:** Resolved via parameter-level sync.

**Problem:** REAPER's `SetTrackStateChunk` API does not load AU plugin internal state from chunk data. AU plugins always initialize with their factory default state, regardless of what state blob is in the chunk.

**Solution:** Replaced opaque state blobs with explicit parameter maps using `TrackFX_GetParam`/`TrackFX_SetParam`, which works for all plugin types including AU. The data flow is now:

1. Lua captures params via `TrackFX_GetParam` → sends to CLI
2. CLI uses params for state (hashing, comparison, storage), chunk for structure (plugin identity)
3. CLI returns: modified chunk (structural) + parameter maps (state)
4. Lua applies chunk via `SetTrackStateChunk` (creates FX with default state)
5. Lua applies params via `TrackFX_SetParam` (sets correct state — works for AU)

### Deferred: RPP file sync

The `sync` and `status` commands that operate on RPP files directly cannot use `TrackFX_SetParam` (requires a running REAPER instance). These commands compile but emit a warning. RPP file sync needs a fundamentally different approach — either require REAPER to be running, or find a way to embed parameter state in the chunk format that REAPER will load.

---

These are known workarounds for the current development setup. They should be resolved before publishing to npm/GitHub.

## CLI access

The CLI isn't installed globally yet. Using a shell alias for testing:

```bash
alias reabase='npx tsx /Users/bjorndjurnamn/Documents/Code/tracks-as-dependencies/src/cli.ts'
```

**To resolve:** Publish to GitHub, then `npm install -g` from the repo. The `bin` entry in `package.json` already points to `./dist/cli.js`.

## Lua script location

The Lua script is loaded directly from the repo via REAPER's "Load ReaScript" action. It lives at:

```
/Users/bjorndjurnamn/Documents/Code/tracks-as-dependencies/lua/reabase.lua
```

**To resolve:** Decide on a proper install location. Options:
- Copy/symlink `lua/` into `~/Library/Application Support/REAPER/Scripts/reabase/`
- Or add a ReaPack entry so it can be installed via REAPER's package manager

## Lua bridge CLI path (environment-specific)

The Lua bridge (`lua/lib/bridge.lua` line 8) has `cli_path` hardcoded to the nvm-managed node path:

```lua
bridge.cli_path = "/Users/bjorndjurnamn/.nvm/versions/node/v24.12.0/bin/reabase"
```

The PATH prefix logic that derives the node bin directory from this path is a general fix (macOS GUI apps don't inherit shell PATH). But the hardcoded path itself is environment-specific.

**To resolve:** Auto-detect the CLI path. Options:
- On install, write the path to a config file that the Lua script reads
- Or default to `"reabase"` and document that it must be in `/usr/local/bin` or similar system-wide location
