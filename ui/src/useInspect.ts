import { useCallback, useEffect, useState } from "react";
import { useInvoke, useEvent } from "@djui/reaper-webview";
import type { InspectResult } from "./bridge";

/**
 * Loads the selected track's `inspect` over the bridge and keeps it fresh:
 * fetches on mount, on a manual `refresh()`, and whenever REAPER's track
 * selection changes (the Lua side emits `selection-changed`).
 *
 * Updates are merged into existing state (no remount), so in-flight UI state
 * survives a refresh. (Live in-track change detection — polling the chunk hash
 * in Lua — comes later; see the migration notes.)
 */
export function useInspect() {
  const invoke = useInvoke();
  const [data, setData] = useState<InspectResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const result = await invoke<InspectResult>("inspect");
      setData(result);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [invoke]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // selection-changed = a different track; track-changed = the same track's
  // state changed (param tweak, FX edit). Both re-inspect.
  useEvent("selection-changed", () => void refresh());
  useEvent("track-changed", () => void refresh());

  return { data, error, loading, refresh };
}
