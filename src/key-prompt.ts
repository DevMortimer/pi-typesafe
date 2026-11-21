import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Container, CURSOR_MARKER, type Focusable, Input, Key, matchesKey, Text, truncateToWidth } from "@earendil-works/pi-tui";

export type KeyPromptState =
  | { readonly status: "editing" }
  | { readonly status: "submitted"; readonly value: string }
  | { readonly status: "cancelled" };

export type KeyPromptEvent =
  | { readonly type: "submit"; readonly value: string }
  | { readonly type: "cancel" };

export interface KeyPromptTransition {
  readonly state: KeyPromptState;
  readonly settledNow: boolean;
}

/** Terminal UIs can deliver trailing keystrokes after Enter or Escape; settle at most once. */
export function transitionKeyPrompt(state: KeyPromptState, event: KeyPromptEvent): KeyPromptTransition {
  if (state.status !== "editing") return { state, settledNow: false };
  if (event.type === "submit") return { state: { status: "submitted", value: event.value }, settledNow: true };
  return { state: { status: "cancelled" }, settledNow: true };
}

/** Single-line input that renders bullets instead of the typed value. */
class SecretInput extends Input {
  override render(width: number): string[] {
    const length = [...this.getValue()].length;
    const bullets = "•".repeat(Math.min(length, Math.max(0, width - 2)));
    const cursor = this.focused ? `${CURSOR_MARKER}\x1b[7m \x1b[27m` : "";
    return [truncateToWidth(bullets + cursor, width, "")];
  }
}

class KeyPrompt extends Container implements Focusable {
  private readonly input = new SecretInput();
  private isFocused = false;
  private state: KeyPromptState = { status: "editing" };
  private readonly done: (value: string | undefined) => void;

  constructor(theme: { fg(color: string, text: string): string; bold(text: string): string }, label: string, done: (value: string | undefined) => void) {
    super();
    this.done = done;
    this.addChild(new Text(theme.fg("accent", theme.bold(`${label} API key`)), 1, 0));
    this.addChild(new Text(theme.fg("muted", "Paste the key. Input is hidden. Enter saves, Esc cancels."), 1, 0));
    this.addChild(this.input);
    this.input.onSubmit = value => this.settle({ type: "submit", value });
    this.input.onEscape = () => this.settle({ type: "cancel" });
  }

  private settle(event: KeyPromptEvent): void {
    const next = transitionKeyPrompt(this.state, event);
    this.state = next.state;
    if (!next.settledNow) return;
    this.done(next.state.status === "submitted" ? next.state.value : undefined);
  }

  get focused(): boolean {
    return this.isFocused;
  }

  set focused(value: boolean) {
    this.isFocused = value;
    this.input.focused = value;
  }

  handleInput(data: string): void {
    if (this.state.status !== "editing") return;
    if (matchesKey(data, Key.escape)) {
      this.settle({ type: "cancel" });
      return;
    }
    this.input.handleInput(data);
  }
}

/** Hidden input in the TUI; falls back to Pi's plain input dialog where custom components are unavailable. */
export async function promptForApiKey(ctx: ExtensionCommandContext, label = "TypeSafe"): Promise<string | undefined> {
  if (typeof ctx.ui.custom === "function") {
    return ctx.ui.custom<string | undefined>((_tui, theme, _keybindings, done) => new KeyPrompt(theme, label, done));
  }
  return ctx.ui.input(`${label} API key (visible while typing)`, "Paste the key, then press Enter");
}
