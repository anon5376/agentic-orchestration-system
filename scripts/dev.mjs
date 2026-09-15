import { spawn } from 'node:child_process';

const children = [
  spawn(process.execPath, ['engine/serve.js'], { stdio: 'inherit' }),
  spawn(process.execPath, ['node_modules/vite/bin/vite.js'], { stdio: 'inherit' }),
];

for (const child of children) {
  child.on('exit', (code) => {
    for (const other of children) {
      if (other !== child) other.kill('SIGTERM');
    }
    process.exit(code ?? 1);
  });
}
