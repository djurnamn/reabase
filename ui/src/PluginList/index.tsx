import useBem from "use-bem";
import { Typography } from "djui";
import type { FxSlot } from "../bridge";
import "./index.scss";

/**
 * Read-only list of FX slots for a tab body. This is a placeholder for the
 * sortable, per-row-action plugin table to come — for now it just surfaces
 * name / type / bypassed so the shell shows real data.
 */
export function PluginList({ slots }: { slots: FxSlot[] }) {
  const bem = useBem("PluginList");

  if (slots.length === 0) {
    return <Typography variant="caption">No plugins.</Typography>;
  }

  return (
    <ul className={bem()}>
      {slots.map((slot) => (
        <li key={slot.slotId} className={bem("row", { bypassed: !!slot.bypassed })}>
          <span className={bem("name")}>
            {slot.displayName || slot.pluginName || slot.slotId}
          </span>
          {slot.pluginType && <span className={bem("type")}>{slot.pluginType}</span>}
          {slot.bypassed && <span className={bem("flag")}>deactivated</span>}
        </li>
      ))}
    </ul>
  );
}
