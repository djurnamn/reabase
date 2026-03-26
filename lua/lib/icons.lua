-- Font and icon management for ReaImGui.
-- Loads Nunito Medium as the default text font and Lucide as the icon font.
--
-- Usage:
--   local icons = require("icons")
--   icons.setup(ctx)  -- call once after creating ImGui context
--
--   -- In render loop (Nunito is already the active default font):
--   icons.text(ctx, icons.CHECK)           -- standalone icon
--   icons.label(ctx, icons.SAVE, "Save")   -- icon + text on same line

local icons = {}

-- ─── Font state ──────────────────────────────────────────────────

local icon_font = nil
local text_font = nil
local script_path = debug.getinfo(1, "S").source:match("@(.+[/\\])")

--- Default text font size (em-square pixels for PushFont).
icons.TEXT_SIZE = 14

--- Icon size relative to the current text font size.
icons.ICON_SCALE = 1.25

--- Initialize fonts. Call once after ImGui_CreateContext.
---@param ctx ImGui_Context
function icons.setup(ctx)
  icon_font = reaper.ImGui_CreateFontFromFile(script_path .. "lucide.ttf")
  text_font = reaper.ImGui_CreateFontFromFile(script_path .. "nunito.ttf")
  reaper.ImGui_Attach(ctx, icon_font)
  reaper.ImGui_Attach(ctx, text_font)
end

--- Push the default text font. Call at the start of each frame.
---@param ctx ImGui_Context
function icons.push_default_font(ctx)
  reaper.ImGui_PushFont(ctx, text_font, icons.TEXT_SIZE)
end

--- Pop the default text font. Call at the end of each frame.
---@param ctx ImGui_Context
function icons.pop_default_font(ctx)
  reaper.ImGui_PopFont(ctx)
end

-- Style var/color counts for push/pop balancing
local STYLE_VAR_COUNT = 4
local STYLE_COLOR_COUNT = 18

--- Push global style overrides. Call once per frame before Begin.
---@param ctx ImGui_Context
function icons.push_global_styles(ctx)
  -- Vars
  reaper.ImGui_PushStyleVar(ctx, reaper.ImGui_StyleVar_FramePadding(), 6, 4)
  reaper.ImGui_PushStyleVar(ctx, reaper.ImGui_StyleVar_FrameRounding(), 4)
  reaper.ImGui_PushStyleVar(ctx, reaper.ImGui_StyleVar_TabRounding(), 4)
  reaper.ImGui_PushStyleVar(ctx, reaper.ImGui_StyleVar_PopupRounding(), 4)

  -- Colors: gray-based palette
  reaper.ImGui_PushStyleColor(ctx, reaper.ImGui_Col_FrameBg(),          0x2A2A2AFF)
  reaper.ImGui_PushStyleColor(ctx, reaper.ImGui_Col_FrameBgHovered(),   0x363636FF)
  reaper.ImGui_PushStyleColor(ctx, reaper.ImGui_Col_FrameBgActive(),    0x404040FF)
  reaper.ImGui_PushStyleColor(ctx, reaper.ImGui_Col_Button(),           0x383838FF)
  reaper.ImGui_PushStyleColor(ctx, reaper.ImGui_Col_ButtonHovered(),    0x484848FF)
  reaper.ImGui_PushStyleColor(ctx, reaper.ImGui_Col_ButtonActive(),     0x555555FF)
  reaper.ImGui_PushStyleColor(ctx, reaper.ImGui_Col_Header(),           0x333333FF)
  reaper.ImGui_PushStyleColor(ctx, reaper.ImGui_Col_HeaderHovered(),    0x444444FF)
  reaper.ImGui_PushStyleColor(ctx, reaper.ImGui_Col_HeaderActive(),     0x505050FF)
  reaper.ImGui_PushStyleColor(ctx, reaper.ImGui_Col_Tab(),              0x2A2A2AFF)
  reaper.ImGui_PushStyleColor(ctx, reaper.ImGui_Col_TabHovered(),       0x484848FF)
  reaper.ImGui_PushStyleColor(ctx, reaper.ImGui_Col_TabSelected(),      0x404040FF)
  reaper.ImGui_PushStyleColor(ctx, reaper.ImGui_Col_CheckMark(),        0xCCCCCCFF)
  reaper.ImGui_PushStyleColor(ctx, reaper.ImGui_Col_TableRowBgAlt(),    0x262626FF)
  reaper.ImGui_PushStyleColor(ctx, reaper.ImGui_Col_TitleBg(),          0x1A1A1AFF)
  reaper.ImGui_PushStyleColor(ctx, reaper.ImGui_Col_TitleBgActive(),    0x2A2A2AFF)
  reaper.ImGui_PushStyleColor(ctx, reaper.ImGui_Col_TitleBgCollapsed(), 0x1A1A1AFF)
  reaper.ImGui_PushStyleColor(ctx, reaper.ImGui_Col_ResizeGrip(),       0x333333FF)
