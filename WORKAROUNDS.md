# Temporary workarounds

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
