-- reabase — Manage FX chain presets from within REAPER.
-- Requires: ReaImGui, SWS Extension
--
-- Install: Add this script as a REAPER action.
-- Recommended: Bind to a keyboard shortcut for quick access.

-- ─── Setup ───────────────────────────────────────────────────────

-- Add the script's lib/ directory to the Lua package path
local script_path = debug.getinfo(1, "S").source:match("@(.+[/\\])")
package.path = script_path .. "lib/?.lua;" .. package.path

local json = require("json")
local bridge = require("bridge")
local icons = require("icons")

-- Check dependencies
if not reaper.ImGui_CreateContext then
  reaper.MB(
    "reabase requires the ReaImGui extension.\n\n"
      .. "Install it from ReaPack:\n"
      .. "Extensions > ReaPack > Browse packages > search 'ReaImGui'",
    "reabase — Missing dependency",
    0
  )
  return
end

if not reaper.SNM_GetSetObjectState then
  reaper.MB(
    "reabase requires the SWS Extension.\n\n"
      .. "Download from: https://www.sws-extension.org/",
    "reabase — Missing dependency",
    0
  )
  return
end

-- ─── Debug logging ───────────────────────────────────────────────

local DEBUG = true

local function log(msg)
  if DEBUG then
    reaper.ShowConsoleMsg("[reabase] " .. msg .. "\n")
  end
end

-- ─── State ───────────────────────────────────────────────────────

local ctx = reaper.ImGui_CreateContext("reabase")
icons.setup(ctx)
local WINDOW_FLAGS = reaper.ImGui_WindowFlags_NoCollapse()

-- Sentinel value to distinguish "released" from "no pending change" in Lua tables
local RELEASED = {}

local state = {
  -- Track state
  track = nil,
  track_name = "",
  track_guid = "",
  track_chunk = "",

  -- Inspect result from CLI
  inspect = nil,
  inspect_error = nil,

  -- UI state
  selected_preset_index = 0,
  new_preset_name = "",
  new_preset_fx_selected = {},    -- boolean/"disabled" table, 1-indexed by FX position
  status_message = nil,
  status_is_error = false,

  -- Inheritance tab state
  selected_tab = nil,             -- preset name of selected tab (nil = use leaf default)
  previous_tab = nil,             -- tracks tab transitions for checkbox init

  -- Modal state
  save_preset_modal_open = false,       -- triggers name-input modal
  assign_conflict_pending = false,      -- triggers assign-conflict modal
  assign_conflict_preset = "",          -- preset name for conflict modal

  -- Ownership / pending assignment state
  pending_assignments = {},       -- slotId -> preset name (string) or RELEASED sentinel
  has_pending_changes = false,
  move_ownership_pending = nil,   -- {slotId, from, to} for confirm popup

  -- Overwrite confirmation state
  overwrite_pending = false,      -- true when waiting for user to confirm overwrite
  overwrite_preset_name = "",     -- the name that would be overwritten
  overwrite_extends_preset = nil, -- preserves extends context across overwrite confirm

  -- Delete confirmation state
  delete_pending = false,         -- true when waiting for user to confirm deletion
  delete_preset_name = "",        -- the name that would be deleted

  -- Select-all checkbox state (persisted across frames)
  select_all_checked = false,

  -- Override confirmation state
  override_pending = false,
  override_child_slot = "",        -- child plugin slot ID
  override_parent_slot = "",       -- parent plugin slot ID
  override_plugin_name = "",       -- display name for confirm dialog

  -- Refresh tracking
  last_track = nil,
  needs_refresh = true,

  -- Auto-poll state
  last_chunk_hash = "",           -- simple hash of track chunk for change detection
  poll_counter = 0,               -- frame counter for throttling polls

  -- Discovered reabase path
  reabase_path = nil,
}

-- ─── Reabase path discovery ──────────────────────────────────────

--- Find the .reabase/ directory by walking up from the current REAPER project path.
---@return string|nil path to the directory containing .reabase/
local function find_reabase_root()
  local project_path = reaper.GetProjectPath()
  if not project_path or project_path == "" then
    return nil
  end

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
    if not parent or parent == current then
      break
    end
    current = parent
  end

  return nil
end

-- ─── Track chunk helpers ─────────────────────────────────────────

local function get_track_chunk(track)
  local retval, chunk = reaper.GetTrackStateChunk(track, "", false)
  if retval then
    return chunk
  end
  return nil
end

local function set_track_chunk(track, chunk)
  return reaper.SetTrackStateChunk(track, chunk, false)
end


--- Round a parameter value to 6 decimal places for stable comparison.
--- REAPER uses 32-bit floats internally but exposes 64-bit doubles,
--- so 0.4 comes back as 0.40000000596046. Rounding normalizes these.
local function round_param(value)
  return math.floor(value * 1e6 + 0.5) / 1e6
end

