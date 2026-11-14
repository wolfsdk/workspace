/**
 * `@wolfsdk/review/seal`: the sealed-page kit for hosting `<wolf-review>` with
 * no network egress (response-header policy, offline loader, vault assets and
 * the egress probe). Importing it removes the WebRTC constructors from this
 * realm, so import it first on a sealed page.
 */
export * from "@wolfsdk/runtime/seal";
