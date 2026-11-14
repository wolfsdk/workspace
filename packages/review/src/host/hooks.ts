import { useEffect, useState } from "preact/hooks";
import type { EditorHost, EditorSnapshot } from "./ui.ts";

/** Re-render on every host publish and return the current snapshot. */
export function useEditor(host: EditorHost): EditorSnapshot {
  const [snapshot, setSnapshot] = useState(host.getSnapshot());
  useEffect(() => {
    // Catch a publish that happened between render and subscribe.
    setSnapshot(host.getSnapshot());
    return host.subscribe(() => setSnapshot(host.getSnapshot()));
  }, [host]);
  return snapshot;
}
