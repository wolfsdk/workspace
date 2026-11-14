import { useEffect, useState } from "preact/hooks";
import type { EditorHost } from "../host/index.ts";
import { reviewStore, type ReviewStore } from "./store.ts";

/** The per-host review store, re-rendering the caller on every change. */
export function useReview(host: EditorHost): ReviewStore {
  const store = reviewStore(host);
  const [, setVersion] = useState(store.version);
  useEffect(() => {
    setVersion(store.version);
    return store.subscribe(() => setVersion(store.version));
  }, [store]);
  return store;
}
