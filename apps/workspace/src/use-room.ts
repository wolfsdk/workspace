// The joined room as Preact state: one `RoomClient` per room id, its view, its connection status, and a way to
// listen to the raw events (the stage feeds agent activity to `<wolf-review>` from them). The assistant rides the
// same socket beside the room: its messages go out through `sendAssistant` and come back to `subscribeAssistant`,
// never into the view.
import type { AssistantClientMessage, RoomServerEvent } from "@wolfsdk/protocol/workspace";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { type ConnectionStatus, RoomClient } from "./lib/room-client.ts";
import { applyRoomEvent, EMPTY_VIEW, type RoomView } from "./lib/room-state.ts";

export type RoomHandle = {
  client: RoomClient | null;
  view: RoomView;
  status: ConnectionStatus;
  /** The last `error` event no request claimed. */
  lastError: { code: string; message: string } | null;
  /** Listen to every event of the room; returns the unsubscribe. */
  subscribe(listener: (event: RoomServerEvent) => void): () => void;
  /** Write one assistant message, with the `request_id` the caller chose, on the room's socket. False, with nothing
   * sent, while there is no room or it is not live. A new value whenever the room changes. */
  sendAssistant(message: AssistantClientMessage): boolean;
  /** Listen to every assistant message of the room's socket, parsed but not yet validated; returns the unsubscribe. */
  subscribeAssistant(listener: (event: unknown) => void): () => void;
};

/** `url` is the room socket of the signed-in page (`socketUrlFor`): with `?token=`, or none behind a hosting front. */
export function useRoom(url: string, roomId: string | null): RoomHandle {
  const [client, setClient] = useState<RoomClient | null>(null);
  const [view, setView] = useState<RoomView>(EMPTY_VIEW);
  const [status, setStatus] = useState<ConnectionStatus>("closed");
  const [lastError, setLastError] = useState<RoomHandle["lastError"]>(null);
  const listeners = useRef(new Set<(event: RoomServerEvent) => void>());
  const assistantListeners = useRef(new Set<(event: unknown) => void>());

  useEffect(() => {
    setView(EMPTY_VIEW);
    setLastError(null);
    if (roomId === null) {
      setClient(null);
      setStatus("closed");
      return;
    }
    const next = new RoomClient({
      url,
      roomId,
      onEvent(event) {
        setView((current) => applyRoomEvent(current, event));
        if ("seq" in event) setLastError(null);
        if (event.type === "error" && event.request_id === null) setLastError({ code: event.code, message: event.message });
        for (const listener of listeners.current) listener(event);
      },
      onAssistant(event) {
        for (const listener of assistantListeners.current) listener(event);
      },
      onStatus: setStatus,
    });
    setClient(next);
    next.connect();
    return () => next.close();
  }, [url, roomId]);

  const subscribe = useCallback((listener: (event: RoomServerEvent) => void): (() => void) => {
    listeners.current.add(listener);
    return () => {
      listeners.current.delete(listener);
    };
  }, []);

  const sendAssistant = useCallback((message: AssistantClientMessage): boolean => client?.sendAssistant(message) ?? false, [client]);

  const subscribeAssistant = useCallback((listener: (event: unknown) => void): (() => void) => {
    assistantListeners.current.add(listener);
    return () => {
      assistantListeners.current.delete(listener);
    };
  }, []);

  return { client, view, status, lastError, subscribe, sendAssistant, subscribeAssistant };
}
