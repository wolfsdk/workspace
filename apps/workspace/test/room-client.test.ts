// The room client lives in `@wolfsdk/runtime/ws-room` (its tests are there); the app's module only re-exports it, so
// the app and a headless page share one implementation.
import { describe, expect, test } from "bun:test";
import * as runtime from "@wolfsdk/runtime/ws-room";
import * as app from "../src/lib/room-client.ts";

describe("the app's room client", () => {
  test("is the runtime package's, not a copy", () => {
    expect(app.RoomClient).toBe(runtime.RoomClient);
    expect(app.RoomRequestError).toBe(runtime.RoomRequestError);
    expect(app.decodeDisplayListSnapshot).toBe(runtime.decodeDisplayListSnapshot);
    expect(app.renderDisplayListSnapshot).toBe(runtime.renderDisplayListSnapshot);
    expect(app.SNAPSHOT_RENDER).toBe(runtime.SNAPSHOT_RENDER);
    expect(Object.keys(app).sort()).toEqual(Object.keys(runtime).sort());
  });
});
