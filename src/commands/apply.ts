import type { RppNode, RppChild } from "../parser/types.js";
import { getFxChain, getFxPlugins, getFxPluginName, getFxPluginType } from "../parser/helpers.js";
import type { FxFingerprint } from "../snapshot/types.js";

/**
 * Apply a resolved FX chain to a track's FXCHAIN block.
 *
 * Creates plugin blocks structurally (no state blob content).
 * REAPER will create FX with default state — actual parameter state
 * is applied separately by Lua via TrackFX_SetParam.
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
    // Create a new FXCHAIN block and do full replacement
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
    const firstItemIndex = track.children.findIndex(
      (c) => c.kind === "node" && c.token === "ITEM"
    );
    if (firstItemIndex >= 0) {
      track.children.splice(firstItemIndex, 0, fxChain);
    } else {
      track.children.push(fxChain);
    }
    buildFxChainFromScratch(fxChain, resolvedChain);
    return;
  }

  // Full replacement — structural only, params applied by Lua
  buildFxChainFromScratch(fxChain, resolvedChain);
}

/**
 * Replace an FXCHAIN's children with freshly-built plugin blocks.
 * Preserves header structs (SHOW, LASTSEL, DOCKED, WNDRECT).
 * Plugin nodes have no state children — REAPER creates FX with default state,
 * and Lua applies correct params via TrackFX_SetParam afterwards.
 */
function buildFxChainFromScratch(
  fxChain: RppNode,
  resolvedChain: FxFingerprint[]
): void {
  const headerTokens = new Set(["SHOW", "LASTSEL", "DOCKED", "WNDRECT"]);
  const headerChildren = fxChain.children.filter(
    (child) => child.kind === "struct" && headerTokens.has(child.token)
  );

  const newChildren: RppChild[] = [...headerChildren];

  for (const fx of resolvedChain) {
    newChildren.push({
      kind: "struct",
      token: "BYPASS",
      params: [0, 0, 0],
    });

    const pluginNode: RppNode = {
      kind: "node",
      token: fx.pluginType,
      params: [fx.pluginName, ...(fx.pluginParams ?? [])],
      children: [],
    };

    newChildren.push(pluginNode);

    newChildren.push({
      kind: "struct",
      token: "FLOATPOS",
      params: [0, 0, 0, 0],
    });

    newChildren.push({
      kind: "struct",
      token: "FXID",
      params: ["{00000000-0000-0000-0000-000000000000}"],
    });

    newChildren.push({
      kind: "struct",
      token: "WAK",
      params: [0, 0],
    });
  }

  fxChain.children = newChildren;
  fxChain._rawOpening = undefined;
}
