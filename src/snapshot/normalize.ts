/**
 * State blob normalization for stable hashing.
 *
 * Plugin state blobs contain non-deterministic metadata (timestamps, counters,
 * etc.) that changes on every REAPER serialization even when plugin parameters
 * haven't changed. This module strips that metadata so hashes reflect only
 * actual parameter changes.
 *
 * Architecture:
 *
 *   normalizeStateBlob(blob, pluginType)
 *       │
 *       ├── AU   → strip binary header + plist wrapper → extract <data> → pattern handlers (zip, ...)
 *       ├── VST  → strip 8-byte REAPER header + 8 trailing bytes → hash plugin chunk only
 *       ├── VST3 → strip 8-byte REAPER header → extract IComponent state only (ignore IEditController)
 *       ├── JS   → identity (plain text key-value pairs, deterministic)
 *       └── DX   → (stub — Windows-only, untested)
 *
 * Each plugin type has a base handler that understands the type's wrapper
 * format (e.g., AU uses a plist XML envelope). Within each base handler,
 * pattern handlers address specific inner data formats (e.g., zip archives
 * with non-deterministic timestamps).
 *
 * When adding support for a new non-deterministic format:
 * 1. Identify which plugin type produces it
 * 2. Add or extend the base handler for that type
 * 3. Add a pattern handler if the inner data has a recognizable structure
 */

// ─── main entry point ─────────────────────────────────────────

/**
 * Normalize a plugin state blob for stable hashing.
 * Dispatches to a type-specific handler based on the plugin type.
 */
export function normalizeStateBlob(blob: string, pluginType: string): string {
  switch (pluginType) {
    case "AU":
      return normalizeAuState(blob);
    case "VST":
      return normalizeVstState(blob);
    case "VST3":
      return normalizeVst3State(blob);
    case "JS":
      return normalizeJsState(blob);
    case "DX":
      return normalizeDxState(blob);
    default:
      return blob;
  }
}

// ─── AU handler ───────────────────────────────────────────────

/**
 * Normalize AU (Audio Unit) plugin state.
 *
 * AU state blobs are structured as:
 *   [52-byte binary header] [plist XML with <data> tag]
 *
 * The binary header and plist wrapper contain non-deterministic metadata
 * from Apple's AU hosting layer (timestamps, counters) that changes on
 * every serialization. We extract and normalize only the inner <data>
 * payload.
 *
 * The <data> content format is vendor-specific — pattern handlers below
 * address known formats.
 */
function normalizeAuState(blob: string): string {
  try {
    const binary = Buffer.from(blob, "base64");
    const xmlStart = binary.indexOf("<?xml");
    if (xmlStart < 0) return blob;

    const text = binary.slice(xmlStart).toString("utf-8");
    const dataMatch = text.match(/<data>([\s\S]*?)<\/data>/);
    if (!dataMatch) return blob;

    const innerBase64 = dataMatch[1].replace(/\s/g, "");
    const innerBinary = Buffer.from(innerBase64, "base64");

    // Try pattern handlers on the inner data
    const normalized = applyAuPatternHandlers(innerBinary);
    if (normalized) return normalized;

    // Fallback: use the raw <data> content (still strips the plist wrapper)
    return innerBase64;
  } catch {
    return blob;
  }
}

/**
 * AU pattern handlers. Each handler inspects the inner <data> content
 * and returns a normalized string if it recognizes the format, or null
 * to pass to the next handler.
 */
const auPatternHandlers: Array<(data: Buffer) => string | null> = [
  neutralizeZipTimestamps,
];

function applyAuPatternHandlers(data: Buffer): string | null {
  for (const handler of auPatternHandlers) {
    const result = handler(data);
    if (result !== null) return result;
  }
  return null;
}

// ─── AU pattern: ZIP timestamps ───────────────────────────────

