import type { LabBus, LabEvent } from "./types.ts";

/** Synchronous fan-out. A listener that throws does not stop the others. */
export function createLabBus(): LabBus {
  const listeners = new Set<(event: LabEvent) => void>();
  return {
    emit(event) {
      for (const listener of [...listeners]) {
        try {
          listener(event);
        } catch (error) {
          console.error("lab bus listener failed", error);
        }
      }
    },
    on(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
