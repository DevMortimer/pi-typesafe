import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Container, CURSOR_MARKER, type Focusable, Input, Key, matchesKey, Text, truncateToWidth } from "@earendil-works/pi-tui";

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

  constructor(theme: { fg(color: string, text: string): string; bold(text: string): string }, done: (value: string | undefined) => void) {
    super();
    this.addChild(new Text(theme.fg("accent", theme.bold("TypeSafe API key")), 1, 0));
    this.addChild(new Text(theme.fg("muted", "Paste the key from console.typesafe.ai › API Keys. Input is hidden. Enter saves, Esc cancels."), 1, 0));
    this.addChild(this.input);
    this.input.onSubmit = value => done(value);
    this.input.onEscape = () => done(undefined);
  }

  get focused(): boolean {
    return this.isFocused;
  }

  set focused(value: boolean) {
    this.isFocused = value;
    this.input.focused = value;
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.input.onEscape?.();
      return;
    }
    this.input.handleInput(data);
  }
}

/** Hidden input in the TUI; falls back to Pi's plain input dialog where custom components are unavailable. */
export async function promptForApiKey(ctx: ExtensionCommandContext): Promise<string | undefined> {
  if (typeof ctx.ui.custom === "function") {
    return ctx.ui.custom<string | undefined>((_tui, theme, _keybindings, done) => new KeyPrompt(theme, done));
  }
  return ctx.ui.input("TypeSafe API key (visible while typing)", "Paste the key, then press Enter");
}
