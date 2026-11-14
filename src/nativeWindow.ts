import * as cp from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { PanelMessage } from './catWindow';
import { appendLog, browserJunk } from './discordBrowser';
import { mapClipUrls, renderPanel, Surface, SurfaceEvents } from './surface';

// The frameless cat window (Windows): window/host.cs shows media/panel.html in WebView2, in a
// borderless, always-on-top window the page drags and resizes itself (it never leaves the screen).
// It follows this VS Code window: while that is minimized it hides (catYoink.minimizeWithVSCode).
// It runs as window/CatHost.exe (host.cs compiled when the extension was packaged,
// scripts/build-host.js). If that is missing or doesn't start, powershell.exe compiles host.cs and
// runs it instead, which takes about twice as long. Either way we talk to it over stdin/stdout
// with JSON lines (the protocol is at the top of host.cs).

/** How long it may take until its page says ready: the exe, and PowerShell (which compiles host.cs first). */
const EXE_START_TIMEOUT_MS = 15000;
const POWERSHELL_START_TIMEOUT_MS = 30000;
const LOG_LINES = 200;
const HOST_EXE = 'CatHost.exe';
/** The host's own error for a PC without the WebView2 Runtime (host.cs Fail): PowerShell can't help then. */
const RUNTIME_MISSING = /WebView2 Runtime isn't installed/;

/**
 * CatHost.exe didn't start here (blocked by policy, wrong architecture...): PowerShell is used
 * until the extension is loaded again.
 */
let exeFailed = false;

/** Where the page and its files come from, as the host maps them (window/host.cs). */
const MEDIA_ORIGIN = 'https://cat-yoink.media';
const GIFS_ORIGIN = 'https://cat-yoink.gifs';

/** What it keeps in the extension's storage folder. */
const LAYOUT_FILE = 'window-layout.json';
const WEBVIEW2_DATA = 'window-webview2';
const LIB_COPIES = 'window-lib';
export const WINDOW_LOG = 'window.log';

/** Why the frameless window can't run here, or undefined if it can (it may still fail to start). */
export function nativeUnavailable(extensionPath: string): string | undefined {
  if (process.platform !== 'win32') {
    return 'it needs Windows';
  }
  if (!fs.existsSync(path.join(extensionPath, 'window', 'lib', 'version.txt'))) {
    return 'its WebView2 files are missing from window/lib';
  }
  return undefined;
}

/**
 * The page in the frameless window. hide() only hides it: the process and the page keep running
 * (and receiving messages), so the next cat shows instantly. One process per instance: if it exits
 * by itself, this reports onGone (or `onFailed`, before its page ever said ready) and is done.
 */
export class NativeSurface implements Surface {
  private proc?: cp.ChildProcess;
  /** Its page said ready at least once. */
  private started = false;
  private disposed = false;
  private startTimer?: NodeJS.Timeout;
  /** The last of its output that wasn't a message, for window.log and the error. */
  private tail = '';
  private error?: string;
  private minimizeWith: boolean;
  /** The running process is CatHost.exe, not PowerShell. */
  private viaExe = false;
  private launchedAt = 0;
  private timedOut = false;
  /** What show() / hide() last asked for, for a process started again on the PowerShell path. */
  private wantShown = false;

  /** `onFailed`: it couldn't start; `reason` is shown to the user. */
  constructor(
    private opts: { extensionPath: string; storageDir: string; gifDir: string; minimizeWith: boolean },
    private events: SurfaceEvents,
    private onFailed: (reason: string) => void
  ) {
    this.minimizeWith = opts.minimizeWith;
  }

  show(): void {
    this.wantShown = true;
    if (!this.proc && !this.disposed) {
      this.launch();
    }
    this.cmd({ cmd: 'show' });
  }

  hide(): void {
    this.wantShown = false;
    this.cmd({ cmd: 'hide' });
  }

  post(m: PanelMessage): void {
    this.cmd({ cmd: 'post', json: JSON.stringify(mapClipUrls(m, (f) => this.url(f))) });
  }

  /**
   * Only once its page is ready (CatWindow claims again then): a window still starting reads its
   * input seconds later, when another window may be in front.
   */
  claimOwner(): void {
    if (this.started) {
      this.cmd({ cmd: 'claim' });
    }
  }

  setMinimizeWith(on: boolean): void {
    this.minimizeWith = on; // for a window started later
    this.cmd({ cmd: 'minimizeWith', on });
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    clearTimeout(this.startTimer);
    const proc = this.proc;
    this.proc = undefined;
    if (!proc) {
      return;
    }
    this.write(proc, { cmd: 'quit' });
    proc.stdin?.end(); // it quits on EOF too
    setTimeout(() => kill(proc), 2000).unref();
  }

  // ---- internals ----

  private get mediaDir(): string {
    return path.join(this.opts.extensionPath, 'media');
  }

  private log(text: string): void {
    appendLog(path.join(this.opts.storageDir, WINDOW_LOG), text, LOG_LINES);
  }

