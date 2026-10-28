import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createTypeSafe, noul, TypeSafeIntegrationError } from "../src/index.js";
import type { BackendEndpoint } from "../src/index.js";

// The judge body a Bun runtime turns into `TypeError: Body already used` once the SDK has buffered it.
const JUDGE_BODY = JSON.stringify({
  model: "jev-1.13-free",
  answers: { q1: { type: "noul", noul: 0.42 } },
  usage: { input_tokens: 10, output_tokens: 1 },
});
const request = { state: "synthetic", questions: { q1: noul("Is this synthetic?") } };
const apiKey = "ts_fake_key_0123456789abcdef";
const bunVersion = (process.versions as { bun?: string }).bun;

interface LocalServer {
  readonly host: string;
  readonly requests: () => number;
  readonly close: () => Promise<void>;
}

async function localServer(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<LocalServer> {
  let requests = 0;
  const server = createServer((req, res) => {
    requests += 1;
    req.resume();
    handler(req, res);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    host: `http://127.0.0.1:${port}`,
    requests: () => requests,
    close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

const backend = (host: string): BackendEndpoint => ({ label: "Local", host, keyEnv: "JUDGE_KEY", defaultModel: "jev-1.13" });

/** A response that counts the clones the SDK's buffering step makes, so a test can see whether the raw one was handed over. */
class CountingResponse extends Response {
  clones = 0;
  override clone(): Response {
    this.clones += 1;
    return super.clone();
  }
}

const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
const savedGlobalFetch = globalThis.fetch;
before(() => {
  // Auth state is written next to the key store; keep this run's records out of the developer's own store.
  process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-typesafe-bun-"));
});
after(() => {
  if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
  globalThis.fetch = savedGlobalFetch;
});

// 1. A judge call with no injected transport, against a real server, on whichever runtime runs this file.

test("a judge call with no injected transport returns the parsed answers and makes one request", async () => {
  const server = await localServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JUDGE_BODY);
  });
  try {
    const client = createTypeSafe({ apiKey, backend: backend(server.host) });
    const result = await client.evaluate(request);
    assert.equal(result.answers.q1.type, "noul");
    assert.equal((result.answers.q1 as { noul: number }).noul, 0.42);
    assert.equal(result.model, "jev-1.13-free");
    assert.equal(server.requests(), 1);
  } finally {
    await server.close();
  }
});

// 2. Status and headers survive the body replay, so the SDK reports the backend's own status.

test("a non-2xx body keeps its status and headers", async () => {
  const server = await localServer((_req, res) => {
    res.writeHead(429, { "content-type": "application/json", "retry-after": "7" });
    res.end(JSON.stringify({ error: { message: "quota" } }));
  });
  try {
    const client = createTypeSafe({ apiKey, backend: backend(server.host) });
    const error = await client.evaluate(request).then(() => undefined, (caught: unknown) => caught);
    assert.ok(error instanceof TypeSafeIntegrationError);
    assert.equal(error.code, "http");
    assert.equal(error.status, 429);
    // The Retry-After count reaches the message only if the headers were carried across.
    assert.equal(error.message, "TypeSafe returned HTTP 429. Check your account quota and try again later. Retry after 7 seconds. No automatic retry was made.");
    assert.equal(server.requests(), 1);
  } finally {
    await server.close();
  }
});

// 3. An abort during body delivery rejects with the abort, not with a half-read body or a timeout.

test("an aborted request rejects as aborted", async () => {
  const server = await localServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.flushHeaders();
    res.write(JUDGE_BODY.slice(0, 20));
    // Never ends: the body stays in flight until the caller aborts.
  });
  try {
    const client = createTypeSafe({ apiKey, backend: backend(server.host), timeoutMs: 30_000 });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("caller gave up")), 100);
    const error = await client.evaluate(request, { signal: controller.signal }).then(() => undefined, (caught: unknown) => caught);
    clearTimeout(timer);
    assert.ok(error instanceof TypeSafeIntegrationError);
    assert.equal(error.code, "aborted");
    assert.equal(server.requests(), 1);
  } finally {
    await server.close();
  }
});

// 4. The transport handed over is runtime-dependent: Bun gets this package's replay, Node gets the raw response.

test("with no fetch option, Node hands the SDK the raw response and Bun hands it a replay", async () => {
  const response = new CountingResponse(JUDGE_BODY, { headers: { "content-type": "application/json" } });
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return response;
  };
  try {
    const client = createTypeSafe({ apiKey, backend: backend("http://127.0.0.1:1") });
    const result = await client.evaluate(request);
    assert.equal((result.answers.q1 as { noul: number }).noul, 0.42);
    assert.equal(calls, 1, "one HTTP request per evaluate");
    // The SDK's buffering step clones the response it is given: on Node that is the caller's own, on Bun the replay is.
    assert.equal(response.clones, bunVersion === undefined ? 1 : 0);
  } finally {
    globalThis.fetch = savedGlobalFetch;
  }
});

// 5. A caller's own transport, such as a wrapper that reads the body, is wrapped too and stays harmless.

test("a caller-supplied fetch is called once per request", async () => {
  let calls = 0;
  const seen: string[] = [];
  const client = createTypeSafe({ apiKey, backend: backend("http://127.0.0.1:1"), fetch: async (url, init) => {
    calls += 1;
    seen.push(String(url));
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${apiKey}`);
    return new Response(JUDGE_BODY, { headers: { "content-type": "application/json" } });
  } });
  const result = await client.evaluate(request);
  assert.equal((result.answers.q1 as { noul: number }).noul, 0.42);
  assert.equal(calls, 1);
  assert.deepEqual(seen, ["http://127.0.0.1:1/v1/systemone"]);
});

// 6. A backend that renames its model list gets the same readable body: the replay sits ahead of that rewrite too.

test("a backend that rewrites its model list still returns models", async () => {
  let calls = 0;
  const client = createTypeSafe({
    apiKey,
    backend: { label: "Gateway", host: "https://gw.example.com", modelsPath: "/v1/catalog", modelsField: "data", modelsIdField: "id", keyEnv: "GATEWAY_JEV_KEY", defaultModel: "jev-1.13" },
    fetch: async (url) => {
      calls += 1;
      if (String(url).endsWith("/v1/catalog")) return new Response(JSON.stringify({ data: [{ id: "jev-1.13" }] }), { headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify({ model: "jev-1.13", answers: { q1: { type: "noul", noul: 0.42 } }, usage: { input_tokens: 10, output_tokens: 1 } }), { headers: { "content-type": "application/json" } });
    },
  });
  assert.deepEqual(await client.listModels(), ["jev-1.13"]);
  const result = await client.evaluate(request);
  assert.equal((result.answers.q1 as { noul: number }).noul, 0.42);
  assert.equal(calls, 2);
});
