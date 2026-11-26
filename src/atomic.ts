import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

let writes = 0;

function temporaryPath(path: string): string {
  writes += 1;
  return `${path}.${process.pid}.${writes}.tmp`;
}

export async function writeFileAtomic(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = temporaryPath(path);
  await writeFile(temporary, text, { mode: 0o600 });
  // mode on writeFile only applies on creation; chmod prevents an existing temp file from weakening permissions.
  await chmod(temporary, 0o600);
  await rename(temporary, path);
}

export function writeFileAtomicSync(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = temporaryPath(path);
  writeFileSync(temporary, text, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
}

const queues = new Map<string, Promise<void>>();

export function serialize<T>(key: string, task: () => Promise<T> | T): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  const run = previous.then(task);
  const settled = run.then(() => undefined, () => undefined);
  queues.set(key, settled);
  void settled.then(() => {
    if (queues.get(key) === settled) queues.delete(key);
  });
  return run;
}
