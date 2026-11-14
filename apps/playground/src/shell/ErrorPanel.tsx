import { type KernelError, TID } from "../lab/index.ts";
import { Component, type ComponentChildren } from "preact";
import { kernelErrorOf } from "./logic.ts";

/** A refusal or trap, shown with its structured code. Never a blank stage. */
export function ErrorPanel({ error, title }: { error: KernelError; title: string }) {
  return (
    <div class="lab-error" role="alert" data-testid={TID.errorPanel} data-code={error.code}>
      <p class="lab-error__title">{title}</p>
      <p class="lab-error__code">
        <span class="lab-error__label">Code</span> <code>{error.code}</code>
      </p>
      <p class="lab-error__message">{error.message}</p>
      {error.argument !== undefined && (
        <p class="lab-error__argument">
          <span class="lab-error__label">Argument</span> <code>{error.argument}</code>
        </p>
      )}
    </div>
  );
}

/** Keeps a mode that throws while rendering from blanking the stage. */
export class StageBoundary extends Component<{ children: ComponentChildren }, { error: KernelError | null }> {
  override state = { error: null as KernelError | null };

  static getDerivedStateFromError(error: unknown) {
    return { error: kernelErrorOf(error, "mode-crashed") };
  }

  override render() {
    return this.state.error ? <ErrorPanel error={this.state.error} title="This mode stopped." /> : this.props.children;
  }
}
