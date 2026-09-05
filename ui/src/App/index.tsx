import { useEffect, useState } from "react";
import useBem from "use-bem";
import { Button, Modal, Select, Spinner, Tabs, Typography } from "djui";
import type { SelectOption, Tab } from "djui";
import { Icon, Menu } from "@djui/lucide";
import { useInvoke, useConfirm, toast } from "@djui/reaper-webview";
import { Brand } from "../Brand";
import { StatusPill } from "../StatusPill";
import { PluginTable } from "../PluginTable";
import { useInspect } from "../useInspect";
import { useStagedEdits, type TableEdits } from "../useStagedEdits";
import {
  deactivatedListForPreset,
  excludedPayload,
  ownershipPayload,
  presetsWithStagedDeactivation,
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
  const confirm = useConfirm();
  const [saving, setSaving] = useState(false);
  // The target preset awaiting a Merge/Replace choice (assign onto a track that
  // already has non-preset plugins).
  const [pendingAssign, setPendingAssign] = useState<string | null>(null);

  // Drop staged edits only when the SELECTED TRACK changes — not on every
  // inspect (the chunk-hash poll re-inspects the same track constantly; clearing
  // on that would wipe pending edits mid-work). Commit clears explicitly.
  useEffect(() => {
    clear();
  }, [data?.trackGuid, clear]);

  async function saveChanges() {
    if (!data) return;
    setSaving(true);
    try {
      if (ownership.size > 0) {
        await invoke("update-presets", ownershipPayload(data, ownership));
      }
      // Composition edits per preset: deactivation is scoped (composed preset
      // and/or individual sources); exclusion is composed-scope only.
      const deactPresets = presetsWithStagedDeactivation(deactivation);
      const compositionPresets = new Set(deactPresets);
      if (exclusion.size > 0 && data.preset) compositionPresets.add(data.preset);
      for (const preset of compositionPresets) {
        const fields: Record<string, unknown> = { presetName: preset };
        if (deactPresets.includes(preset)) {
          fields.deactivated = deactivatedListForPreset(
            data,
            preset,
            ownership,
            deactivation,
          );
        }
        if (preset === data.preset && exclusion.size > 0) {
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

  async function runPresetAction(fn: () => Promise<unknown>) {
    try {
      await fn();
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  // Dropdown change routes to assign / unassign / switch (no-op if unchanged).
  // Confirms before losing uncommitted work; everything is undoable (Cmd-Z).
  async function changePreset(target: string) {
    if (!data) return;
    const current = data.preset ?? "";
    if (target === current) return; // no-op

    const hasUncommitted =
      data.status === "modified" || data.status === "conflict" || count > 0;

    if (target === "") {
      if (hasUncommitted) {
        const ok = await confirm({
          title: "Unassign preset?",
          description:
            "Uncommitted changes to this preset's plugins will be lost. Your other track plugins stay.",
          confirmLabel: "Unassign",
          destructive: true,
        });
        if (!ok) return;
      }
      await runPresetAction(() => invoke("unassign-preset", {}));
    } else if (current !== "") {
      // Switch: keep local additions, drop the old preset (merge mode).
      if (hasUncommitted) {
        const ok = await confirm({
          title: `Switch to "${target}"?`,
          description: `Uncommitted changes to "${current}" will be lost. Your local additions stay.`,
          confirmLabel: "Switch",
          destructive: true,
        });
        if (!ok) return;
      }
      await runPresetAction(() =>
        invoke("assign-preset", { preset: target, mode: "merge" }),
      );
    } else if (data.currentChain.length > 0) {
      // Assign onto a track that already has (non-preset) plugins — ask.
      setPendingAssign(target);
    } else {
      await runPresetAction(() =>
        invoke("assign-preset", { preset: target, mode: "replace" }),
      );
    }
  }

  function resolveAssign(mode: "merge" | "replace" | null) {
    const target = pendingAssign;
    setPendingAssign(null);
    if (!target || !mode) return;
    void runPresetAction(() => invoke("assign-preset", { preset: target, mode }));
  }

  // Revert is IMMEDIATE (mutates the live FX), not staged.
  async function revert(slotId: string) {
    try {
      await invoke("revert-plugin", { slotId });
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  // Reorder persists immediately (composed → update-composition order; source
  // → reorder-preset-plugins). `presetName` is the tab's preset.
  async function persistReorder(
    command: "update-composition" | "reorder-preset-plugins",
    presetName: string,
    order: string[],
  ) {
    try {
      await invoke(command, { presetName, order });
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
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
            size={1}
            value={data?.preset ?? ""}
            options={presetOptions(data)}
            onChange={(e) => void changePreset(e.currentTarget.value)}
          />
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
            tabs={buildTabs(data, edits, revert, persistReorder)}
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

      {pendingAssign && (
        <Modal open onClose={() => setPendingAssign(null)}>
          <div className={bem("assign-dialog")}>
            <Typography variant="heading" tag="h2">
              Assign "{pendingAssign}"
            </Typography>
            <Typography variant="body" tag="p">
              This track already has {data?.currentChain.length} plugin
              {(data?.currentChain.length ?? 0) > 1 ? "s" : ""}. Keep them
              alongside the preset, or replace them? Either way it's undoable
              (Cmd-Z).
            </Typography>
            <div className={bem("assign-actions")}>
              <Button
                label="Cancel"
                variant="soft"
                onClick={() => setPendingAssign(null)}
              />
              <Button
                label="Replace"
                variant="soft"
                color="context-negative"
                onClick={() => resolveAssign("replace")}
              />
              <Button
                label="Keep both"
                variant="solid"
                color="accent-primary"
                onClick={() => resolveAssign("merge")}
              />
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

function presetOptions(data: InspectResult | null): SelectOption[] {
  // Picking "(no preset)" (value "") unassigns. Flat for now — grouping needs
  // <optgroup> (djui gap).
  const options: SelectOption[] = [{ value: "", label: "(no preset)" }];
  if (data) {
    for (const preset of data.presets) {
      options.push({ value: preset.name, label: preset.name });
    }
  }
  return options;
}

function buildTabs(
  data: InspectResult,
  edits: TableEdits,
  onRevert: (slotId: string) => void,
  onReorder: (
    command: "update-composition" | "reorder-preset-plugins",
    presetName: string,
    order: string[],
  ) => void,
): Tab[] {
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
        onRevert={onRevert}
        onReorder={onReorder}
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
          onRevert={onRevert}
          onReorder={onReorder}
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
