// `@wolfsdk/mcp`: the compact MCP server of Wolf Workspace. Eight tools (`wolfsdk.mcp-workspace.v1`) over a room
// of `@wolfsdk/server`, served on Streamable HTTP or stdio.
export { engineInspector } from "./inspector.ts";
export { engineRenderer } from "./visual.ts";
export * from "./hooks.ts";
export {
  createMcpHttpHandler,
  prefersEventStream,
  startMcpHttpServer,
  type McpHttpHandler,
  type McpHttpOptions,
  type McpHttpServerOptions,
  type RunningMcpHttpServer,
} from "./http.ts";
export * from "./jsonrpc.ts";
export { blankDocument, readDocument, ReadError, type Block, type CellEntry, type ReadableDocument, type SearchUnit } from "./read/index.ts";
export { errorResult, okResult, type ContentBlock, type ToolErrorCode, type ToolResult } from "./results.ts";
export {
  MCP_LOG_LEVELS,
  MCP_PROTOCOL_VERSIONS,
  MCP_ROOM_LOGGER,
  McpServer,
  McpSession,
  type AttachResult,
  type EventSink,
  type McpLogLevel,
  type McpProtocolVersion,
  type McpServerOptions,
} from "./server.ts";
export { runMcpStdioServer, type McpStdioOptions } from "./stdio.ts";
export { MAX_VISUAL_PAGES, WorkspaceTools, type WorkspaceToolsOptions } from "./tools.ts";
