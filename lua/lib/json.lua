-- Minimal JSON encoder/decoder for reabase bridge communication.
-- Handles the subset of JSON used by the CLI: objects, arrays, strings, numbers, booleans, null.

local json = {}

-- ─── Decode ──────────────────────────────────────────────────────

local function skip_whitespace(str, pos)
  return str:match("^%s*()", pos)
end

local function decode_string(str, pos)
  -- pos should be right after the opening "
  local buf = {}
  local i = pos
  while i <= #str do
    local c = str:sub(i, i)
    if c == '"' then
      return table.concat(buf), i + 1
    elseif c == '\\' then
      i = i + 1
      local esc = str:sub(i, i)
      if esc == '"' or esc == '\\' or esc == '/' then
        buf[#buf + 1] = esc
      elseif esc == 'n' then
        buf[#buf + 1] = '\n'
      elseif esc == 'r' then
        buf[#buf + 1] = '\r'
      elseif esc == 't' then
        buf[#buf + 1] = '\t'
      elseif esc == 'u' then
        -- Basic Unicode escape (ASCII range only)
        local hex = str:sub(i + 1, i + 4)
        buf[#buf + 1] = string.char(tonumber(hex, 16))
        i = i + 4
      end
    else
      buf[#buf + 1] = c
    end
    i = i + 1
  end
  error("Unterminated string at position " .. pos)
end

local decode_value -- forward declaration

local function decode_array(str, pos)
  local arr = {}
  pos = skip_whitespace(str, pos)
  if str:sub(pos, pos) == ']' then
    return arr, pos + 1
  end
  while true do
    local val
    val, pos = decode_value(str, pos)
    arr[#arr + 1] = val
    pos = skip_whitespace(str, pos)
    local c = str:sub(pos, pos)
    if c == ']' then
      return arr, pos + 1
    elseif c == ',' then
      pos = skip_whitespace(str, pos + 1)
    else
      error("Expected ',' or ']' at position " .. pos)
    end
  end
end

local function decode_object(str, pos)
  local obj = {}
  pos = skip_whitespace(str, pos)
  if str:sub(pos, pos) == '}' then
    return obj, pos + 1
  end
  while true do
    -- Key must be a string
    pos = skip_whitespace(str, pos)
    if str:sub(pos, pos) ~= '"' then
      error("Expected string key at position " .. pos)
    end
    local key
    key, pos = decode_string(str, pos + 1)
    pos = skip_whitespace(str, pos)
    if str:sub(pos, pos) ~= ':' then
      error("Expected ':' at position " .. pos)
    end
    pos = skip_whitespace(str, pos + 1)
    local val
    val, pos = decode_value(str, pos)
    obj[key] = val
    pos = skip_whitespace(str, pos)
    local c = str:sub(pos, pos)
    if c == '}' then
      return obj, pos + 1
    elseif c == ',' then
      pos = skip_whitespace(str, pos + 1)
    else
      error("Expected ',' or '}' at position " .. pos)
    end
  end
end

decode_value = function(str, pos)
  pos = skip_whitespace(str, pos)
  local c = str:sub(pos, pos)
  if c == '"' then
    return decode_string(str, pos + 1)
  elseif c == '{' then
    return decode_object(str, skip_whitespace(str, pos + 1))
  elseif c == '[' then
    return decode_array(str, skip_whitespace(str, pos + 1))
  elseif c == 't' then
    if str:sub(pos, pos + 3) == 'true' then
      return true, pos + 4
    end
  elseif c == 'f' then
    if str:sub(pos, pos + 4) == 'false' then
      return false, pos + 5
    end
  elseif c == 'n' then
    if str:sub(pos, pos + 3) == 'null' then
      return nil, pos + 4
    end
  else
    -- Number
    local num_str = str:match("^-?%d+%.?%d*[eE]?[+-]?%d*", pos)
    if num_str then
      return tonumber(num_str), pos + #num_str
    end
  end
  error("Unexpected character '" .. c .. "' at position " .. pos)
end

function json.decode(str)
  local val, pos = decode_value(str, 1)
  return val
end

-- ─── Encode ──────────────────────────────────────────────────────

local function encode_string(s)
  s = s:gsub('\\', '\\\\')
  s = s:gsub('"', '\\"')
  s = s:gsub('\n', '\\n')
  s = s:gsub('\r', '\\r')
  s = s:gsub('\t', '\\t')
  return '"' .. s .. '"'
end

local encode_value -- forward declaration

local function encode_array(arr)
  local parts = {}
  for i = 1, #arr do
    parts[i] = encode_value(arr[i])
  end
  return '[' .. table.concat(parts, ',') .. ']'
end

local function is_array(t)
  if type(t) ~= 'table' then return false end
  local n = #t
  for k in pairs(t) do
    if type(k) ~= 'number' or k < 1 or k > n or math.floor(k) ~= k then
      return false
    end
  end
  return true
end

local function encode_object(obj)
  local parts = {}
  for k, v in pairs(obj) do
    parts[#parts + 1] = encode_string(tostring(k)) .. ':' .. encode_value(v)
  end
  return '{' .. table.concat(parts, ',') .. '}'
end

encode_value = function(val)
  local t = type(val)
  if val == nil then
    return 'null'
  elseif t == 'boolean' then
    return val and 'true' or 'false'
  elseif t == 'number' then
    return tostring(val)
  elseif t == 'string' then
    return encode_string(val)
  elseif t == 'table' then
    if is_array(val) then
      return encode_array(val)
    else
      return encode_object(val)
    end
  else
    error("Cannot encode type: " .. t)
  end
end

function json.encode(val)
  return encode_value(val)
end

return json
