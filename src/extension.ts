// Thin loader: runs core.ts and swaps in a new build without reloading the VS Code window.
//
// scripts/sync-install.js (run by F5) copies the new build into the installed extension folder
// and touches <extension>/.reload. We see that, stop the old core (Discord browser and cat
// window included), drop the compiled modules from require's cache, and start the new core.
// Other extensions keep running.
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

interface Core {
  activate(context: vscode.ExtensionContext): void;
  /** `reloading`: a new build is about to start (hot reload), not VS Code shutting down. */
  deactivate(reloading?: boolean): Promise<void>;
}

let context: vscode.ExtensionContext;
let core: Core | undefined;
let subs: vscode.Disposable[] = [];
let signalFile = '';
let lastSignal = 0;
let manifest = '';
let reloading: Promise<void> | undefined;

export function activate(ctx: vscode.ExtensionContext) {
  context = ctx;
  signalFile = path.join(ctx.extensionPath, '.reload');
  lastSignal = mtime(signalFile);
  manifest = manifestKey();
  load();
  fs.watchFile(signalFile, { interval: 1000 }, () => {
    const t = mtime(signalFile);
    if (t > lastSignal) {
      lastSignal = t;
      void reload();
    }
  });
}

export async function deactivate() {
  fs.unwatchFile(signalFile);
  await reloading;
  await unload();
}

// ---- internals ----

function mtime(file: string): number {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

/** The parts of package.json that only take effect after a window reload. */
function manifestKey(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(context.extensionPath, 'package.json'), 'utf8'));
    return JSON.stringify([pkg.contributes, pkg.activationEvents, pkg.main]);
  } catch {
    return '';
  }
}

function load() {
  subs = [];
  // Core registers its commands etc. on context.subscriptions; give it our own list so a reload
  // can dispose exactly those. VS Code freezes the context, so a Proxy can't swap that property
  // (Proxy invariants); instead inherit everything from the real context and shadow just that one.
  const scoped = Object.create(context, {
    subscriptions: { value: subs, enumerable: true },
  }) as vscode.ExtensionContext;
  try {
    core = require('./core') as Core;
    core.activate(scoped);
  } catch (err: any) {
    core = undefined;
    void vscode.window.showErrorMessage(`Cat Yoink failed to start: ${err?.message ?? err}`);
  }
}

async function unload(reloading = false) {
  const c = core;
  core = undefined;
  try {
    await c?.deactivate(reloading);
  } catch {
    // keep going: the new build should still get a chance
  }
  for (const d of subs.splice(0)) {
    try {
      d.dispose();
    } catch {
      // ignore
    }
  }
}

function reload(): Promise<void> {
  if (reloading) {
    return reloading;
  }
  reloading = (async () => {
    await unload(true);
    // Forget every compiled module of ours except this loader, so require() reads the new files.
    const norm = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);
    const outDir = norm(path.join(context.extensionPath, 'out') + path.sep);
    const self = norm(__filename);
    for (const id of Object.keys(require.cache)) {
      if (norm(id).startsWith(outDir) && norm(id) !== self) {
        delete require.cache[id];
      }
    }
    load();
    vscode.window.setStatusBarMessage('$(cat-yoink-cat) Cat Yoink reloaded', 3000);

    const now = manifestKey();
    if (now !== manifest) {
      manifest = now;
      void vscode.window
        .showInformationMessage('Cat Yoink: commands or settings changed. Reload the window to apply them.', 'Reload Window')
        .then((choice) => choice && vscode.commands.executeCommand('workbench.action.reloadWindow'));
    }
  })().finally(() => {
    reloading = undefined;
  });
  return reloading;
}