end

--- Pop global style overrides. Call once per frame after End.
---@param ctx ImGui_Context
function icons.pop_global_styles(ctx)
  reaper.ImGui_PopStyleColor(ctx, STYLE_COLOR_COUNT)
  reaper.ImGui_PopStyleVar(ctx, STYLE_VAR_COUNT)
end

--- Get the computed icon size based on the current text font.
---@param ctx ImGui_Context
---@return number
local function get_icon_size(ctx)
  return reaper.ImGui_GetFontSize(ctx) * icons.ICON_SCALE
end

-- ─── Rendering helpers ───────────────────────────────────────────

--- Draw an icon via DrawList, centered within a given rect.
--- Does not create any ImGui item — purely visual.
---@param ctx ImGui_Context
---@param codepoint string UTF-8 encoded icon character
---@param x1 number Left edge
---@param y1 number Top edge
---@param x2 number Right edge
---@param y2 number Bottom edge
---@param color number RGBA color
---@param size number|nil Icon font size override
function icons.draw_icon(ctx, codepoint, x1, y1, x2, y2, color, size)
  local icon_size = size or get_icon_size(ctx)
  local draw_list = reaper.ImGui_GetWindowDrawList(ctx)
  reaper.ImGui_PushFont(ctx, icon_font, icon_size)
  local iw, ih = reaper.ImGui_CalcTextSize(ctx, codepoint)
  reaper.ImGui_DrawList_AddText(draw_list,
    x1 + (x2 - x1 - iw) * 0.5,
    y1 + (y2 - y1 - ih) * 0.5,
    color, codepoint)
  reaper.ImGui_PopFont(ctx)
end

--- Render an icon as text, vertically centered with the current text line.
---@param ctx ImGui_Context
---@param codepoint string UTF-8 encoded icon character
---@param size number|nil Font size override for the icon
function icons.text(ctx, codepoint, size)
  local icon_size = size or get_icon_size(ctx)
  local text_line_h = reaper.ImGui_GetTextLineHeight(ctx)
  -- Offset cursor to vertically center the icon with surrounding text
  local offset_y = (text_line_h - icon_size) * 0.5
  if offset_y > 0 then
    local cx, cy = reaper.ImGui_GetCursorPos(ctx)
    reaper.ImGui_SetCursorPos(ctx, cx, cy + offset_y)
  end
  reaper.ImGui_PushFont(ctx, icon_font, icon_size)
  reaper.ImGui_Text(ctx, codepoint)
  reaper.ImGui_PopFont(ctx)
end

--- Render an icon followed by a text label on the same line.
---@param ctx ImGui_Context
---@param codepoint string UTF-8 encoded icon character
---@param label string Text to show after the icon
---@param size number|nil Font size for the icon
function icons.label(ctx, codepoint, label, size)
  icons.text(ctx, codepoint, size)
  reaper.ImGui_SameLine(ctx)
  reaper.ImGui_Text(ctx, label)
end

