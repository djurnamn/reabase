/**
 * A parsed value from an RPP file.
 * Can be a string (including quoted strings and GUIDs) or a number.
 */
export type RppValue = string | number;

/**
 * A single-line key-value entry in an RPP file.
 * Example: `NAME BJÖRN` or `VOLPAN 1 0 -1 -1 1`
 *
 * Stores the original raw line content (minus leading whitespace) for
 * perfect round-trip serialization. The parsed `token` and `params` are
 * available for programmatic access. When a struct is created or modified
 * programmatically, `_raw` should be cleared so the serializer rebuilds
 * the line from token + params.
 */
export interface RppStruct {
  kind: "struct";
  token: string;
  params: RppValue[];
  /** Original line content (trimmed of leading whitespace). Used for round-trip fidelity. */
  _raw?: string;
}

/**
 * A block/node in the RPP tree.
 * Example: `<TRACK {GUID}\n  ...children...\n>`
 *
 * Children can be:
 * - Nested RppNode blocks (e.g., <FXCHAIN>, <ITEM>)
 * - RppStruct single-line entries (e.g., NAME, VOLPAN)
 * - Raw strings (base64 data, unrecognized lines)
 */
export interface RppNode {
  kind: "node";
  token: string;
  params: RppValue[];
  children: RppChild[];
  /** Raw opening line content after '<' (trimmed). Used for round-trip fidelity. */
  _rawOpening?: string;
}

export type RppChild = RppNode | RppStruct | RppRawLine;

/**
 * A raw line that we preserve as-is for round-trip fidelity.
 * Used for base64 data inside plugin blocks, MIDI events, etc.
 */
export interface RppRawLine {
  kind: "raw";
  content: string;
}
