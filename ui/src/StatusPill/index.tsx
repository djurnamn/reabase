import useBem from "use-bem";
import type { TrackStatus } from "../bridge";
import "./index.scss";

// Small colored status badge. djui has no Badge/Tag primitive yet — this fills
// that gap minimally (a candidate to upstream into djui later). Colors live in
// index.scss keyed by the status modifier.
const LABELS: Record<NonNullable<TrackStatus> | "unknown", string> = {
  "up-to-date": "Up to date",
  modified: "Modified",
  "upstream-changes": "Upstream changes",
  conflict: "Conflict",
  "no-snapshot": "Not synced",
  "unresolvable-preset": "Unresolvable",
  "no-preset": "No preset",
  unknown: "—",
};

export function StatusPill({ status }: { status: TrackStatus }) {
  const bem = useBem("StatusPill");
  const key = status ?? "unknown";
  return <span className={bem(undefined, key)}>{LABELS[key]}</span>;
}
