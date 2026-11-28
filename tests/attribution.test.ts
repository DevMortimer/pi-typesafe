import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createTypeSafe, DECISIONS_BACKENDS, noul, TypeSafeIntegrationError } from "../src/index.js";
import type { Attribution, BackendSpec } from "../src/index.js";

// An obviously fake key; nothing here reaches a network.
const apiKey = "or_fake_key_0123456789abcdef";
const secret = "private-user-content";
const sample = () => ({ state: secret, questions: { yes: noul("Is this synthetic?") } });
const reply = () => Response.json({ model: "typesafe/jev-1.13-20260917", answers: { yes: { type: "noul", noul: 0.9 } }, usage: { input_tokens: 10, output_tokens: 0 } });
const ATTRIBUTION_HEADERS = ["http-referer", "x-openrouter-title", "x-openrouter-categories", "x-openrouter-app-visibility"];

const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
before(() => {
  // The default ledger and auth state land in a temporary directory, never the developer's own.
  process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-typesafe-attribution-"));
});
after(() => {
  if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
});

/** The attribution headers each request carried, keyed by the URL it went to, with every other header dropped. */
function recording(): { fetch: (url: string, init?: RequestInit) => Promise<Response>; sent: Array<{ url: string; headers: Record<string, string> }> } {
  const sent: Array<{ url: string; headers: Record<string, string> }> = [];
  return {
    sent,
    fetch: async (url, init) => {
      const headers = Object.fromEntries([...new Headers(init?.headers)].filter(([name]) => ATTRIBUTION_HEADERS.includes(name)));
      sent.push({ url: String(url), headers });
      return String(url).endsWith("/models") ? Response.json({ data: [{ id: "typesafe/jev-1.13" }] }) : reply();
    },
  };
}

test("OpenRouter's judgment request and model list both name pi-typesafe by default", async () => {
  const { fetch, sent } = recording();
  const client = createTypeSafe({ apiKey, backend: "openrouter", fetch });
  await client.evaluate(sample());
  await client.listModels();
  const expected = { "http-referer": "https://github.com/DevMortimer/pi-typesafe", "x-openrouter-title": "pi-typesafe", "x-openrouter-categories": "cli-agent" };
  assert.deepEqual(sent, [
    { url: "https://openrouter.ai/api/alpha/decisions", headers: expected },
    { url: "https://openrouter.ai/api/v1/models", headers: expected },
  ]);
  // The headers name the app, never the key or what was submitted.
  for (const value of Object.values(expected)) {
    assert.ok(!value.includes(apiKey));
    assert.ok(!value.includes(secret));
  }
});

test("an extension's attribution replaces the default whole, and a field it leaves out is not sent", async () => {
  const cases: Array<[Attribution, Record<string, string>]> = [
    [
      { url: "https://example.com/my-extension", title: "My Extension", categories: ["ide-extension", "cli-agent"], hidden: true },
      { "http-referer": "https://example.com/my-extension", "x-openrouter-title": "My Extension", "x-openrouter-categories": "ide-extension,cli-agent", "x-openrouter-app-visibility": "hidden" },
    ],
    [{ url: "https://example.com" }, { "http-referer": "https://example.com" }],
    [{ url: " http://localhost:3000 ", title: " Local App ", categories: [], hidden: false }, { "http-referer": "http://localhost:3000", "x-openrouter-title": "Local App" }],
  ];
  for (const [attribution, expected] of cases) {
    const { fetch, sent } = recording();
    const client = createTypeSafe({ apiKey, backend: "openrouter", attribution, fetch });
    await client.evaluate(sample());
    await client.listModels();
    assert.deepEqual(sent.map(request => request.headers), [expected, expected]);
  }
});

test("no other backend receives an attribution header, even when an attribution is passed", async () => {
  const gateway: BackendSpec = { label: "Gateway", host: "https://gw.example.com", keyEnv: "GATEWAY_JEV_KEY", defaultModel: "jev-latest" };
  const backends: BackendSpec[] = [...Object.keys(DECISIONS_BACKENDS).filter(name => name !== "openrouter") as BackendSpec[], gateway];
  for (const backend of backends) {
    for (const attribution of [undefined, { url: "https://example.com/my-extension", title: "My Extension", categories: ["cli-agent"], hidden: true }]) {
      const { fetch, sent } = recording();
      const client = createTypeSafe({ apiKey, backend, fetch, ...(attribution === undefined ? {} : { attribution }) });
      await client.evaluate(sample());
      // Some lists arrive in a shape this stub does not answer with; only the headers that went out matter here.
      await client.listModels().catch(() => undefined);
      assert.equal(sent.length, 2);
      for (const request of sent) assert.deepEqual(request.headers, {}, `${typeof backend === "string" ? backend : backend.label} ${request.url}`);
    }
  }
});

