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
  r = run('code', ['--install-extension', `"${vsix}"`, '--force']);
  fs.rmSync(vsix, { force: true });
  if (r.status !== 0) {
    throw new Error('code --install-extension failed (is `code` on PATH?)');
  }
  console.log('[sync-install] Installed. Restart VS Code or run "Developer: Reload Window" to use it.');
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
