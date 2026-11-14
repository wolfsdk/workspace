// JSON-RPC 2.0 as MCP uses it: the message shapes, the error codes and the checks that tell a request from a
// notification and a response. Nothing here knows a tool or a transport.
export type JsonRpcId = string | number;
export type JsonRpcParams = Record<string, unknown>;

export type JsonRpcRequest = { jsonrpc: "2.0"; id: JsonRpcId; method: string; params?: JsonRpcParams };
export type JsonRpcNotification = { jsonrpc: "2.0"; method: string; params?: JsonRpcParams };
export type JsonRpcError = { code: number; message: string; data?: unknown };
export type JsonRpcResponse =
  | { jsonrpc: "2.0"; id: JsonRpcId; result: unknown }
  | { jsonrpc: "2.0"; id: JsonRpcId | null; error: JsonRpcError };

export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;

/** A failure to report as the JSON-RPC `error` of the request being handled. */
export class RpcError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "RpcError";
    this.code = code;
    this.data = data;
  }
}

export const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isId = (value: unknown): value is JsonRpcId => typeof value === "string" || (typeof value === "number" && Number.isFinite(value));

export type Classified =
  | { kind: "request"; message: JsonRpcRequest }
  | { kind: "notification"; message: JsonRpcNotification }
  | { kind: "response" }
  | { kind: "invalid"; id: JsonRpcId | null; reason: string };

/** What a decoded JSON value is as a JSON-RPC message. A response (a `result` or an `error` with an id) is the
 * answer to something this server never asked, so it is only recognised, never handled. */
export function classify(value: unknown): Classified {
  if (!isObject(value)) return { kind: "invalid", id: null, reason: "a JSON-RPC message is an object" };
  const id = isId(value.id) ? value.id : null;
  if (value.jsonrpc !== "2.0") return { kind: "invalid", id, reason: 'jsonrpc must be "2.0"' };
  if (typeof value.method !== "string") {
    if (("result" in value || "error" in value) && isId(value.id)) return { kind: "response" };
    return { kind: "invalid", id, reason: "a request has a string method" };
  }
  const params = value.params;
  if (params !== undefined && !isObject(params)) return { kind: "invalid", id, reason: "params must be an object" };
  if (!("id" in value)) {
    const message: JsonRpcNotification = { jsonrpc: "2.0", method: value.method };
    if (params !== undefined) message.params = params;
    return { kind: "notification", message };
  }
  if (!isId(value.id)) return { kind: "invalid", id: null, reason: "id must be a string or a number" };
  const message: JsonRpcRequest = { jsonrpc: "2.0", id: value.id, method: value.method };
  if (params !== undefined) message.params = params;
  return { kind: "request", message };
}

export const rpcResult = (id: JsonRpcId, result: unknown): JsonRpcResponse => ({ jsonrpc: "2.0", id, result });

export function rpcError(id: JsonRpcId | null, code: number, message: string, data?: unknown): JsonRpcResponse {
  const error: JsonRpcError = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: "2.0", id, error };
}

export const notification = (method: string, params?: JsonRpcParams): JsonRpcNotification =>
  params === undefined ? { jsonrpc: "2.0", method } : { jsonrpc: "2.0", method, params };
