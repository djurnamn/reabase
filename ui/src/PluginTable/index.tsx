import { useEffect, useMemo, useState, type CSSProperties } from "react";
import useBem from "use-bem";
import { Checkbox, Typography } from "djui";
import { Icon, GripVertical, Power, X } from "@djui/lucide";
import { useConfirm } from "@djui/reaper-webview";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { InspectResult } from "../bridge";
import {
  accentForOwner,
  buildRows,
  deactivationKey,
  effectiveDeactivatedFor,
  effectiveExcluded,
  importSources,
  inspectDeactivatedFor,
  inspectOwner,
  type OwnershipRow,
} from "../ownership";
import type { TableEdits } from "../useStagedEdits";
import "./index.scss";

/**
 * The plugin tab body. Checkbox = attachment; the power toggle = deactivate
 * (bypassed but kept in the chain); the X = exclude (removed from the chain,
 * grayed-in-place — composed view only, where exclusion is scoped). All edits
 * are staged; reorder is still LOCAL only.
 */
export function PluginTable({
  data,
  ownerSource,
  composedView,
  edits,
}: {
  data: InspectResult;
  ownerSource: string | null;
  composedView: boolean;
  edits: TableEdits;
}) {
  const bem = useBem("PluginTable");
  const [showOthers, setShowOthers] = useState(false);
  const [hideExcluded, setHideExcluded] = useState(false);
  const sources = useMemo(() => importSources(data), [data]);

  const rows = useMemo(() => {
    const built = buildRows(data, ownerSource, composedView, edits.ownership, showOthers);
    if (composedView && hideExcluded) {
      return built.filter(
        (r) =>
          !(
            r.excludedBaseline &&
            effectiveExcluded(r.slot.slotId, r.excludedBaseline, edits.exclusion)
          ),
      );
    }
    return built;
  }, [data, ownerSource, composedView, edits.ownership, edits.exclusion, showOthers, hideExcluded]);

  const [items, setItems] = useState<OwnershipRow[]>(rows);
  useEffect(() => setItems(rows), [rows]);

  const hasExcluded =
    (data.excludedChain?.length ?? 0) > 0 || edits.exclusion.size > 0;

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    setItems((prev) => {
      const from = prev.findIndex((r) => r.slot.slotId === active.id);
      const to = prev.findIndex((r) => r.slot.slotId === over.id);
      if (from === -1 || to === -1) return prev;
      return arrayMove(prev, from, to);
    });
    // TODO (next): persist — composed view → composed `order`; import tab →
    // that preset's internal order (see HANDOFF-PRESET-INTERNAL-ORDER.md).
  }

  return (
    <div className={bem()}>
      {composedView
        ? hasExcluded && (
            <div className={bem("toolbar")}>
              <Checkbox
                inlineLabel="Hide excluded"
                checked={hideExcluded}
                onChange={setHideExcluded}
              />
            </div>
          )
        : (
            <div className={bem("toolbar")}>
              <Checkbox
                inlineLabel="Show plugins from other presets"
                checked={showOthers}
                onChange={setShowOthers}
              />
            </div>
          )}

      {items.length === 0 ? (
        <Typography variant="caption">No plugins.</Typography>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={items.map((r) => r.slot.slotId)}
            strategy={verticalListSortingStrategy}
          >
            <ul className={bem("list")}>
              {items.map((row) => (
                <PluginRow
                  key={row.slot.slotId}
                  row={row}
                  data={data}
                  ownerSource={ownerSource}
                  composedView={composedView}
                  sources={sources}
                  edits={edits}
                />
              ))}
            </ul>
          </SortableContext>
        </DndContext>
      )}
    </div>
  );
}

