-- Bridge between REAPER Lua and the reabase CLI.
-- Handles calling the CLI via io.popen and parsing JSON responses.

local json = require("json")

local bridge = {}

-- Path to the reabase CLI binary. Override this if not in PATH.
bridge.cli_path = "/Users/bjorndjurnamn/.nvm/versions/node/v24.12.0/bin/reabase"

-- ─── Helpers ─────────────────────────────────────────────────────

--- Run a CLI command with optional stdin data, return stdout and exit status.
---@param args string CLI arguments
---@param stdin_data string|nil Data to pipe to stdin
---@return string|nil output
---@return number exit_code
local function run_cli(args, stdin_data)
  -- Prepend node's directory to PATH so the shebang #!/usr/bin/env node works.
  -- GUI apps on macOS don't inherit the shell's PATH.
  local path_prefix = ""
  if bridge.cli_path:match("/") then
    local bin_dir = bridge.cli_path:match("^(.*)/[^/]+$")
    if bin_dir then
      path_prefix = 'PATH="' .. bin_dir .. ':$PATH" '
    end
  end
  local cmd = path_prefix .. bridge.cli_path .. " " .. args

  if stdin_data then
    -- Write stdin data to a temp file, pipe it in
    local tmp = os.tmpname()
    local f = io.open(tmp, "w")
    if not f then
      return nil, -1
    end
    f:write(stdin_data)
    f:close()
    cmd = cmd .. ' < "' .. tmp .. '"'

    local handle = io.popen(cmd .. " 2>&1", "r")
    if not handle then
      os.remove(tmp)
      return nil, -1
    end
    local output = handle:read("*a")
    handle:close()
    os.remove(tmp)
    return output, 0
  else
    local handle = io.popen(cmd .. " 2>&1", "r")
    if not handle then
      return nil, -1
    end
    local output = handle:read("*a")
    handle:close()
    return output, 0
  end
end

-- ─── Public API ──────────────────────────────────────────────────

--- List available presets.
---@param reabase_path string|nil Optional path to search from
---@return table|nil presets Array of {name, description, extends, fxChainFile}
---@return string|nil error
function bridge.list_presets(reabase_path)
  local path_arg = reabase_path and (' -p "' .. reabase_path .. '"') or ""
  local output, code = run_cli("presets --json" .. path_arg)
  if not output or output == "" then
    return nil, "Failed to run reabase presets"
  end

  local ok, result = pcall(json.decode, output)
  if not ok then
    return nil, "Failed to parse presets JSON: " .. tostring(result)
  end
  return result, nil
end

--- Inspect a track by sending its chunk to the CLI.
---@param track_chunk string The full track chunk from SNM_GetSetObjectState
---@param reabase_path string|nil Optional path to search from
---@return table|nil result InspectOutput from the CLI
---@return string|nil error
function bridge.inspect_track(track_chunk, reabase_path)
  local path_arg = reabase_path and (' -p "' .. reabase_path .. '"') or ""
  local output, code = run_cli("inspect" .. path_arg, track_chunk)
  if not output or output == "" then
    return nil, "Failed to run reabase inspect"
  end

  local ok, result = pcall(json.decode, output)
  if not ok then
    return nil, "Failed to parse inspect JSON.\nCLI output:\n" .. output
  end
  return result, nil
end

--- Apply a resolved FX chain to a track chunk.
---@param track_chunk string The full track chunk
---@param resolved_chain table Array of FxFingerprint objects
---@return string|nil modified_chunk The modified track chunk
---@return string|nil error
function bridge.apply_chunk(track_chunk, resolved_chain)
  local input = json.encode({
    trackChunk = track_chunk,
    resolvedChain = resolved_chain,
  })

  local output, code = run_cli("apply-chunk", input)
  if not output or output == "" then
    return nil, "Failed to run reabase apply-chunk"
  end

  local ok, result = pcall(json.decode, output)
  if not ok then
    return nil, "Failed to parse apply-chunk JSON: " .. tostring(result)
  end
  return result.modifiedChunk, nil
end

--- Set a preset on a track chunk.
---@param track_chunk string The full track chunk
---@param preset string The preset to assign
---@return string|nil modified_chunk The modified track chunk
---@return string|nil error
function bridge.set_preset(track_chunk, preset)
  local input = json.encode({
    trackChunk = track_chunk,
    preset = preset,
  })

  local output, code = run_cli("set-preset", input)
  if not output or output == "" then
    return nil, "Failed to run reabase set-preset"
  end

  local ok, result = pcall(json.decode, output)
  if not ok then
    return nil, "Failed to parse set-preset JSON: " .. tostring(result)
  end
  return result.modifiedChunk, nil
end

