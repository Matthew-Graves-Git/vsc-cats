// npm run test-window: compiles, then opens the Cat Yoink window in its scripted --test mode.
const cp = require('child_process');
const path = require('path');

const root = path.join(__dirname, '..');
const tsc = cp.spawnSync(process.execPath, [path.join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', root], {
  stdio: 'inherit',
});
if (tsc.status !== 0) {
  process.exit(tsc.status || 1);
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE; // set when launched from a VS Code terminal; Electron would run as plain Node
const electron = require('electron'); // the path of the electron binary
const run = cp.spawn(electron, [path.join(root, 'window', 'main.js'), '--test', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env,
});
run.on('exit', (code) => process.exit(code ?? 0));