  private launch(): void {
    const { extensionPath, storageDir, gifDir } = this.opts;
    let host: { dir: string; exe?: string };
    try {
      host = stageHost(extensionPath, storageDir);
    } catch (e) {
      this.log(`window not started: copying window/lib failed: ${(e as Error).message}`);
      setImmediate(() => !this.disposed && this.onFailed('its WebView2 files could not be copied'));
      return;
    }
    // Before the host starts on it (WebView2 keeps its data in EBWebView). Synchronous, but only the
    // first time is there much to delete: the host stops WebView2 downloading components. Its
    // caches stay (mostly GPU shaders, a few MB), so the window draws its first frames as fast.
    for (const junk of browserJunk(path.join(storageDir, WEBVIEW2_DATA, 'EBWebView'), false)) {
      try {
        fs.rmSync(junk, { recursive: true, force: true });
      } catch {
        // in use after all: next time
      }
    }
    const html = renderPanel(this.mediaDir, {
      csp: `${MEDIA_ORIGIN} ${GIFS_ORIGIN}`,
      nonce: crypto.randomBytes(16).toString('hex'),
      media: MEDIA_ORIGIN,
    });
    const viaExe = !!host.exe && !exeFailed;
    const stdio = { stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'], windowsHide: true };
    let proc: cp.ChildProcess;
    if (viaExe) {
      proc = cp.spawn(host.exe!, [], stdio);
    } else {
      const q = (s: string) => s.replace(/'/g, "''"); // inside a PowerShell '...' string
      const script = [
        "$ErrorActionPreference = 'Stop'",
        "$ProgressPreference = 'SilentlyContinue'",
        `$lib = '${q(host.dir)}'`,
        "$core = Join-Path $lib 'Microsoft.Web.WebView2.Core.dll'",
        '[void][Reflection.Assembly]::LoadFrom($core)',
        `Add-Type -Path '${q(path.join(extensionPath, 'window', 'host.cs'))}' -IgnoreWarnings ` +
          '-ReferencedAssemblies System.Windows.Forms, System.Drawing, System.Web.Extensions, $core',
        '[CatHost]::Run($lib)',
      ].join('; ');
      proc = cp.spawn(powershellExe(), ['-NoProfile', '-NonInteractive', '-Sta', '-Command', script], stdio);
    }
    this.proc = proc;
    this.viaExe = viaExe;
    this.launchedAt = Date.now();
    this.timedOut = false;
    this.error = undefined;
    this.tail = '';
    this.log(`window started (pid ${proc.pid}, ${this.how()})`);
    proc.stdin?.on('error', () => {});
    this.write(proc, {
      cmd: 'init',
      html,
      mediaDir: this.mediaDir,
      gifDir,
      userDataDir: path.join(storageDir, WEBVIEW2_DATA),
      layoutFile: path.join(storageDir, LAYOUT_FILE),
      devTools: !!process.env.CAT_YOINK_DEVTOOLS,
      // How it recognizes this VS Code's windows: they belong to VS Code's main process, which is
      // the extension host's parent (or, failing that, to the same exe).
      codePid: process.ppid,
      codeExe: process.execPath,
      minimizeWith: this.minimizeWith,
    });

    proc.stdout?.setEncoding('utf8');
    let buf = '';
    proc.stdout?.on('data', (chunk: string) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) {
          this.onLine(proc, line);
        }
      }
    });
    proc.stderr?.on('data', (d: Buffer) => this.collect(d.toString()));
    proc.on('error', (err) => {
      this.log(`window failed to start: ${err.message}`);
      this.error ??= err.message;
      this.onExit(proc);
    });
    proc.on('exit', (code, signal) => {
      this.log(`window exited (code ${code}, signal ${signal})${this.tail.trim() ? `\n${this.tail}` : ''}`);
      this.onExit(proc);
    });