--- Snapshot the current FX chain state (adopts current state as baseline).
--- Returns the modified chunk with slot map written to P_EXT.
---@param track_chunk string The full track chunk
---@param preset string The assigned preset
---@param reabase_path string|nil Optional path to search from
---@return string|nil modified_chunk The modified track chunk (with slot map in P_EXT)
---@return string|nil error
function bridge.snapshot(track_chunk, preset, reabase_path)
  local path_arg = reabase_path and (' -p "' .. reabase_path .. '"') or ""
  local input = json.encode({
    trackChunk = track_chunk,
    preset = preset,
  })

  local output, code = run_cli("snapshot" .. path_arg, input)
  if not output or output == "" then
    return nil, "Failed to run reabase snapshot"
  end

  local ok, result = pcall(json.decode, output)
  if not ok then
    return nil, "Failed to parse snapshot JSON: " .. tostring(result)
  end
  if result.success then
    return result.modifiedChunk, nil
  end
  return nil, "Snapshot failed"
end

--- Save the current FX chain as a new preset.
---@param track_chunk string The full track chunk
---@param preset_name string Name for the new preset
---@param reabase_path string|nil Optional path to search from
---@param selected_indices number[]|nil 0-based FX indices to include
---@param extends_preset string|nil Parent preset name for inheritance
---@param overwrite boolean|nil If true, overwrite existing preset
---@return boolean success
---@return string|nil error
---@return boolean|nil exists True if preset exists and overwrite was not set
function bridge.save_preset(track_chunk, preset_name, reabase_path, selected_indices, extends_preset, overwrite)
  local path_arg = reabase_path and (' -p "' .. reabase_path .. '"') or ""
  local payload = {
    trackChunk = track_chunk,
    presetName = preset_name,
  }
  if selected_indices then
    payload.selectedPlugins = selected_indices
  end
  if extends_preset then
    payload.extendsPreset = extends_preset
  end
  if overwrite then
    payload.overwrite = true
  end
  local input = json.encode(payload)

  local output, code = run_cli("save-preset" .. path_arg, input)
  if not output or output == "" then
    return false, "Failed to run reabase save-preset"
  end

  local ok, result = pcall(json.decode, output)
  if not ok then
    return false, "Failed to parse save-preset JSON: " .. tostring(result)
  end
  if result.exists then
    return false, nil, true
  end
  return result.success == true, nil, false
end

--- Delete a preset.
---@param preset_name string Name of the preset to delete
---@param reabase_path string|nil Optional path to search from
---@return boolean success
---@return string|nil error
function bridge.delete_preset(preset_name, reabase_path)
  local path_arg = reabase_path and (' -p "' .. reabase_path .. '"') or ""
  local input = json.encode({
    presetName = preset_name,
  })

  local output, code = run_cli("delete-preset" .. path_arg, input)
  if not output or output == "" then
    return false, "Failed to run reabase delete-preset"
  end

  local ok, result = pcall(json.decode, output)
  if not ok then
    return false, "Failed to parse delete-preset JSON: " .. tostring(result)
  end
  return result.success == true and result.deleted == true, nil
end

--- Update preset files from the track's current state and ownership assignments.
---@param track_chunk string The full track chunk
---@param ownership table Map of preset name -> array of slotIds
---@param released table Array of slotIds that are released (local-only)
---@param reabase_path string|nil Optional path to search from
---@return table|nil result {success, updatedPresets, modifiedChunk}
---@return string|nil error
function bridge.update_presets(track_chunk, ownership, released, reabase_path)
  local path_arg = reabase_path and (' -p "' .. reabase_path .. '"') or ""
  local input = json.encode({
    trackChunk = track_chunk,
    ownership = ownership,
    released = released,
  })

  local output, code = run_cli("update-presets" .. path_arg, input)
  if not output or output == "" then
    return nil, "Failed to run reabase update-presets"
  end

  local ok, result = pcall(json.decode, output)
  if not ok then
    return nil, "Failed to parse update-presets JSON: " .. tostring(result)
  end
  if result.error then
    return nil, result.error
  end
  return result, nil
end

--- Revert a single plugin's state back to its preset-defined state.
---@param track_chunk string The full track chunk
---@param slot_id string The slot ID of the plugin to revert
---@param reabase_path string|nil Optional path to search from
---@return string|nil modified_chunk The modified track chunk
---@return string|nil error
function bridge.revert_plugin(track_chunk, slot_id, reabase_path)
  local path_arg = reabase_path and (' -p "' .. reabase_path .. '"') or ""
  local input = json.encode({
    trackChunk = track_chunk,
    slotId = slot_id,
  })

  local output, code = run_cli("revert-plugin" .. path_arg, input)
  if not output or output == "" then
    return nil, "Failed to run reabase revert-plugin"
  end

  local ok, result = pcall(json.decode, output)
  if not ok then
    return nil, "Failed to parse revert-plugin JSON: " .. tostring(result)
  end
  if result.error then
    return nil, result.error
  end
  return result.modifiedChunk, nil
end

return bridge
