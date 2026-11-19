// The two ways the engine can not do what was asked. A refusal is an answer: the worker is healthy and said
// no, in a frame that validates. A fault is a failure of the worker or of the pipe (crash, timeout,
// malformed or invalid frame, a lie the server can check): the worker is discarded and nothing it said is
// trusted.
import type { ReactorPipeCommand } from "@wolfsdk/protocol/workspace";
import type { PlanLimitReason, ReadOnlyMode, ReadOnlyReason, RoomFailure } from "./service.ts";

/** The stable codes of a refusal that a plan caused (`RoomFailure.reason`, and the first word of its message). */
export const PLAN_SEAT_LIMIT: PlanLimitReason = "plan-seat-limit";
export const PLAN_WORKSPACE_LIMIT: PlanLimitReason = "plan-workspace-limit";
/** The stable code of the refusal of a write in a read-only workspace (`RoomFailure.reason`, and the first word of
 * its message). */
export const WORKSPACE_READ_ONLY: ReadOnlyReason = "workspace-read-only";

/** The refusal of a write in a read-only workspace: `LICENSE_LIMIT` on the wire, as a plan limit is, with the stable
 * `reason` and a message that is that code, the reason the workspace is read-only and the way out of it. */
export function readOnlyFailure(mode: ReadOnlyMode): RoomFailure {
  return { code: "LICENSE_LIMIT", message: `${WORKSPACE_READ_ONLY}: ${mode.reason} ${mode.upgrade}`, reason: WORKSPACE_READ_ONLY };
}

const ENGINE_FAILURE_CODES: Readonly<Record<string, true>> = {
  "reactor-document-limit": true,
  "reactor-document-memory-limit": true,
  "reactor-host-memory-limit": true,
  "internal-error": true,
};

export class EngineRefusal extends Error {
  readonly code: string;
  readonly cmd: ReactorPipeCommand | undefined;
  readonly argument: string | undefined;

  constructor(code: string, message: string, cmd?: ReactorPipeCommand, argument?: string) {
    super(`${cmd ?? "request"} refused: ${code}: ${message}`);
    this.name = "EngineRefusal";
    this.code = code;
    this.cmd = cmd;
    this.argument = argument;
  }

  /** A refusal because of the running licence (`license-seat-limit`, `license-workspace-limit`, ...). */
  get isLicense(): boolean {
    return this.code.startsWith("license-");
  }

  /** A refusal that says nothing about the request: a budget was reached (the documents the worker holds, the
   * memory it may use) or the engine reported an internal error. The request was fine and the same request can
   * succeed later. */
  get isEngineFailure(): boolean {
    return Object.hasOwn(ENGINE_FAILURE_CODES, this.code);
  }
}

export class EngineFault extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EngineFault";
  }
}
