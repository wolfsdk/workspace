import { WolfReviewElement } from "./element.tsx";

export { WolfReviewElement };
export { KernelRequestError } from "@wolfsdk/protocol/contract";
export {
  DEFAULT_ENGINE_CHANNEL,
  ENGINE_FORMATS,
  ENGINE_MODULE_NAME,
  EngineLoadError,
  inferEngineFormat,
} from "@wolfsdk/runtime/loader";
export type * from "./types.ts";

let baseTag: string | null = null;

/**
 * Register the element under `tag` (default `wolf-review`) and return its
 * constructor. Idempotent per tag. A second tag gets its own subclass (a
 * constructor can be defined only once). Throws when `tag` already names
 * another element.
 */
export function defineWolfReview(tag = "wolf-review"): typeof WolfReviewElement {
  const existing = customElements.get(tag);
  if (existing) {
    if (existing === WolfReviewElement || existing.prototype instanceof WolfReviewElement) {
      return existing as typeof WolfReviewElement; // checked on the line above
    }
    throw new Error(`<${tag}> is already defined by another element`);
  }
  const ctor = baseTag === null ? WolfReviewElement : class extends WolfReviewElement {};
  customElements.define(tag, ctor);
  baseTag ??= tag;
  return ctor;
}

declare global {
  interface HTMLElementTagNameMap {
    "wolf-review": WolfReviewElement;
  }
}