    const timeout = viaExe ? EXE_START_TIMEOUT_MS : POWERSHELL_START_TIMEOUT_MS;
    this.startTimer = setTimeout(() => {
      if (this.proc === proc && !this.started) {
        this.log(`window: it didn't open within ${timeout / 1000} s`);
        this.error ??= `it didn't open within ${timeout / 1000} s`;
        this.timedOut = true;
        kill(proc);
      }
    }, timeout);
  }

  /** How the running process was started, for window.log. */
  private how(): string {
    return this.viaExe ? 'prebuilt' : 'compiled by PowerShell';
  }

  private onLine(proc: cp.ChildProcess, line: string): void {
    let m: { t?: unknown; msg?: { type?: unknown }; text?: unknown } | undefined;
    try {
      m = line.startsWith('{') ? JSON.parse(line) : undefined;
    } catch {
      m = undefined;
    }
    if (!m || typeof m.t !== 'string') {
      this.collect(line + '\n'); // PowerShell's own output, e.g. a compile error
      return;
    }
    if (proc !== this.proc && m.t !== 'log') {
      return; // disposed: only its last words still go to window.log
    }
    switch (m.t) {
      case 'page':
        if (m.msg && typeof m.msg.type === 'string') {
          if (m.msg.type === 'ready') {
            if (!this.started) {
              this.log(`window ready in ${Date.now() - this.launchedAt} ms (${this.how()})`);
            }
            this.started = true;
            clearTimeout(this.startTimer);
          }
          this.events.onMessage(m.msg as { type: string });
        }
        break;
      case 'closed':
        this.events.onClosed();
        break;
      case 'log':
        this.log(`window: ${String(m.text)}`);
        break;
      case 'error':
        this.error = String(m.text);
        this.log(`window error: ${this.error}`);
        break;
    }
  }

  private onExit(proc: cp.ChildProcess): void {
    if (proc !== this.proc) {
      return; // disposed, or already handled ('error' and 'exit' can both fire)
    }
    this.proc = undefined;
    clearTimeout(this.startTimer);
    if (this.disposed) {
      return;
    }
    if (this.started) {
      this.events.onGone();
      return;
    }
    const reason = this.error ?? lastLine(this.tail) ?? 'it closed while starting';
    // The exe couldn't run here: PowerShell compiling host.cs may still work. Not after a timeout
    // or without the WebView2 Runtime, which would fail the same way.
    if (this.viaExe && !this.timedOut && !RUNTIME_MISSING.test(reason)) {
      exeFailed = true;
      this.log(`window: ${HOST_EXE} didn't start (${reason}); compiling host.cs with PowerShell instead`);
      this.launch();
      if (this.wantShown) {
        this.cmd({ cmd: 'show' });
      }
      return;
    }
    this.onFailed(reason);
  }

  private collect(text: string): void {
    this.tail = (this.tail + text).slice(-3000);
  }

  private cmd(c: object): void {
    if (this.proc) {
      this.write(this.proc, c);
    }
  }

  private write(proc: cp.ChildProcess, c: object): void {
    if (proc.stdin?.writable) {
      proc.stdin.write(JSON.stringify(c) + '\n');
    }
  }

  /** A GIF clip's URL in the window: the GIF folder and media/ are mapped to their own origins. */
  private url(file: string): string {
    const roots: [string, string][] = [
      [this.opts.gifDir, GIFS_ORIGIN],
      [this.mediaDir, MEDIA_ORIGIN],
    ];
    for (const [root, origin] of roots) {
      const rel = path.relative(root, file);
      if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
        return `${origin}/${rel.split(path.sep).map(encodeURIComponent).join('/')}`;
      }
    }
    return ''; // outside both: the page can't load it (as with the webview's localResourceRoots)
  }
}

/** Windows PowerShell 5.1, which every Windows 10/11 has (its Add-Type compiles C# 5). */
function powershellExe(): string {
  const exe = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return fs.existsSync(exe) ? exe : 'powershell.exe';
}

/** Ends the window and its WebView2 processes if it is still running. */
function kill(proc: cp.ChildProcess): void {
  if (proc.exitCode === null && proc.signalCode === null && proc.pid) {
    cp.execFile('taskkill.exe', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true }, () => {});
  }
}

function lastLine(text: string): string | undefined {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .pop();
}

/**
 * Copies window/lib, and window/CatHost.exe if this build has one, to <storage>/window-lib/<key>
 * (once per key) and returns that folder and the exe in it. The key is the SDK version plus a hash
 * of the exe, so a rebuilt exe gets a folder of its own. The window runs from the copy, so a
 * running window never locks the extension folder, which reinstalls and scripts/sync-install.js
 * replace. Other copies are removed (one a running window still holds stays until next time).
 */
function stageHost(extensionPath: string, storageDir: string): { dir: string; exe?: string } {
  const windowDir = path.join(extensionPath, 'window');
  const src = path.join(windowDir, 'lib');
  const version = fs.readFileSync(path.join(src, 'version.txt'), 'utf8').trim();
  let exe: Buffer | undefined;
  try {
    exe = fs.readFileSync(path.join(windowDir, HOST_EXE));
  } catch {
    // a build without it (packaged on another platform): PowerShell compiles host.cs
  }
  const key = exe ? `${version}-${crypto.createHash('sha1').update(exe).digest('hex').slice(0, 12)}` : version;
  const root = path.join(storageDir, LIB_COPIES);
  const dst = path.join(root, key);
  if (!fs.existsSync(path.join(dst, 'version.txt'))) {
    const tmp = `${dst}.tmp-${process.pid}`;
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.cpSync(src, tmp, { recursive: true });
    if (exe) {
      fs.writeFileSync(path.join(tmp, HOST_EXE), exe);
    }
    fs.rmSync(dst, { recursive: true, force: true }); // an incomplete copy, if any
    try {
      fs.renameSync(tmp, dst);
    } catch (e) {
      fs.rmSync(tmp, { recursive: true, force: true });
      if (!fs.existsSync(path.join(dst, 'version.txt'))) {
        throw e; // not just another VS Code window that got there first
      }
    }
  }
  for (const name of fs.readdirSync(root)) {
    if (name !== key && !name.includes('.tmp-')) {
      fs.rm(path.join(root, name), { recursive: true, force: true }, () => {});
    }
  }
  return { dir: dst, exe: exe ? path.join(dst, HOST_EXE) : undefined };
}
