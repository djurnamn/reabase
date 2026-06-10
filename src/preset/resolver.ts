import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ExcludedSlot, LoadedPreset, ResolvedPreset } from "./types.js";
import type { FxFingerprint } from "../snapshot/types.js";
import { parsePresetFxChain } from "./rfxchain.js";
import { hashParameters } from "../snapshot/capture.js";
import { assignSlotIds } from "../slot/identity.js";

/**
 * Resolve a composed preset to a flat FX chain.
 *
 * Algorithm:
 *   1. Gather sources: the container's own plugins (when it has any) plus
 *      each entry in `imports`. Each source contributes a list of
 *      FxFingerprints with stable slotIds. Imported presets are loaded as
 *      plain presets — nesting is forbidden, and the loader enforces that.
 *   2. Reject same-slot-ID across sources. Naming discipline keeps slots
 *      unique; if two sources collide, fix it by renaming one.
 *   3. Build a lookup keyed by source then original slotId, each entry an
 *      FxFingerprint with `origin` and `displayName` populated.
 *   4. Walk `order` (or a default order) to build the visual chain. For
 *      each entry: if in `excluded`, skip into the excluded-list; if in
 *      `deactivated`, set `bypassed: true` on the fingerprint; otherwise
 *      include as-is. Default order is each source's internal order, in
 *      source-list order.
 *   5. Drift: any surviving slot from a source that wasn't in `order` and
 *      isn't excluded gets appended at the end. The status pipeline
 *      detects this as `upstream-changes`.
 *   6. Validate: every entry in `deactivated` and `excluded` must reference
 *      a real slot. Any leftover entries error out.
 *   7. Compute a version hash over the resolved fxChain (excluded slots
 *      omitted).
 */
export function resolvePreset(
  name: string,
  presets: Map<string, LoadedPreset>
): ResolvedPreset {
  const definition = presets.get(name);
  if (!definition) {
    throw new Error(`Preset '${name}' not found`);
  }

  const sourcesList = gatherSources(definition, presets);
  const sources = sourcesList.map((s) => s.source);

  rejectCrossSourceCollisions(name, sourcesList);

  const lookupBySource = buildLookup(sourcesList);

  const excludedSet = new Set(definition.excluded ?? []);
  const deactivatedSet = new Set(definition.deactivated ?? []);

  const { fxChain, excludedChain, mentionedEntries } =
    definition.order && definition.order.length > 0
      ? buildOrderedChain(definition, sourcesList, lookupBySource, excludedSet, deactivatedSet)
      : buildDefaultOrderChain(sourcesList, lookupBySource, excludedSet, deactivatedSet);

  // Drift: append any surviving slots not mentioned in `order`. This kicks
  // in when an import gains a plugin since the user last edited the composed
  // preset. A drifted slot that's also excluded lands in the excluded chain
  // at the end (after every resolved slot) rather than the resolved chain.
  for (const sp of sourcesList) {
    const inner = lookupBySource.get(sp.source)!;
    for (const sourceFp of sp.fxChain) {
      const entry = `${sp.source}/${sourceFp.slotId}`;
      if (mentionedEntries.has(entry)) continue;
      const fp = inner.get(sourceFp.slotId)!;
      mentionedEntries.add(entry);
      if (excludedSet.has(entry)) {
        excludedChain.push({ fingerprint: fp, position: fxChain.length });
        continue;
      }
      fxChain.push(deactivatedSet.has(entry) ? { ...fp, bypassed: true } : fp);
    }
  }

  validateRefList(name, definition.deactivated, "deactivated", lookupBySource, sources);
  validateRefList(name, definition.excluded, "excluded", lookupBySource, sources);

  const versionInput = fxChain
    .map((fx) => `${fx.pluginType}::${fx.pluginName}::${fx.stateHash}::${fx.bypassed ? "bypass" : "active"}`)
    .join("|");
  const version = createHash("sha256")
    .update(versionInput)
    .digest("hex")
    .slice(0, 12);

  return {
    name,
    sources,
    fxChain,
    excluded: definition.excluded ? [...definition.excluded] : [],
    excludedChain,
    version,
  };
}

interface SourcePlugins {
  source: string;
  fxChain: FxFingerprint[];
}

function gatherSources(
  definition: LoadedPreset,
  presets: Map<string, LoadedPreset>
): SourcePlugins[] {
  const sourcesList: SourcePlugins[] = [];

  if (definition.fxChainFile) {
    sourcesList.push({
      source: definition.name,
      fxChain: loadOwnPlugins(definition),
    });
  }

  if (definition.imports) {
    for (const importName of definition.imports) {
      const importedDef = presets.get(importName);
      if (!importedDef) {
        throw new Error(
          `Preset '${definition.name}' imports '${importName}' which does not exist`
        );
      }
      const fxChain = importedDef.fxChainFile
        ? loadOwnPlugins(importedDef)
        : [];
      sourcesList.push({ source: importName, fxChain });
    }
  }

  return sourcesList;
}

function rejectCrossSourceCollisions(
  presetName: string,
  sourcesList: SourcePlugins[]
): void {
  const slotIdToFirstSource = new Map<string, string>();
  for (const sp of sourcesList) {
    for (const fp of sp.fxChain) {
      const previous = slotIdToFirstSource.get(fp.slotId);
      if (previous && previous !== sp.source) {
        throw new Error(
          `Preset '${presetName}': slot '${fp.slotId}' is defined in both ` +
            `'${previous}' and '${sp.source}'. Slot IDs must be unique across all ` +
            `sources — rename one of them.`
        );
      }
      slotIdToFirstSource.set(fp.slotId, sp.source);
    }
  }
}