--- Create an icon-only button. Returns true if clicked.
---@param ctx ImGui_Context
---@param codepoint string UTF-8 encoded icon character
---@param button_id string ImGui button ID (e.g., "##save")
---@param size number|nil Font size for the icon
---@return boolean clicked
function icons.button(ctx, codepoint, button_id, size)
  local icon_size = size or get_icon_size(ctx)
  reaper.ImGui_PushFont(ctx, icon_font, icon_size)
  local clicked = reaper.ImGui_Button(ctx, codepoint .. button_id)
  reaper.ImGui_PopFont(ctx)
  return clicked
end

--- Create a button with an icon followed by a text label. Returns true if clicked.
--- Uses InvisibleButton + DrawList since the icon font has no Latin glyphs.
---@param ctx ImGui_Context
---@param codepoint string UTF-8 encoded icon character
---@param label string Text label to show after the icon
---@param button_id string ImGui button ID (e.g., "##save")
---@param size number|nil Font size for the icon
---@return boolean clicked
function icons.button_with_label(ctx, codepoint, label, button_id, size)
  local icon_size = size or get_icon_size(ctx)
  local style_frame_x, style_frame_y = reaper.ImGui_GetStyleVar(ctx, reaper.ImGui_StyleVar_FramePadding())
  local icon_gap = 5

  -- Measure icon width
  reaper.ImGui_PushFont(ctx, icon_font, icon_size)
  local icon_w, icon_h = reaper.ImGui_CalcTextSize(ctx, codepoint)
  reaper.ImGui_PopFont(ctx)

  -- Measure label
  local label_w, label_h = reaper.ImGui_CalcTextSize(ctx, label)

  -- Use the taller of the two for button height
  local content_h = math.max(icon_h, label_h)
  local total_w = style_frame_x + icon_w + icon_gap + label_w + style_frame_x
  local total_h = content_h + style_frame_y * 2

  local clicked = reaper.ImGui_InvisibleButton(ctx, button_id, total_w, total_h)
  local is_hovered = reaper.ImGui_IsItemHovered(ctx)
  local is_active = reaper.ImGui_IsItemActive(ctx)

  -- Draw button background
  local draw_list = reaper.ImGui_GetWindowDrawList(ctx)
  local x, y = reaper.ImGui_GetItemRectMin(ctx)
  local x2, y2 = reaper.ImGui_GetItemRectMax(ctx)
  local rounding = reaper.ImGui_GetStyleVar(ctx, reaper.ImGui_StyleVar_FrameRounding())

  local bg_color
  if is_active then
    bg_color = reaper.ImGui_GetStyleColor(ctx, reaper.ImGui_Col_ButtonActive())
  elseif is_hovered then
    bg_color = reaper.ImGui_GetStyleColor(ctx, reaper.ImGui_Col_ButtonHovered())
  else
    bg_color = reaper.ImGui_GetStyleColor(ctx, reaper.ImGui_Col_Button())
  end
  reaper.ImGui_DrawList_AddRectFilled(draw_list, x, y, x2, y2, bg_color, rounding)

  -- Draw icon — vertically centered
  local text_color = reaper.ImGui_GetStyleColor(ctx, reaper.ImGui_Col_Text())
  local icon_y = y + style_frame_y + (content_h - icon_h) * 0.5
  reaper.ImGui_PushFont(ctx, icon_font, icon_size)
  reaper.ImGui_DrawList_AddText(draw_list, x + style_frame_x, icon_y, text_color, codepoint)
  reaper.ImGui_PopFont(ctx)

  -- Draw label text — vertically centered
  local label_y = y + style_frame_y + (content_h - label_h) * 0.5
  reaper.ImGui_DrawList_AddText(draw_list, x + style_frame_x + icon_w + icon_gap, label_y, text_color, label)

  return clicked
end

