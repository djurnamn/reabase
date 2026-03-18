import type { FxFingerprint } from "../snapshot/types.js";

/**
 * A preset definition as stored in a YAML file.
 * Defines a canonical FX chain that can be assigned to tracks.
 */
export interface PresetDefinition {
  /** Unique name, e.g., "player_voice" */
  name: string;
  /** Optional human-readable description */
  description?: string;
  /** Parent preset name for inheritance, e.g., "player_voice" */
  extends?: string;
  /** Relative path to the .json preset file (from the presets/ directory).
   *  Required when no `extends` is set. Optional when extending a parent. */
  fxChainFile?: string;
  /** Slot ID list — position maps to FX in preset file */
  plugins?: { id: string }[];
  /** Per-slot parameter override (keyed by slot ID) */
  override?: Record<string, { stateFile: string }>;
  /** Slot IDs to remove from parent */
  remove?: string[];
  /** New slots to add (data comes from child's fxChainFile) */
  add?: Array<{ id: string; after?: string }>;
}

/**
 * A fully resolved preset with its inheritance chain applied.
 */
export interface ResolvedPreset {
  /** The preset name */
  name: string;
  /** Full inheritance chain, root-first: ["voice_base", "player_voice", "player_voice_male"] */
  inheritanceChain: string[];
  /** The resolved FX chain after applying all overrides */
  fxChain: FxFingerprint[];
  /** Hash of the resolved FX chain for versioning */
  version: string;
}
