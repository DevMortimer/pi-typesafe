import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { loadEnvFile } from 'node:process';

const root = fileURLToPath(new URL('../', import.meta.url));
// Optional: a private .env can supply TYPESAFE_API_KEY; otherwise use /typesafe login inside Pi.
try {
  loadEnvFile(join(root, '.env'));
} catch {
  // No .env present; the stored key from /typesafe login (if any) is used.
}
// --no-extensions keeps an installed pi-typesafe (or other extensions) from loading alongside the working tree.
const child = spawn('pi', ['--no-extensions', '-e', root, ...process.argv.slice(2)], {
  cwd: root,
  env: process.env,
  stdio: 'inherit',
});
child.on('error', () => {
  console.error('Could not start Pi. Install the Pi CLI and make it available on PATH.');
  process.exitCode = 1;
});
child.on('exit', code => { process.exitCode = code ?? 1; });
