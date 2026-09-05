-- reabase (webview) — the new HTML/CSS/JS UI, rendered by reaper-webview.
--
-- Runs in PARALLEL with the legacy ReaImGui UI (`reabase.lua`) while the web
-- UI is brought to parity — install both as separate REAPER actions. This
-- entry opens a webview pointed at the `ui/` app and bridges its
-- `window.reaper.invoke(...)` calls to the same reabase CLI the old UI uses
-- (via `lua/lib/bridge.lua`). The TypeScript backend is untouched.
--
-- Requires: reaper-webview extension, SWS Extension.

-- ─── Setup ───────────────────────────────────────────────────────

local script_dir = debug.getinfo(1, "S").source:match("@(.+[/\\])")
package.path = script_dir .. "lib/?.lua;" .. package.path

local json = require("json")
local bridge = require("bridge")

local WINDOW_ID = "reabase"

-- Entry resolution: prefer the Vite dev server (hot reload while iterating on
-- `ui/`) WHEN it's actually running, otherwise load the bundled single-file
-- build. Auto-detecting avoids the blank-white-page trap of pointing at a dev
-- server that isn't up. Set PREFER_DEV_SERVER=false to always use the build.
local PREFER_DEV_SERVER = true
local DEV_SERVER_URL = "http://localhost:5173"
local repo_root = (script_dir or ""):gsub("[/\\]lua[/\\]$", "")
local PROD_ENTRY = repo_root .. "/ui/dist/index.html"

--- True if an HTTP server answers at `url` within a short timeout.
local function http_server_up(url)
  local handle = io.popen(
    'curl -s -o /dev/null -m 0.4 -w "%{http_code}" "' .. url .. '" 2>/dev/null'
  )
  if not handle then return false end
  local code = handle:read("*a")
  handle:close()
  return code == "200"
end

local function file_exists(path)
  local f = io.open(path, "r")
  if f then f:close() return true end
  return false
end

--- Pick the entry URL, falling back from dev server → built dist.
local function resolve_entry()
  if PREFER_DEV_SERVER and http_server_up(DEV_SERVER_URL) then
    return DEV_SERVER_URL
  end
  if file_exists(PROD_ENTRY) then
    return PROD_ENTRY
  end
  return nil
end

-- ─── Dependency checks ───────────────────────────────────────────

local required_apis = {
  "Webview_Open", "Webview_Close", "Webview_PollMessage",
  "Webview_Respond", "Webview_RespondError", "Webview_Emit",
}
for _, name in ipairs(required_apis) do
  if not reaper.APIExists(name) then
    reaper.MB(
      "reabase (webview) requires the reaper-webview extension.\n\n"
        .. "Missing: reaper." .. name .. "\n"
        .. "Install/update the extension, then restart REAPER.",
      "reabase — Missing dependency",
      0
    )
    return
  end
end

if not reaper.SNM_GetSetObjectState then
  reaper.MB(
    "reabase requires the SWS Extension.\n\nDownload from: https://www.sws-extension.org/",
    "reabase — Missing dependency",
    0
  )
  return
end

-- ─── REAPER-side helpers ─────────────────────────────────────────
-- (Mirrors the proven helpers in reabase.lua. Kept self-contained so the two
-- entry points stay decoupled while the legacy UI is still shipping; these can
-- be extracted into a shared lib once reabase.lua is retired.)

--- Find the directory containing `.reabase/config.yaml`, walking up from the
--- current REAPER project path.
local function find_reabase_root()
  local project_path = reaper.GetProjectPath()
  if not project_path or project_path == "" then return nil end

  local current = project_path
  local sep = package.config:sub(1, 1)
  while current and current ~= "" do
    local candidate = current .. sep .. ".reabase"
    local f = io.open(candidate .. sep .. "config.yaml", "r")
    if f then
      f:close()
      return current
    end
    local parent = current:match("^(.*)" .. sep .. "[^" .. sep .. "]+$")
    if not parent or parent == current then break end
    current = parent
  end
  return nil
end

local function get_track_chunk(track)
  local retval, chunk = reaper.GetTrackStateChunk(track, "", false)
  if retval then return chunk end
  return nil
end

--- Round to 6 decimals for stable float comparison (see reabase.lua).
local function round_param(value)
  return math.floor(value * 1e6 + 0.5) / 1e6
end