function buildLookup(
  sourcesList: SourcePlugins[]
): Map<string, Map<string, FxFingerprint>> {
  const lookup = new Map<string, Map<string, FxFingerprint>>();
  for (const sp of sourcesList) {
    const inner = new Map<string, FxFingerprint>();
    for (const fp of sp.fxChain) {
      inner.set(fp.slotId, { ...fp, origin: sp.source });
    }
    lookup.set(sp.source, inner);
  }
  return lookup;
}

interface ChainBuildResult {
  fxChain: FxFingerprint[];
  /** Excluded slots collected during the walk, each with the insert-index
   *  position they'd occupy in `fxChain` (= number of resolved slots before
   *  them). Surfaced so the UI can render them grayed-in-place. */
  excludedChain: ExcludedSlot[];
  /** "<source>/<slotId>" entries the chain build has already emitted or
   *  consumed (excluded entries count as consumed). Used to detect drift. */
  mentionedEntries: Set<string>;
}

function buildOrderedChain(
  definition: LoadedPreset,
  sourcesList: SourcePlugins[],
  lookupBySource: Map<string, Map<string, FxFingerprint>>,
  excludedSet: Set<string>,
  deactivatedSet: Set<string>
): ChainBuildResult {
  const fxChain: FxFingerprint[] = [];
  const excludedChain: ExcludedSlot[] = [];
  const mentionedEntries = new Set<string>();

  for (const entry of definition.order!) {
    const slashIndex = entry.indexOf("/");
    const sourceName = entry.slice(0, slashIndex);
    const slotId = entry.slice(slashIndex + 1);

    const sourceLookup = lookupBySource.get(sourceName);
    if (!sourceLookup) {
      const known = sourcesList.map((s) => s.source).join(", ");
      throw new Error(
        `Preset '${definition.name}': order entry '${entry}' references unknown source '${sourceName}'. ` +
          `Available sources: [${known}].`
      );
    }
    const fp = sourceLookup.get(slotId);
    if (!fp) {
      throw new Error(
        `Preset '${definition.name}': order entry '${entry}' references slot '${slotId}' ` +
          `which does not exist in source '${sourceName}'.`
      );
    }

    mentionedEntries.add(entry);
    if (excludedSet.has(entry)) {
      // Excluded slots are kept in `order` for visual position but are
      // filtered out of the resolved (= apply target) chain. Record the
      // slot with its insert-index so the UI can render it grayed-in-place.
      // `fxChain.length` here is exactly the count of resolved slots before
      // it. Exclusion supersedes deactivation, so don't tag bypassed.
      excludedChain.push({ fingerprint: fp, position: fxChain.length });
      continue;
    }

    fxChain.push(deactivatedSet.has(entry) ? { ...fp, bypassed: true } : fp);
  }

  return { fxChain, excludedChain, mentionedEntries };
}

function buildDefaultOrderChain(
  sourcesList: SourcePlugins[],
  lookupBySource: Map<string, Map<string, FxFingerprint>>,
  excludedSet: Set<string>,
  deactivatedSet: Set<string>
): ChainBuildResult {
  const fxChain: FxFingerprint[] = [];
  const excludedChain: ExcludedSlot[] = [];
  const mentionedEntries = new Set<string>();

  for (const sp of sourcesList) {
    const inner = lookupBySource.get(sp.source)!;
    for (const sourceFp of sp.fxChain) {
      const entry = `${sp.source}/${sourceFp.slotId}`;
      mentionedEntries.add(entry);
      const fp = inner.get(sourceFp.slotId)!;
      if (excludedSet.has(entry)) {
        excludedChain.push({ fingerprint: fp, position: fxChain.length });
        continue;
      }
      fxChain.push(deactivatedSet.has(entry) ? { ...fp, bypassed: true } : fp);
    }
  }

  return { fxChain, excludedChain, mentionedEntries };
}

function validateRefList(
  presetName: string,
  list: string[] | undefined,
  fieldName: "deactivated" | "excluded",
  lookupBySource: Map<string, Map<string, FxFingerprint>>,
  sources: string[]
): void {
  if (!list || list.length === 0) return;
  for (const entry of list) {
    const slashIndex = entry.indexOf("/");
    const sourceName = entry.slice(0, slashIndex);
    const slotId = entry.slice(slashIndex + 1);
    const sourceLookup = lookupBySource.get(sourceName);
    if (!sourceLookup) {
      throw new Error(
        `Preset '${presetName}': '${fieldName}' entry '${entry}' references unknown source '${sourceName}'. ` +
          `Available sources: [${sources.join(", ")}].`
      );
    }
    if (!sourceLookup.has(slotId)) {
      throw new Error(
        `Preset '${presetName}': '${fieldName}' entry '${entry}' references slot '${slotId}' ` +
          `which does not exist in source '${sourceName}'.`
      );
    }
  }
}

function loadOwnPlugins(definition: LoadedPreset): FxFingerprint[] {
  if (!definition.fxChainFile) return [];

  // `fxChainFile` is relative to the YAML's own folder, so co-located
  // assets travel with the preset when a folder is moved.
  const presetPath = resolve(definition._sourceDir, definition.fxChainFile);
  const presetContent = readFileSync(presetPath, "utf-8");
  let chain = parsePresetFxChain(presetContent).map((fx) => ({
    ...fx,
    stateHash: hashParameters(fx.parameters),
  }));

  if (definition.plugins) {
    chain = chain.map((fx, i) => {
      const entry = definition.plugins![i];
      if (!entry) return fx;
      return {
        ...fx,
        slotId: entry.id,
        ...(entry.label !== undefined ? { displayName: entry.label } : {}),
      };
    });
  } else {
    chain = assignSlotIds(chain);
  }

  return chain;
}
