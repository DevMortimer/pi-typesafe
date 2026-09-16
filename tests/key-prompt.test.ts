import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { promptForApiKey } from "../src/key-prompt.js";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

function fakeContext(drive: (component: { render(width: number): string[]; handleInput(data: string): void; focused: boolean }) => void): ExtensionCommandContext {
  const ui = {
    custom: async <T>(factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (value: T) => void) => unknown) =>
      new Promise<T>(resolve => {
        const component = factory({}, theme, {}, resolve) as { render(width: number): string[]; handleInput(data: string): void; focused: boolean };
        component.focused = true;
        drive(component);
      }),
    input: async () => { throw new Error("must not fall back"); },
  };
  return { hasUI: true, ui } as unknown as ExtensionCommandContext;
}

test("typed key is masked on screen and returned on Enter", async () => {
  let frame: string[] = [];
  const key = await promptForApiKey(fakeContext(component => {
    for (const character of "ts_secret_key_0123456789") component.handleInput(character);
    frame = component.render(60);
    component.handleInput("\r");
  }));
  assert.equal(key, "ts_secret_key_0123456789");
  const screen = frame.join("\n");
  assert.equal(screen.includes("ts_secret"), false);
  assert.ok(screen.includes("•".repeat(24)));
  assert.ok(screen.includes("TypeSafe API key"));
  assert.ok(frame.every(line => line.replace(/\x1b\[[0-9;]*m/g, "").length <= 60 + 8));
});

test("Escape cancels without a value", async () => {
  const key = await promptForApiKey(fakeContext(component => {
    component.handleInput("a");
    component.handleInput("\x1b");
  }));
  assert.equal(key, undefined);
});

test("falls back to Pi's plain input when custom UI is unavailable", async () => {
  const ctx = { hasUI: true, ui: { input: async () => "  ts_plain_key_0123456789  " } } as unknown as ExtensionCommandContext;
  assert.equal(await promptForApiKey(ctx), "  ts_plain_key_0123456789  ");
});
