import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { promptForApiKey, transitionKeyPrompt } from "../src/key-prompt.js";
import type { KeyPromptEvent, KeyPromptState } from "../src/key-prompt.js";

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

test("the prompt names the backend whose key it asks for", async () => {
  let screen = "";
  const key = await promptForApiKey(fakeContext(component => {
    screen = component.render(60).join("\n");
    component.handleInput("\r");
  }), "OpenRouter");
  assert.ok(screen.includes("OpenRouter API key"), screen);
  assert.equal(key, "");
});

test("KeyPrompt settles at most once and ignores trailing input after Enter or Escape", async () => {
  const submitCalls: Array<string | undefined> = [];
  let afterSubmitRender = "";
  const submitCtx = {
    hasUI: true,
    ui: {
      custom: async <T>(factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (value: T) => void) => unknown) =>
        new Promise<T>(resolve => {
          const component = factory({}, theme, {}, (value: T) => {
            submitCalls.push(value as string | undefined);
            resolve(value);
          }) as { render(width: number): string[]; handleInput(data: string): void; focused: boolean };
          component.focused = true;
          for (const ch of "abc") component.handleInput(ch);
          component.handleInput("\r");
          // Trailing input, second Enter, and Escape after settlement must be ignored.
          component.handleInput("z");
          component.handleInput("\r");
          component.handleInput("\x1b");
          afterSubmitRender = component.render(60).join("\n");
        }),
      input: async () => { throw new Error("must not fall back"); },
    },
  } as unknown as ExtensionCommandContext;
  assert.equal(await promptForApiKey(submitCtx), "abc");
  assert.deepEqual(submitCalls, ["abc"]);
  assert.equal(afterSubmitRender.includes("••••"), false, "post-submit keystroke must not mutate input");

  const cancelCalls: Array<string | undefined> = [];
  const cancelCtx = {
    hasUI: true,
    ui: {
      custom: async <T>(factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (value: T) => void) => unknown) =>
        new Promise<T>(resolve => {
          const component = factory({}, theme, {}, (value: T) => {
            cancelCalls.push(value as string | undefined);
            resolve(value);
          }) as { render(width: number): string[]; handleInput(data: string): void; focused: boolean };
          component.focused = true;
          component.handleInput("a");
          component.handleInput("\x1b");
          component.handleInput("\x1b");
          component.handleInput("b");
          component.handleInput("\r");
        }),
      input: async () => { throw new Error("must not fall back"); },
    },
  } as unknown as ExtensionCommandContext;
  assert.equal(await promptForApiKey(cancelCtx), undefined);
  assert.deepEqual(cancelCalls, [undefined]);
});

test("transitionKeyPrompt table is closed across editing and terminal states", () => {
  const cases: Array<{ state: KeyPromptState; event: KeyPromptEvent; next: KeyPromptState; settledNow: boolean }> = [
    { state: { status: "editing" }, event: { type: "submit", value: "k1" }, next: { status: "submitted", value: "k1" }, settledNow: true },
    { state: { status: "editing" }, event: { type: "cancel" }, next: { status: "cancelled" }, settledNow: true },
    { state: { status: "submitted", value: "k1" }, event: { type: "submit", value: "k2" }, next: { status: "submitted", value: "k1" }, settledNow: false },
    { state: { status: "submitted", value: "k1" }, event: { type: "cancel" }, next: { status: "submitted", value: "k1" }, settledNow: false },
    { state: { status: "cancelled" }, event: { type: "submit", value: "k2" }, next: { status: "cancelled" }, settledNow: false },
    { state: { status: "cancelled" }, event: { type: "cancel" }, next: { status: "cancelled" }, settledNow: false },
  ];
  for (const row of cases) {
    assert.deepEqual(transitionKeyPrompt(row.state, row.event), { state: row.next, settledNow: row.settledNow });
  }
});
