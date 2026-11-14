// Compiles the frameless cat window (window/host.cs) into window/CatHost.exe, so it starts without
// PowerShell compiling it first (src/nativeWindow.ts runs the exe; PowerShell is its fallback).
//
// Uses the C# compiler of the .NET Framework that every Windows 10/11 has, the same one
// PowerShell's Add-Type uses, so host.cs builds the same both ways. The exe is AnyCPU: it runs as
// x64 or arm64, whichever the machine is. Needs window/lib (scripts/fetch-webview2.js).
//
// Runs from `vscode:prepublish` and scripts/sync-install.js; does nothing when the exe is newer
// than its inputs. On other platforms it only says so: a .vsix built there has no exe, and its
// cat window is compiled by PowerShell at every start. No dependencies.
const cp = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join('window', 'host.cs');
const OUT = path.join('window', 'CatHost.exe');
const CORE = path.join('window', 'lib', 'Microsoft.Web.WebView2.Core.dll');
/** A change to any of these means a rebuild. */
const INPUTS = [SRC, path.join('window', 'lib', 'version.txt'), path.join('scripts', 'build-host.js')];

function mtime(rel) {
  try {
    return fs.statSync(path.join(ROOT, rel)).mtimeMs;
  } catch {
    return 0;
  }
}

function findCsc() {
  const net = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET');
  for (const dir of ['Framework64', 'FrameworkArm64', 'Framework']) {
    const csc = path.join(net, dir, 'v4.0.30319', 'csc.exe');
    if (fs.existsSync(csc)) {
      return csc;
    }
  }
  return undefined;
}

function main() {
  if (process.platform !== 'win32') {
    console.log('[build-host] skipped: window/CatHost.exe is only built on Windows.');
    return;
  }
  if (!fs.existsSync(path.join(ROOT, CORE))) {
    throw new Error(`${CORE} is missing; run scripts/fetch-webview2.js first`);
  }
  const built = mtime(OUT);
  if (built && INPUTS.every((f) => mtime(f) < built)) {
    return;
  }
  const csc = findCsc();
  if (!csc) {
    throw new Error('no csc.exe under %SystemRoot%\\Microsoft.NET (the .NET Framework 4 C# compiler)');
  }
  const r = cp.spawnSync(
    csc,
    [
      '/nologo',
      '/target:winexe', // no console window; stdin and stdout are still the extension's pipes
      '/platform:anycpu',
      '/optimize+',
      '/debug-',
      `/out:${OUT}`,
      '/r:System.dll',
      '/r:System.Core.dll',
      '/r:System.Drawing.dll',
      '/r:System.Windows.Forms.dll',
      '/r:System.Web.Extensions.dll',
      `/r:${CORE}`,
      SRC,
    ],
    { cwd: ROOT, encoding: 'utf8', windowsHide: true }
  );
  const output = `${r.stdout || ''}${r.stderr || ''}`.trim();
  if (r.error || r.status !== 0) {
    throw new Error(`csc.exe failed${r.error ? `: ${r.error.message}` : ''}${output ? `\n${output}` : ''}`);
  }
  if (output) {
    console.log(output); // warnings
  }
  console.log(`[build-host] built ${OUT} (${fs.statSync(path.join(ROOT, OUT)).size} bytes)`);
}

try {
  main();
} catch (e) {
  console.error(`[build-host] ${e.message}`);
  process.exit(1);
}