function PluginRow({
  row,
  data,
  ownerSource,
  composedView,
  sources,
  edits,
}: {
  row: OwnershipRow;
  data: InspectResult;
  ownerSource: string | null;
  composedView: boolean;
  sources: string[];
  edits: TableEdits;
}) {
  const bem = useBem("PluginTable");
  const confirm = useConfirm();
  const { slot, owner, excludedBaseline } = row;

  // Checked = attached to a preset (owned by ANY source). Full if owned by this
  // tab's source, grayed if another (click = bring over), unchecked if loose.
  const here = ownerSource != null && owner === ownerSource;
  const isOther = owner != null && owner !== ownerSource;
  const checked = owner != null;
  // Deactivate is scoped to the tab's preset (composed preset, or this source).
  const deactivated =
    ownerSource != null &&
    effectiveDeactivatedFor(data, slot, ownerSource, edits.deactivation);
  const excluded = effectiveExcluded(slot.slotId, excludedBaseline, edits.exclusion);
  const powerAccent = composedView ? undefined : accentForOwner(owner, sources);
  // Shown for any owned slot in the composed view, but only this source's own
  // plugins in a source tab (a source's `deactivated` covers only its own).
  const showDeactivate =
    ownerSource != null && (composedView ? owner != null : here);
  const modified =
    edits.ownership.has(slot.slotId) ||
    (ownerSource != null &&
      edits.deactivation.has(deactivationKey(ownerSource, slot.slotId))) ||
    edits.exclusion.has(slot.slotId);

  // Composed view sorts the whole chain; import tabs only sort their own.
  const draggable = composedView || here;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: slot.slotId, disabled: !draggable });

  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
  };
  const name = slot.displayName || slot.pluginName || slot.slotId;

  async function handleToggle(nextChecked: boolean) {
    if (!ownerSource) return;
    const original = inspectOwner(slot);
    if (here) {
      if (!nextChecked) edits.stageOwnership(slot.slotId, null, original); // detach
    } else if (isOther) {
      const ok = await confirm({
        title: `Move "${name}" to "${ownerSource}"?`,
        description: `It leaves "${owner}". Both presets show as modified until you save.`,
        confirmLabel: "Move",
      });
      if (ok) edits.stageOwnership(slot.slotId, ownerSource, original);
    } else if (owner == null && nextChecked) {
      edits.stageOwnership(slot.slotId, ownerSource, original); // attach loose
    }
  }

  return (
    <li
      ref={setNodeRef}
      style={style}
      className={bem("row", {
        deactivated,
        excluded,
        muted: isOther,
        modified,
        dragging: isDragging,
      })}
    >
      {draggable ? (
        <button
          type="button"
          className={bem("handle")}
          aria-label="Drag to reorder"
          {...attributes}
          {...listeners}
        >
          <Icon icon={GripVertical} size={0.7} />
        </button>
      ) : (
        <span className={bem("handle", "placeholder")} aria-hidden />
      )}

      <Checkbox
        checked={checked}
        color={accentForOwner(owner, sources)}
        disabled={ownerSource == null}
        onChange={(next) => void handleToggle(next)}
      />

      <span className={bem("name")}>{name}</span>
      {modified && (
        <span className={bem("modified-dot")} title="Modified — save to commit" />
      )}
      {slot.pluginType && <span className={bem("type")}>{slot.pluginType}</span>}

      {showDeactivate && ownerSource != null && (
        <button
          type="button"
          className={bem("deactivate", { off: deactivated })}
          style={
            !deactivated && powerAccent
              ? { color: `rgb(var(--djui-${powerAccent}-rgb))` }
              : undefined
          }
          aria-label={deactivated ? "Reactivate" : "Deactivate"}
          aria-pressed={deactivated}
          title={deactivated ? "Deactivated (bypassed)" : "Deactivate"}
          onClick={() =>
            edits.stageDeactivation(
              ownerSource,
              slot.slotId,
              !deactivated,
              inspectDeactivatedFor(data, slot, ownerSource),
            )
          }
        >
          <Icon icon={Power} size={0.65} />
        </button>
      )}

      {/* Exclude = removed from the chain, grayed-in-place. Composed view only
          (exclusion is composed-scope). */}
      {composedView && owner != null && (
        <button
          type="button"
          className={bem("exclude", { on: excluded })}
          aria-label={excluded ? "Re-include" : "Exclude"}
          aria-pressed={excluded}
          title={excluded ? "Excluded (re-include)" : "Exclude"}
          onClick={() =>
            edits.stageExclusion(slot.slotId, !excluded, excludedBaseline)
          }
        >
          <Icon icon={X} size={0.7} />
        </button>
      )}
    </li>
  );
}
