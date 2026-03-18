import type { RppNode, RppRawLine, RppStruct, RppValue } from "./types.js";

/**
 * Parse an RPP file string into a tree of RppNodes.
 * Returns the root node (typically REAPER_PROJECT).
 */
export function parseRpp(input: string): RppNode {
  // Normalize line endings — we restore them during serialization if needed
  const lines = input.replace(/\r\n/g, "\n").split("\n");
  const stack: RppNode[] = [];
  let root: RppNode | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();

    if (trimmed === "" || trimmed === "\r") {
      // Preserve empty lines as raw content if we're inside a node
      if (stack.length > 0) {
        stack[stack.length - 1].children.push({ kind: "raw", content: line });
      }
      continue;
    }

    if (trimmed.startsWith("<")) {
      // Block open: <TOKEN params...
      const node = parseBlockOpen(trimmed);
      if (stack.length > 0) {
        stack[stack.length - 1].children.push(node);
      } else {
        root = node;
      }
      stack.push(node);
    } else if (trimmed === ">" || trimmed === ">\r") {
      // Block close
      if (stack.length === 0) {
        throw new RppParseError(`Unexpected closing '>' at line ${i + 1}`);
      }
      stack.pop();
    } else {
      // Content line: either a struct or raw data
      if (stack.length === 0) {
        throw new RppParseError(
          `Content outside of any block at line ${i + 1}: ${trimmed}`
        );
      }
      const child = parseContentLine(trimmed);
      stack[stack.length - 1].children.push(child);
    }
  }

  if (stack.length > 0) {
    throw new RppParseError(
      `Unclosed block: <${stack[stack.length - 1].token}>`
    );
  }
  if (root === null) {
    throw new RppParseError("Empty RPP file: no root block found");
  }

  return root;
}

/**
 * Parse a block opening line like `<TRACK {GUID}` or `<AU "name" "manufacturer" ...`
 */
function parseBlockOpen(line: string): RppNode {
  // Remove leading '<' and trailing whitespace
  const content = line.slice(1).trimEnd();
  const values = parseValues(content);

  if (values.length === 0) {
    throw new RppParseError(`Empty block opening: <${line}>`);
  }

  const token = values[0];
  if (typeof token !== "string") {
    throw new RppParseError(`Block token must be a string, got: ${token}`);
  }

  return {
    kind: "node",
    token,
    params: values.slice(1),
    children: [],
    _rawOpening: content,
  };
}

/**
 * Parse a content line into either an RppStruct or RppRawLine.
 *
 * A line is classified as a struct if it starts with a word-like token
 * (letters, digits, underscores, starting with a letter). This covers
 * both uppercase RPP tokens (NAME, VOLPAN) and lowercase extension keys
 * (nvk_take_source_type_v2).
 *
 * Lines that don't match (base64 data, MIDI events, pipe-delimited text)
 * are stored as raw lines.
 */
function parseContentLine(trimmed: string): RppStruct | RppRawLine {
  // Match a token: starts with a letter (upper or lower), followed by
  // letters, digits, or underscores. Must be followed by whitespace or end of line.
  const match = trimmed.match(/^([a-zA-Z][a-zA-Z0-9_]*)(\s|$)/);
  if (match) {
    const token = match[1];
    const afterToken = trimmed.slice(token.length).trim();
    const params = afterToken ? parseValues(afterToken) : [];
    return {
      kind: "struct",
      token,
      params,
      _raw: trimmed,
    };
  }

  // Otherwise it's raw data (base64, pipe-delimited text, etc.)
  return {
    kind: "raw",
    content: trimmed,
  };
}

/**
 * Parse a space-separated list of values, handling quoted strings.
 *
 * Handles:
 * - Double-quoted strings: "hello world"
 * - Single-quoted strings: 'hello'
 * - Backtick-quoted strings: `hello`
 * - Unquoted tokens: BJÖRN, 1.5, {GUID-HERE}, -1:U
 * - Numbers: integers and floats
 */
export function parseValues(input: string): RppValue[] {
  const values: RppValue[] = [];
  let i = 0;

  while (i < input.length) {
    // Skip whitespace
    while (i < input.length && (input[i] === " " || input[i] === "\t")) {
      i++;
    }
    if (i >= input.length) break;

    const char = input[i];

    if (char === '"' || char === "'" || char === "`") {
      // Quoted string
      const { value, end } = parseQuotedString(input, i, char);
      values.push(value);
      i = end;
    } else {
      // Unquoted token — read until whitespace
      const start = i;
      while (i < input.length && input[i] !== " " && input[i] !== "\t") {
        i++;
      }
      const token = input.slice(start, i);
      values.push(maybeNumber(token));
    }
  }

  return values;
}

/**
 * Parse a quoted string starting at position `start`.
 * Returns the string content (without quotes) and the position after the closing quote.
 */
function parseQuotedString(
  input: string,
  start: number,
  quote: string
): { value: string; end: number } {
  let i = start + 1; // skip opening quote
  let result = "";

  while (i < input.length) {
    if (input[i] === quote) {
      return { value: result, end: i + 1 };
    }
    // Handle escape sequences in double-quoted strings
    if (quote === '"' && input[i] === "\\" && i + 1 < input.length) {
      const next = input[i + 1];
      if (next === '"' || next === "\\") {
        result += next;
        i += 2;
        continue;
      }
    }
    result += input[i];
    i++;
  }

  // Unterminated string — return what we have
  return { value: result, end: i };
}

/**
 * Convert a string to a number if it looks like one, otherwise return as-is.
 */
function maybeNumber(token: string): RppValue {
  // Don't convert GUIDs, colon-separated values, or empty strings
  if (
    token === "" ||
    token.startsWith("{") ||
    token.includes(":") ||
    token.includes("/")
  ) {
    return token;
  }

  const num = Number(token);
  if (!isNaN(num) && token !== "") {
    return num;
  }

  return token;
}

export class RppParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RppParseError";
  }
}
