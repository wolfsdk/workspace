// What a tool returns. A tool that works returns its data twice, as `structuredContent` and as the compact JSON
// text of the same value (MCP asks for both, so a client that reads only `content` loses nothing). A tool that
// fails returns `isError: true` and the failure in the same two places: the call itself was well formed, so the
// failure is for the agent to read and act on, not a JSON-RPC error.
import type { RoomErrorCode } from "@wolfsdk/protocol/workspace";

export type TextBlock = { type: "text"; text: string };
export type ImageBlock = { type: "image"; data: string; mimeType: string };
export type ContentBlock = TextBlock | ImageBlock;

export type ToolResult = {
  content: ContentBlock[];
  structuredContent: Record<string, unknown>;
  isError?: true;
};

/** `code` of a failed tool: the codes of the room contract, plus `INTERNAL` for a fault of this server or of a
 * hook that was plugged into it. */
export type ToolErrorCode = RoomErrorCode | "REVISION_MISMATCH" | "INTERNAL";

export function okResult(data: Record<string, unknown>, extra: readonly ContentBlock[] = []): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data) }, ...extra], structuredContent: data };
}

export function errorResult(code: ToolErrorCode, message: string, detail?: unknown): ToolResult {
  const error: { code: ToolErrorCode; message: string; detail?: unknown } = { code, message };
  if (detail !== undefined) error.detail = detail;
  const data = { error };
  return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data, isError: true };
}

export const imageBlock = (png: Uint8Array): ImageBlock => ({ type: "image", data: Buffer.from(png).toString("base64"), mimeType: "image/png" });
