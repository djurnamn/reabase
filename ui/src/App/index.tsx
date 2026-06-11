import { useEffect, useState } from "react";
import useBem from "use-bem";
import { Button, Select, Spinner, Tabs, Typography } from "djui";
import type { SelectOption, Tab } from "djui";
import { Icon, Menu } from "@djui/lucide";
import { useInvoke, toast } from "@djui/reaper-webview";
import { Brand } from "../Brand";
import { StatusPill } from "../StatusPill";
import { PluginTable } from "../PluginTable";
import { useInspect } from "../useInspect";
import { useStagedEdits, type TableEdits } from "../useStagedEdits";
import {
  deactivatedPayload,
  excludedPayload,
  ownershipPayload,
} from "../ownership";
import type { InspectResult } from "../bridge";
import "./index.scss";

/**
 * Panel shell: fixed surface-2 header (brand / track / menu, then the preset
 * row) over folder tabs, with a save bar that appears while there are staged
 * (uncommitted) edits — save-when-ready. Ownership (attach/bring-over) commits
 * via update-presets; deactivation commits via update-composition.
 */
export function App() {
  const bem = useBem("App");
  const { data, error, loading, refresh } = useInspect();
  const {
    ownership,
    deactivation,
    exclusion,
    stageOwnership,
    stageDeactivation,
    stageExclusion,
    clear,
    count,
  } = useStagedEdits();
  const invoke = useInvoke();
  const [saving, setSaving] = useState(false);

  // A fresh inspect (track change / commit / manual refresh) is a new baseline
  // — drop any staged edits.
  useEffect(() => {
    clear();
  }, [data, clear]);

  async function saveChanges() {
    if (!data) return;
    setSaving(true);
    try {
      if (ownership.size > 0) {
        await invoke("update-presets", ownershipPayload(data, ownership));
      }
      // deactivation + exclusion are both composition fields on the composed
      // preset — commit them in one update-composition call.
      if ((deactivation.size > 0 || exclusion.size > 0) && data.preset) {
        const fields: Record<string, unknown> = { presetName: data.preset };
        if (deactivation.size > 0) {
          fields.deactivated = deactivatedPayload(data, ownership, deactivation);
        }
        if (exclusion.size > 0) {
          fields.excluded = excludedPayload(data, ownership, exclusion);
        }
        await invoke("update-composition", fields);
      }
      clear();
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  const edits: TableEdits = {
    ownership,
    deactivation,
    exclusion,
    stageOwnership,
    stageDeactivation,
    stageExclusion,
  };

  return (
    <div className={bem()}>
      <header className={bem("header")}>
        <div className={bem("bar")}>
          <div className={bem("area", "brand")}>
            <Brand />
          </div>
          <div className={bem("area", "track")}>
            <span className={bem("track-name")}>
              {data?.trackName
                ? `Selected track: ${data.trackName}`
                : "No track selected"}
            </span>
            {data?.status && <StatusPill status={data.status} />}
          </div>
          {/* TODO: turn into a popout menu (about / refresh / options). */}
          <button
            type="button"
            className={bem("menu")}
            onClick={() => void refresh()}
            aria-label="Menu"
          >
            <Icon icon={Menu} size={0.75} />
          </button>
        </div>

        <div className={bem("preset-row")}>
          <Typography variant="label">preset</Typography>
          <Select
            className={bem("preset-select")}
            placeholder="Select preset"
            value={data?.preset ?? ""}
            options={presetOptions(data)}
            onChange={() => {
              /* TODO: set-preset */
            }}
          />
          <Button label={data?.preset ? "Unassign" : "Assign"} variant="soft" />
          {/* TODO: popout — duplicate, delete. */}
          <Button label="⋯" variant="soft" />
        </div>
      </header>

      <div className={bem("body")} data-djui-set-surface="2">
        {loading && !data && <Spinner />}
        {error && (
          <Typography variant="body" tag="p">
            {error}
          </Typography>
        )}
        {data && (
          <Tabs
            theme="folder"
            surfaceDirection="previous"
            tabs={buildTabs(data, edits)}
          />
        )}
      </div>

      {count > 0 && (
        <div className={bem("footer")}>
          <Typography variant="label">
            {count} pending change{count > 1 ? "s" : ""}
          </Typography>
          <div className={bem("footer-actions")}>
            <Button
              label="Discard"
              variant="soft"
              onClick={clear}
              disabled={saving}
            />
            <Button
              label="Save changes"
              variant="solid"
              color="accent-primary"
              onClick={() => void saveChanges()}
              disabled={saving}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function presetOptions(data: InspectResult | null): SelectOption[] {
  if (!data) return [];
  // Flat for now — grouping needs <optgroup> (djui gap).
  return data.presets.map((preset) => ({
    value: preset.name,
    label: preset.name,
  }));
}

function buildTabs(data: InspectResult, edits: TableEdits): Tab[] {
  const tabs: Tab[] = [];

  // Tab 1 IS the assigned preset's own container (its checkbox = "owned by the
  // composed preset itself"); it shows the whole composed chain. null only when
  // the track has no preset.
  const mainLabel =
    data.preset ?? (data.currentChain.length > 0 ? "Unsaved" : "No preset");
  tabs.push({
    id: "__main__",
    label: mainLabel,
    content: (
      <PluginTable
        data={data}
        ownerSource={data.preset ?? null}
        composedView
        edits={edits}
      />
    ),
  });

  // One tab per imported source (the container is already tab 1).
  for (const source of data.sources) {
    const sourceName = source.name;
    if (sourceName === data.preset) continue;
    tabs.push({
      id: sourceName,
      label: sourceName,
      content: (
        <PluginTable
          data={data}
          ownerSource={sourceName}
          composedView={false}
          edits={edits}
        />
      ),
    });
  }

  // The "+" tab (add a source) only appears once a preset is assigned.
  if (data.preset) {
    tabs.push({
      id: "__add__",
      label: "+",
      content: (
        <Typography variant="caption">
          Add a source — create a new preset or import an existing one. (TODO)
        </Typography>
      ),
    });
  }

  return tabs;
}
