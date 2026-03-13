import { parseRpp } from "../parser/parse.js";
import { serializeRpp } from "../parser/serialize.js";
import type { RppNode } from "../parser/types.js";
import { captureFxChain } from "../snapshot/capture.js";
import type { FxFingerprint } from "../snapshot/types.js";

/**
 * Parse an .RfxChain file into FX fingerprints.
 *
 * An .RfxChain file uses the same format as the body of an <FXCHAIN> block,
 * without the <FXCHAIN> wrapper. We wrap it in a synthetic FXCHAIN block
 * and parse using the standard parser.
 */
export function parseRfxChain(content: string): FxFingerprint[] {
  // Wrap in a synthetic FXCHAIN block so we can reuse the parser
  const wrapped = `<FXCHAIN\n${content}\n>`;

  // We need to wrap FXCHAIN in a synthetic TRACK so it's inside a REAPER_PROJECT
  const fullRpp = `<REAPER_PROJECT\n<TRACK\n${wrapped}\n>\n>`;
  const root = parseRpp(fullRpp);

  // Navigate: REAPER_PROJECT -> TRACK -> FXCHAIN
  const track = root.children.find(
    (c) => c.kind === "node" && c.token === "TRACK"
  ) as RppNode | undefined;
  if (!track) return [];

  return captureFxChain(track);
}

/**
 * Serialize FX fingerprints to an .RfxChain file format.
 * This is a simplified version — it only stores plugin identity and state,
 * not the full BYPASS/FLOATPOS/FXID/WAK attributes.
 *
 * For full fidelity, use the original .RfxChain file content and only
 * modify the state blobs.
 */
export function serializeRfxChainFromFingerprints(
  fingerprints: FxFingerprint[]
): string {
  const lines: string[] = [];

  for (const fx of fingerprints) {
    // BYPASS line (default: not bypassed)
    lines.push("BYPASS 0 0 0");
    // Plugin block
    lines.push(`<${fx.pluginType} "${fx.pluginName}"`);
    // State blob (indented)
    for (const blobLine of fx.stateBlob.split("\n")) {
      lines.push(`  ${blobLine}`);
    }
    lines.push(">");
    // FLOATPOS, FXID, WAK (defaults)
    lines.push("FLOATPOS 0 0 0 0");
    lines.push("FXID {00000000-0000-0000-0000-000000000000}");
    lines.push("WAK 0 0");
  }

  return lines.join("\n") + "\n";
}

/**
 * Extract the raw FXCHAIN block content from a track's RPP node.
 * This preserves all attributes (BYPASS, FLOATPOS, FXID, WAK) for round-trip fidelity.
 * The result can be written directly as an .RfxChain file.
 */
export function extractRfxChainContent(track: RppNode): string | null {
  const fxChain = track.children.find(
    (c) => c.kind === "node" && c.token === "FXCHAIN"
  ) as RppNode | undefined;

  if (!fxChain) return null;

  // Serialize just the FXCHAIN block, then strip the wrapper
  const serialized = serializeRpp({
    kind: "node",
    token: "REAPER_PROJECT",
    params: [],
    children: [fxChain],
  });

  // Extract content between <FXCHAIN\n and \n>
  const lines = serialized.split("\n");
  const fxChainStartIndex = lines.findIndex((l) => l.trimStart().startsWith("<FXCHAIN"));

  if (fxChainStartIndex === -1) return null;

  // The serializer appends a trailing newline, so the structure is:
  //   [0] <REAPER_PROJECT
  //   [1]   <FXCHAIN
  //   [2..N-4] content (indented 4 spaces)
  //   [N-3]   >          ← FXCHAIN close
  //   [N-2] >            ← REAPER_PROJECT close
  //   [N-1] ""           ← trailing newline
  // We want lines between FXCHAIN open and FXCHAIN close (exclusive of both).
  const fxChainEndIndex = lines.length - 3; // FXCHAIN closing >

  // Get lines between FXCHAIN open and close
  const contentLines = lines.slice(fxChainStartIndex + 1, fxChainEndIndex);
  // Remove the FXCHAIN-level indentation (4 spaces: 2 for REAPER_PROJECT + 2 for FXCHAIN)
  const dedented = contentLines.map((line) => {
    if (line.startsWith("    ")) return line.slice(4);
    return line;
  });

  return dedented.join("\n") + "\n";
}
