import type { RppNode, RppStruct, RppValue } from "./types.js";

// ─── Node querying ──────────────────────────────────────────────

/**
 * Find the first child struct with the given token.
 */
export function findStruct(
  node: RppNode,
  token: string
): RppStruct | undefined {
  for (const child of node.children) {
    if (child.kind === "struct" && child.token === token) {
      return child;
    }
  }
  return undefined;
}

/**
 * Find all child structs with the given token.
 */
export function findAllStructs(node: RppNode, token: string): RppStruct[] {
  return node.children.filter(
    (child): child is RppStruct =>
      child.kind === "struct" && child.token === token
  );
}

/**
 * Find the first child node with the given token.
 */
export function findChildNode(
  node: RppNode,
  token: string
): RppNode | undefined {
  for (const child of node.children) {
    if (child.kind === "node" && child.token === token) {
      return child;
    }
  }
  return undefined;
}

/**
 * Find all child nodes with the given token.
 */
export function findAllChildNodes(node: RppNode, token: string): RppNode[] {
  return node.children.filter(
    (child): child is RppNode =>
      child.kind === "node" && child.token === token
  );
}

// ─── Track helpers ──────────────────────────────────────────────

/**
 * Get all top-level TRACK nodes from a project.
 */
export function getTracks(project: RppNode): RppNode[] {
  return findAllChildNodes(project, "TRACK");
}

/**
 * Get a track's name.
 */
export function getTrackName(track: RppNode): string | undefined {
  const nameStruct = findStruct(track, "NAME");
  if (!nameStruct || nameStruct.params.length === 0) return undefined;
  return String(nameStruct.params[0]);
}

/**
 * Get a track's GUID.
 * Checks the TRACK node's opening params first (<TRACK {GUID}>),
 * then falls back to the TRACKID struct inside the track.
 * SWS GetSetObjectState may omit the GUID from the opening line.
 */
export function getTrackGuid(track: RppNode): string | undefined {
  // Try opening params first (RPP file format)
  if (track.params.length > 0) {
    const guid = String(track.params[0]);
    if (guid.startsWith("{") && guid.endsWith("}")) return guid;
  }
  // Fall back to TRACKID struct (SWS chunk format)
  const trackId = findStruct(track, "TRACKID");
  if (trackId && trackId.params.length > 0) {
    const guid = String(trackId.params[0]);
    if (guid.startsWith("{") && guid.endsWith("}")) return guid;
  }
  return undefined;
}

/**
 * Get a track's folder depth (ISBUS).
 * Returns [depth_change, compact] or undefined if not set.
 * - depth_change > 0: opens a folder with that many levels
 * - depth_change = 0: not a folder
 * - depth_change < 0 (ISBUS 2 -N): closes N folder levels
 */
export function getTrackFolderDepth(
  track: RppNode
): { depthChange: number; compact: number } | undefined {
  const isbus = findStruct(track, "ISBUS");
  if (!isbus || isbus.params.length < 2) return undefined;
  const flag = Number(isbus.params[0]);
  const depth = Number(isbus.params[1]);
  if (flag === 1) {
    // Folder open: ISBUS 1 N (N = folder depth, typically 1)
    return { depthChange: depth, compact: 0 };
  } else if (flag === 2) {
    // Folder close: ISBUS 2 -N (closes N levels)
    return { depthChange: depth, compact: 0 };
  }
  // ISBUS 0 0 = regular track
  return { depthChange: 0, compact: 0 };
}

// ─── FX chain helpers ───────────────────────────────────────────

/**
 * Get a track's FX chain node.
 */
export function getFxChain(track: RppNode): RppNode | undefined {
  return findChildNode(track, "FXCHAIN");
}

/** Known FX plugin block tokens */
const FX_PLUGIN_TOKENS = new Set(["AU", "VST", "VST3", "JS", "DX"]);

/**
 * Get all FX plugin nodes from an FX chain.
 * These are <AU>, <VST>, <VST3>, <JS>, or <DX> blocks.
 */
export function getFxPlugins(fxChain: RppNode): RppNode[] {
  return fxChain.children.filter(
    (child): child is RppNode =>
      child.kind === "node" && FX_PLUGIN_TOKENS.has(child.token)
  );
}

/**
 * Get the display name of an FX plugin.
 * For AU plugins: first param is like `"AU: T-De-Esser 2 (Techivation)"`
 */
export function getFxPluginName(plugin: RppNode): string | undefined {
  if (plugin.params.length === 0) return undefined;
  return String(plugin.params[0]);
}

/**
 * Get the FX plugin type (AU, VST, VST3, JS, DX).
 */
export function getFxPluginType(plugin: RppNode): string {
  return plugin.token;
}

/**
 * Get the FXID (GUID) for an FX plugin.
 * This is stored as a FXID struct that follows the plugin block in the FXCHAIN.
 *
 * Because of how RPP structures FX chains, the FXID is a sibling of the plugin
 * block, not a child. We need to find it by looking at the parent FXCHAIN's
 * children, finding the plugin, and getting the next FXID struct after it.
 */