test("an invalid attribution is a configuration error on every backend, before any request, and never quotes the value", () => {
  const cases: Array<[unknown, string]> = [
    [null, "attribution must be an object with only url, title, categories, and hidden."],
    ["https://example.com", "attribution must be an object with only url, title, categories, and hidden."],
    [["https://example.com"], "attribution must be an object with only url, title, categories, and hidden."],
    [{ url: "https://example.com", referer: "https://example.com" }, "attribution must be an object with only url, title, categories, and hidden."],
    [{}, "Attribution url must be an absolute https: or http: URL of at most 200 printable ASCII characters, with no user info, query, or fragment."],
    [{ url: "example.com" }, "Attribution url must be an absolute https: or http: URL of at most 200 printable ASCII characters, with no user info, query, or fragment."],
    [{ url: "ftp://example.com" }, "Attribution url must be an absolute https: or http: URL of at most 200 printable ASCII characters, with no user info, query, or fragment."],
    [{ url: "https://user:pw-secret@example.com" }, "Attribution url must be an absolute https: or http: URL of at most 200 printable ASCII characters, with no user info, query, or fragment."],
    [{ url: "https://example.com/?token=pw-secret" }, "Attribution url must be an absolute https: or http: URL of at most 200 printable ASCII characters, with no user info, query, or fragment."],
    [{ url: "https://example.com/#pw-secret" }, "Attribution url must be an absolute https: or http: URL of at most 200 printable ASCII characters, with no user info, query, or fragment."],
    [{ url: "https://exämple.com" }, "Attribution url must be an absolute https: or http: URL of at most 200 printable ASCII characters, with no user info, query, or fragment."],
    [{ url: `https://example.com/${"a".repeat(200)}` }, "Attribution url must be an absolute https: or http: URL of at most 200 printable ASCII characters, with no user info, query, or fragment."],
    [{ url: "https://example.com", title: " " }, "Attribution title must be a nonempty string of at most 60 printable ASCII characters."],
    [{ url: "https://example.com", title: "a".repeat(61) }, "Attribution title must be a nonempty string of at most 60 printable ASCII characters."],
    [{ url: "https://example.com", title: "Line\r\nX-Injected: 1" }, "Attribution title must be a nonempty string of at most 60 printable ASCII characters."],
    [{ url: "https://example.com", title: "Café" }, "Attribution title must be a nonempty string of at most 60 printable ASCII characters."],
    [{ url: "https://example.com", title: 7 }, "Attribution title must be a nonempty string of at most 60 printable ASCII characters."],
    [{ url: "https://example.com", categories: "cli-agent" }, 'Attribution categories must be an array of at most 2 lowercase, hyphen-separated slugs of at most 30 characters, such as "cli-agent".'],
    [{ url: "https://example.com", categories: ["cli-agent", "cloud-agent", "ide-extension"] }, 'Attribution categories must be an array of at most 2 lowercase, hyphen-separated slugs of at most 30 characters, such as "cli-agent".'],
    [{ url: "https://example.com", categories: ["CLI Agent"] }, 'Attribution categories must be an array of at most 2 lowercase, hyphen-separated slugs of at most 30 characters, such as "cli-agent".'],
    [{ url: "https://example.com", categories: ["cli-agent,cloud-agent"] }, 'Attribution categories must be an array of at most 2 lowercase, hyphen-separated slugs of at most 30 characters, such as "cli-agent".'],
    [{ url: "https://example.com", categories: [`a${"-b".repeat(15)}`] }, 'Attribution categories must be an array of at most 2 lowercase, hyphen-separated slugs of at most 30 characters, such as "cli-agent".'],
    [{ url: "https://example.com", hidden: "true" }, "Attribution hidden must be a boolean."],
  ];
  for (const backend of ["openrouter", "typesafe"] as const) {
    for (const [attribution, message] of cases) {
      let calls = 0;
      assert.throws(() => createTypeSafe({ apiKey, backend, attribution: attribution as Attribution, fetch: async () => { calls += 1; return reply(); } }), (error: unknown) => {
        assert.ok(error instanceof TypeSafeIntegrationError);
        assert.equal(error.code, "configuration");
        assert.equal(error.message, message);
        assert.ok(!error.message.includes("pw-secret"));
        return true;
      });
      assert.equal(calls, 0);
    }
  }
});
