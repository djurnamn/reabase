import type { RppChild, RppNode, RppStruct, RppValue } from "./types.js";

export interface SerializeOptions {
  /** Line ending to use. Defaults to "\n". */
  lineEnding?: string;
}

/**
 * Serialize an RppNode tree back to an RPP file string.
 * Uses stored raw content when available for perfect round-trip fidelity.
 * Falls back to rebuilding from parsed values for programmatically created/modified nodes.
 */
export function serializeRpp(
  node: RppNode,
  options?: SerializeOptions
): string {
  const lineEnding = options?.lineEnding ?? "\n";
  const lines: string[] = [];
  serializeNode(node, 0, lines);
  return lines.join(lineEnding) + lineEnding;
}

/**
 * Detect the line ending used in an RPP file string.
 * Returns "\r\n" if CRLF is found, "\n" otherwise.
 */
export function detectLineEnding(input: string): string {
  return input.includes("\r\n") ? "\r\n" : "\n";
}

function serializeNode(node: RppNode, depth: number, lines: string[]): void {
  const indent = "  ".repeat(depth);

  // Opening line: use raw if available, otherwise rebuild
  if (node._rawOpening !== undefined) {
    lines.push(`${indent}<${node._rawOpening}`);
  } else {
    const paramStr =
      node.params.length > 0
        ? " " + node.params.map(serializeValue).join(" ")
        : "";
    lines.push(`${indent}<${node.token}${paramStr}`);
  }

  // Children
  for (const child of node.children) {
    serializeChild(child, depth + 1, lines);
  }

  // Closing >
  lines.push(`${indent}>`);
}

function serializeChild(
  child: RppChild,
  depth: number,
  lines: string[]
): void {
  switch (child.kind) {
    case "node":
      serializeNode(child, depth, lines);
      break;
    case "struct":
      serializeStruct(child, depth, lines);
      break;
    case "raw":
      serializeRaw(child.content, depth, lines);
      break;
  }
}

function serializeStruct(
  struct: RppStruct,
  depth: number,
  lines: string[]
): void {
  const indent = "  ".repeat(depth);

  // Use raw line if available (preserves original quoting, spacing, etc.)
  if (struct._raw !== undefined) {
    lines.push(`${indent}${struct._raw}`);
  } else {
    const paramStr =
      struct.params.length > 0
        ? " " + struct.params.map(serializeValue).join(" ")
        : "";
    lines.push(`${indent}${struct.token}${paramStr}`);
  }
}

function serializeRaw(content: string, depth: number, lines: string[]): void {
  const indent = "  ".repeat(depth);
  lines.push(`${indent}${content}`);
}

/**
 * Serialize a single value, quoting strings that need it.
 * Used when rebuilding lines from parsed values (no raw content available).
 */
export function serializeValue(value: RppValue): string {
  if (typeof value === "number") {
    return formatNumber(value);
  }

  // GUIDs: always unquoted
  if (value.startsWith("{") && value.endsWith("}")) {
    return value;
  }

  // Empty strings must be quoted
  if (value === "") {
    return '""';
  }

  // Strings that need quoting: contain spaces, special chars, or could be ambiguous
  if (needsQuoting(value)) {
    return quoteString(value);
  }

  return value;
}

function needsQuoting(value: string): boolean {
  return (
    value.includes(" ") ||
    value.includes("\t") ||
    value.includes('"') ||
    value.includes("'") ||
    value.includes("`") ||
    value.includes("<") ||
    value.includes(">")
  );
}

/**
 * Quote a string value, choosing the appropriate quote style.
 * REAPER prefers double quotes. Falls back to single quotes if the string
 * contains double quotes, and backticks as last resort.
 */
function quoteString(value: string): string {
  if (!value.includes('"')) {
    return `"${value}"`;
  }
  if (!value.includes("'")) {
    return `'${value}'`;
  }
  if (!value.includes("`")) {
    return `\`${value}\``;
  }
  // Escape double quotes as last resort
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Format a number to match REAPER's output style.
 */
function formatNumber(value: number): string {
  return value.toString();
}