/**
 * Neutralize non-deterministic fields in a ZIP archive.
 *
 * Some AU plugins (e.g., Kilohearts) store state as a ZIP archive
 * containing state.json. The ZIP local file header has modification
 * timestamps (bytes 10-13) that REAPER increments on every serialization,
 * even when plugin parameters haven't changed.
 *
 * Returns a base64 string of the data with timestamps zeroed,
 * or null if the input is not a ZIP archive.
 */
function neutralizeZipTimestamps(data: Buffer): string | null {
  // ZIP local file header signature: PK\x03\x04
  if (
    data.length < 30 ||
    data[0] !== 0x50 ||
    data[1] !== 0x4b ||
    data[2] !== 0x03 ||
    data[3] !== 0x04
  ) {
    return null;
  }

  const copy = Buffer.from(data);

  // Zero out modification time (2 bytes at offset 10) and date (2 bytes at offset 12)
  copy[10] = 0;
  copy[11] = 0;
  copy[12] = 0;
  copy[13] = 0;

  return copy.toString("base64");
}

// ─── VST2 handler ────────────────────────────────────────────

/**
 * Normalize VST2 plugin state.
 *
 * REAPER wraps VST2 plugin chunks with host-specific metadata:
 *   [8-byte REAPER header] [plugin chunk from effGetChunk] [8 trailing bytes]
 *
 * The header contains routing/channel configuration and the trailing
 * bytes contain host metadata. Neither is part of the plugin's own state,
 * so we strip them to hash only the plugin's chunk data.
 *
 * If the blob is too short to contain the wrapper (< 16 bytes decoded),
 * we fall back to hashing the full blob.
 */
const VST2_HEADER_SIZE = 8;
const VST2_TRAILER_SIZE = 8;

function normalizeVstState(blob: string): string {
  try {
    const binary = Buffer.from(blob, "base64");
    const minSize = VST2_HEADER_SIZE + VST2_TRAILER_SIZE + 1;
    if (binary.length < minSize) return blob;

    const pluginChunk = binary.slice(
      VST2_HEADER_SIZE,
      binary.length - VST2_TRAILER_SIZE
    );
    return pluginChunk.toString("base64");
  } catch {
    return blob;
  }
}

// ─── VST3 handler ────────────────────────────────────────────

/**
 * Normalize VST3 plugin state.
 *
 * VST3 plugins have a dual-component architecture. REAPER stores both
 * states concatenated with an 8-byte header:
 *
 *   [4 bytes: IComponent state length (LE int32)]
 *   [4 bytes: separator (typically 0x01000000)]
 *   [IComponent state — DSP/parameter data]
 *   [IEditController state — GUI-only data (scroll positions, view state)]
 *
 * The IEditController state can change without any parameter modification
 * (e.g., the user scrolls a plugin window). We extract and hash only the
 * IComponent state to avoid false positives from GUI-only changes.
 *
 * Falls back to the full blob if the header can't be parsed.
 */
const VST3_HEADER_SIZE = 8;

function normalizeVst3State(blob: string): string {
  try {
    const binary = Buffer.from(blob, "base64");
    if (binary.length < VST3_HEADER_SIZE + 1) return blob;

    const componentStateLength = binary.readUInt32LE(0);

    // Sanity check: component state length should fit within the blob
    const componentEnd = VST3_HEADER_SIZE + componentStateLength;
    if (componentStateLength === 0 || componentEnd > binary.length) return blob;

    const componentState = binary.slice(VST3_HEADER_SIZE, componentEnd);
    return componentState.toString("base64");
  } catch {
    return blob;
  }
}

// ─── JS handler (stub) ───────────────────────────────────────

/**
 * Normalize JS (JSFX/EEL) plugin state.
 *
 * JS plugins store state as plain text key-value pairs.
 * These are typically deterministic, but this handler exists
 * as a hook if edge cases are found.
 */
function normalizeJsState(blob: string): string {
  return blob;
}

// ─── DX handler (stub) ───────────────────────────────────────

/**
 * Normalize DirectX plugin state.
 *
 * DX plugins are Windows-only. No known non-deterministic fields yet.
 */
function normalizeDxState(blob: string): string {
  return blob;
}