--- Capture FX parameters from all plugins on a track via TrackFX_GetParam.
--- Returns an array of parameter maps (one per FX), keyed by param index as string.
--- Values are rounded to 6 decimal places for float stability.
---@param track MediaTrack
---@return table[] Array of {["0"] = {name, value}, ["1"] = {name, value}, ...}
local function capture_fx_parameters(track)
  local result = {}
  local fx_count = reaper.TrackFX_GetCount(track)
  for i = 0, fx_count - 1 do
    local params = {}
    local num_params = reaper.TrackFX_GetNumParams(track, i)
    for p = 0, num_params - 1 do
      local val, min_val, max_val = reaper.TrackFX_GetParam(track, i, p)
      local _, name = reaper.TrackFX_GetParamName(track, i, p)
      params[tostring(p)] = { name = name or ("param_" .. p), value = round_param(val) }
    end
    result[#result + 1] = params
  end
  return result
end

--- Apply parameter values from a map to FX on a track.
---@param track MediaTrack
---@param parameter_maps table[] Array of {["0"] = {name, value}, ...}
---@return number applied Number of FX that had params applied
local function set_fx_parameters(track, parameter_maps)
  local fx_count = reaper.TrackFX_GetCount(track)
  local applied = 0
  for i = 0, fx_count - 1 do
    local params = parameter_maps[i + 1] -- Lua 1-indexed
    if params then
      for key, pv in pairs(params) do
        local param_index = tonumber(key)
        if param_index then
          local num_params = reaper.TrackFX_GetNumParams(track, i)
          if param_index < num_params then
            reaper.TrackFX_SetParam(track, i, param_index, pv.value)
          end
        end
      end
      applied = applied + 1
    end
  end
  return applied
end

--- Apply parameter maps to FX on a track via TrackFX_SetParam.
--- Does two passes with a frame gap between them: the first pass sets all params,
--- the second re-applies after plugins have had a frame to initialize their modes
--- (some multi-mode plugins like Airwindows need the mode param set before other
--- params become active).
---@param track MediaTrack
---@param parameter_maps table[] Array of {["0"] = {name, value}, ...}
---@param callback function|nil Optional callback to run after params are applied
local function apply_fx_parameters(track, parameter_maps, callback)
  -- First pass: deferred to allow a frame for FX to initialize after SetTrackStateChunk
  reaper.defer(function()
    local applied = set_fx_parameters(track, parameter_maps)
    log("  apply_fx_parameters: pass 1 applied params to " .. applied .. " FX")
    -- Second pass: re-apply after another frame to catch mode-dependent params
    reaper.defer(function()
      local reapplied = set_fx_parameters(track, parameter_maps)
      log("  apply_fx_parameters: pass 2 reapplied params to " .. reapplied .. " FX")
      if callback then callback() end
    end)
  end)
end

--- Build a minimal RPP plugin opening line from name, type, and params.
---@param plugin_name string e.g., "AU: Snap Heap (Kilohearts)"
---@param plugin_type string e.g., "AU"
---@param plugin_params table|nil Additional opening-line params
---@return string The opening line e.g., '<AU "AU: Snap Heap (Kilohearts)" "Kilohearts: Snap Heap" "" ...'
local function build_plugin_opening_line(plugin_name, plugin_type, plugin_params)
  local parts = { '<' .. plugin_type .. ' "' .. plugin_name .. '"' }
  if plugin_params then
    for _, p in ipairs(plugin_params) do
      if type(p) == "string" then
        parts[#parts + 1] = '"' .. p .. '"'
      else
        parts[#parts + 1] = tostring(p)
      end
    end
  end
  return table.concat(parts, ' ')
end

--- Build a minimal temp track chunk containing plugins with their state blobs.
--- Used for blob-based restoration via temp track + CopyToTrack.
---@param plugins table[] Array of {pluginName, pluginType, pluginParams, stateBlob, parameters}
---@return string RPP track chunk
local function build_temp_track_chunk(plugins)
  -- Use FLAT format (no indentation) matching GetTrackStateChunk output.
  -- SNM_GetSetObjectState expects this format for correct AU state loading.
  local lines = {
    '<TRACK',
    'NAME __reabase_temp',
    'ISBUS 0 0',
    'MAINSEND 1 0',
    '<FXCHAIN',
    'SHOW 0',
    'LASTSEL 0',
    'DOCKED 0',
  }
  for _, fx in ipairs(plugins) do
    lines[#lines + 1] = 'BYPASS 0 0 0'
    lines[#lines + 1] = build_plugin_opening_line(fx.pluginName, fx.pluginType, fx.pluginParams)
    if fx.stateBlob then
      -- Preserve original line breaks from the blob (280-char lines from GetTrackStateChunk)
      for blob_line in fx.stateBlob:gmatch("[^\n]+") do
        lines[#lines + 1] = blob_line
      end
    end
    lines[#lines + 1] = '>'
    lines[#lines + 1] = 'FLOATPOS 0 0 0 0'
    lines[#lines + 1] = 'FXID {00000000-0000-0000-0000-000000000000}'
    lines[#lines + 1] = 'WAK 0 0'
  end
  lines[#lines + 1] = '>'
  lines[#lines + 1] = '>'
  return table.concat(lines, '\n')
end

--- Create a temp track with plugins loaded from blob state via SNM_GetSetObjectState.
--- Unlike SetTrackStateChunk, SNM_GetSetObjectState correctly loads AU plugin state
--- (including modular plugins like Snap Heap). Uses 128-char base64 line wrapping.
--- Returns the newly created track or nil.
---@param plugins table[] Array of {pluginName, pluginType, pluginParams, stateBlob}
---@return MediaTrack|nil temp_track The newly created track
local function create_temp_track_with_plugins(plugins)
  -- Create a temp track, get its chunk, then use the CLI to build a proper
  -- chunk with blobs (the CLI's RPP serializer handles blob formatting correctly,
  -- avoiding corruption from the JSON round-trip through our Lua builder).
  local track_count_before = reaper.CountTracks(0)
  reaper.InsertTrackAtIndex(track_count_before, false)
  local temp_track = reaper.GetTrack(0, track_count_before)
  if not temp_track then
    log("  create_temp_track_with_plugins: failed to create temp track")
    return nil
  end

  -- Get the empty temp track's chunk
  local empty_chunk = get_track_chunk(temp_track)
  if not empty_chunk then
    log("  create_temp_track_with_plugins: failed to get temp track chunk")
    reaper.DeleteTrack(temp_track)
    return nil
  end

  -- Use the CLI to build a chunk with correctly formatted blobs
  local apply_result, apply_err = bridge.apply_chunk(empty_chunk, plugins)
  if not apply_result then
    log("  create_temp_track_with_plugins: apply_chunk failed: " .. (apply_err or "unknown"))
    reaper.DeleteTrack(temp_track)
    return nil
  end

  -- Apply the chunk with blobs via SetTrackStateChunk.
  -- This correctly loads AU plugin state (including modular plugins like Snap Heap)
  -- now that the parser captures complete blob data.
  set_track_chunk(temp_track, apply_result.modifiedChunk)
  log("  create_temp_track_with_plugins: loaded " .. reaper.TrackFX_GetCount(temp_track) .. " FX via SetTrackStateChunk")
  return temp_track
end

--- Restore a single plugin's full state via temp track + CopyToTrack.
--- Creates a temp track with the plugin (including blob state), then copies
--- it to the target track at the specified index.
---@param track MediaTrack Target track
---@param plugin_index number 0-based FX index on target
---@param fx table {pluginName, pluginType, pluginParams, stateBlob, parameters}
---@param callback function|nil Called after restoration
local function restore_plugin_with_blob(track, plugin_index, fx, callback)
  local temp_track = create_temp_track_with_plugins({ fx })
  if not temp_track then
    if callback then callback() end
    return
  end

  -- Defer to let FX initialize, apply params (safety net), then copy
  reaper.defer(function()
    -- Apply params to temp track's FX (safety net)
    if fx.parameters then
      local num_params = reaper.TrackFX_GetNumParams(temp_track, 0)
      for key, pv in pairs(fx.parameters) do
        local param_index = tonumber(key)
        if param_index and param_index < num_params then
          reaper.TrackFX_SetParam(temp_track, 0, param_index, pv.value)
        end
      end
    end

    -- Delete the old FX on target, copy the template-loaded one from temp
    reaper.TrackFX_Delete(track, plugin_index)
    reaper.TrackFX_CopyToTrack(temp_track, 0, track, plugin_index, true)
    log("  restore_plugin_with_blob: copied " .. fx.pluginName .. " to index " .. plugin_index)

    reaper.DeleteTrack(temp_track)
    if callback then callback() end
  end)
end

--- Apply a chunk (for structure) then apply parameter maps (for state).
--- Replaces the old set_track_chunk_with_fx_reload workaround.
--- @param track MediaTrack - target track
--- @param chunk string - modified chunk with structural FX chain
--- @param parameter_maps table[]|nil - parameter maps for each FX
--- @param preset string|nil - if provided, snapshot after applying
--- @param reabase_path string|nil
local function apply_chunk_and_parameters(track, chunk, parameter_maps, preset, reabase_path)
  -- Apply chunk with embedded blobs. SetTrackStateChunk correctly loads all plugin
  -- state (including AU modular plugins) now that blob data is captured completely.
  set_track_chunk(track, chunk)

  if parameter_maps and #parameter_maps > 0 then
    -- Apply parameters after a frame to let FX initialize
    apply_fx_parameters(track, parameter_maps, function()
      -- Snapshot after params are applied
      if preset then
        local reaper_chunk = get_track_chunk(track)
        if reaper_chunk then
          local snap_chunk = bridge.snapshot(reaper_chunk, preset, reabase_path, capture_fx_parameters(track))
          if snap_chunk then
            set_track_chunk(track, snap_chunk)
          end
        end
      end
      state.needs_refresh = true
    end)
  else
    -- No parameters to apply — just snapshot
    if preset then
      local reaper_chunk = get_track_chunk(track)
      if reaper_chunk then
        local snap_chunk = bridge.snapshot(reaper_chunk, preset, reabase_path, capture_fx_parameters(track))
        if snap_chunk then
          set_track_chunk(track, snap_chunk)
        end
      end
    end
    state.needs_refresh = true
  end
  return true
end

-- ─── Data fetching ───────────────────────────────────────────────

--- Refresh the inspect state from the CLI.
--- @param silent boolean If true, don't clear UI state (used by auto-poll).
local function refresh_inspect(silent)
  if not silent then
    state.inspect = nil
    state.inspect_error = nil
    state.status_message = nil
  end

  if not state.track then
    return
  end

  state.track_chunk = get_track_chunk(state.track)
  if not state.track_chunk then
    state.inspect_error = "Failed to get track chunk via SWS"
    return
  end

  if not state.reabase_path then
    state.reabase_path = find_reabase_root()
  end
  if not state.reabase_path then
    state.inspect_error = "No .reabase/ directory found.\n"
      .. "Run 'reabase init' in your show/project root."
    return
  end

  -- Capture FX parameters for state hashing
  local fx_params = capture_fx_parameters(state.track)
  local result, err = bridge.inspect_track(state.track_chunk, state.reabase_path, fx_params)
  if err then
    state.inspect_error = err
    return
  end

  state.inspect = result

  -- Only auto-set preset selection on explicit refresh (track change, user
  -- action), not on silent auto-poll — otherwise the user's dropdown
  -- selection gets reset while they're interacting with it.
  if not silent then
    if result and result.preset and result.presets then
      state.selected_preset_index = 0
      for i, preset in ipairs(result.presets) do
        if preset.name == result.preset then
          state.selected_preset_index = i
          break
        end
      end
    else
      state.selected_preset_index = 0
    end
  end
end

--- Simple string hash for change detection (djb2 algorithm).
local function quick_hash(str)
  local hash = 5381
  for i = 1, math.min(#str, 2000) do
    hash = ((hash * 33) + string.byte(str, i)) % 0x100000000
  end
  return hash
end

local POLL_INTERVAL = 30  -- check every ~30 frames (~1 second at 30fps)

local function check_track_change()
  local track = reaper.GetSelectedTrack(0, 0)
  if track ~= state.last_track then
    state.last_track = track
    state.track = track
    state.needs_refresh = true
    state.last_chunk_hash = ""
    state.selected_tab = nil
    state.previous_tab = nil
    state.tabs_need_init = false
    state.pending_assignments = {}
    state.has_pending_changes = false
    state.move_ownership_pending = nil

    if track then
      local _, name = reaper.GetTrackName(track)
      state.track_name = name or "unnamed"
      state.track_guid = reaper.GetTrackGUID(track) or ""
    else
      state.track_name = ""
      state.track_guid = ""
    end
  end

  -- Auto-poll: periodically check if the track chunk has changed
  if track and not state.needs_refresh then
    state.poll_counter = state.poll_counter + 1
    if state.poll_counter >= POLL_INTERVAL then
      state.poll_counter = 0
      local chunk = get_track_chunk(track)
      if chunk then
        local hash = quick_hash(chunk)
        if hash ~= state.last_chunk_hash then
          log("poll: chunk changed! old_hash=" .. state.last_chunk_hash .. " new_hash=" .. hash)
          state.last_chunk_hash = hash
          state.needs_refresh = "poll"
        end
      end
    end
  end

  if state.needs_refresh then
    local silent = state.needs_refresh == "poll"
    state.needs_refresh = false
    refresh_inspect(silent)
    -- Update hash after refresh so we don't immediately re-trigger
    if state.track_chunk then
      state.last_chunk_hash = quick_hash(state.track_chunk)
    end
  end
end

-- ─── Actions ─────────────────────────────────────────────────────

local function assign_preset(preset_name, replace, keep_both)
  if not state.track or not state.track_chunk then
    return
  end

  log("=== assign_preset('" .. preset_name .. "', replace=" .. tostring(replace) .. ") ===")

  local modified, err = bridge.set_preset(state.track_chunk, preset_name)
  if err then
    state.status_message = "Error: " .. err
    state.status_is_error = true
    return
  end

  log("  set_preset done, writing to REAPER...")

  reaper.Undo_BeginBlock()
  set_track_chunk(state.track, modified)
  reaper.Undo_EndBlock("reabase: assign preset '" .. preset_name .. "'", -1)

  -- Re-read from REAPER to get the chunk as REAPER normalizes it.
  -- This is critical: REAPER may reformat whitespace, line breaks etc. in the
  -- chunk, so we must snapshot from what REAPER actually has, not what we wrote.
  local reaper_chunk = get_track_chunk(state.track)
  if not reaper_chunk then
    state.status_message = "Preset assigned, but failed to re-read track chunk"
    state.status_is_error = true
    state.needs_refresh = true
    return
  end

  log("  re-read chunk from REAPER: " .. #reaper_chunk .. " bytes")

  -- Replace mode: apply the resolved chain to overwrite existing FX
  if replace then
    local inspect_result, inspect_err = bridge.inspect_track(reaper_chunk, state.reabase_path, capture_fx_parameters(state.track))
    if inspect_result and inspect_result.merge and inspect_result.merge.resolvedChain then
      local apply_result, apply_err = bridge.apply_chunk(reaper_chunk, inspect_result.merge.resolvedChain)
      if apply_result then
        set_track_chunk(state.track, apply_result.modifiedChunk)
        -- Apply parameters after a frame for FX to initialize, then snapshot
        if apply_result.parameterMaps and #apply_result.parameterMaps > 0 then
          apply_fx_parameters(state.track, apply_result.parameterMaps, function()
            -- Snapshot AFTER params are applied so hashes match
            local post_param_chunk = get_track_chunk(state.track)
            if post_param_chunk then
              local snap_chunk = bridge.snapshot(post_param_chunk, preset_name, state.reabase_path, capture_fx_parameters(state.track))
              if snap_chunk then
                set_track_chunk(state.track, snap_chunk)
                log("  replace: snapshot done after param apply")
              end
            end
            state.selected_tab = nil
            state.previous_tab = nil
            state.pending_assignments = {}
            state.has_pending_changes = false
            state.status_message = "Preset set to '" .. preset_name .. "'"
            state.status_is_error = false
            state.needs_refresh = true
          end)
          reaper.Undo_EndBlock("reabase: assign preset '" .. preset_name .. "'", -1)
          return -- early return; the deferred callback handles the rest
        end
        reaper_chunk = get_track_chunk(state.track)
        if not reaper_chunk then
          state.status_message = "Preset assigned (replace), but failed to re-read after apply"
          state.status_is_error = true
          state.needs_refresh = true
          return
        end
        log("  replace: applied resolved chain, re-read " .. #reaper_chunk .. " bytes")
      else
        log("  replace: apply_chunk failed: " .. (apply_err or "unknown"))
      end
    else
      log("  replace: inspect failed or no resolved chain: " .. (inspect_err or "no chain"))
    end
  end

  -- Snapshot the current FX chain as baseline (returns chunk with slot map).
  -- In "Keep both" mode, preserve local slotIds so existing plugins
  -- aren't matched to preset slots — they stay as local additions.
  -- Normal assign (save+assign) uses standard resolution so plugins match the preset.
  local preserve_local = keep_both
  local snap_chunk, snap_err = bridge.snapshot(reaper_chunk, preset_name, state.reabase_path, capture_fx_parameters(state.track), preserve_local)
  if not snap_chunk then
    state.status_message = "Preset assigned, but snapshot failed: " .. (snap_err or "unknown")
    state.status_is_error = true
    state.needs_refresh = true
    return
  end

  log("  snapshot done, writing slot map to REAPER...")

  -- Write slot map back to track
  set_track_chunk(state.track, snap_chunk)

  -- In "Keep both" mode, the preset's plugins aren't on the track yet (they're add_base).
  -- Insert ONLY the missing preset plugins via REAPER API, preserving existing plugins'
  -- full internal state (not just params). This avoids rebuilding the entire FXCHAIN.
  if keep_both then
    local post_snap_chunk = get_track_chunk(state.track)
    if post_snap_chunk then
      local inspect_result = bridge.inspect_track(post_snap_chunk, state.reabase_path, capture_fx_parameters(state.track))

      -- Debug: dump the keep-both inspect results
      if inspect_result then
        log("  keep-both inspect: status=" .. (inspect_result.status or "nil"))
        if inspect_result.currentChain then
          for _, fx in ipairs(inspect_result.currentChain) do
            log("    current: " .. fx.slotId .. " = " .. (fx.stateHash or "") .. " (" .. fx.pluginName .. ")")
          end
        end
        if inspect_result.merge and inspect_result.merge.actions then
          for _, a in ipairs(inspect_result.merge.actions) do
            local fx = a.fx or a["local"] or a.base
            log("    action: " .. a.type .. " — " .. (fx and fx.pluginName or "?") .. " [" .. (fx and fx.slotId or "?") .. "]")
          end
        end
      end

      if inspect_result and inspect_result.merge and inspect_result.merge.actions then
        -- Collect add_base plugins (preset plugins not yet on the track)
        local plugins_to_add = {}
        for _, action in ipairs(inspect_result.merge.actions) do
          if action.type == "add_base" and action.fx then
            plugins_to_add[#plugins_to_add + 1] = action.fx
          end
        end

        if #plugins_to_add > 0 then
          local existing_fx_count = reaper.TrackFX_GetCount(state.track)

          -- Check if any plugins have blobs for full state restoration
          local has_blobs = false
          for _, fx in ipairs(plugins_to_add) do
            if fx.stateBlob then has_blobs = true; break end
          end

          if has_blobs then
            -- Blob path: insert temp track via .RTrackTemplate (loads AU state correctly),
            -- then CopyToTrack each FX to the target. Preserves full plugin state.
            log("  keep-both: adding " .. #plugins_to_add .. " preset plugins via track template (blob)")
            local temp_track = create_temp_track_with_plugins(plugins_to_add)
            if temp_track then
              -- Defer to let FX initialize, apply params (safety net), then copy
              reaper.defer(function()
                -- Apply params to temp track's FX (safety net)
                for i = 0, #plugins_to_add - 1 do
                  local fx = plugins_to_add[i + 1]
                  if fx.parameters then
                    local num_params = reaper.TrackFX_GetNumParams(temp_track, i)
                    for key, pv in pairs(fx.parameters) do
                      local param_index = tonumber(key)
                      if param_index and param_index < num_params then
                        reaper.TrackFX_SetParam(temp_track, i, param_index, pv.value)
                      end
                    end
                  end
                end

                -- Copy each FX from temp to target (at end, preserving local plugins)
                for i = 0, #plugins_to_add - 1 do
                  reaper.TrackFX_CopyToTrack(temp_track, i, state.track, existing_fx_count + i, false)
                  log("    copied " .. plugins_to_add[i + 1].pluginName .. " to index " .. (existing_fx_count + i))
                end

                reaper.DeleteTrack(temp_track)

                -- Re-snapshot after copy
                local final_chunk = get_track_chunk(state.track)
                if final_chunk then
                  local resnap = bridge.snapshot(final_chunk, preset_name, state.reabase_path, capture_fx_parameters(state.track))
                  if resnap then
                    set_track_chunk(state.track, resnap)
                    log("  keep-both: re-snapshot after blob insert")
                  end
                end
                state.needs_refresh = true
              end)
            end
          else
            -- No-blob path: use TrackFX_AddByName + params (existing approach)
            log("  keep-both: adding " .. #plugins_to_add .. " preset plugins after " .. existing_fx_count .. " existing FX")

            for i = 1, #plugins_to_add do
              local fx = plugins_to_add[i]
              local fx_index = reaper.TrackFX_AddByName(state.track, fx.pluginName, false, -1)
              if fx_index >= 0 then
                log("    added " .. fx.pluginName .. " at index " .. fx_index)
              else
                log("    FAILED to add " .. fx.pluginName)
              end
            end

            local new_param_maps = {}
            local total_fx = reaper.TrackFX_GetCount(state.track)
            for i = 1, total_fx do
              if i > existing_fx_count then
                local add_index = i - existing_fx_count
                new_param_maps[i] = plugins_to_add[add_index] and plugins_to_add[add_index].parameters
              end
            end

            apply_fx_parameters(state.track, new_param_maps, function()
              local final_chunk = get_track_chunk(state.track)
              if final_chunk then
                local resnap = bridge.snapshot(final_chunk, preset_name, state.reabase_path, capture_fx_parameters(state.track))
                if resnap then
                  set_track_chunk(state.track, resnap)
                  log("  keep-both: re-snapshot after insert")
                end
              end
              state.needs_refresh = true
            end)
          end

          reaper.Undo_EndBlock("reabase: assign preset '" .. preset_name .. "'", -1)
          state.selected_tab = nil
          state.previous_tab = nil
          state.pending_assignments = {}
          state.has_pending_changes = false
          state.status_message = "Preset set to '" .. preset_name .. "'"
          state.status_is_error = false
          return -- deferred callback handles the rest
        end
      end
    end
  end

  -- Re-read again to capture what REAPER actually has after slot map write
  local final_chunk = get_track_chunk(state.track)
  if final_chunk then
    log("  final chunk: " .. #final_chunk .. " bytes, hash=" .. quick_hash(final_chunk))
  end

  state.selected_tab = nil
  state.previous_tab = nil
  state.pending_assignments = {}
  state.has_pending_changes = false
  state.status_message = "Preset set to '" .. preset_name .. "'"
  state.status_is_error = false
  state.needs_refresh = true
end

local function remove_preset()
  if not state.track or not state.track_chunk then
    return
  end

  local modified, err = bridge.set_preset(state.track_chunk, "")
  if err then
    state.status_message = "Error: " .. err
    state.status_is_error = true
    return
  end

  reaper.Undo_BeginBlock()
  set_track_chunk(state.track, modified)
  reaper.Undo_EndBlock("reabase: remove preset from '" .. state.track_name .. "'", -1)

  state.selected_preset_index = 0
  state.status_message = "Preset removed"
  state.status_is_error = false
  state.needs_refresh = true
end

local function apply_preset()
  log("=== apply_preset() ===")
  if not state.track or not state.track_chunk then
    log("  BAIL: no track or chunk")
    return
  end
  if not state.inspect or not state.inspect.merge then
    log("  BAIL: no inspect or merge")
    return
  end

  -- Determine apply strategy:
  -- - Structural changes (add/remove/reorder) → full apply_chunk rebuild
  -- - State-only changes (use_new_base) → surgical per-slot revert_plugin
  local has_structural_changes = false
  local slots_to_update = {}
  for _, action in ipairs(state.inspect.merge.actions) do
    if action.type == "add_base" or action.type == "remove" then
      has_structural_changes = true
      break
    elseif action.type == "use_new_base" then
      slots_to_update[#slots_to_update + 1] = action.fx.slotId
    end
  end

  -- Detect order changes: compare resolved chain order to current chain order.
  -- The resolved chain follows the preset's intended order; if it differs from
  -- the current track order, we need a full structural rebuild.
  if not has_structural_changes and state.inspect.merge.resolvedChain and state.inspect.currentChain then
    local resolved_order = {}
    local current_order = {}
    -- Build ordered slotId lists for managed plugins only
    local resolved_slots = {}
    for _, fx in ipairs(state.inspect.merge.resolvedChain) do
      resolved_slots[fx.slotId] = true
    end
    for _, fx in ipairs(state.inspect.merge.resolvedChain) do
      resolved_order[#resolved_order + 1] = fx.slotId
    end
    for _, fx in ipairs(state.inspect.currentChain) do
      if resolved_slots[fx.slotId] then
        current_order[#current_order + 1] = fx.slotId
      end
    end
    -- Compare orders
    if #resolved_order == #current_order then
      for i = 1, #resolved_order do
        if resolved_order[i] ~= current_order[i] then
          has_structural_changes = true
          log("  order change detected at position " .. i .. ": " .. current_order[i] .. " -> " .. resolved_order[i])
          break
        end
      end
    end
  end

  reaper.Undo_BeginBlock()

  local role = state.inspect.preset

  if has_structural_changes then
    -- Structural changes: need full FXCHAIN replacement + param apply
    local resolved_chain = state.inspect.merge.resolvedChain
    if not resolved_chain then
      state.status_message = "Error: no resolved chain in merge result"
      state.status_is_error = true
      reaper.Undo_EndBlock("reabase: apply preset (failed)", -1)
      return
    end
    local result, err = bridge.apply_chunk(state.track_chunk, resolved_chain)
    if err then
      state.status_message = "Error: " .. err
      state.status_is_error = true
      reaper.Undo_EndBlock("reabase: apply preset (failed)", -1)
      return
    end
    apply_chunk_and_parameters(state.track, result.modifiedChunk, result.parameterMaps, role, state.reabase_path)
  else
    -- State-only changes: apply parameter maps via TrackFX_SetParam
    local param_maps_by_index = {}
    for _, slot_id in ipairs(slots_to_update) do
      log("  reverting slot " .. slot_id .. " to preset state")
      local result, err = bridge.revert_plugin(state.track_chunk, slot_id, state.reabase_path)
      if err then
        log("  ERROR reverting " .. slot_id .. ": " .. err)
      elseif result and result.pluginIndex ~= nil and result.parameterMap then
        -- pluginIndex is 0-based from CLI, store as 1-based for Lua array
        param_maps_by_index[result.pluginIndex + 1] = result.parameterMap
        log("  got params for FX index " .. result.pluginIndex)
      else
        log("  WARNING: revert_plugin returned no pluginIndex or parameterMap for " .. slot_id)
      end
    end
    -- Build a dense array for apply_fx_parameters (nil entries are skipped)
    local param_maps_array = {}
    local fx_count = reaper.TrackFX_GetCount(state.track)
    for i = 1, fx_count do
      param_maps_array[i] = param_maps_by_index[i]
    end
    apply_fx_parameters(state.track, param_maps_array, function()
      if role then
        local reaper_chunk = get_track_chunk(state.track)
        if reaper_chunk then
          local snap_chunk = bridge.snapshot(reaper_chunk, role, state.reabase_path, capture_fx_parameters(state.track))
          if snap_chunk then
            set_track_chunk(state.track, snap_chunk)
          end
        end
      end
      state.needs_refresh = true
    end)
  end

  reaper.Undo_EndBlock("reabase: apply preset to '" .. state.track_name .. "'", -1)

  state.status_message = "Preset applied"
  state.status_is_error = false
  state.needs_refresh = true
end

local function keep_mine()
  if not state.track or not state.track_chunk then
    return
  end

  local role = state.inspect and state.inspect.preset
  if not role then
    return
  end

  -- Re-read from REAPER to snapshot what REAPER actually has
  local reaper_chunk = get_track_chunk(state.track)
  if not reaper_chunk then
    state.status_message = "Error: failed to read track chunk"
    state.status_is_error = true
    return
  end

  local snap_chunk, snap_err = bridge.snapshot(reaper_chunk, role, state.reabase_path, capture_fx_parameters(state.track))
  if not snap_chunk then
    state.status_message = "Error: " .. (snap_err or "unknown")
    state.status_is_error = true
    return
  end

  -- Write slot map back to track
  reaper.Undo_BeginBlock()
  set_track_chunk(state.track, snap_chunk)
  reaper.Undo_EndBlock("reabase: keep local version", -1)

  state.status_message = "Kept local version, snapshot updated"
  state.status_is_error = false
  state.needs_refresh = true
end

local function save_as_preset(name, force_overwrite, extends_preset)
  if not state.track or not state.track_chunk then
    return
  end
  if not name or name == "" then
    state.status_message = "Error: preset name cannot be empty"
    state.status_is_error = true
    return
  end

  -- Build selected indices (0-based) from checkboxes
  -- Use == true to exclude "disabled" sentinel values
  local selected_indices = nil
  if state.new_preset_fx_selected and #state.new_preset_fx_selected > 0 then
    selected_indices = {}
    for i, checked in ipairs(state.new_preset_fx_selected) do
      if checked == true then
        selected_indices[#selected_indices + 1] = i - 1  -- 0-based
      end
    end
  end

  log("=== save_as_preset('" .. name .. "') ===")

  local fx_params = capture_fx_parameters(state.track)
  local ok, err, exists = bridge.save_preset(
    state.track_chunk, name, state.reabase_path,
    selected_indices, extends_preset, force_overwrite, nil, fx_params
  )
  log("  save_preset result: ok=" .. tostring(ok) .. " exists=" .. tostring(exists))
  if exists then
    -- Preset already exists — ask for confirmation
    state.overwrite_pending = true
    state.overwrite_preset_name = name
    state.overwrite_extends_preset = extends_preset
    return
  end
  if not ok then
    state.status_message = "Error: " .. (err or "unknown")
    state.status_is_error = true
    return
  end

  -- Assign the newly created preset to this track
  assign_preset(name)

  state.selected_tab = nil
  state.previous_tab = nil
  state.new_preset_name = ""
  state.new_preset_fx_selected = {}
  state.overwrite_pending = false
  state.overwrite_preset_name = ""
  state.overwrite_extends_preset = nil
  state.status_message = "Preset '" .. name .. "' created and assigned"
  state.status_is_error = false
  state.needs_refresh = true
end

local function revert_plugin(slot_id)
  if not state.track or not state.track_chunk then
    return
  end

  local result, err = bridge.revert_plugin(state.track_chunk, slot_id, state.reabase_path)
  if err then
    state.status_message = "Error: " .. err
    state.status_is_error = true
    return
  end

  reaper.Undo_BeginBlock()
  if result and result.pluginIndex ~= nil and result.parameterMap then
    -- Step 1: Try parameter-only revert (cheap, no flicker)
    local fx_index = result.pluginIndex
    for key, pv in pairs(result.parameterMap) do
      local param_index = tonumber(key)
      if param_index then
        reaper.TrackFX_SetParam(state.track, fx_index, param_index, pv.value)
      end
    end
    log("  revert: applied params for " .. (result.pluginName or slot_id))

    -- Step 2: Check if blob now matches — if so, params were sufficient
    if result.stateBlob and result.pluginName then
      -- Re-read the track chunk to get the current blob after param revert
      local updated_chunk = get_track_chunk(state.track)
      if updated_chunk then
        local current_blob_result = bridge.revert_plugin(updated_chunk, slot_id, state.reabase_path)
        -- Compare: if the current blob still differs from preset blob, do full restore
        if current_blob_result and current_blob_result.stateBlob ~= result.stateBlob then
          log("  revert: blobs still differ after param revert — doing full blob restore")
          restore_plugin_with_blob(state.track, result.pluginIndex, {
            pluginName = result.pluginName,
            pluginType = result.pluginType,
            pluginParams = result.pluginParams,
            stateBlob = result.stateBlob,
            parameters = result.parameterMap,
          })
        else
          log("  revert: param revert was sufficient (blobs match)")
        end
      end
    end
  end
  reaper.Undo_EndBlock("reabase: revert plugin '" .. slot_id .. "'", -1)

  state.status_message = "Plugin '" .. slot_id .. "' reverted to preset state"
  state.status_is_error = false
  state.needs_refresh = true
end

local function link_override(child_slot_id, parent_slot_id)
  if not state.track or not state.track_chunk then
    return
  end

  local fx_params = capture_fx_parameters(state.track)
  local result, err = bridge.link_as_override(
    state.track_chunk, child_slot_id, parent_slot_id, state.reabase_path, fx_params
  )
  if err then
    state.status_message = "Error: " .. err
    state.status_is_error = true
    return
  end

  if result and result.modifiedChunk then
    reaper.Undo_BeginBlock()
    apply_chunk_and_parameters(state.track, result.modifiedChunk, result.parameterMaps,
      state.inspect and state.inspect.preset, state.reabase_path)
    reaper.Undo_EndBlock("reabase: override '" .. parent_slot_id .. "' with '" .. child_slot_id .. "'", -1)
  end

  state.status_message = "Override applied"
  state.status_is_error = false
  state.needs_refresh = true
end

--- Build the ownership map and released array from pending_assignments and resolvedChain.
local function build_ownership_tables()
  local inspect = state.inspect
  if not inspect or not inspect.resolvedChain then
    return {}, {}
  end

  -- Start with the resolved chain's origin assignments
  local effective_owner = {}
  for _, fx in ipairs(inspect.resolvedChain) do
    if fx.origin then
      effective_owner[fx.slotId] = fx.origin
    end
  end

  -- Apply pending assignments on top
  for slotId, assignment in pairs(state.pending_assignments) do
    if assignment == RELEASED then
      effective_owner[slotId] = nil
    else
      effective_owner[slotId] = assignment
    end
  end

  -- Build ownership map: preset_name -> array of slotIds
  local ownership = {}
  local released = {}

  for slotId, preset_name in pairs(effective_owner) do
    if not ownership[preset_name] then
      ownership[preset_name] = {}
    end
    local t = ownership[preset_name]
    t[#t + 1] = slotId
  end

  -- Build released array from pending assignments that use RELEASED
  for slotId, assignment in pairs(state.pending_assignments) do
    if assignment == RELEASED then
      released[#released + 1] = slotId
    end
  end

  return ownership, released
end

local function update_presets_action()
  if not state.track or not state.track_chunk then
    return
  end

  local ownership, released = build_ownership_tables()

  local fx_params = capture_fx_parameters(state.track)
  local result, err = bridge.update_presets(
    state.track_chunk, ownership, released, state.reabase_path, fx_params
  )
  if err then
    state.status_message = "Error: " .. err
    state.status_is_error = true
    return
  end

  if result and result.modifiedChunk then
    reaper.Undo_BeginBlock()
    set_track_chunk(state.track, result.modifiedChunk)
    reaper.Undo_EndBlock("reabase: update presets", -1)
  end

  state.pending_assignments = {}
  state.has_pending_changes = false
  local preset_names = result and result.updatedPresets or {}
  state.status_message = "Updated presets: " .. table.concat(preset_names, ", ")
  state.status_is_error = false
  state.needs_refresh = true
end

local function update_and_sync_project()
  if not state.track or not state.track_chunk then
    return
  end

  -- First update presets from the current track
  local ownership, released = build_ownership_tables()
  local fx_params = capture_fx_parameters(state.track)

  local result, err = bridge.update_presets(
    state.track_chunk, ownership, released, state.reabase_path, fx_params
  )
  if err then
    state.status_message = "Error updating presets: " .. err
    state.status_is_error = true
    return
  end

  if result and result.modifiedChunk then
    set_track_chunk(state.track, result.modifiedChunk)
  end

  -- Now sync all other tracks in the project
  local synced_count = 0
  reaper.Undo_BeginBlock()

  local track_count = reaper.CountTracks(0)
  log("  sync: scanning " .. track_count .. " tracks")
  for i = 0, track_count - 1 do
    local track = reaper.GetTrack(0, i)
    if track ~= state.track then
      local chunk = get_track_chunk(track)
      if chunk then
        log("  sync: inspecting track " .. i .. " (" .. #chunk .. " bytes)")
        local track_fx_params = capture_fx_parameters(track)
        local inspect_result, inspect_err = bridge.inspect_track(chunk, state.reabase_path, track_fx_params)
        log("  sync: track " .. i .. " status=" .. (inspect_result and inspect_result.status or inspect_err or "nil"))
        if inspect_result and inspect_result.status == "upstream-changes" and inspect_result.merge then
          -- Collect slots that need updating
          local slots_to_update = {}
          local has_structural = false
          for _, action in ipairs(inspect_result.merge.actions) do
            if action.type == "add_base" or action.type == "remove" then
              has_structural = true
              break
            elseif action.type == "use_new_base" then
              slots_to_update[#slots_to_update + 1] = action.fx.slotId
            end
          end

          -- Detect order changes (same logic as apply_preset)
          if not has_structural and inspect_result.merge.resolvedChain and inspect_result.currentChain then
            local resolved_slots = {}
            local resolved_order = {}
            local current_order = {}
            for _, fx in ipairs(inspect_result.merge.resolvedChain) do
              resolved_slots[fx.slotId] = true
              resolved_order[#resolved_order + 1] = fx.slotId
            end
            for _, fx in ipairs(inspect_result.currentChain) do
              if resolved_slots[fx.slotId] then
                current_order[#current_order + 1] = fx.slotId
              end
            end
            if #resolved_order == #current_order then
              for idx = 1, #resolved_order do
                if resolved_order[idx] ~= current_order[idx] then
                  has_structural = true
                  break
                end
              end
            end
          end

          local sync_preset = inspect_result.preset
          if has_structural then
            local resolved_chain = inspect_result.merge.resolvedChain
            if resolved_chain then
              local apply_result = bridge.apply_chunk(chunk, resolved_chain)
              if apply_result then
                apply_chunk_and_parameters(track, apply_result.modifiedChunk, apply_result.parameterMaps, sync_preset, state.reabase_path)
              end
            end
          else
            -- State-only changes: apply parameters directly
            local param_maps = {}
            for _, slot_id in ipairs(slots_to_update) do
              log("  sync: reverting slot " .. slot_id .. " on track " .. i)
              local result = bridge.revert_plugin(chunk, slot_id, state.reabase_path)
              if result and result.pluginIndex ~= nil and result.parameterMap then
                param_maps[result.pluginIndex + 1] = result.parameterMap -- 0-based to 1-based
              end
            end
            apply_fx_parameters(track, param_maps, function()
              if sync_preset then
                local reaper_chunk = get_track_chunk(track)
                if reaper_chunk then
                  local snap_chunk = bridge.snapshot(reaper_chunk, sync_preset, state.reabase_path, capture_fx_parameters(track))
                  if snap_chunk then set_track_chunk(track, snap_chunk) end
                end
              end
            end)
          end
          synced_count = synced_count + 1
        end
      end
    end
  end

  reaper.Undo_EndBlock("reabase: update presets and sync project", -1)

  state.pending_assignments = {}
  state.has_pending_changes = false
  local preset_names = result and result.updatedPresets or {}
  state.status_message = "Updated presets: " .. table.concat(preset_names, ", ")
    .. " | Synced " .. synced_count .. " other track(s)"
  state.status_is_error = false
  state.needs_refresh = true
end

local function revert_all()
  -- Re-applies the preset's clean resolved chain, discarding all local changes.
  -- Uses resolvedChain (pure preset state) NOT merge.resolvedChain (which preserves local mods).
  if not state.track or not state.track_chunk then
    return
  end
  if not state.inspect or not state.inspect.resolvedChain then
    return
  end

  local result, err = bridge.apply_chunk(state.track_chunk, state.inspect.resolvedChain)
  if err then
    state.status_message = "Error: " .. err
    state.status_is_error = true
    return
  end

  local role = state.inspect.preset

  reaper.Undo_BeginBlock()
  apply_chunk_and_parameters(state.track, result.modifiedChunk, result.parameterMaps, role, state.reabase_path)
  reaper.Undo_EndBlock("reabase: revert all local changes on '" .. state.track_name .. "'", -1)

  state.status_message = "All local changes reverted"
  state.status_is_error = false
  state.needs_refresh = true
end

local function delete_preset(name)
  if not name or name == "" then
    return
  end

  local ok, err = bridge.delete_preset(name, state.reabase_path)
  if not ok then
    state.status_message = "Error deleting preset: " .. (err or "not found")
    state.status_is_error = true
    return
  end

  -- If the deleted preset was assigned to this track, remove the assignment
  if state.inspect and state.inspect.preset == name then
    remove_preset()
  end

  state.delete_pending = false
  state.delete_preset_name = ""
  state.status_message = "Preset '" .. name .. "' deleted"
  state.status_is_error = false
  state.needs_refresh = true
end

-- ─── UI Rendering ────────────────────────────────────────────────

local STATUS_COLORS = {
  ["up-to-date"]          = 0x4CAF50FF,
  ["modified"]            = 0xFFC107FF,
  ["upstream-changes"]    = 0x2196F3FF,
  ["conflict"]            = 0xF44336FF,
  ["no-snapshot"]         = 0x9E9E9EFF,
  ["no-preset"]             = 0x9E9E9EFF,
  ["unresolvable-preset"] = 0xFF5722FF,
}

local STATUS_LABELS = {
  ["up-to-date"]          = "Up to date",
  ["modified"]            = "Modified locally",
  ["upstream-changes"]    = "Upstream changes available",
  ["conflict"]            = "Conflict",
  ["no-snapshot"]         = "Not yet synced",
  ["no-preset"]             = "No preset assigned",
  ["unresolvable-preset"] = "Unknown preset",
}

local STATUS_ICONS = {
  ["up-to-date"]          = icons.CIRCLE_CHECK,
  ["modified"]            = icons.CIRCLE_DOT,
  ["upstream-changes"]    = icons.CIRCLE_ARROW_DOWN,
  ["conflict"]            = icons.CIRCLE_ALERT,
  ["no-snapshot"]         = icons.CIRCLE_MINUS,
  ["no-preset"]           = icons.CIRCLE,
  ["unresolvable-preset"] = icons.CIRCLE_HELP,
}

local function render_status(status)
  local color = STATUS_COLORS[status] or 0x9E9E9EFF
  local label = STATUS_LABELS[status] or status
  local icon = STATUS_ICONS[status]
  reaper.ImGui_PushStyleColor(ctx, reaper.ImGui_Col_Text(), color)
  if icon then
    icons.text(ctx, icon)
    reaper.ImGui_SameLine(ctx, 0, 5)
  end
  reaper.ImGui_Text(ctx, label)
  reaper.ImGui_PopStyleColor(ctx)
end

--- Get the currently selected preset name, or nil for (none).
local function get_selected_preset_name()
  local inspect = state.inspect
  if not inspect or not inspect.presets then return nil end
  if state.selected_preset_index > 0 and state.selected_preset_index <= #inspect.presets then
    return inspect.presets[state.selected_preset_index].name
  end
  return nil
end

-- ─── Tab helpers ──────────────────────────────────────────────

local CREATE_TAB = "##create"
local EXTEND_TAB = "##extend"

local function is_creation_tab()
  return state.selected_tab == CREATE_TAB or state.selected_tab == EXTEND_TAB
end

--- Initialize checkboxes when switching tabs.
--- Create tab: all FX checked (true).
--- Extend tab: parent-owned FX marked "disabled" (grayed out); unassigned FX checked (true).
--- Preset tab: clear checkboxes.
local function init_tab_checkboxes()
  local inspect = state.inspect
  if not inspect then return end

  if state.selected_tab == CREATE_TAB then
    state.new_preset_fx_selected = {}
    if inspect.currentChain then
      for i = 1, #inspect.currentChain do
        state.new_preset_fx_selected[i] = true
      end
    end
  elseif state.selected_tab == EXTEND_TAB then
    state.new_preset_fx_selected = {}
    if inspect.currentChain then
      -- Build lookup of slotIds that have an origin in resolvedChain
      local owned_slots = {}
      if inspect.resolvedChain then
        for _, resolved_fx in ipairs(inspect.resolvedChain) do
          if resolved_fx.slotId and resolved_fx.origin then
            owned_slots[resolved_fx.slotId] = true
          end
        end
      end
      for i, fx in ipairs(inspect.currentChain) do
        local slot_id = fx.slotId or ""
        if owned_slots[slot_id] then
          state.new_preset_fx_selected[i] = "disabled"
        else
          state.new_preset_fx_selected[i] = true
        end
      end
    end
  else
    state.new_preset_fx_selected = {}
  end
end

--- Render the tab bar: "Create preset" when no preset, inheritance chain + "Extend preset" when preset assigned.
local function render_tab_bar()
  local inspect = state.inspect
  if not inspect then return end

  local has_preset = inspect.preset and inspect.preset ~= ""
  local chain = inspect.inheritanceChain or {}

  -- Default selected_tab
  if not state.selected_tab then
    if has_preset and #chain > 0 then
      state.selected_tab = chain[#chain]  -- leaf
    else
      state.selected_tab = CREATE_TAB
    end
    state.tabs_need_init = true
  end

  if reaper.ImGui_BeginTabBar(ctx, "##main_tabs") then
    if has_preset then
      -- Inheritance chain tabs
      for _, preset_name in ipairs(chain) do
        local flags = 0
        if state.tabs_need_init and preset_name == state.selected_tab then
          flags = reaper.ImGui_TabItemFlags_SetSelected()
        end
        local selected = reaper.ImGui_BeginTabItem(ctx, preset_name, nil, flags)
        if selected then
          state.selected_tab = preset_name
          reaper.ImGui_EndTabItem(ctx)
        end
      end

      -- "Extend preset" tab
      local extend_flags = 0
      if state.tabs_need_init and state.selected_tab == EXTEND_TAB then
        extend_flags = reaper.ImGui_TabItemFlags_SetSelected()
      end
      local extend_selected = reaper.ImGui_BeginTabItem(ctx, "Extend preset##extend", nil, extend_flags)
      if extend_selected then
        state.selected_tab = EXTEND_TAB
        reaper.ImGui_EndTabItem(ctx)
      end
    else
      -- No preset: single "Create preset" tab
      local create_flags = 0
      if state.tabs_need_init and state.selected_tab == CREATE_TAB then
        create_flags = reaper.ImGui_TabItemFlags_SetSelected()
      end
      local create_selected = reaper.ImGui_BeginTabItem(ctx, "Create preset##create", nil, create_flags)
      if create_selected then
        state.selected_tab = CREATE_TAB
        reaper.ImGui_EndTabItem(ctx)
      end
    end

    state.tabs_need_init = false
    reaper.ImGui_EndTabBar(ctx)

    -- Remove spacing after tab bar so the table connects flush
    reaper.ImGui_SetCursorPosY(ctx, reaper.ImGui_GetCursorPosY(ctx) - ({reaper.ImGui_GetStyleVar(ctx, reaper.ImGui_StyleVar_ItemSpacing())})[2])
  end

  -- Check for tab transitions
  if state.selected_tab ~= state.previous_tab then
    init_tab_checkboxes()
    state.select_all_checked = false
    state.previous_tab = state.selected_tab
  end
end

--- Render the preset selector dropdown and assign/unassign/delete buttons.
local function render_preset_selector()
  local inspect = state.inspect

  local current_label = "(none)"
  local selected_name = get_selected_preset_name()
  if selected_name then
    current_label = selected_name
  end

  local current_assignment = inspect and inspect.preset
  local is_assigned = selected_name and selected_name == current_assignment
  local is_different_preset = selected_name and selected_name ~= current_assignment

  -- Measure button widths to reserve space on the right
  local assign_w = reaper.ImGui_CalcTextSize(ctx, "Assign")
  local unassign_w = reaper.ImGui_CalcTextSize(ctx, "Unassign")
  local delete_w = reaper.ImGui_CalcTextSize(ctx, "Delete")
  local frame_pad_x = ({reaper.ImGui_GetStyleVar(ctx, reaper.ImGui_StyleVar_FramePadding())})[1]
  local item_spacing_x = ({reaper.ImGui_GetStyleVar(ctx, reaper.ImGui_StyleVar_ItemSpacing())})[1]

  -- Calculate right-side reserved width
  local action_btn_w = math.max(assign_w, unassign_w) + frame_pad_x * 2
  local delete_btn_w = delete_w + frame_pad_x * 2
  local reserved_right = item_spacing_x + action_btn_w + item_spacing_x + delete_btn_w

  reaper.ImGui_Text(ctx, "Preset:")
  reaper.ImGui_SameLine(ctx)

  reaper.ImGui_SetNextItemWidth(ctx, -reserved_right)
  if reaper.ImGui_BeginCombo(ctx, "##preset", current_label) then
    -- Preset options (no "(none)" entry — unassign via button instead)
    if inspect and inspect.presets then
      for i, preset in ipairs(inspect.presets) do
        local label = preset.name
        if preset.description then
          label = label .. "  --  " .. preset.description
        end
        if reaper.ImGui_Selectable(ctx, label, state.selected_preset_index == i) then
          state.selected_preset_index = i
        end
      end
    end

    reaper.ImGui_EndCombo(ctx)
  end

  -- Assign / Unassign button
  reaper.ImGui_SameLine(ctx)
  if is_assigned or (current_assignment and not selected_name) then
    -- Currently assigned preset is selected (or no selection but has assignment): show Unassign
    if reaper.ImGui_Button(ctx, "Unassign##unassign_preset", action_btn_w) then
      remove_preset()
    end
  elseif is_different_preset then
    -- Different preset selected: show Assign
    if reaper.ImGui_Button(ctx, "Assign##assign_preset", action_btn_w) then
      if inspect and inspect.currentChain and #inspect.currentChain > 0 then
        state.assign_conflict_pending = true
        state.assign_conflict_preset = selected_name
      else
        assign_preset(selected_name, true)
      end
    end
  else
    -- No preset selected and nothing assigned: disabled Assign
    reaper.ImGui_BeginDisabled(ctx)
    reaper.ImGui_Button(ctx, "Assign##assign_preset", action_btn_w)
    reaper.ImGui_EndDisabled(ctx)
  end

  -- Delete button
  reaper.ImGui_SameLine(ctx)
  if selected_name then
    reaper.ImGui_PushStyleColor(ctx, reaper.ImGui_Col_Button(), 0x8B0000FF)
    reaper.ImGui_PushStyleColor(ctx, reaper.ImGui_Col_ButtonHovered(), 0xB22222FF)
    if reaper.ImGui_Button(ctx, "Delete##delete_preset", delete_btn_w) then
      state.delete_pending = true
      state.delete_preset_name = selected_name
    end
    reaper.ImGui_PopStyleColor(ctx, 2)
  else
    reaper.ImGui_BeginDisabled(ctx)
    reaper.ImGui_Button(ctx, "Delete##delete_preset", delete_btn_w)
    reaper.ImGui_EndDisabled(ctx)
  end
end

--- Render the FX chain table. Unified columns across all tabs:
--- [Move] [Checkbox] [Plugin] [Type] [Status] [Actions]
local function render_fx_table()
  local inspect = state.inspect
  if not inspect then return end

  local chain = inspect.currentChain
  if not chain or #chain == 0 then
    reaper.ImGui_TextDisabled(ctx, "No FX plugins on this track")
    return
  end

  -- Build a lookup of merge actions by slotId (with fallback to plugin identity)
  local merge_actions = {}
  if inspect.merge and inspect.merge.actions then
    for _, action in ipairs(inspect.merge.actions) do
      local fx = action.fx or action["local"] or action.base
      if fx then
        if fx.slotId and fx.slotId ~= "" then
          merge_actions[fx.slotId] = action
        end
        local key = (fx.pluginType or "") .. "::" .. (fx.pluginName or "")
        if not merge_actions[key] then
          merge_actions[key] = action
        end
      end
    end
  end

  -- Build resolved chain lookup by slotId for ownership and revert checks
  local resolved_by_slot = {}
  if inspect.resolvedChain then
    for _, fx in ipairs(inspect.resolvedChain) do
      if fx.slotId then
        resolved_by_slot[fx.slotId] = fx
      end
    end
  end

  local ACTION_ICONS = {
    keep_base    = { icon = icons.CIRCLE,             color = 0x9E9E9EFF, tip = "Unchanged" },
    keep_local   = { icon = icons.CIRCLE_DOT,         color = 0xFFC107FF, tip = "Modified locally" },
    use_new_base = { icon = icons.CIRCLE_ARROW_DOWN,  color = 0x2196F3FF, tip = "Preset update available" },
    add_local    = { icon = icons.CIRCLE_PLUS,        color = 0x4CAF50FF, tip = "Added locally" },
    add_base     = { icon = icons.CIRCLE_ARROW_DOWN,  color = 0x2196F3FF, tip = "Added by preset" },
    remove       = { icon = icons.CIRCLE_X,           color = 0xF44336FF, tip = "Removed" },
    conflict     = { icon = icons.CIRCLE_ALERT,       color = 0xF44336FF, tip = "Conflict: both sides changed" },
  }

  local COL_STRETCH = reaper.ImGui_TableColumnFlags_WidthStretch()
  local COL_FIXED = reaper.ImGui_TableColumnFlags_WidthFixed()

  local show_create_checkboxes = is_creation_tab()
  local has_preset = inspect.preset and inspect.preset ~= ""
  local has_tabs = has_preset and inspect.inheritanceChain and #inspect.inheritanceChain > 0
  local show_ownership = has_tabs and not show_create_checkboxes
  -- Show checkbox column if ownership OR creation checkboxes are needed
  local show_checkbox = show_ownership or show_create_checkboxes

  -- Fixed 6 columns: Move, Checkbox, Plugin, Type, Status, Actions
  local col_count = 6

  -- Set alternating row colors for the table
  reaper.ImGui_PushStyleColor(ctx, reaper.ImGui_Col_TableRowBg(),    0x00000000)  -- transparent
  reaper.ImGui_PushStyleColor(ctx, reaper.ImGui_Col_TableRowBgAlt(), 0x1A1A1A40)  -- very subtle

  if reaper.ImGui_BeginTable(ctx, "fxchain", col_count,
      reaper.ImGui_TableFlags_RowBg()
      | reaper.ImGui_TableFlags_NoHostExtendX()
      | reaper.ImGui_TableFlags_PadOuterX()) then

    reaper.ImGui_TableSetupColumn(ctx, "",        COL_FIXED, 50)
    reaper.ImGui_TableSetupColumn(ctx, "",        COL_FIXED, 30)
    reaper.ImGui_TableSetupColumn(ctx, "Plugin",  COL_STRETCH)
    reaper.ImGui_TableSetupColumn(ctx, "Type",    COL_FIXED, 40)
    reaper.ImGui_TableSetupColumn(ctx, "",        COL_FIXED, 30)
    reaper.ImGui_TableSetupColumn(ctx, "",        COL_FIXED, 60)

    -- Header row — uses a normal row so height matches data rows
    reaper.ImGui_TableNextRow(ctx)

    -- Move column header (empty)
    reaper.ImGui_TableNextColumn(ctx)

    -- Checkbox column header: select-all toggle
    reaper.ImGui_TableNextColumn(ctx)
    if show_checkbox then
      local cb_changed, cb_val = reaper.ImGui_Checkbox(ctx, "##select_all", state.select_all_checked)
      if cb_changed then
        state.select_all_checked = cb_val
        if show_create_checkboxes then
          for i = 1, #chain do
            if state.new_preset_fx_selected[i] ~= "disabled" then
              state.new_preset_fx_selected[i] = cb_val
            end
          end
        elseif show_ownership then
          for i = 1, #chain do
            local slot_id = (chain[i].slotId or "")
            local pending = state.pending_assignments[slot_id]
            local eff_owner
            if pending == RELEASED then
              eff_owner = nil
            elseif pending then
              eff_owner = pending
            elseif resolved_by_slot[slot_id] and resolved_by_slot[slot_id].origin then
              eff_owner = resolved_by_slot[slot_id].origin
            end
            if cb_val then
              if not eff_owner then
                state.pending_assignments[slot_id] = state.selected_tab
                state.has_pending_changes = true
              end
            else
              if eff_owner == state.selected_tab then
                state.pending_assignments[slot_id] = RELEASED
                state.has_pending_changes = true
              end
            end
          end
        end
      end
    end

    -- Plugin header
    reaper.ImGui_TableNextColumn(ctx)
    reaper.ImGui_TextDisabled(ctx, "Plugin")

    -- Type header
    reaper.ImGui_TableNextColumn(ctx)
    reaper.ImGui_TextDisabled(ctx, "Type")

    -- Status header (empty — icon column)
    reaper.ImGui_TableNextColumn(ctx)

    -- Actions header (empty)
    reaper.ImGui_TableNextColumn(ctx)

    --- Check if this FX can override an ancestor preset's instance of the same plugin.
    --- Returns true when: a preset is assigned, the current tab is a child preset,
    --- and an ancestor preset owns an instance of the same plugin.
    local function can_override_ancestor(fx_entry)
      if not has_preset then return false end
      if not state.selected_tab then return false end
      if is_creation_tab() then return false end
      local inspect_data = state.inspect
      if not inspect_data or not inspect_data.inheritanceChain then return false end
      -- Current tab must not be the root preset (must have ancestors)
      local chain_list = inspect_data.inheritanceChain
      if #chain_list < 2 then return false end
      -- Current tab must be after the first in the chain (i.e., is a child)
      local tab_idx = nil
      for ci, name in ipairs(chain_list) do
        if name == state.selected_tab then tab_idx = ci; break end
      end
      if not tab_idx or tab_idx <= 1 then return false end
      -- Check if any ancestor preset owns an instance of the same plugin
      for slot_id, resolved_fx in pairs(resolved_by_slot) do
        if resolved_fx.origin and resolved_fx.pluginName == fx_entry.pluginName
            and resolved_fx.pluginType == fx_entry.pluginType
            and resolved_fx.slotId ~= fx_entry.slotId then
          -- Check if origin is an ancestor (before current tab in chain)
          for ci = 1, tab_idx - 1 do
            if chain_list[ci] == resolved_fx.origin then
              return true
            end
          end
        end
      end
      return false
    end

    -- ─── Data rows ───
    local fx_count = #chain
    for i, fx in ipairs(chain) do
      reaper.ImGui_TableNextRow(ctx)

      -- Move up/down buttons (column 0)
      reaper.ImGui_TableSetColumnIndex(ctx, 0)
      if i > 1 then
        if icons.square_button(ctx, icons.CHEVRON_UP, "##up_" .. i) then
          reaper.TrackFX_CopyToTrack(state.track, i - 1, state.track, i - 2, true)
          state.needs_refresh = true
        end
      else
        reaper.ImGui_BeginDisabled(ctx)
        icons.square_button(ctx, icons.CHEVRON_UP, "##up_" .. i)
        reaper.ImGui_EndDisabled(ctx)
      end
      reaper.ImGui_SameLine(ctx, 0, 2)
      if i < fx_count then
        if icons.square_button(ctx, icons.CHEVRON_DOWN, "##dn_" .. i) then
          reaper.TrackFX_CopyToTrack(state.track, i - 1, state.track, i, true)
          state.needs_refresh = true
        end
      else
        reaper.ImGui_BeginDisabled(ctx)
        icons.square_button(ctx, icons.CHEVRON_DOWN, "##dn_" .. i)
        reaper.ImGui_EndDisabled(ctx)
      end

      -- Checkbox column
      reaper.ImGui_TableSetColumnIndex(ctx, 1)
      if show_ownership then
        local slot_id = fx.slotId or ""
        local effective_owner = nil
        local pending = state.pending_assignments[slot_id]
        if pending == RELEASED then
          effective_owner = nil
        elseif pending then
          effective_owner = pending
        elseif resolved_by_slot[slot_id] and resolved_by_slot[slot_id].origin then
          effective_owner = resolved_by_slot[slot_id].origin
        end

        local current_tab = state.selected_tab

        if effective_owner == current_tab then
          local cb_changed, cb_val = reaper.ImGui_Checkbox(ctx, "##own_" .. i, true)
          if cb_changed and not cb_val then
            state.pending_assignments[slot_id] = RELEASED
            state.has_pending_changes = true
          end
        elseif effective_owner and effective_owner ~= current_tab then
          reaper.ImGui_PushStyleVar(ctx, reaper.ImGui_StyleVar_Alpha(), 0.4)
          local cb_changed = reaper.ImGui_Checkbox(ctx, "##own_" .. i, true)
          reaper.ImGui_PopStyleVar(ctx)
          if cb_changed then
            state.move_ownership_pending = {
              slotId = slot_id,
              from = effective_owner,
              to = current_tab,
            }
          end
        else
          local cb_changed, cb_val = reaper.ImGui_Checkbox(ctx, "##own_" .. i, false)
          if cb_changed and cb_val then
            state.pending_assignments[slot_id] = current_tab
            state.has_pending_changes = true
          end
        end
      elseif show_create_checkboxes then
        local checked_val = state.new_preset_fx_selected[i]
        if checked_val == "disabled" then
          reaper.ImGui_PushStyleVar(ctx, reaper.ImGui_StyleVar_Alpha(), 0.35)
          reaper.ImGui_Checkbox(ctx, "##fx_sel_" .. i, false)
          reaper.ImGui_PopStyleVar(ctx)
        else
          local is_checked = checked_val == true
          local cb_changed, cb_val = reaper.ImGui_Checkbox(ctx, "##fx_sel_" .. i, is_checked)
          if cb_changed then
            state.new_preset_fx_selected[i] = cb_val
          end
        end
      end

      -- Plugin name (clickable to open FX UI)
      reaper.ImGui_TableSetColumnIndex(ctx, 2)
      if state.track then
        reaper.ImGui_PushStyleColor(ctx, reaper.ImGui_Col_Text(), 0xCCCCCCFF)
        if reaper.ImGui_Selectable(ctx, (fx.pluginName or "") .. "##fx_open_" .. i, false) then
          reaper.TrackFX_Show(state.track, i - 1, 3)
        end
        reaper.ImGui_PopStyleColor(ctx)
      else
        reaper.ImGui_Text(ctx, fx.pluginName or "")
      end

      -- Type
      reaper.ImGui_TableSetColumnIndex(ctx, 3)
      reaper.ImGui_Text(ctx, fx.pluginType or "")

      -- Status (always rendered as icon + tooltip)
      reaper.ImGui_TableSetColumnIndex(ctx, 4)
      local action = (fx.slotId and merge_actions[fx.slotId])
        or merge_actions[(fx.pluginType or "") .. "::" .. (fx.pluginName or "")]
      if action then
        local ai = ACTION_ICONS[action.type]
        if ai then
          reaper.ImGui_PushStyleColor(ctx, reaper.ImGui_Col_Text(), ai.color)
          icons.text(ctx, ai.icon)
          reaper.ImGui_PopStyleColor(ctx)
          if reaper.ImGui_IsItemHovered(ctx) then
            reaper.ImGui_SetTooltip(ctx, ai.tip)
          end
        end
      elseif has_preset then
        reaper.ImGui_PushStyleColor(ctx, reaper.ImGui_Col_Text(), 0x9E9E9EFF)
        icons.text(ctx, icons.CIRCLE)
        reaper.ImGui_PopStyleColor(ctx)
        if reaper.ImGui_IsItemHovered(ctx) then
          reaper.ImGui_SetTooltip(ctx, "Unchanged")
        end
      end

      -- Actions (always rendered)
      reaper.ImGui_TableSetColumnIndex(ctx, 5)
      if has_preset then
        local slot_id = fx.slotId or ""
        local preset_fp = resolved_by_slot[slot_id]

        -- Override button: link this plugin as an override of an ancestor's instance
        if can_override_ancestor(fx) then
          if icons.square_button(ctx, icons.LINK_2, "##link_" .. i) then
            -- TODO: when multiple ancestor instances of the same plugin exist,
            -- present a selection dialog to choose which one to override.
            -- For now, find the first matching ancestor slot.
            local inspect_data = state.inspect
            local chain_list = inspect_data and inspect_data.inheritanceChain or {}
            local tab_idx = 0
            for ci, name in ipairs(chain_list) do
              if name == state.selected_tab then tab_idx = ci; break end
            end
            local parent_slot = nil
            for sid, resolved_fx in pairs(resolved_by_slot) do
              if resolved_fx.origin and resolved_fx.pluginName == fx.pluginName
                  and resolved_fx.pluginType == fx.pluginType
                  and resolved_fx.slotId ~= fx.slotId then
                for ci = 1, tab_idx - 1 do
                  if chain_list[ci] == resolved_fx.origin then
                    parent_slot = resolved_fx.slotId
                    break
                  end
                end
                if parent_slot then break end
              end
            end
            if parent_slot then
              state.override_pending = true
              state.override_child_slot = fx.slotId or ""
              state.override_parent_slot = parent_slot
              state.override_plugin_name = fx.pluginName or ""
            end
          end
          if reaper.ImGui_IsItemHovered(ctx) then
            reaper.ImGui_SetTooltip(ctx, "Override ancestor's instance of this plugin")
          end
          reaper.ImGui_SameLine(ctx, 0, 2)
        end

        -- Revert button (when plugin state differs from preset)
        if preset_fp then
          if fx.stateHash and preset_fp.stateHash
              and fx.stateHash ~= preset_fp.stateHash then
            if icons.square_button(ctx, icons.UNDO, "##rv_" .. i) then
              revert_plugin(slot_id)
            end
            if reaper.ImGui_IsItemHovered(ctx) then
              reaper.ImGui_SetTooltip(ctx, "Revert to preset state")
            end
          end
        else
          -- Remove button (locally added plugin)
          if icons.square_button(ctx, icons.X, "##rm_" .. i) then
            state.status_message = "Use 'Revert all local changes' to remove added plugins"
            state.status_is_error = false
          end
          if reaper.ImGui_IsItemHovered(ctx) then
            reaper.ImGui_SetTooltip(ctx, "Remove locally added plugin")
          end
        end
      end
    end

    -- Show FX that are only in the merge (added by preset, not yet on track)
    if inspect.merge and inspect.merge.actions then
      for _, action in ipairs(inspect.merge.actions) do
        if action.type == "add_base" and action.fx then
          reaper.ImGui_TableNextRow(ctx)
          reaper.ImGui_TableSetColumnIndex(ctx, 2)  -- Plugin
          reaper.ImGui_PushStyleColor(ctx, reaper.ImGui_Col_Text(), 0x2196F3FF)
          reaper.ImGui_Text(ctx, action.fx.pluginName or "")
          reaper.ImGui_PopStyleColor(ctx)
          reaper.ImGui_TableSetColumnIndex(ctx, 3)  -- Type
          reaper.ImGui_Text(ctx, action.fx.pluginType or "")
          reaper.ImGui_TableSetColumnIndex(ctx, 4)  -- Status
          reaper.ImGui_PushStyleColor(ctx, reaper.ImGui_Col_Text(), 0x2196F3FF)
          icons.text(ctx, icons.CIRCLE_ARROW_DOWN)
          reaper.ImGui_PopStyleColor(ctx)
          if reaper.ImGui_IsItemHovered(ctx) then
            reaper.ImGui_SetTooltip(ctx, "Added by preset")
          end
        end
      end
    end

    reaper.ImGui_EndTable(ctx)
  end

  reaper.ImGui_PopStyleColor(ctx, 2)
end

--- Render the "Save as preset" button below the FX table (create/extend tabs only).
local function render_creation_actions()
  if not is_creation_tab() then return end

  reaper.ImGui_Spacing(ctx)

  -- Check if any FX are actually checked (not "disabled")
  local has_checked = false
  for _, checked in ipairs(state.new_preset_fx_selected) do
    if checked == true then
      has_checked = true
      break
    end
  end

  if not has_checked then
    reaper.ImGui_BeginDisabled(ctx)
  end
  if icons.button_with_label(ctx, icons.SAVE, "Save as preset", "##save_preset_btn") then
    state.save_preset_modal_open = true
    state.new_preset_name = ""
  end
  if not has_checked then
    reaper.ImGui_EndDisabled(ctx)
  end
end

--- Render the save-preset name modal.
local function render_save_preset_modal()
  if state.save_preset_modal_open then
    reaper.ImGui_OpenPopup(ctx, "Save preset")
    state.save_preset_modal_open = false  -- only open once
  end

  if reaper.ImGui_BeginPopupModal(ctx, "Save preset", nil,
      reaper.ImGui_WindowFlags_AlwaysAutoResize()) then
    reaper.ImGui_Text(ctx, "Preset name:")
    reaper.ImGui_SetNextItemWidth(ctx, 250)
    local changed, val = reaper.ImGui_InputText(ctx, "##modal_preset_name", state.new_preset_name)
    if changed then
      state.new_preset_name = val
    end

    reaper.ImGui_Spacing(ctx)

    local name_ok = state.new_preset_name ~= ""
    if not name_ok then
      reaper.ImGui_BeginDisabled(ctx)
    end
    if reaper.ImGui_Button(ctx, "Save") then
      -- Derive extends_preset from context
      local extends_preset = nil
      if state.selected_tab == EXTEND_TAB then
        local inspect = state.inspect
        if inspect and inspect.inheritanceChain and #inspect.inheritanceChain > 0 then
          extends_preset = inspect.inheritanceChain[#inspect.inheritanceChain]  -- leaf
        end
      end
      reaper.ImGui_CloseCurrentPopup(ctx)
      save_as_preset(state.new_preset_name, false, extends_preset)
    end
    if not name_ok then
      reaper.ImGui_EndDisabled(ctx)
    end

    reaper.ImGui_SameLine(ctx)
    if reaper.ImGui_Button(ctx, "Cancel##save_modal") then
      reaper.ImGui_CloseCurrentPopup(ctx)
    end

    reaper.ImGui_EndPopup(ctx)
  end
end

--- Render the assign-conflict modal (track already has FX plugins).
local function render_assign_conflict_modal()
  if state.assign_conflict_pending then
    reaper.ImGui_OpenPopup(ctx, "Assign preset?")
    state.assign_conflict_pending = false  -- only open once
  end

  if reaper.ImGui_BeginPopupModal(ctx, "Assign preset?", nil,
      reaper.ImGui_WindowFlags_AlwaysAutoResize()) then
    reaper.ImGui_TextWrapped(ctx, "This track already has FX plugins. How should they be handled?")
    reaper.ImGui_Spacing(ctx)

    if reaper.ImGui_Button(ctx, "Keep both") then
      reaper.ImGui_CloseCurrentPopup(ctx)
      assign_preset(state.assign_conflict_preset, nil, true)
      state.assign_conflict_preset = ""
    end
    if reaper.ImGui_IsItemHovered(ctx) then
      reaper.ImGui_SetTooltip(ctx, "Existing FX become local deviations")
    end

    reaper.ImGui_SameLine(ctx)
    if reaper.ImGui_Button(ctx, "Replace") then
      reaper.ImGui_CloseCurrentPopup(ctx)
      assign_preset(state.assign_conflict_preset, true)
      state.assign_conflict_preset = ""
    end
    if reaper.ImGui_IsItemHovered(ctx) then
      reaper.ImGui_SetTooltip(ctx, "Replace current FX with preset's chain")
    end

    reaper.ImGui_SameLine(ctx)
    if reaper.ImGui_Button(ctx, "Cancel##conflict") then
      reaper.ImGui_CloseCurrentPopup(ctx)
      state.assign_conflict_preset = ""
    end

    reaper.ImGui_EndPopup(ctx)
  end
end

--- Render the main window.
local function render()
  icons.push_default_font(ctx)
  icons.push_global_styles(ctx)
  local visible, open = reaper.ImGui_Begin(ctx, "reabase", true, WINDOW_FLAGS)
  if not visible then
    icons.pop_global_styles(ctx)
    icons.pop_default_font(ctx)
    return open
  end

  -- No track selected
  if not state.track then
    reaper.ImGui_TextDisabled(ctx, "Select a track to manage its FX preset.")
    reaper.ImGui_End(ctx)
    icons.pop_global_styles(ctx)
    icons.pop_default_font(ctx)
    return open
  end

  -- Track header
  reaper.ImGui_Text(ctx, "Track: " .. state.track_name)
  reaper.ImGui_Separator(ctx)

  -- Error state
  if state.inspect_error then
    reaper.ImGui_PushStyleColor(ctx, reaper.ImGui_Col_Text(), 0xF44336FF)
    local avail_w = reaper.ImGui_GetContentRegionAvail(ctx)
    local line_count = 1
    for _ in state.inspect_error:gmatch("\n") do line_count = line_count + 1 end
    local text_height = line_count * reaper.ImGui_GetTextLineHeightWithSpacing(ctx) + 8
    reaper.ImGui_InputTextMultiline(ctx, "##error", state.inspect_error,
      avail_w, math.min(text_height, 200),
      reaper.ImGui_InputTextFlags_ReadOnly())
    reaper.ImGui_PopStyleColor(ctx)

    if icons.button_with_label(ctx, icons.REFRESH_CW, "Retry", "##retry_btn") then
      state.needs_refresh = true
    end

    reaper.ImGui_End(ctx)
    icons.pop_global_styles(ctx)
    icons.pop_default_font(ctx)
    return open
  end

  local inspect = state.inspect
  if not inspect then
    reaper.ImGui_TextDisabled(ctx, "Loading...")
    reaper.ImGui_End(ctx)
    icons.pop_global_styles(ctx)
    icons.pop_default_font(ctx)
    return open
  end

  -- Status
  reaper.ImGui_Text(ctx, "Status: ")
  reaper.ImGui_SameLine(ctx)
  render_status(inspect.status or "no-preset")

  reaper.ImGui_Spacing(ctx)

  -- Preset selector
  render_preset_selector()

  reaper.ImGui_Spacing(ctx)
  reaper.ImGui_Separator(ctx)
  reaper.ImGui_Spacing(ctx)

  -- Tab bar (Create / inheritance chain + Extend)
  render_tab_bar()

  -- FX chain table — flush against tabs (no gap between tab underline and table)
  render_fx_table()

  -- Creation actions ("Save as preset" button for create/extend tabs)
  render_creation_actions()

  -- Management actions (when a preset tab is selected, not creation)
  if not is_creation_tab() then
    local has_local_changes = inspect.status == "modified" or inspect.status == "conflict"
    local has_upstream_only = inspect.status == "upstream-changes" or inspect.status == "no-snapshot"
    local has_pending = state.has_pending_changes

    if has_local_changes or has_pending then
      reaper.ImGui_Spacing(ctx)

      if inspect.merge and inspect.merge.hasConflicts and not has_pending then
        reaper.ImGui_TextWrapped(ctx,
          "Both the preset and your track have changed since the last sync.")
        reaper.ImGui_Spacing(ctx)

        if icons.button_with_label(ctx, icons.CHECK, "Accept preset", "##accept_preset") then
          apply_preset()
        end
        reaper.ImGui_SameLine(ctx)
        reaper.ImGui_TextDisabled(ctx, "Overwrite with preset's FX chain")
      end

      if icons.button_with_label(ctx, icons.SAVE, "Update presets", "##update_presets") then
        update_presets_action()
      end
      reaper.ImGui_SameLine(ctx)
      reaper.ImGui_TextDisabled(ctx, "Write local changes into preset files")

      if icons.button_with_label(ctx, icons.REFRESH_CW, "Update and sync project", "##update_sync") then
        update_and_sync_project()
      end
      reaper.ImGui_SameLine(ctx)
      reaper.ImGui_TextDisabled(ctx, "Update presets, then sync all tracks")

      if icons.button_with_label(ctx, icons.UNDO_2, "Revert all local changes", "##revert_all") then
        revert_all()
      end
      reaper.ImGui_SameLine(ctx)
      reaper.ImGui_TextDisabled(ctx, "Discard local changes, re-apply preset")

    elseif has_upstream_only then
      reaper.ImGui_Spacing(ctx)
      if icons.button_with_label(ctx, icons.ARROW_DOWN, "Apply preset changes", "##apply_changes") then
        apply_preset()
      end
    end
  end

  -- Status message
  if state.status_message then
    reaper.ImGui_Spacing(ctx)
    reaper.ImGui_Separator(ctx)
    reaper.ImGui_Spacing(ctx)
    local color = state.status_is_error and 0xF44336FF or 0x4CAF50FF
    reaper.ImGui_PushStyleColor(ctx, reaper.ImGui_Col_Text(), color)
    reaper.ImGui_TextWrapped(ctx, state.status_message)
    reaper.ImGui_PopStyleColor(ctx)
  end

  -- Modals
  render_save_preset_modal()
  render_assign_conflict_modal()

  -- Overwrite confirmation popup
  if state.overwrite_pending then
    reaper.ImGui_OpenPopup(ctx, "Overwrite preset?")
    state.overwrite_pending = false  -- only open once
  end

  if reaper.ImGui_BeginPopupModal(ctx, "Overwrite preset?", nil,
      reaper.ImGui_WindowFlags_AlwaysAutoResize()) then
    reaper.ImGui_Text(ctx, "A preset with this name already exists.")
    reaper.ImGui_Text(ctx, "Overwrite '" .. state.overwrite_preset_name .. "'?")
    reaper.ImGui_Spacing(ctx)
    if reaper.ImGui_Button(ctx, "Overwrite") then
      reaper.ImGui_CloseCurrentPopup(ctx)
      save_as_preset(state.overwrite_preset_name, true, state.overwrite_extends_preset)
    end
    reaper.ImGui_SameLine(ctx)
    if reaper.ImGui_Button(ctx, "Cancel##overwrite") then
      reaper.ImGui_CloseCurrentPopup(ctx)
      state.overwrite_preset_name = ""
      state.overwrite_extends_preset = nil
    end
    reaper.ImGui_EndPopup(ctx)
  end

  -- Move ownership confirmation popup
  if state.move_ownership_pending then
    reaper.ImGui_OpenPopup(ctx, "Move plugin ownership?")
  end

  if reaper.ImGui_BeginPopupModal(ctx, "Move plugin ownership?", nil,
      reaper.ImGui_WindowFlags_AlwaysAutoResize()) then
    local pending = state.move_ownership_pending
    if pending then
      reaper.ImGui_Text(ctx, "Move '" .. pending.slotId .. "' from '" .. pending.from .. "' to '" .. pending.to .. "'?")
      reaper.ImGui_Spacing(ctx)
      if reaper.ImGui_Button(ctx, "Move") then
        reaper.ImGui_CloseCurrentPopup(ctx)
        state.pending_assignments[pending.slotId] = pending.to
        state.has_pending_changes = true
        state.move_ownership_pending = nil
      end
      reaper.ImGui_SameLine(ctx)
      if reaper.ImGui_Button(ctx, "Cancel##move") then
        reaper.ImGui_CloseCurrentPopup(ctx)
        state.move_ownership_pending = nil
      end
    end
    reaper.ImGui_EndPopup(ctx)
  else
    -- Reset if popup was closed without action
    state.move_ownership_pending = nil
  end

  -- Delete confirmation popup
  if state.delete_pending then
    -- Collect all descendants that will be cascade-deleted
    state.delete_children = {}
    if state.inspect and state.inspect.presets then
      local function collect_children(parent_name)
        for _, p in ipairs(state.inspect.presets) do
          if p.extends == parent_name then
            state.delete_children[#state.delete_children + 1] = p.name
            collect_children(p.name)
          end
        end
      end
      collect_children(state.delete_preset_name)
    end
    reaper.ImGui_OpenPopup(ctx, "Delete preset?")
    state.delete_pending = false  -- only open once
  end

  if reaper.ImGui_BeginPopupModal(ctx, "Delete preset?", nil,
      reaper.ImGui_WindowFlags_AlwaysAutoResize()) then
    reaper.ImGui_Text(ctx, "Delete preset '" .. state.delete_preset_name .. "'?")
    if state.delete_children and #state.delete_children > 0 then
      reaper.ImGui_Spacing(ctx)
      reaper.ImGui_PushStyleColor(ctx, reaper.ImGui_Col_Text(), 0xFFC107FF)
      reaper.ImGui_Text(ctx, "This will also delete " .. #state.delete_children .. " child preset(s):")
      reaper.ImGui_PopStyleColor(ctx)
      for _, child_name in ipairs(state.delete_children) do
        reaper.ImGui_BulletText(ctx, child_name)
      end
    end
    reaper.ImGui_Spacing(ctx)
    reaper.ImGui_Text(ctx, "This cannot be undone.")
    reaper.ImGui_Spacing(ctx)
    reaper.ImGui_PushStyleColor(ctx, reaper.ImGui_Col_Button(), 0x8B0000FF)
    reaper.ImGui_PushStyleColor(ctx, reaper.ImGui_Col_ButtonHovered(), 0xB22222FF)
    if reaper.ImGui_Button(ctx, "Delete##confirm") then
      reaper.ImGui_CloseCurrentPopup(ctx)
      delete_preset(state.delete_preset_name)
    end
    reaper.ImGui_PopStyleColor(ctx, 2)
    reaper.ImGui_SameLine(ctx)
    if reaper.ImGui_Button(ctx, "Cancel##delete") then
      reaper.ImGui_CloseCurrentPopup(ctx)
      state.delete_preset_name = ""
      state.delete_children = nil
    end
    reaper.ImGui_EndPopup(ctx)
  end

  -- Override confirmation popup
  if state.override_pending then
    reaper.ImGui_OpenPopup(ctx, "Override plugin?")
    state.override_pending = false
  end

  if reaper.ImGui_BeginPopupModal(ctx, "Override plugin?", nil,
      reaper.ImGui_WindowFlags_AlwaysAutoResize()) then
    reaper.ImGui_TextWrapped(ctx,
      "Override '" .. state.override_parent_slot .. "' with the parameters from '"
      .. state.override_child_slot .. "'?")
    reaper.ImGui_Spacing(ctx)
    reaper.ImGui_TextDisabled(ctx, state.override_plugin_name)
    reaper.ImGui_Spacing(ctx)
    if reaper.ImGui_Button(ctx, "Override") then
      reaper.ImGui_CloseCurrentPopup(ctx)
      link_override(state.override_child_slot, state.override_parent_slot)
      state.override_child_slot = ""
      state.override_parent_slot = ""
      state.override_plugin_name = ""
    end
    reaper.ImGui_SameLine(ctx)
    if reaper.ImGui_Button(ctx, "Cancel##override") then
      reaper.ImGui_CloseCurrentPopup(ctx)
      state.override_child_slot = ""
      state.override_parent_slot = ""
      state.override_plugin_name = ""
    end
    reaper.ImGui_EndPopup(ctx)
  end

  reaper.ImGui_End(ctx)
  icons.pop_global_styles(ctx)
  icons.pop_default_font(ctx)
  return open
end

-- ─── Main loop ───────────────────────────────────────────────────

local function loop()
  check_track_change()
  local open = render()
  if open then
    reaper.defer(loop)
  end
end

state.needs_refresh = true
reaper.defer(loop)
