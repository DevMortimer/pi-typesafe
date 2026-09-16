import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { loadEnvFile } from 'node:process';

const root = fileURLToPath(new URL('../', import.meta.url));
try {
  loadEnvFile(join(root, '.env'));
} catch {
  console.error('Create a private project .env with TYPESAFE_API_KEY before starting the development session.');
  process.exit(1);
}
const child = spawn('pi', ['-e', root, ...process.argv.slice(2)], {
  cwd: root,
  env: process.env,
  stdio: 'inherit',
});
child.on('error', () => {
  console.error('Could not start Pi. Install the Pi CLI and make it available on PATH.');
  process.exitCode = 1;
});
child.on('exit', code => { process.exitCode = code ?? 1; });
