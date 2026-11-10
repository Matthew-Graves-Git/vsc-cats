// Makes the build you just compiled (F5) the one normal VS Code loads.
//
// VS Code runs this extension from ~/.vscode/extensions/<publisher>.<name>-<version>, a copy that
// was installed from a VSIX. F5 only runs the workspace in the Extension Development Host, so
// without this script that installed copy never changes.
//
//  - Fast path: copy out/, media/, window/, package.json and README.md into the installed folder
//    (only files that changed; stale files removed). node_modules is left alone.
//  - Slow path: if the folder is missing, or the version or dependencies differ, build a VSIX and
//    install it with `code --install-extension --force` instead.
//
// After a fast sync it touches <extension>/.reload; the loader in src/extension.ts sees that and
// swaps in the new build in every open VS Code window, without reloading the window.
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const extDir = path.join(os.homedir(), '.vscode', 'extensions', `${pkg.publisher}.${pkg.name}-${pkg.version}`);

const SYNC_DIRS = ['out', 'media', 'window'];
const SYNC_FILES = ['package.json', 'README.md'];

// ---- excludes: same patterns as .vscodeignore, so the synced files match what a VSIX contains ----

function globToRegex(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') {
        re += '(?:.*/)?';
        i += 2;
      } else {
        re += '.*';
        i += 1;
      }
    } else if (c === '*') {
      re += '[^/]*';
    } else {
      re += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp('^' + re + '$');
}

const excludes = fs
  .readFileSync(path.join(root, '.vscodeignore'), 'utf8')
  .split(/\r?\n/)
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('#') && !l.startsWith('!'))
  .map(globToRegex);
const isExcluded = (rel) => excludes.some((re) => re.test(rel));

// ---- helpers ----

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Retries briefly: a running Cat Yoink window can hold a file open on Windows. */
function withRetry(fn) {
  for (let attempt = 0; ; attempt++) {
    try {
      return fn();
    } catch (e) {
      if (attempt >= 4 || !['EBUSY', 'EPERM', 'EACCES'].includes(e.code)) {
        throw e;
      }
      sleep(200);
    }
  }
}

function walk(dir, rel, out) {
  if (!fs.existsSync(dir)) {
    return out;
  }
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      walk(path.join(dir, e.name), r, out);
    } else if (e.isFile()) {
      out.push(r);
    }
  }
  return out;
}

function same(a, b) {
  try {
    const sa = fs.statSync(a);
    const sb = fs.statSync(b);
    // utimes rounds to whole milliseconds, so allow a little slack.
    return sa.size === sb.size && Math.abs(sa.mtimeMs - sb.mtimeMs) < 2;
  } catch {
    return false;
  }
}

// ---- the running cat window ----

/** Windows: processes running from the installed folder ({pid, helper}), i.e. the cat window's Electron. */
function processesInExtDir() {
  if (process.platform !== 'win32') {
    return [];
  }
  const root = (path.resolve(extDir) + path.sep).toLowerCase().replace(/'/g, "''");
  const script =
    `Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and ` +
    `$_.ExecutablePath.ToLower().StartsWith('${root}') } | ` +
    `ForEach-Object { '{0} {1}' -f $_.ProcessId, [int]($_.CommandLine -match '--type=') }`;
  const r = cp.spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { encoding: 'utf8', windowsHide: true }
  );
  return (r.stdout || '')
    .split(/\r?\n/)
    .map((l) => l.trim().split(' '))
    .filter((a) => a.length === 2 && Number(a[0]) > 0)
    .map(([pid, helper]) => ({ pid: Number(pid), helper: helper === '1' }));
}

/**
 * The cat window runs electron.exe from the installed folder, and Windows won't delete a running
 * exe, so VS Code can't replace the folder while it is open ("Please restart VS Code before
 * reinstalling Cat Yoink", after deleting part of the folder). Close it first; the extension
 * reopens it after the reload signal.
 */
function stopCatWindows() {
  let procs = processesInExtDir();
  if (!procs.length) {
    return;
  }
  const kill = (pid) => cp.spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
  const mains = procs.filter((p) => !p.helper);
  for (const p of mains.length ? mains : procs) {
    kill(p.pid); // /T also ends its GPU/renderer helpers and the window tracker
  }
  for (let i = 0; i < 10 && (procs = processesInExtDir()).length; i++) {
    if (i >= 2) {
      procs.forEach((p) => kill(p.pid)); // stragglers
    }
    sleep(500);
  }
  console.log(
    procs.length
      ? `[sync-install] WARNING: processes still running from ${extDir}: ${procs.map((p) => p.pid).join(', ')}`
      : '[sync-install] Closed the Cat Yoink window so the extension folder can be replaced.'
  );
}

/**
 * A failed reinstall can delete the installed folder while VS Code's extensions.json still lists
 * it. Every later reinstall then fails the same way: VS Code first renames the listed folder
 * away, which throws for a missing folder. An empty folder there lets that step succeed.
 */
