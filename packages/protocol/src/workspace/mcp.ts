// The compact MCP server of Wolf Workspace (`wolfsdk.mcp-workspace.v1`, Streamable HTTP): eight tools, small
// enough that an agent pays under 3500 tokens for the tool list. The schema file is the single source of the
// descriptors; this module reads them, measures them and validates a `tools/call` against them. Nothing here
// touches the DOM, Preact or a kernel.
import { validateSchema, type Schema } from "../session/record.ts";
import mcpSchema from "../../schemas/mcp-workspace.v1.schema.json" with { type: "json" };

export const MCP_WORKSPACE_CONTRACT = "wolfsdk.mcp-workspace.v1";
export const MCP_WORKSPACE_SCHEMA: Schema = mcpSchema;

export const MCP_WORKSPACE_TOOL_NAMES = [
  "workspace_list",
  "doc_read",
  "doc_search",
  "doc_create",
  "doc_edit",
  "doc_inspect_visual",
  "pack_link_refresh",
  "comment_reply",
] as const;
export type McpWorkspaceToolName = (typeof MCP_WORKSPACE_TOOL_NAMES)[number];

/** A tool as `tools/list` returns it. `inputSchema` is self-contained JSON Schema (no `$ref`). */
export type McpToolDescriptor = { name: McpWorkspaceToolName; description: string; inputSchema: Schema };

/** The eight tools, in the order `tools/list` returns them. The test suite pins each name and shape. */
export const MCP_WORKSPACE_TOOLS: readonly McpToolDescriptor[] = mcpSchema["x-wolfsdk-tools"] as unknown as McpToolDescriptor[];

/** The tool list, serialized, stays under this many UTF-8 bytes ... */
export const MCP_WORKSPACE_TOOLS_MAX_BYTES = 14_000;
/** ... which is under this many tokens, at four bytes to a token. */
export const MCP_WORKSPACE_TOOLS_MAX_TOKENS = 3_500;

/** UTF-8 length of the compact JSON of `tools`. */
export function mcpToolsBytes(tools: readonly McpToolDescriptor[] = MCP_WORKSPACE_TOOLS): number {
  return new TextEncoder().encode(JSON.stringify(tools)).length;
}

/** Tokens an agent pays for `tools`: UTF-8 bytes of the compact JSON over four, rounded up. */
export function mcpToolsTokenEstimate(tools: readonly McpToolDescriptor[] = MCP_WORKSPACE_TOOLS): number {
  return Math.ceil(mcpToolsBytes(tools) / 4);
}

/** The arguments of each tool, as `tools/call` passes them. */
export type McpWorkspaceCall =
  | { name: "workspace_list"; arguments: { format?: "docx" | "xlsx" | "pptx" | "pdf"; limit?: number } }
  | {
      name: "doc_read";
      arguments: { doc: string; view?: "structure" | "text" | "markdown" | "cells"; target?: string; max_nodes?: number };
    }
  | { name: "doc_search"; arguments: { query: string; doc?: string; regex?: boolean; limit?: number } }
  | {
      name: "doc_create";
      arguments: { name: string; format: "docx" | "xlsx" | "pptx"; template?: string; ops?: { op: string; [member: string]: unknown }[] };
    }
  | {
      name: "doc_edit";
      arguments: {
        doc: string;
        base_revision: number;
        mode: "propose" | "commit";
        ops: { op: string; [member: string]: unknown }[];
        message?: string;
      };
    }
  | {
      name: "doc_inspect_visual";
      arguments: { doc: string; pages?: number[]; dpi?: 72 | 96 | 150; preflight?: boolean; proposal_id?: string };
    }
  | { name: "pack_link_refresh"; arguments: { pack: string; bindings?: string[]; mode?: "propose" | "commit" } }
  | { name: "comment_reply"; arguments: { thread_id: string; body: string; resolve?: boolean } };

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** The evaluator behind `validateSchema` does not read `minItems`; the tool schemas use it for the arrays that
 * must not be empty, so this pass reads it off the same schema. */
function minItems(schema: Schema, value: unknown, path: string, out: string[]): void {
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) out.push(`${path}: fewer than ${schema.minItems} items`);
    return;
  }
  if (isObject(value) && schema.properties)
    for (const [k, sub] of Object.entries(schema.properties)) if (k in value) minItems(sub, value[k], `${path}.${k}`, out);
}

const toolOf = (name: unknown): McpToolDescriptor | undefined =>
  typeof name === "string" ? MCP_WORKSPACE_TOOLS.find((t) => t.name === name) : undefined;

/** Problems of a `tools/call` of this server, `{name, arguments}` (empty when valid): the name is one of the
 * eight tools, the arguments satisfy its `inputSchema`, and the arguments agree with themselves (a regular
 * expression search has a valid expression, no binding is named twice). */
export function validateMcpToolCall(call: unknown): string[] {
  const out = validateSchema(MCP_WORKSPACE_SCHEMA, call);
  const tool = isObject(call) ? toolOf(call.name) : undefined;
  if (out.length || !tool || !isObject(call)) return out;

  const args = call.arguments;
  const problems = validateSchema(tool.inputSchema, args);
  if (isObject(args) && tool.inputSchema.additionalProperties === false) {
    for (const name of Object.keys(args)) {
      if (Object.hasOwn(tool.inputSchema.properties ?? {}, name)) continue;
      const problem = `$: unexpected ${name}`;
      if (!problems.includes(problem)) problems.push(problem);
    }
  }
  out.push(...problems.map((problem) => {
    const path = problem.replace(/^\$/, "$.arguments");
    return problem.startsWith("$: unexpected ")
      ? `${path}. Defined arguments for ${tool.name}: ${Object.keys(tool.inputSchema.properties ?? {}).join(", ")}.`
      : path;
  }));
  minItems(tool.inputSchema, args, "$.arguments", out);
  if (out.length || !isObject(args)) return out;

  if (tool.name === "doc_search" && args.regex === true) {
    try {
      new RegExp(args.query as string, "u");
    } catch {
      out.push("$.arguments.query: is not a valid regular expression");
    }
  }
  if (tool.name === "pack_link_refresh" && Array.isArray(args.bindings)) {
    const ids = args.bindings as string[];
    const duplicate = ids.find((id, i) => ids.indexOf(id) !== i);
    if (duplicate !== undefined) out.push(`$.arguments.bindings: ${JSON.stringify(duplicate)} is named twice`);
  }
  return out;
}
