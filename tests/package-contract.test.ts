import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));

test("TypeBox uses the Pi host's wildcard peer rather than a bundled runtime dependency", () => {
  assert.equal(pkg.dependencies?.typebox, undefined);
  assert.equal(pkg.optionalDependencies?.typebox, undefined);
  assert.equal(pkg.peerDependencies?.typebox, "*");
  assert.ok(!pkg.bundleDependencies?.includes("typebox"));
  assert.ok(!pkg.bundledDependencies?.includes("typebox"));
});

test("standalone consumers require TypeBox and development installs supply it", () => {
  // Unlike optional Pi-only peers, the public library imports TypeBox at runtime.
  assert.notEqual(pkg.peerDependenciesMeta?.typebox?.optional, true);
  assert.equal(typeof pkg.devDependencies?.typebox, "string");
});

test("the lockfile root preserves the host TypeBox peer contract", () => {
  const root = lock.packages[""];
  assert.equal(root.dependencies?.typebox, undefined);
  assert.equal(root.peerDependencies?.typebox, "*");
  assert.equal(root.devDependencies?.typebox, pkg.devDependencies.typebox);
  assert.notEqual(root.peerDependenciesMeta?.typebox?.optional, true);
});