function recreateListedFolder() {
  if (fs.existsSync(extDir)) {
    return;
  }
  try {
    const list = JSON.parse(fs.readFileSync(path.join(path.dirname(extDir), 'extensions.json'), 'utf8'));
    const name = path.basename(extDir).toLowerCase();
    if (list.some((e) => String(e.relativeLocation ?? '').toLowerCase() === name)) {
      fs.mkdirSync(extDir);
      console.log('[sync-install] The installed folder was missing but still registered; recreated it empty so VS Code can replace it.');
    }
  } catch {
    // no extensions.json yet: a first install, nothing to repair
  }
}

// ---- slow path ----

function needsFullInstall() {
  let installed;
  try {
    installed = JSON.parse(fs.readFileSync(path.join(extDir, 'package.json'), 'utf8'));
  } catch {
    return 'the installed copy is missing';
  }
  if (installed.version !== pkg.version) {
    return 'the version changed';
  }
  if (JSON.stringify(installed.dependencies) !== JSON.stringify(pkg.dependencies)) {
    return 'the dependencies changed';
  }
  // VS Code caches extension manifests; only a real install refreshes that cache, so new
  // windows would otherwise keep the old commands and settings. Same key as manifestKey() in
  // src/extension.ts.
  const manifestKey = (p) => JSON.stringify([p.contributes, p.activationEvents, p.main]);
  if (manifestKey(installed) !== manifestKey(pkg)) {
    return 'commands or settings changed';
  }
  return undefined;
}

function fullInstall(reason) {
  console.log(`[sync-install] Full install: ${reason}. Packaging a VSIX (this takes a while)...`);
  const vsix = path.join(os.tmpdir(), `${pkg.name}-${pkg.version}-f5.vsix`);
  const run = (cmd, args) =>
    cp.spawnSync(cmd, args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
  let r = run('npx', ['--no-install', 'vsce', 'package', '--out', `"${vsix}"`]);
  if (r.status !== 0) {
    throw new Error('vsce package failed');
  }
  const install = () => {
    stopCatWindows();
    recreateListedFolder();
    return run('code', ['--install-extension', `"${vsix}"`, '--force']).status === 0;
  };
  // Retry once: a cat appearing mid-install can reopen the window and lock the folder again.
  let ok = install();
  if (!ok) {
    console.log('[sync-install] Install failed; retrying once...');
    ok = install();
  }
  fs.rmSync(vsix, { force: true });
  if (!ok) {
    throw new Error('code --install-extension failed; see the output above');
  }
  // Same signal as the fast path: Cat Yoink in open windows loads the new build (and its window
  // comes back), then asks for a window reload because commands or settings changed.
  try {
    fs.writeFileSync(path.join(extDir, '.reload'), new Date().toISOString());
  } catch {
    // the reload prompt below still applies
  }
  console.log(
    '[sync-install] Installed. Cat Yoink in open VS Code windows reloads itself; run "Developer: Reload Window" ' +
      '(you will be asked) so VS Code picks up the new commands and settings.'
  );
}

// ---- fast path ----

function fastSync() {
  let copied = 0;
  let removed = 0;
  const skipped = [];

  const copy = (rel) => {
    const from = path.join(root, rel);
    const to = path.join(extDir, rel);
    if (same(from, to)) {
      return;
    }
    try {
      withRetry(() => {
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.copyFileSync(from, to);
        const st = fs.statSync(from);
        fs.utimesSync(to, st.atime, st.mtime); // so the next run sees the file as unchanged
      });
      copied++;
    } catch (e) {
      skipped.push(`${rel} (${e.code || e.message})`);
    }
  };

  for (const dir of SYNC_DIRS) {
    const wanted = new Set(walk(path.join(root, dir), dir, []).filter((r) => !isExcluded(r)));
    for (const rel of wanted) {
      copy(rel);
    }
    // Remove files that no longer exist (or are now excluded) in the workspace.
    for (const rel of walk(path.join(extDir, dir), dir, [])) {
      if (!wanted.has(rel)) {
        try {
          withRetry(() => fs.rmSync(path.join(extDir, rel), { force: true }));
          removed++;
        } catch (e) {
          skipped.push(`${rel} (${e.code || e.message})`);
        }
      }
    }
  }
  for (const rel of SYNC_FILES) {
    if (fs.existsSync(path.join(root, rel))) {
      copy(rel);
    }
  }

  // Tell the running extension to reload itself.
  fs.writeFileSync(path.join(extDir, '.reload'), new Date().toISOString());

  const note = skipped.length ? ` WARNING, could not update: ${skipped.join(', ')}` : '';
  console.log(
    `[sync-install] Synced ${copied} file(s), removed ${removed} -> ${extDir}. ` +
      `Cat Yoink in open VS Code windows reloads itself.${note}`
  );
}

// ---- main ----

try {
  if (fs.existsSync(extDir) && fs.realpathSync(extDir) === fs.realpathSync(root)) {
    console.log('[sync-install] The installed extension is this workspace; nothing to do.');
  } else {
    const reason = needsFullInstall();
    if (reason) {
      fullInstall(reason);
    } else {
      fastSync();
    }
  }
} catch (e) {
  // Never block F5 on this; the dev host still runs the workspace build.
  console.warn(`[sync-install] Skipped: ${e.message}`);
}
