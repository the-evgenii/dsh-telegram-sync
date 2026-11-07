import { readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

function run(args) {
  const result = spawnSync(process.execPath, args, { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
if (!manifest.dsh?.bundle?.patch || !manifest.engines.node) throw new Error('Missing DSH package metadata');
for (const dir of ['src', 'bin', 'scripts', 'test']) {
  for (const file of readdirSync(dir).filter(file => /\.(?:mjs|js)$/.test(file))) run(['--check', `${dir}/${file}`]);
}
const tests = readdirSync('test').filter(file => file.endsWith('.test.mjs')).map(file => `test/${file}`);
run(['--test', ...tests]);