export function getFxId(
  fxChain: RppNode,
  pluginIndex: number
): string | undefined {
  let fxCount = 0;
  for (let i = 0; i < fxChain.children.length; i++) {
    const child = fxChain.children[i];
    if (
      child.kind === "node" &&
      FX_PLUGIN_TOKENS.has(child.token)
    ) {
      if (fxCount === pluginIndex) {
        // Find the FXID after this plugin
        for (let j = i + 1; j < fxChain.children.length; j++) {
          const sibling = fxChain.children[j];
          if (sibling.kind === "struct" && sibling.token === "FXID") {
            return sibling.params.length > 0
              ? String(sibling.params[0])
              : undefined;
          }
          // Stop if we hit another plugin block
          if (
            sibling.kind === "node" &&
            FX_PLUGIN_TOKENS.has(sibling.token)
          ) {
            break;
          }
        }
        return undefined;
      }
      fxCount++;
    }
  }
  return undefined;
}

/**
 * Get the base64 state blob(s) from an FX plugin node.
 * These are the raw string children inside the plugin block.
 */
export function getFxStateBlob(plugin: RppNode): string {
  return plugin.children
    .filter((child) => child.kind === "raw")
    .map((child) => child.content)
    .join("\n");
}

/**
 * Get the BYPASS state for an FX plugin.
 * Returns the BYPASS struct that precedes the plugin in the FXCHAIN,
 * or undefined if not found.
 */
export function getFxBypass(
  fxChain: RppNode,
  pluginIndex: number
): RppStruct | undefined {
  let fxCount = 0;
  for (let i = 0; i < fxChain.children.length; i++) {
    const child = fxChain.children[i];
    if (
      child.kind === "node" &&
      FX_PLUGIN_TOKENS.has(child.token)
    ) {
      if (fxCount === pluginIndex) {
        // Walk backwards to find the preceding BYPASS
        for (let j = i - 1; j >= 0; j--) {
          const sibling = fxChain.children[j];
          if (sibling.kind === "struct" && sibling.token === "BYPASS") {
            return sibling;
          }
          // Stop if we hit another plugin or non-struct
          if (sibling.kind === "node") break;
        }
        return undefined;
      }
      fxCount++;
    }
  }
  return undefined;
}

// ─── Routing helpers ────────────────────────────────────────────

export interface AuxReceive {
  sourceTrackIndex: number;
  mode: number;
  volume: number;
  pan: number;
  muteState: number;
  monoSumming: number;
  phase: number;
  sourceChannel: number;
  destinationChannel: number;
  panLaw: string;
  midiFlags: number;
  automationMode: number;
  /** Raw params for round-trip fidelity */
  rawParams: RppValue[];
}

/**
 * Get all AUXRECV (receive/send) entries from a track.
 */
export function getAuxReceives(track: RppNode): AuxReceive[] {
  return findAllStructs(track, "AUXRECV").map((struct) => ({
    sourceTrackIndex: Number(struct.params[0] ?? 0),
    mode: Number(struct.params[1] ?? 0),
    volume: Number(struct.params[2] ?? 1),
    pan: Number(struct.params[3] ?? 0),
    muteState: Number(struct.params[4] ?? 0),
    monoSumming: Number(struct.params[5] ?? 0),
    phase: Number(struct.params[6] ?? 0),
    sourceChannel: Number(struct.params[7] ?? 0),
    destinationChannel: Number(struct.params[8] ?? 0),
    panLaw: String(struct.params[9] ?? "-1:U"),
    midiFlags: Number(struct.params[10] ?? 0),
    automationMode: Number(struct.params[11] ?? -1),
    rawParams: struct.params,
  }));
}

// ─── P_EXT / Extension state helpers ────────────────────────────

/**
 * Get a P_EXT value from a track's <EXT> block.
 * P_EXT data is stored in REAPER as:
 * <EXT
 *   key value
 * >
 */
export function getExtState(
  node: RppNode,
  key: string
): string | undefined {
  const extBlock = findChildNode(node, "EXT");
  if (!extBlock) return undefined;

  for (const child of extBlock.children) {
    if (child.kind === "struct" && child.token === key) {
      return child.params.length > 0 ? String(child.params[0]) : "";
    }
  }
  return undefined;
}

/**
 * Set a P_EXT value on a node's <EXT> block.
 * Creates the <EXT> block if it doesn't exist.
 */
export function setExtState(
  node: RppNode,
  key: string,
  value: string
): void {
  let extBlock = findChildNode(node, "EXT");

  if (!extBlock) {
    extBlock = {
      kind: "node",
      token: "EXT",
      params: [],
      children: [],
    };
    node.children.push(extBlock);
  }

  // Find existing entry and update, or add new one
  for (const child of extBlock.children) {
    if (child.kind === "struct" && child.token === key) {
      child.params = [value];
      child._raw = undefined; // Force re-serialization
      return;
    }
  }

  extBlock.children.push({
    kind: "struct",
    token: key,
    params: [value],
  });
}
