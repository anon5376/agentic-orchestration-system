import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { loadOperatorToken } from '../engine/operator-auth.js';

const dataDir = resolve(process.env.AOS_HOME || '.aos');
const operatorToken = loadOperatorToken({ dataDir }).token;
const childEnv = { ...process.env, AOS_OPERATOR_TOKEN: operatorToken };

const children = [
  spawn(process.execPath, ['engine/serve.js'], { stdio: 'inherit', env: childEnv }),
  spawn(process.execPath, ['node_modules/vite/bin/vite.js'], { stdio: 'inherit', env: childEnv }),
];

for (const child of children) {
  child.on('exit', (code) => {
    for (const other of children) {
      if (other !== child) other.kill('SIGTERM');
    }
    process.exit(code ?? 1);
  });
}