--- Capture FX parameters for all plugins on a track, one map per FX.
local function capture_fx_parameters(track)
  local result = {}
  local fx_count = reaper.TrackFX_GetCount(track)
  for i = 0, fx_count - 1 do
    local params = {}
    local num_params = reaper.TrackFX_GetNumParams(track, i)
    for p = 0, num_params - 1 do
      local val = reaper.TrackFX_GetParam(track, i, p)
      local _, name = reaper.TrackFX_GetParamName(track, i, p)
      params[tostring(p)] = { name = name or ("param_" .. p), value = round_param(val) }
    end
    result[#result + 1] = params
  end
  return result
end

local function set_track_chunk(track, chunk)
  return reaper.SetTrackStateChunk(track, chunk, false)
end

--- Apply parameter maps (one per FX) to the live FX via TrackFX_SetParam.
local function set_fx_parameters(track, parameter_maps)
  local fx_count = reaper.TrackFX_GetCount(track)
  for i = 0, fx_count - 1 do
    local params = parameter_maps[i + 1]
    if params then
      local num_params = reaper.TrackFX_GetNumParams(track, i)
      for key, pv in pairs(params) do
        local pi = tonumber(key)
        if pi and pi < num_params then
          reaper.TrackFX_SetParam(track, i, pi, pv.value)
        end
      end
    end
  end
end

--- Map slotId → preset parameters from a resolved chain.
local function preset_params_by_slot(resolved_chain)
  local map = {}
  if resolved_chain then
    for _, fx in ipairs(resolved_chain) do
      if fx.slotId then map[fx.slotId] = fx.parameters end
    end
  end
  return map
end

--- Capture current FX params, but substitute the preset's params for every
--- preset-managed slot. Used after a revert so the snapshot baseline reflects
--- the clean preset state — the reverted slot then resolves to keep_base on the
--- next inspect, while other local tweaks stay keep_local against this baseline.
local function capture_fx_parameters_as_preset_baseline(track, resolved_chain, current_chain)
  local fx_parameters = capture_fx_parameters(track)
  if not resolved_chain or not current_chain then return fx_parameters end
  local preset_params = preset_params_by_slot(resolved_chain)
  for idx, fx in ipairs(current_chain) do
    if fx.slotId then
      local target = preset_params[fx.slotId]
      if target then fx_parameters[idx] = target end
    end
  end
  return fx_parameters
end

--- Create a temp track loaded with `plugins` (including blob state) so a full
--- plugin state can be restored via CopyToTrack. Uses the CLI to format the
--- chunk so blobs round-trip correctly. Returns the temp track or nil.
local function create_temp_track_with_plugins(plugins)
  local before = reaper.CountTracks(0)
  reaper.InsertTrackAtIndex(before, false)
  local temp_track = reaper.GetTrack(0, before)
  if not temp_track then return nil end

  local empty_chunk = get_track_chunk(temp_track)
  if not empty_chunk then
    reaper.DeleteTrack(temp_track)
    return nil
  end

  local apply_result = bridge.apply_chunk(empty_chunk, plugins)
  if not apply_result then
    reaper.DeleteTrack(temp_track)
    return nil
  end

  set_track_chunk(temp_track, apply_result.modifiedChunk)
  return temp_track
end

--- Restore one plugin's full state (params + state blob) via a temp track +
--- CopyToTrack — for plugins whose params alone don't capture their state
--- (e.g. RS5K samples, modular plugins). Synchronous (the bridge is
--- request/response, so no reaper.defer).
local function restore_plugin_with_blob(track, plugin_index, fx)
  local temp_track = create_temp_track_with_plugins({ fx })
  if not temp_track then return end

  if fx.parameters then
    local num_params = reaper.TrackFX_GetNumParams(temp_track, 0)
    for key, pv in pairs(fx.parameters) do
      local pi = tonumber(key)
      if pi and pi < num_params then
        reaper.TrackFX_SetParam(temp_track, 0, pi, pv.value)
      end
    end
  end

  reaper.TrackFX_Delete(track, plugin_index)
  reaper.TrackFX_CopyToTrack(temp_track, 0, track, plugin_index, true)
  reaper.DeleteTrack(temp_track)
end

--- Delete the preset-MANAGED plugins (those in the resolved chain) from the
--- track, keeping local/loose ones. `inspect` is a prior inspect result.
local function remove_managed_plugins(track, inspect)
  if not (inspect and inspect.resolvedChain and inspect.currentChain) then return end
  local managed = {}
  for _, fx in ipairs(inspect.resolvedChain) do
    if fx.slotId then managed[fx.slotId] = true end
  end
  -- currentChain[i] is the FX at 0-based index i-1, in chain order.
  local remove_indices = {}
  for i, fx in ipairs(inspect.currentChain) do
    if fx.slotId and managed[fx.slotId] then
      remove_indices[#remove_indices + 1] = i - 1
    end
  end
  table.sort(remove_indices, function(a, b) return a > b end) -- reverse, indices stay valid
  for _, idx in ipairs(remove_indices) do
    reaper.TrackFX_Delete(track, idx)
  end
end

--- Merge insert: add the new preset's plugins that aren't on the track yet
--- (`add_base` in the merge) ON TOP of the existing FX (before the local
--- plugins), preserving the existing plugins' full state. Re-snapshots. Assumes
--- the preset is already set and the track was snapshotted with
--- preserveLocalSlotIds so existing plugins read as local and the preset's read
--- as add_base.
local function merge_insert_preset_plugins(track, preset, reabase_path)
  local inspect = bridge.inspect_track(
    get_track_chunk(track), reabase_path, capture_fx_parameters(track)
  )
  if not (inspect and inspect.merge and inspect.merge.actions) then return end

  local to_add = {}
  for _, action in ipairs(inspect.merge.actions) do
    if action.type == "add_base" and action.fx then
      to_add[#to_add + 1] = action.fx
    end
  end
  if #to_add == 0 then return end

  local temp = create_temp_track_with_plugins(to_add)
  if not temp then return end

  -- Apply params to the temp FX (safety net), then copy each ON TOP (before the
  -- existing local plugins) so the chain order matches reabase's composed view.
  for i = 0, #to_add - 1 do
    local fx = to_add[i + 1]
    if fx.parameters then
      local np = reaper.TrackFX_GetNumParams(temp, i)
      for key, pv in pairs(fx.parameters) do
        local pi = tonumber(key)
        if pi and pi < np then reaper.TrackFX_SetParam(temp, i, pi, pv.value) end
      end
    end
  end
  for i = 0, #to_add - 1 do
    reaper.TrackFX_CopyToTrack(temp, i, track, i, false)
  end
  reaper.DeleteTrack(temp)

  local resnap = bridge.snapshot(
    get_track_chunk(track), preset, reabase_path, capture_fx_parameters(track)
  )
  if resnap then set_track_chunk(track, resnap) end
end

--- Run `mutate` (which may freely churn the live track — temp tracks,
--- CopyToTrack, repeated chunk swaps, snapshot file writes) and collapse the
--- whole thing into ONE clean REAPER undo step. Native undo is corrupted by
--- temp-track create+delete and multiple SetTrackStateChunk calls inside a
--- block; so instead we run the mutation OUTSIDE any block, capture the
--- resulting chunk, restore the track's pre-mutation chunk, and re-apply the
--- result with a single SetTrackStateChunk inside the block. The block then
--- holds exactly one swap on one track → Cmd-Z reverts the FX chain + preset
--- binding faithfully. (Orphaned .reabase snapshot files from the mutation are
--- a separate prune concern and don't affect the user-visible undo.) On error
--- the track is restored to its original chunk before the failure is re-raised.
local function as_single_undo(track, label, mutate)
  local original = get_track_chunk(track)
  reaper.PreventUIRefresh(1)
  local ok, err = pcall(mutate)
  local final = get_track_chunk(track)
  if original then set_track_chunk(track, original) end -- true before-state
  reaper.PreventUIRefresh(-1)
  if not ok then error(err) end
  reaper.Undo_BeginBlock()
  if final then set_track_chunk(track, final) end
  reaper.Undo_EndBlock(label, -1)
end

-- ─── Action handlers ─────────────────────────────────────────────
-- One entry per `window.reaper.invoke(action, args)` the UI can call. A
-- handler returns a Lua table (sent back as the resolved JSON) or raises an
-- error (rejects the JS promise with the message). Grows one entry per screen.
--
-- NOTE: handlers re-encode the bridge's decoded Lua table with json.encode.
-- That is faithful for empty arrays ([] round-trips correctly) but an EMPTY
-- JSON object would come back as []. The status panel reads no empty-object
-- fields, so this is safe here; chain-rendering screens that read FX param
-- maps may need a raw-passthrough instead.

local handlers = {}

handlers["inspect"] = function()
  local track = reaper.GetSelectedTrack(0, 0)
  if not track then error("No track selected") end

  local reabase_path = find_reabase_root()
  if not reabase_path then
    error("No .reabase/ project found for the current REAPER project")
  end

  local chunk = get_track_chunk(track)
  if not chunk then error("Could not read the track's state chunk") end

  local fx_params = capture_fx_parameters(track)
  local result, err = bridge.inspect_track(chunk, reabase_path, fx_params)
  if not result then error(err or "inspect failed") end
  return result
end

-- Commit staged ownership (attach / detach / bring-over) by pushing the
-- track's plugins back into the source preset YAMLs. `args.ownership` maps
-- source name → owned slotIds; `args.released` lists slots dropped to local.
-- The whole map is committed at once, so a move's both sides land atomically.
handlers["update-presets"] = function(args)
  local track = reaper.GetSelectedTrack(0, 0)
  if not track then error("No track selected") end

  local reabase_path = find_reabase_root()
  if not reabase_path then
    error("No .reabase/ project found for the current REAPER project")
  end

  local chunk = get_track_chunk(track)
  if not chunk then error("Could not read the track's state chunk") end

  local fx_params = capture_fx_parameters(track)
  local result, err = bridge.update_presets(
    chunk, args.ownership or {}, args.released or {}, reabase_path, fx_params
  )
  if not result then error(err or "update-presets failed") end

  -- Ownership lives in the preset YAMLs; the only track-side change is the
  -- refreshed slot map in the modified chunk. Write it back.
  reaper.SetTrackStateChunk(track, result.modifiedChunk, false)
  return { success = true, updatedPresets = result.updatedPresets }
end

-- Commit staged composition edits (deactivate; later exclude/order) by writing
-- the composed preset's fields. Edits the preset YAML only — the track reflects
-- the change on the next apply/sync (not done here).
handlers["update-composition"] = function(args)
  local reabase_path = find_reabase_root()
  if not reabase_path then
    error("No .reabase/ project found for the current REAPER project")
  end
  if not args.presetName or args.presetName == "" then
    error("No preset to edit")
  end

  local result, err = bridge.update_composition(args.presetName, args, reabase_path)
  if not result then error(err or "update-composition failed") end
  return result
end

-- Revert one plugin to its preset-defined state. IMMEDIATE (mutates the live
-- FX), not staged: applies preset params via TrackFX_SetParam, falls back to a
-- full blob restore if params don't capture the state, then re-snapshots to the
-- clean preset baseline so the row stops reporting modified.
handlers["revert-plugin"] = function(args)
  local track = reaper.GetSelectedTrack(0, 0)
  if not track then error("No track selected") end

  local reabase_path = find_reabase_root()
  if not reabase_path then
    error("No .reabase/ project found for the current REAPER project")
  end
  if not args.slotId then error("No slotId to revert") end

  local chunk = get_track_chunk(track)
  if not chunk then error("Could not read the track's state chunk") end

  local result, err = bridge.revert_plugin(chunk, args.slotId, reabase_path)
  if not result then error(err or "revert-plugin failed") end

  as_single_undo(track, "reabase: revert plugin '" .. tostring(args.slotId) .. "'", function()
    -- Step 1: parameter revert (cheap, no FX reload).
    if result.pluginIndex ~= nil and result.parameterMap then
      for key, pv in pairs(result.parameterMap) do
        local pi = tonumber(key)
        if pi then reaper.TrackFX_SetParam(track, result.pluginIndex, pi, pv.value) end
      end
    end

    -- Step 2: if a state blob is involved and params didn't fully restore it,
    -- do a full blob restore via temp track.
    if result.stateBlob and result.pluginName then
      local updated_chunk = get_track_chunk(track)
      local current = updated_chunk
        and bridge.revert_plugin(updated_chunk, args.slotId, reabase_path)
      if current and current.stateBlob ~= result.stateBlob then
        restore_plugin_with_blob(track, result.pluginIndex, {
          pluginName = result.pluginName,
          pluginType = result.pluginType,
          pluginParams = result.pluginParams,
          stateBlob = result.stateBlob,
          parameters = result.parameterMap,
        })
      end
    end

    -- Step 3: re-snapshot to the clean preset baseline (re-inspect to get the
    -- resolved/current chains). Keeps the reverted slot at keep_base and other
    -- local tweaks at keep_local next inspect.
    local reaper_chunk = get_track_chunk(track)
    local fx_params = capture_fx_parameters(track)
    local inspect = reaper_chunk
      and bridge.inspect_track(reaper_chunk, reabase_path, fx_params)
    if inspect and inspect.preset and inspect.resolvedChain then
      local snap_params = capture_fx_parameters_as_preset_baseline(
        track, inspect.resolvedChain, inspect.currentChain
      )
      local snap_chunk = bridge.snapshot(
        reaper_chunk, inspect.preset, reabase_path, snap_params
      )
      if snap_chunk then set_track_chunk(track, snap_chunk) end
    end
  end)

  return { success = true }
end

-- Reorder a plain preset's own plugins (its internal/canonical order). Pure
-- preset-file I/O — no track involved. `order` is the preset's own bare slotIds
-- in their new sequence (an exact permutation of that preset's own slots).
handlers["reorder-preset-plugins"] = function(args)
  local reabase_path = find_reabase_root()
  if not reabase_path then
    error("No .reabase/ project found for the current REAPER project")
  end
  if not args.presetName or args.presetName == "" then
    error("No preset to reorder")
  end

  local result, err = bridge.reorder_preset_plugins(
    args.presetName, args.order or {}, reabase_path
  )
  if not result then error(err or "reorder-preset-plugins failed") end
  return result
end

-- Assign a preset to the track. `mode`:
--   "replace" (default) — overwrite the FX chain with the preset's resolved
--                         chain.
--   "merge"             — keep the track's local plugins, add the preset's
--                         plugins AFTER them. When switching from another
--                         preset, that preset's managed plugins are removed
--                         first (so only local additions survive).
-- One undo block, so Cmd-Z restores the prior track state.
handlers["assign-preset"] = function(args)
  local track = reaper.GetSelectedTrack(0, 0)
  if not track then error("No track selected") end

  local reabase_path = find_reabase_root()
  if not reabase_path then
    error("No .reabase/ project found for the current REAPER project")
  end
  if not args.preset or args.preset == "" then error("No preset to assign") end

  local mode = args.mode == "merge" and "merge" or "replace"

  as_single_undo(track, "reabase: assign preset '" .. args.preset .. "'", function()
    if mode == "merge" then
      -- Switching: drop the current preset's managed plugins, keep local ones.
      -- (A fresh assign has no current preset, so nothing is removed.)
      local cur = bridge.inspect_track(
        get_track_chunk(track), reabase_path, capture_fx_parameters(track)
      )
      if cur and cur.preset and cur.preset ~= "" then
        remove_managed_plugins(track, cur)
      end

      local with_preset = bridge.set_preset(get_track_chunk(track), args.preset)
      if with_preset then set_track_chunk(track, with_preset) end

      -- preserveLocalSlotIds: remaining plugins read as local, the new preset's
      -- as add_base — which merge_insert then adds on top of the existing FX.
      local snap = bridge.snapshot(
        get_track_chunk(track), args.preset, reabase_path,
        capture_fx_parameters(track), true
      )
      if snap then set_track_chunk(track, snap) end

      merge_insert_preset_plugins(track, args.preset, reabase_path)
    else
      local with_preset, err = bridge.set_preset(get_track_chunk(track), args.preset)
      if not with_preset then error(err or "set-preset failed") end
      set_track_chunk(track, with_preset)

      local inspect = bridge.inspect_track(
        get_track_chunk(track), reabase_path, capture_fx_parameters(track)
      )
      if inspect and inspect.resolvedChain then
        local apply = bridge.apply_chunk(get_track_chunk(track), inspect.resolvedChain)
        if apply then
          set_track_chunk(track, apply.modifiedChunk)
          if apply.parameterMaps then set_fx_parameters(track, apply.parameterMaps) end
          local snap = bridge.snapshot(
            get_track_chunk(track), args.preset, reabase_path, capture_fx_parameters(track)
          )
          if snap then set_track_chunk(track, snap) end
        end
      end
    end
  end)

  return { success = true }
end

-- Unassign: remove the preset-MANAGED plugins, keep local/loose ones, clear the
-- binding. Undoable. Confirm-if-uncommitted is handled in the UI. NOTE: the
-- track's snapshot file isn't pruned — stale-snapshot cleanup is a separate
-- backend concern.
handlers["unassign-preset"] = function(args)
  local track = reaper.GetSelectedTrack(0, 0)
  if not track then error("No track selected") end

  local reabase_path = find_reabase_root()
  if not reabase_path then
    error("No .reabase/ project found for the current REAPER project")
  end

  local chunk = get_track_chunk(track)
  if not chunk then error("Could not read the track's state chunk") end
  local inspect = bridge.inspect_track(chunk, reabase_path, capture_fx_parameters(track))

  as_single_undo(track, "reabase: unassign preset", function()
    remove_managed_plugins(track, inspect)
    local cleared = bridge.set_preset(get_track_chunk(track), "")
    if cleared then set_track_chunk(track, cleared) end
  end)
  return { success = true }
end

-- ─── Message dispatch ────────────────────────────────────────────

local function handle_message(raw)
  local ok, msg = pcall(json.decode, raw)
  if not ok or type(msg) ~= "table" then return end

  local call_id, action = msg.callId, msg.action
  if not call_id or not action then return end

  local handler = handlers[action]
  if not handler then
    reaper.Webview_RespondError(WINDOW_ID, call_id, "Unknown action: " .. tostring(action))
    return
  end

  local success, result_or_err = pcall(handler, msg.args)
  if success then
    reaper.Webview_Respond(WINDOW_ID, call_id, json.encode(result_or_err))
  else
    reaper.Webview_RespondError(WINDOW_ID, call_id, tostring(result_or_err))
  end
end

-- ─── Open + poll loop ────────────────────────────────────────────

local ENTRY = resolve_entry()
if not ENTRY then
  reaper.MB(
    "Nothing to load.\n\n"
      .. "Start the dev server (cd ui && pnpm dev) for hot reload, or build it "
      .. "once (cd ui && pnpm build) to load the bundled UI.\n\n"
      .. "Looked for a build at:\n" .. PROD_ENTRY,
    "reabase (webview)",
    0
  )
  return
end

-- Open as a standalone floating window (title bar + close button), not a
-- dockable panel. DIALOG mode is the same standalone-window path the dialog
-- runner uses; resizable (no FIXED_SIZE) so the panel can grow with content.
local flags = 0
if reaper.APIExists("Webview_Flag_DIALOG") then
  flags = reaper.Webview_Flag_DIALOG()
end

if not reaper.Webview_Open(WINDOW_ID, ENTRY, flags, nil, 480, 720) then
  reaper.MB("Webview_Open failed.\nEntry: " .. ENTRY, "reabase (webview)", 0)
  return
end

-- Change detection. We emit two events the page re-inspects on:
--   selection-changed — the selected track pointer changed.
--   track-changed     — the SAME track's state changed (param tweak, FX add/
--                        remove/reorder, bypass), detected by hashing the chunk
--                        on a throttle.
local last_track_id = nil
local last_chunk_hash = nil
local poll_counter = 0
local POLL_INTERVAL = 20 -- ~0.7s at 30fps

-- djb2 over the whole chunk (so a param change anywhere is caught) plus the
-- length (so add/remove is caught). Throttled, so the full-chunk cost is fine.
local function chunk_hash(str)
  local hash = 5381
  for i = 1, #str do
    hash = ((hash * 33) + string.byte(str, i)) % 0x100000000
  end
  return hash .. ":" .. #str
end

local function loop()
  while true do
    local ok, msg = reaper.Webview_PollMessage(WINDOW_ID, "", 1 << 20)
    if not ok or not msg or msg == "" then break end
    handle_message(msg)
  end

  local track = reaper.GetSelectedTrack(0, 0)
  local id = track and tostring(track) or "none"
  if id ~= last_track_id then
    last_track_id = id
    last_chunk_hash = nil
    poll_counter = 0
    reaper.Webview_Emit(WINDOW_ID, "selection-changed", "{}")
  elseif track then
    poll_counter = poll_counter + 1
    if poll_counter >= POLL_INTERVAL then
      poll_counter = 0
      local chunk = get_track_chunk(track)
      if chunk then
        local hash = chunk_hash(chunk)
        if last_chunk_hash ~= nil and hash ~= last_chunk_hash then
          reaper.Webview_Emit(WINDOW_ID, "track-changed", "{}")
        end
        last_chunk_hash = hash
      end
    end
  end

  reaper.defer(loop)
end

reaper.defer(loop)
