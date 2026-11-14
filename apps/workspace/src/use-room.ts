// The joined room as Preact state: one `RoomClient` per room id, its view, its connection status, and a way to
// listen to the raw events (the stage feeds agent activity to `<wolf-review>` from them).
import type { RoomServerEvent } from "@wolfsdk/protocol/workspace";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { type ConnectionStatus, RoomClient, roomSocketUrl } from "./lib/room-client.ts";
import { applyRoomEvent, EMPTY_VIEW, type RoomView } from "./lib/room-state.ts";

export type RoomHandle = {
  client: RoomClient | null;
  view: RoomView;
  status: ConnectionStatus;
  /** The last `error` event no request claimed. */
  lastError: { code: string; message: string } | null;
  /** Listen to every event of the room; returns the unsubscribe. */
  subscribe(listener: (event: RoomServerEvent) => void): () => void;
};

export function useRoom(token: string | null, roomId: string | null): RoomHandle {
  const [client, setClient] = useState<RoomClient | null>(null);
  const [view, setView] = useState<RoomView>(EMPTY_VIEW);
  const [status, setStatus] = useState<ConnectionStatus>("closed");
  const [lastError, setLastError] = useState<RoomHandle["lastError"]>(null);
  const listeners = useRef(new Set<(event: RoomServerEvent) => void>());

  useEffect(() => {
    setView(EMPTY_VIEW);
    setLastError(null);
    if (token === null || roomId === null) {
      setClient(null);
      setStatus("closed");
      return;
    }
    const next = new RoomClient({
      url: roomSocketUrl(location.origin, token),
      roomId,
      onEvent(event) {
        setView((current) => applyRoomEvent(current, event));
        if ("seq" in event) setLastError(null);
        if (event.type === "error" && event.request_id === null) setLastError({ code: event.code, message: event.message });
        for (const listener of listeners.current) listener(event);
      },
      onStatus: setStatus,
    });
    setClient(next);
    next.connect();
    return () => next.close();
  }, [token, roomId]);

  const subscribe = useCallback((listener: (event: RoomServerEvent) => void): (() => void) => {
    listeners.current.add(listener);
    return () => {
      listeners.current.delete(listener);
    };
  }, []);

  return { client, view, status, lastError, subscribe };
}
