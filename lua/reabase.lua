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

local DEBUG = false

local function log(msg)
  if DEBUG then
    reaper.ShowConsoleMsg("[reabase] " .. msg .. "\n")
  end
end

-- ─── State ───────────────────────────────────────────────────────

local ctx = reaper.ImGui_CreateContext("reabase")
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
  local fast_str = reaper.SNM_CreateFastString("")
  local result = reaper.SNM_GetSetObjectState(track, fast_str, false, false)
  if result then
    local chunk = reaper.SNM_GetFastString(fast_str)
    reaper.SNM_DeleteFastString(fast_str)
    return chunk
  end
  reaper.SNM_DeleteFastString(fast_str)
  return nil
end

local function set_track_chunk(track, chunk)
  local fast_str = reaper.SNM_CreateFastString(chunk)
  local result = reaper.SNM_GetSetObjectState(track, fast_str, true, false)
  reaper.SNM_DeleteFastString(fast_str)
  return result ~= nil
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

  local result, err = bridge.inspect_track(state.track_chunk, state.reabase_path)
  if err then
    state.inspect_error = err
    return
  end

  state.inspect = result

  -- Debug: log hash comparison when status is unexpected
  if result and result.debug and result.status ~= "no-preset" then
    log("--- inspect result: status=" .. (result.status or "nil"))
    if result.debug.snapshotHashes then
      for _, h in ipairs(result.debug.snapshotHashes) do
        log("  snapshot: " .. h.slotId .. " = " .. h.stateHash)
      end
    end
    if result.debug.presetHashes then
      for _, h in ipairs(result.debug.presetHashes) do
        log("  preset:   " .. h.slotId .. " = " .. h.stateHash)
      end
    end
    if result.debug.currentHashes then
      for _, h in ipairs(result.debug.currentHashes) do
        log("  current:  " .. h.slotId .. " = " .. h.stateHash)
      end
    end
    if result.merge and result.merge.actions then
      for _, a in ipairs(result.merge.actions) do
        local fx = a.fx or a["local"] or a.base
        local name = fx and fx.pluginName or "?"
        log("  action: " .. a.type .. " — " .. name)
      end
    end
  end

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

