/**
 * State blob normalization for stable comparison.
 *
 * Plugin state blobs contain non-deterministic metadata from REAPER's hosting
 * layer that changes on every serialization even when plugin state hasn't changed.
 * This module strips that metadata so blob comparisons reflect actual state changes.
 *
 * Architecture:
 *
 *   normalizeBlobForComparison(blob, pluginType)
 *       │
 *       ├── AU   → strip binary header + plist wrapper → extract <data> → pattern handlers
 *       ├── VST  → strip 8-byte REAPER header + 8 trailing bytes
 *       ├── VST3 → strip 8-byte header → extract IComponent state only
 *       ├── JS   → identity (plain text, deterministic)
 *       └── *    → identity fallback
 *
 * Type-level handlers address REAPER's hosting format (consistent across all
 * plugins of a given type). Pattern handlers address vendor-specific inner
 * formats — these are optional and extensible.
 *
 * To add a vendor pattern handler:
 * 1. Create a function matching `(data: Buffer) => string | null`
 * 2. Add it to the appropriate type's handler array (e.g., `auPatternHandlers`)
 * 3. Return a normalized string if the format is recognized, or null to pass through
 */

// ─── main entry point ─────────────────────────────────────────

/**
 * Normalize a plugin state blob for stable comparison.
 * Strips non-deterministic host metadata per plugin type.
 * Returns a stable string suitable for equality comparison.
 */
export function normalizeBlobForComparison(blob: string, pluginType: string): string {
  switch (pluginType) {
    case "AU":
      return normalizeAuBlob(blob);
    case "VST":
      return normalizeVstBlob(blob);
    case "VST3":
      return normalizeVst3Blob(blob);
    case "JS":
      return blob; // JS state is plain text, deterministic
    default:
      return blob;
  }
}

// ─── AU handler ───────────────────────────────────────────────

/**
 * Normalize AU (Audio Unit) state blob.
 *
 * AU blobs: [52-byte binary header] [plist XML with <data> tag]
 * The header and plist wrapper have non-deterministic metadata from Apple's
 * AU hosting layer. We extract only the inner <data> payload.
 */
function normalizeAuBlob(blob: string): string {
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
    const normalized = applyPatternHandlers(auPatternHandlers, innerBinary);
    if (normalized) return normalized;

    // Fallback: use the raw <data> content (still strips the plist wrapper)
    return innerBase64;
  } catch {
    return blob;
  }
}

// ─── VST2 handler ────────────────────────────────────────────

/**
 * Normalize VST2 state blob.
 *
 * REAPER wraps VST2 chunks:
 *   [8-byte REAPER header] [plugin chunk] [8 trailing bytes]
 * We extract only the plugin's own chunk data.
 */
const VST2_HEADER_SIZE = 8;
const VST2_TRAILER_SIZE = 8;

function normalizeVstBlob(blob: string): string {
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
 * Normalize VST3 state blob.
 *
 * VST3 blobs: [4 bytes: IComponent length (LE)] [4 bytes: separator]
 *             [IComponent state] [IEditController state]
 * The IEditController state changes on GUI interaction (scrolling, etc.).
 * We extract only the IComponent (DSP/parameter) state.
 */
const VST3_HEADER_SIZE = 8;

function normalizeVst3Blob(blob: string): string {
  try {
    const binary = Buffer.from(blob, "base64");
    if (binary.length < VST3_HEADER_SIZE + 1) return blob;

    const componentStateLength = binary.readUInt32LE(0);
    const componentEnd = VST3_HEADER_SIZE + componentStateLength;
    if (componentStateLength === 0 || componentEnd > binary.length) return blob;

    const componentState = binary.slice(VST3_HEADER_SIZE, componentEnd);
    return componentState.toString("base64");
  } catch {
    return blob;
  }
}

// ─── Pattern handler system ──────────────────────────────────

type PatternHandler = (data: Buffer) => string | null;

function applyPatternHandlers(handlers: PatternHandler[], data: Buffer): string | null {
  for (const handler of handlers) {
    const result = handler(data);
    if (result !== null) return result;
  }
  return null;
}

/**
 * AU pattern handlers — extensible array.
 * Each handler inspects the inner <data> content and returns a normalized
 * string if it recognizes the format, or null to pass to the next handler.
 *
 * To add a vendor handler, push a function to this array:
 *   auPatternHandlers.push(myHandler);
 */
export const auPatternHandlers: PatternHandler[] = [
  neutralizeZipTimestamps,
];

// ─── Built-in pattern: ZIP timestamps ────────────────────────

/**
 * Neutralize non-deterministic timestamps in ZIP archives.
 *
 * Some AU plugins (e.g., Kilohearts) store state as a ZIP archive.
 * The ZIP local file header has modification timestamps (bytes 10-13)
 * that change on every serialization. We zero them out.
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

  // Zero out modification time/date in the local file header (bytes 10-13)
  copy[10] = 0;
  copy[11] = 0;
  copy[12] = 0;
  copy[13] = 0;

  // Also zero timestamps in all Central Directory headers (PK\x01\x02).
  // The central directory has its own copy of modification time/date at
  // offset 12-15 relative to each central directory entry.
  let pos = 0;
  while (pos < copy.length - 4) {
    if (
      copy[pos] === 0x50 &&
      copy[pos + 1] === 0x4b &&
      copy[pos + 2] === 0x01 &&
      copy[pos + 3] === 0x02
    ) {
      // Central directory entry: time at +12, date at +14
      if (pos + 15 < copy.length) {
        copy[pos + 12] = 0;
        copy[pos + 13] = 0;
        copy[pos + 14] = 0;
        copy[pos + 15] = 0;
      }
    }
    pos++;
  }

  return copy.toString("base64");
}
