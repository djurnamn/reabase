import useBem from "use-bem";
import "./index.scss";

const VERSION = "1.0.0";

/** The reabase wordmark — "rea" light, "base" bold — with a tiny version. */
export function Brand() {
  const bem = useBem("Brand");
  return (
    <div className={bem()}>
      <span className={bem("wordmark")}>
        <span className={bem("rea")}>rea</span>
        <span className={bem("base")}>base</span>
      </span>
      <span className={bem("version")}>v{VERSION}</span>
    </div>
  );
}
