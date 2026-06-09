import useBem from "use-bem";
import { Button, Select, Spinner, Tabs, Typography } from "djui";
import type { SelectOption, Tab } from "djui";
import { Icon, Menu } from "@djui/lucide";
import { Brand } from "../Brand";
import { StatusPill } from "../StatusPill";
import { PluginList } from "../PluginList";
import { useInspect } from "../useInspect";
import type { InspectResult } from "../bridge";
import "./index.scss";

/**
 * First-pass panel shell. Fixed header: a box-layout bar (brand | track+status
 * | menu, each a surface-2 area separated by thin surface-1 gaps) above the
 * preset row (plain surface-1). Below: inverted folder tabs whose panel is the
 * scrollable, full-width, height-filling area that will hold the plugin table
 * and per-tab actions. DISPLAY-ONLY — Select/Assign/⋯/+ are stubs.
 */
export function App() {
  const bem = useBem("App");
  const { data, error, loading, refresh } = useInspect();

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
          {/* TODO: popout menu (about / refresh / options). Refreshes for now. */}
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

      {/* Anchor the body at surface-2 so djui's folder tabs render natively:
          strip = current surface (2), panel = previous surface (1). */}
      <div className={bem("body")} data-djui-set-surface="2">
        {loading && !data && <Spinner />}
        {error && (
          <Typography variant="body" tag="p">
            {error}
          </Typography>
        )}
        {data && (
          <Tabs theme="folder" surfaceDirection="previous" tabs={buildTabs(data)} />
        )}
      </div>
    </div>
  );
}

function presetOptions(data: InspectResult | null): SelectOption[] {
  if (!data) return [];
  // Flat for now. Grouping by category needs <optgroup>, which djui's Select
  // doesn't expose yet — gathered into the djui gaps handoff.
  return data.presets.map((preset) => ({
    value: preset.name,
    label: preset.name,
  }));
}

function buildTabs(data: InspectResult): Tab[] {
  const tabs: Tab[] = [];

  const mainLabel =
    data.preset ?? (data.currentChain.length > 0 ? "Unsaved" : "No preset");
  const mainSlots = data.resolvedChain ?? data.currentChain;
  tabs.push({
    id: "__main__",
    label: mainLabel,
    content: <PluginList slots={mainSlots} />,
  });

  // Composed preset: one tab per source (skip when it's just the container).
  if (data.sources.length > 1) {
    for (const source of data.sources) {
      const slots = (data.resolvedChain ?? []).filter(
        (slot) => slot.origin === source,
      );
      tabs.push({ id: source, label: source, content: <PluginList slots={slots} /> });
    }
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
