import type { FxFingerprint, ParameterValue } from "../snapshot/types.js";

/**
 * JSON preset format: array of plugin descriptors with parameters.
 */
interface PresetPlugin {
  pluginName: string;
  pluginType: string;
  pluginParams?: (string | number)[];
  slotId: string;
  parameters: Record<string, ParameterValue>;
}

/**
 * Parse a JSON preset file into FX fingerprints.
 */
export function parsePresetFxChain(json: string): FxFingerprint[] {
  const plugins: PresetPlugin[] = JSON.parse(json);
  return plugins.map((p) => ({
    pluginName: p.pluginName,
    pluginType: p.pluginType,
    pluginParams: p.pluginParams,
    slotId: p.slotId,
    parameters: p.parameters ?? {},
    stateHash: "", // Will be computed by caller
  }));
}

/**
 * Serialize FX fingerprints to JSON preset format.
 */
export function serializePresetFxChain(fingerprints: FxFingerprint[]): string {
  const plugins: PresetPlugin[] = fingerprints.map((fx) => ({
    pluginName: fx.pluginName,
    pluginType: fx.pluginType,
    pluginParams: fx.pluginParams,
    slotId: fx.slotId,
    parameters: fx.parameters,
  }));
  return JSON.stringify(plugins, null, 2);
}
