/**
 * Worker half of the egress probe (`worker-fetch`). Loaded from its own
 * script URL, so it runs under the policy of its own response
 * (`headersFor("script")`), the way the engine and rival workers do.
 * Receives `{ url }`, tries one fetch, answers a `WorkerProbeReply`.
 */
import { post } from "./post.ts";
import type { Violation, WorkerProbeReply } from "./probe.ts";

const scope = self as unknown as DedicatedWorkerGlobalScope;
const violations: Violation[] = [];
scope.addEventListener("securitypolicyviolation", (raw) => {
  // Fired at worker globals too; the worker lib does not declare it.
  const event = raw as SecurityPolicyViolationEvent;
  violations.push({ directive: event.effectiveDirective, blockedURI: event.blockedURI });
});

scope.onmessage = async (event: MessageEvent<{ url: string }>) => {
  let reply: WorkerProbeReply;
  try {
    await fetch(event.data.url, { mode: "no-cors", cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer" });
    reply = { note: "The request from the worker completed", violations };
  } catch (error) {
    const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    reply =
      error instanceof DOMException && error.name === "SecurityError"
        ? { note: "", refused: `The browser refused it with an error (${text})`, violations }
        : { note: `The request from the worker failed (${text})`, violations };
  }
  // Violation events are dispatched as tasks; give them a moment.
  await new Promise((resolve) => setTimeout(resolve, 200));
  post(scope, reply);
};