local function assign_preset(preset_name, replace)
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
    local inspect_result, inspect_err = bridge.inspect_track(reaper_chunk, state.reabase_path)
    if inspect_result and inspect_result.merge and inspect_result.merge.resolvedChain then
      local applied_chunk, apply_err = bridge.apply_chunk(reaper_chunk, inspect_result.merge.resolvedChain)
      if applied_chunk then
        set_track_chunk(state.track, applied_chunk)
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

  -- Snapshot the current FX chain as baseline (returns chunk with slot map)
  local snap_chunk, snap_err = bridge.snapshot(reaper_chunk, preset_name, state.reabase_path)
  if not snap_chunk then
    state.status_message = "Preset assigned, but snapshot failed: " .. (snap_err or "unknown")
    state.status_is_error = true
    state.needs_refresh = true
    return
  end

  log("  snapshot done, writing slot map to REAPER...")

  -- Write slot map back to track
  set_track_chunk(state.track, snap_chunk)

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
  if not state.track or not state.track_chunk then
    return
  end
  if not state.inspect or not state.inspect.merge then
    return
  end

  local resolved_chain = state.inspect.merge.resolvedChain
  if not resolved_chain then
    state.status_message = "Error: no resolved chain in merge result"
    state.status_is_error = true
    return
  end

  local modified, err = bridge.apply_chunk(state.track_chunk, resolved_chain)
  if err then
    state.status_message = "Error: " .. err
    state.status_is_error = true
    return
  end

  reaper.Undo_BeginBlock()
  set_track_chunk(state.track, modified)
  reaper.Undo_EndBlock("reabase: apply preset to '" .. state.track_name .. "'", -1)

  local role = state.inspect.preset
  if role then
    -- Re-read from REAPER to get the normalized chunk before snapshotting
    local reaper_chunk = get_track_chunk(state.track)
    if reaper_chunk then
      local snap_chunk = bridge.snapshot(reaper_chunk, role, state.reabase_path)
      if snap_chunk then
        set_track_chunk(state.track, snap_chunk)
      end
    end
  end

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

  local snap_chunk, snap_err = bridge.snapshot(reaper_chunk, role, state.reabase_path)
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

  local ok, err, exists = bridge.save_preset(
    state.track_chunk, name, state.reabase_path,
    selected_indices, extends_preset, force_overwrite
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

  local modified, err = bridge.revert_plugin(state.track_chunk, slot_id, state.reabase_path)
  if err then
    state.status_message = "Error: " .. err
    state.status_is_error = true
    return
  end

  reaper.Undo_BeginBlock()
  set_track_chunk(state.track, modified)
  reaper.Undo_EndBlock("reabase: revert plugin '" .. slot_id .. "'", -1)

  state.status_message = "Plugin '" .. slot_id .. "' reverted to preset state"
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

  local result, err = bridge.update_presets(
    state.track_chunk, ownership, released, state.reabase_path
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

  local result, err = bridge.update_presets(
    state.track_chunk, ownership, released, state.reabase_path
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
  for i = 0, track_count - 1 do
    local track = reaper.GetTrack(0, i)
    if track ~= state.track then
      local chunk = get_track_chunk(track)
      if chunk then
        local inspect_result, inspect_err = bridge.inspect_track(chunk, state.reabase_path)
        if inspect_result and inspect_result.status == "upstream-changes" then
          -- Apply upstream changes
          local resolved_chain = inspect_result.merge and inspect_result.merge.resolvedChain
          if resolved_chain then
            local modified, apply_err = bridge.apply_chunk(chunk, resolved_chain)
            if modified then
              set_track_chunk(track, modified)
              -- Re-read and snapshot
              local reaper_chunk = get_track_chunk(track)
              if reaper_chunk and inspect_result.preset then
                local snap_chunk = bridge.snapshot(reaper_chunk, inspect_result.preset, state.reabase_path)
                if snap_chunk then
                  set_track_chunk(track, snap_chunk)
                end
              end
              synced_count = synced_count + 1
            end
          end
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
  -- Re-applies the resolved preset chain, discarding all local changes
  apply_preset()
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

local function render_status(status)
  local color = STATUS_COLORS[status] or 0x9E9E9EFF
  local label = STATUS_LABELS[status] or status
  reaper.ImGui_PushStyleColor(ctx, reaper.ImGui_Col_Text(), color)
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
  end

  -- Check for tab transitions
  if state.selected_tab ~= state.previous_tab then
    init_tab_checkboxes()
    state.previous_tab = state.selected_tab
  end
end

--- Render the preset selector dropdown and assign/remove button.
local function render_preset_selector()
  local inspect = state.inspect

  local current_label = "(none)"
  local selected_name = get_selected_preset_name()
  if selected_name then
    current_label = selected_name
  end

  reaper.ImGui_Text(ctx, "Preset:")
  reaper.ImGui_SameLine(ctx)

  reaper.ImGui_SetNextItemWidth(ctx, -70)
  if reaper.ImGui_BeginCombo(ctx, "##preset", current_label) then
    -- "None" option
    if reaper.ImGui_Selectable(ctx, "(none)", state.selected_preset_index == 0) then
      state.selected_preset_index = 0
    end

    -- Existing presets
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

  -- Show Assign/Remove button if selection differs from current
  local current_assignment = inspect and inspect.preset
  local has_changed = false
  if state.selected_preset_index == 0 and current_assignment then
    has_changed = true
  elseif selected_name and selected_name ~= current_assignment then
    has_changed = true
  end

  if has_changed then
    reaper.ImGui_SameLine(ctx)
    if state.selected_preset_index == 0 then
      if reaper.ImGui_Button(ctx, "Remove") then
        remove_preset()
      end
    else
      if reaper.ImGui_Button(ctx, "Assign") then
        -- Check for existing FX before assigning
        if inspect and inspect.currentChain and #inspect.currentChain > 0 then
          state.assign_conflict_pending = true
          state.assign_conflict_preset = selected_name
        else
          assign_preset(selected_name)
        end
      end
    end
  end

  -- Delete button for the currently selected preset
  if selected_name then
    reaper.ImGui_SameLine(ctx)
    reaper.ImGui_PushStyleColor(ctx, reaper.ImGui_Col_Button(), 0x8B0000FF)
    reaper.ImGui_PushStyleColor(ctx, reaper.ImGui_Col_ButtonHovered(), 0xB22222FF)
    if reaper.ImGui_Button(ctx, "Delete") then
      state.delete_pending = true
      state.delete_preset_name = selected_name
    end
    reaper.ImGui_PopStyleColor(ctx, 2)
  end
end

--- Render the FX chain table. Always visible — shows current chain with
--- merge action annotations when a merge is active.
--- Includes ownership checkboxes when a preset is assigned and
--- per-plugin revert buttons for locally modified plugins.
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

  local ACTION_COLORS = {
    keep_base    = 0x9E9E9EFF,
    keep_local   = 0x4CAF50FF,
    use_new_base = 0x2196F3FF,
    add_local    = 0x4CAF50FF,
    add_base     = 0x2196F3FF,
    remove       = 0xF44336FF,
    conflict     = 0xF44336FF,
  }

  local ACTION_LABELS = {
    keep_base    = "unchanged",
    keep_local   = "modified locally",
    use_new_base = "preset update",
    add_local    = "added locally",
    add_base     = "from preset",
    remove       = "removed",
    conflict     = "CONFLICT",
  }

  local COL_STRETCH = reaper.ImGui_TableColumnFlags_WidthStretch()
  local COL_FIXED = reaper.ImGui_TableColumnFlags_WidthFixed()
  local has_merge = inspect.merge and inspect.merge.actions and #inspect.merge.actions > 0
  local show_create_checkboxes = is_creation_tab()
  local has_preset = inspect.preset and inspect.preset ~= ""
  local has_tabs = has_preset and inspect.inheritanceChain and #inspect.inheritanceChain > 0
  -- Show ownership checkboxes when we have tabs and are NOT in preset creation mode
  local show_ownership = has_tabs and not show_create_checkboxes

  -- Determine columns
  local col_count = 3  -- Plugin, Type, Slot ID
  if show_create_checkboxes then col_count = col_count + 1 end  -- Include checkbox
  if show_ownership then col_count = col_count + 1 end          -- Owner checkbox
  if has_merge and not show_create_checkboxes then col_count = col_count + 1 end  -- Status
  -- Actions column for per-plugin revert (when modified and not creating)
  local show_actions = has_preset and not show_create_checkboxes
  if show_actions then col_count = col_count + 1 end

  if reaper.ImGui_BeginTable(ctx, "fxchain", col_count,
      reaper.ImGui_TableFlags_Borders() | reaper.ImGui_TableFlags_RowBg()) then

    if show_ownership then
      reaper.ImGui_TableSetupColumn(ctx, "Own", COL_FIXED, 35)
    end
    if show_create_checkboxes then
      reaper.ImGui_TableSetupColumn(ctx, "Include", COL_FIXED, 50)
    end
    reaper.ImGui_TableSetupColumn(ctx, "Plugin", COL_STRETCH)
    reaper.ImGui_TableSetupColumn(ctx, "Type", COL_FIXED, 40)
    reaper.ImGui_TableSetupColumn(ctx, "Slot ID", COL_FIXED, 120)
    if has_merge and not show_create_checkboxes then
      reaper.ImGui_TableSetupColumn(ctx, "Status", COL_FIXED, 100)
    end
    if show_actions then
      reaper.ImGui_TableSetupColumn(ctx, "", COL_FIXED, 30)
    end
    reaper.ImGui_TableHeadersRow(ctx)

    for i, fx in ipairs(chain) do
      reaper.ImGui_TableNextRow(ctx)

      -- Ownership checkbox
      if show_ownership then
        reaper.ImGui_TableNextColumn(ctx)

        local slot_id = fx.slotId or ""
        -- Determine effective owner for this plugin
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
          -- Owned by this tab: normal checked checkbox
          local cb_changed, cb_val = reaper.ImGui_Checkbox(ctx, "##own_" .. i, true)
          if cb_changed and not cb_val then
            -- Unchecked: release ownership
            state.pending_assignments[slot_id] = RELEASED
            state.has_pending_changes = true
          end
        elseif effective_owner and effective_owner ~= current_tab then
          -- Owned by a different preset: grayed-out checkbox
          reaper.ImGui_PushStyleVar(ctx, reaper.ImGui_StyleVar_Alpha(), 0.4)
          local cb_changed = reaper.ImGui_Checkbox(ctx, "##own_" .. i, true)
          reaper.ImGui_PopStyleVar(ctx)
          if cb_changed then
            -- User clicked a grayed-out checkbox: open move confirmation
            state.move_ownership_pending = {
              slotId = slot_id,
              from = effective_owner,
              to = current_tab,
            }
          end
        else
          -- No owner: unchecked checkbox
          local cb_changed, cb_val = reaper.ImGui_Checkbox(ctx, "##own_" .. i, false)
          if cb_changed and cb_val then
            -- Checked: assign to current tab
            state.pending_assignments[slot_id] = current_tab
            state.has_pending_changes = true
          end
        end
      end

      if show_create_checkboxes then
        reaper.ImGui_TableNextColumn(ctx)
        local checked_val = state.new_preset_fx_selected[i]
        if checked_val == "disabled" then
          -- Parent-owned: grayed-out non-interactive checkbox
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

      reaper.ImGui_TableNextColumn(ctx)
      -- Make plugin name clickable to open FX UI
      if state.track and not show_create_checkboxes then
        reaper.ImGui_PushStyleColor(ctx, reaper.ImGui_Col_Text(), 0x82B1FFFF)
        if reaper.ImGui_Selectable(ctx, (fx.pluginName or "") .. "##fx_open_" .. i, false) then
          -- Open the FX floating window (mode 3 = show floating window)
          reaper.TrackFX_Show(state.track, i - 1, 3)
        end
        reaper.ImGui_PopStyleColor(ctx)
      else
        reaper.ImGui_Text(ctx, fx.pluginName or "")
      end

      reaper.ImGui_TableNextColumn(ctx)
      reaper.ImGui_Text(ctx, fx.pluginType or "")

      reaper.ImGui_TableNextColumn(ctx)
      reaper.ImGui_TextDisabled(ctx, fx.slotId or "")

      if has_merge and not show_create_checkboxes then
        reaper.ImGui_TableNextColumn(ctx)
        local action = (fx.slotId and merge_actions[fx.slotId])
          or merge_actions[(fx.pluginType or "") .. "::" .. (fx.pluginName or "")]
        if action then
          local color = ACTION_COLORS[action.type] or 0x9E9E9EFF
          local label = ACTION_LABELS[action.type] or action.type
          reaper.ImGui_PushStyleColor(ctx, reaper.ImGui_Col_Text(), color)
          reaper.ImGui_Text(ctx, label)
          reaper.ImGui_PopStyleColor(ctx)
        else
          reaper.ImGui_TextDisabled(ctx, "unchanged")
        end
      end

      -- Per-plugin action button (revert or remove)
      if show_actions then
        reaper.ImGui_TableNextColumn(ctx)
        local slot_id = fx.slotId or ""
        local preset_fp = resolved_by_slot[slot_id]
        if preset_fp then
          -- Plugin exists in preset: show revert if state differs
          if fx.stateHash and preset_fp.stateHash
              and fx.stateHash ~= preset_fp.stateHash then
            if reaper.ImGui_SmallButton(ctx, "Revert##rv_" .. i) then
              revert_plugin(slot_id)
            end
            if reaper.ImGui_IsItemHovered(ctx) then
              reaper.ImGui_SetTooltip(ctx, "Revert to preset state")
            end
          end
        else
          -- Plugin not in preset (locally added): show remove button
          if reaper.ImGui_SmallButton(ctx, "Remove##rm_" .. i) then
            -- Remove by reverting the entire chain (apply resolved preset)
            -- TODO: per-plugin removal — for now revert all is the mechanism
            state.status_message = "Use 'Revert all local changes' to remove added plugins"
            state.status_is_error = false
          end
          if reaper.ImGui_IsItemHovered(ctx) then
            reaper.ImGui_SetTooltip(ctx, "Plugin added locally (not in preset)")
          end
        end
      end
    end

    -- Show FX that are only in the merge (added by preset, not yet on track)
    if has_merge then
      for _, action in ipairs(inspect.merge.actions) do
        if action.type == "add_base" and action.fx then
          reaper.ImGui_TableNextRow(ctx)
          if show_ownership then
            reaper.ImGui_TableNextColumn(ctx)
          end
          if show_create_checkboxes then
            reaper.ImGui_TableNextColumn(ctx)
          end
          reaper.ImGui_TableNextColumn(ctx)
          reaper.ImGui_PushStyleColor(ctx, reaper.ImGui_Col_Text(), 0x2196F3FF)
          reaper.ImGui_Text(ctx, action.fx.pluginName or "")
          reaper.ImGui_PopStyleColor(ctx)
          reaper.ImGui_TableNextColumn(ctx)
          reaper.ImGui_Text(ctx, action.fx.pluginType or "")
          reaper.ImGui_TableNextColumn(ctx)
          reaper.ImGui_TextDisabled(ctx, action.fx.slotId or "")
          if has_merge and not show_create_checkboxes then
            reaper.ImGui_TableNextColumn(ctx)
            reaper.ImGui_PushStyleColor(ctx, reaper.ImGui_Col_Text(), 0x2196F3FF)
            reaper.ImGui_Text(ctx, "from preset")
            reaper.ImGui_PopStyleColor(ctx)
          end
          if show_actions then
            reaper.ImGui_TableNextColumn(ctx)
          end
        end
      end
    end

    reaper.ImGui_EndTable(ctx)
  end
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
  if reaper.ImGui_Button(ctx, "Save as preset") then
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
      assign_preset(state.assign_conflict_preset)
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
  local visible, open = reaper.ImGui_Begin(ctx, "reabase", true, WINDOW_FLAGS)
  if not visible then
    return open
  end

  -- No track selected
  if not state.track then
    reaper.ImGui_TextDisabled(ctx, "Select a track to manage its FX preset.")
    reaper.ImGui_End(ctx)
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

    if reaper.ImGui_Button(ctx, "Retry") then
      state.needs_refresh = true
    end

    reaper.ImGui_End(ctx)
    return open
  end

  local inspect = state.inspect
  if not inspect then
    reaper.ImGui_TextDisabled(ctx, "Loading...")
    reaper.ImGui_End(ctx)
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

  -- FX chain table (always visible)
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

        if reaper.ImGui_Button(ctx, "Accept preset") then
          apply_preset()
        end
        reaper.ImGui_SameLine(ctx)
        reaper.ImGui_TextDisabled(ctx, "Overwrite with preset's FX chain")
      end

      if reaper.ImGui_Button(ctx, "Update presets") then
        update_presets_action()
      end
      reaper.ImGui_SameLine(ctx)
      reaper.ImGui_TextDisabled(ctx, "Write local changes into preset files")

      if reaper.ImGui_Button(ctx, "Update and sync project") then
        update_and_sync_project()
      end
      reaper.ImGui_SameLine(ctx)
      reaper.ImGui_TextDisabled(ctx, "Update presets, then sync all tracks")

      if reaper.ImGui_Button(ctx, "Revert all local changes") then
        revert_all()
      end
      reaper.ImGui_SameLine(ctx)
      reaper.ImGui_TextDisabled(ctx, "Discard local changes, re-apply preset")

    elseif has_upstream_only then
      reaper.ImGui_Spacing(ctx)
      if reaper.ImGui_Button(ctx, "Apply preset changes") then
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

  -- Refresh button
  reaper.ImGui_Spacing(ctx)
  if reaper.ImGui_Button(ctx, "Refresh") then
    state.needs_refresh = true
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
    reaper.ImGui_OpenPopup(ctx, "Delete preset?")
    state.delete_pending = false  -- only open once
  end

  if reaper.ImGui_BeginPopupModal(ctx, "Delete preset?", nil,
      reaper.ImGui_WindowFlags_AlwaysAutoResize()) then
    reaper.ImGui_Text(ctx, "Delete preset '" .. state.delete_preset_name .. "'?")
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
    end
    reaper.ImGui_EndPopup(ctx)
  end

  reaper.ImGui_End(ctx)
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
