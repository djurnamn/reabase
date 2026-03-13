import type { RppNode, RppChild } from "../parser/types.js";
import { getFxChain, getFxPlugins } from "../parser/helpers.js";
import type { FxFingerprint } from "../snapshot/types.js";

/**
 * Apply a resolved FX chain to a track's FXCHAIN block.
 * Replaces all plugin blocks while preserving the FXCHAIN header
 * (SHOW, LASTSEL, DOCKED) and WNDRECT if present.
 *
 * Modifies the track node in-place.
 */
export function applyResolvedChainToTrack(
  track: RppNode,
  resolvedChain: FxFingerprint[]
): void {
  let fxChain = getFxChain(track);

  if (!fxChain && resolvedChain.length === 0) {
    return; // Nothing to do
  }

  if (!fxChain) {
    // Create a new FXCHAIN block
    fxChain = {
      kind: "node",
      token: "FXCHAIN",
      params: [],
      children: [
        { kind: "struct", token: "SHOW", params: [0] },
        { kind: "struct", token: "LASTSEL", params: [0] },
        { kind: "struct", token: "DOCKED", params: [0] },
      ],
    };
    // Insert FXCHAIN before the first ITEM in the track
    const firstItemIndex = track.children.findIndex(
      (c) => c.kind === "node" && c.token === "ITEM"
    );
    if (firstItemIndex >= 0) {
      track.children.splice(firstItemIndex, 0, fxChain);
    } else {
      track.children.push(fxChain);
    }
  }

  // Preserve header children (SHOW, LASTSEL, DOCKED, WNDRECT)
  const headerTokens = new Set(["SHOW", "LASTSEL", "DOCKED", "WNDRECT"]);
  const headerChildren = fxChain.children.filter(
    (child) => child.kind === "struct" && headerTokens.has(child.token)
  );

  // Build new children: header + FX plugin blocks
  const newChildren: RppChild[] = [...headerChildren];

  for (const fx of resolvedChain) {
    // BYPASS (default: not bypassed)
    newChildren.push({
      kind: "struct",
      token: "BYPASS",
      params: [0, 0, 0],
    });

    // Plugin block
    const pluginNode: RppNode = {
      kind: "node",
      token: fx.pluginType,
      params: [fx.pluginName],
      children: [],
    };

    // Add state blob as raw lines
    for (const line of fx.stateBlob.split("\n")) {
      if (line.trim()) {
        pluginNode.children.push({ kind: "raw", content: line });
      }
    }

    newChildren.push(pluginNode);

    // FLOATPOS
    newChildren.push({
      kind: "struct",
      token: "FLOATPOS",
      params: [0, 0, 0, 0],
    });

    // FXID (generate a placeholder — REAPER will assign real ones)
    newChildren.push({
      kind: "struct",
      token: "FXID",
      params: ["{00000000-0000-0000-0000-000000000000}"],
    });

    // WAK
    newChildren.push({
      kind: "struct",
      token: "WAK",
      params: [0, 0],
    });
  }

  fxChain.children = newChildren;
  // Clear raw opening to force re-serialization
  fxChain._rawOpening = undefined;
}

/**
 * Replace a single plugin's state blob in the FXCHAIN without touching
 * BYPASS/FLOATPOS/FXID/WAK of any plugin.
 *
 * @param track - The track node (modified in-place)
 * @param pluginIndex - 0-based index of the plugin to replace
 * @param newStateBlob - The new state blob content
 */
export function replacePluginState(
  track: RppNode,
  pluginIndex: number,
  newStateBlob: string
): void {
  const fxChain = getFxChain(track);
  if (!fxChain) {
    throw new Error("Track has no FXCHAIN");
  }

  const plugins = getFxPlugins(fxChain);
  if (pluginIndex < 0 || pluginIndex >= plugins.length) {
    throw new Error(
      `Plugin index ${pluginIndex} out of range (0..${plugins.length - 1})`
    );
  }

  const plugin = plugins[pluginIndex];

  // Replace children with new state blob lines.
  // Keep _rawOpening intact — we're only changing the state blob,
  // not the plugin's opening line (type, name, AU/VST params).
  plugin.children = newStateBlob
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => ({ kind: "raw" as const, content: line }));
}
