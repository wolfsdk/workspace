import { Component, type ComponentChildren } from "preact";
import type { EditorHost } from "../host/index.ts";

type Props = { host: EditorHost; plugin: string; slot: string; children: ComponentChildren };
type State = { failed: string | null };

/** Keeps one plugin slot's render failure from taking the shell down; the failure is reported. */
export class PluginBoundary extends Component<Props, State> {
  override state: State = { failed: null };

  static getDerivedStateFromError(error: unknown): State {
    return { failed: error instanceof Error ? error.message : String(error) };
  }

  override componentDidCatch(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.props.host.reportError({
      code: "plugin-failed",
      message: `${this.props.plugin} (${this.props.slot}) failed to render: ${message}`,
      argument: this.props.plugin,
    });
  }

  override render() {
    if (this.state.failed !== null) {
      return (
        <span
          class="we-shell-plugin-failed"
          data-testid={`shell-plugin-failed-${this.props.plugin}-${this.props.slot}`}
          title={this.state.failed}
        >
          {this.props.plugin} {this.props.slot} failed
        </span>
      );
    }
    return this.props.children;
  }
}