--- Create a square icon button (equal width and height). Returns true if clicked.
---@param ctx ImGui_Context
---@param codepoint string UTF-8 encoded icon character
---@param button_id string ImGui button ID (e.g., "##save")
---@param size number|nil Font size for the icon
---@return boolean clicked
function icons.square_button(ctx, codepoint, button_id, size)
  local icon_size = size or get_icon_size(ctx)
  local _, frame_pad_y = reaper.ImGui_GetStyleVar(ctx, reaper.ImGui_StyleVar_FramePadding())
  local line_h = reaper.ImGui_GetTextLineHeight(ctx)
  local btn_h = line_h + frame_pad_y * 2
  -- Push frame padding so width padding matches height padding, making button square
  reaper.ImGui_PushStyleVar(ctx, reaper.ImGui_StyleVar_FramePadding(), frame_pad_y, frame_pad_y)
  reaper.ImGui_PushFont(ctx, icon_font, icon_size)
  local clicked = reaper.ImGui_Button(ctx, codepoint .. button_id)
  reaper.ImGui_PopFont(ctx)
  reaper.ImGui_PopStyleVar(ctx)
  return clicked
end

--- Create an icon-only small button. Returns true if clicked.
---@param ctx ImGui_Context
---@param codepoint string UTF-8 encoded icon character
---@param button_id string ImGui button ID (e.g., "##save")
---@param size number|nil Font size for the icon
---@return boolean clicked
function icons.small_button(ctx, codepoint, button_id, size)
  local icon_size = size or get_icon_size(ctx)
  reaper.ImGui_PushFont(ctx, icon_font, icon_size)
  local clicked = reaper.ImGui_SmallButton(ctx, codepoint .. button_id)
  reaper.ImGui_PopFont(ctx)
  return clicked
end

-- ─── Icon codepoints (Lucide v0.577.0) ──────────────────────────
-- Codepoints from lucide-static font, PUA range U+E038–U+E6BB.

icons.ARROW_DOWN        = utf8.char(0xE042)
icons.ARROW_UP          = utf8.char(0xE04A)
icons.CHECK             = utf8.char(0xE06C)
icons.CHEVRON_DOWN      = utf8.char(0xE06D)
icons.CHEVRON_UP        = utf8.char(0xE070)
icons.CIRCLE            = utf8.char(0xE076)
icons.CIRCLE_ALERT      = utf8.char(0xE077)
icons.CIRCLE_ARROW_DOWN = utf8.char(0xE078)
icons.CIRCLE_CHECK      = utf8.char(0xE226)
icons.CIRCLE_DOT        = utf8.char(0xE345)
icons.CIRCLE_HELP       = utf8.char(0xE082)
icons.CIRCLE_MINUS      = utf8.char(0xE07E)
icons.CIRCLE_PLUS       = utf8.char(0xE081)
icons.CIRCLE_X          = utf8.char(0xE084)
icons.EYE               = utf8.char(0xE0BA)
icons.EYE_OFF           = utf8.char(0xE0BB)
icons.GIT_BRANCH        = utf8.char(0xE0E2)
icons.GRIP_VERTICAL     = utf8.char(0xE0EB)
icons.INFO              = utf8.char(0xE0F9)
icons.LINK              = utf8.char(0xE102)
icons.LINK_2            = utf8.char(0xE103)
icons.LINK_2_OFF        = utf8.char(0xE104)
icons.MENU              = utf8.char(0xE115)
icons.MINUS             = utf8.char(0xE11C)
icons.PACKAGE           = utf8.char(0xE129)
icons.PENCIL            = utf8.char(0xE1F9)
icons.PLUS              = utf8.char(0xE13D)
icons.REFRESH_CW        = utf8.char(0xE145)
icons.SAVE              = utf8.char(0xE14D)
icons.SQUARE_PEN        = utf8.char(0xE172)
icons.TRASH             = utf8.char(0xE18E)
icons.TRIANGLE_ALERT    = utf8.char(0xE193)
icons.UNDO              = utf8.char(0xE19B)
icons.UNDO_2            = utf8.char(0xE2A1)
icons.UNLINK            = utf8.char(0xE19C)
icons.X                 = utf8.char(0xE1B2)

return icons
