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

-- Notify the page when the selected track changes so it can re-inspect.
-- Compared by the track's pointer string; "none" when nothing is selected.
local last_track_id = nil

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
    reaper.Webview_Emit(WINDOW_ID, "selection-changed", "{}")
  end

  reaper.defer(loop)
end

reaper.defer(loop)
