import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import type { RainCat, RainScene, SurfSet } from './gifs';
import { appendLog, run } from './discordBrowser';
import type { MinigameForm } from './discordBrowser';

/** A window that dies this soon after launch, before saying "ready", is reported as a failed start. */
const EARLY_EXIT_MS = 5000;
const LOG_LINES = 200;

/**
 * Windows only: ends Cat Yoink windows left behind by an earlier build or a crashed extension
 * host. Only windows of this extension whose parent is this extension host (a previous core after
 * a hot reload) or no longer exists are killed; windows owned by other live VS Code windows stay.
 */
async function killStaleWindows(extensionPath: string): Promise<void> {
  if (process.platform !== 'win32') {
    return;
  }
  const needle = path.join(extensionPath, 'window', 'main.js').toLowerCase().replace(/'/g, "''");
  const script =
    `$all = @(Get-CimInstance Win32_Process); $ids = @{}; $all | ForEach-Object { $ids[[int]$_.ProcessId] = 1 }; ` +
    `$all | Where-Object { $_.Name -eq 'electron.exe' -and $_.CommandLine -and $_.CommandLine -notmatch '--type=' -and ` +
    `$_.CommandLine.ToLower().Contains('${needle}') -and ` +
    `($_.ParentProcessId -eq ${process.pid} -or -not $ids.ContainsKey([int]$_.ParentProcessId)) } | ` +
    `ForEach-Object { $_.ProcessId }`;
  const out = await run('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    script,
  ]);
  for (const pid of out.split(/\s+/).map(Number).filter((n) => Number.isInteger(n) && n > 0)) {
    await run('taskkill.exe', ['/PID', String(pid), '/T', '/F']);
  }
}

/** What the minigame terminal popup (media/terminal.js) shows. */
export type TerminalMessage =
  | { type: 'offer'; text: string; test?: boolean }
  | { type: 'question'; form: MinigameForm }
  | { type: 'submitted' }
  | { type: 'error'; text: string }
  | { type: 'result'; text: string; win: boolean }
  | { type: 'expired' };

export type PanelMessage =
  | { type: 'idle' }
  /** Watching just started: no cat, and no Nyan yet either until we know whether a cat is out. */
  | { type: 'loading' }
  /**
   * `id`: the spawn message's id, so two cats of the same type in a row are told apart.
   * `skipIntro`: the cat was already there, so show its loop right away (no surf-in / rain enter).
   */
  | { type: 'spawn'; id: string; title: string; surf?: SurfSet; rain?: RainCat; skipIntro?: boolean }
  /** Clips for spawn `id` that finished downloading after it appeared: it animates in at the next loop. */
  | { type: 'gifs'; id: string; surf?: SurfSet; rain?: RainCat }
  /**
   * A cat rain started (`scene` set) or ended (`on` false). `skipIntro`: it was already raining,
   * so show the storm right away (no Nyan → rain start transition).
   */
  | { type: 'rain'; on: boolean; scene?: RainScene; skipIntro?: boolean }
  | { type: 'tooSlow'; text: string }
  | { type: 'status'; text: string }
  | { type: 'result'; text: string; caught: boolean }
  | { type: 'count'; count: number }
  | { type: 'term'; msg: TerminalMessage };

/** `catYoink.windowMode`: inside the watching VS Code window (Windows only), or free-floating. */
export type WindowMode = 'insideVSCode' | 'floating';

export function windowModeSetting(): WindowMode {
  return vscode.workspace.getConfiguration('catYoink').get<string>('windowMode') === 'floating'
    ? 'floating'
    : 'insideVSCode';
}

/**
 * The Cat Yoink window: a frameless Electron window (window/main.js) that shows the Nyan /
 * surfing-cat GIFs and the Yoink button. By default it lives inside this VS Code window (it
 * follows it, stays stacked just above it and hides while it is minimized); in floating mode it
 * is a free always-on-top window. It remembers its own position and size. We talk to it over a
 * named pipe with JSON lines.
 */
export class CatWindow {
  private proc?: cp.ChildProcess;
  private server?: net.Server;
  private sock?: net.Socket;
  private outbox: string[] = [];
  private ready = false;
  private queue: PanelMessage[] = [];
  private last: PanelMessage = { type: 'idle' };
  /** The rain message while a cat rain is on, replayed (before `last`) to a fresh window. */
  private rainMsg?: Extract<PanelMessage, { type: 'rain' }>;
  private count = 0;
  private mode: WindowMode = windowModeSetting();
  /** We asked for the window to be shown and the user hasn't closed it since. */
  private wanted = false;
  private errorShown = false;
  /** True while stale windows are being cleaned up, before the new window is spawned. */
  private launching = false;
  /** Bumped by dispose() so a launch that was still cleaning up doesn't spawn afterwards. */
  private generation = 0;

  onYoink: () => void = () => {};
  /** Messages from the minigame terminal: mgGo, mgAnswer { answer }, mgClose. */
  onTerminal: (m: { type: string; answer?: unknown }) => void = () => {};

  constructor(private extensionPath: string, private storageDir: string) {}

  /** Shows the window (starting it if needed) without taking focus. */
  show(): void {
    this.wanted = true;
    if (!this.proc && !this.launching && !this.launch()) {
      return;
    }
    this.cmd({ cmd: 'show' }); // buffered until the window connects if it is still starting
  }

  hide(): void {
    this.wanted = false;
    if (this.proc || this.launching) {
      this.cmd({ cmd: 'hide' });
    }
  }

  /** Switches between inside-VS Code and floating by restarting the window. */
  async setMode(mode: WindowMode): Promise<void> {
    if (mode === this.mode) {
      return;
    }
    this.mode = mode;
    if (!this.proc && !this.launching) {
      return; // the next launch uses the new mode
    }
    const reopen = this.wanted;
    await this.dispose();
    if (reopen) {
      this.show();
    }
  }

  /**
   * Tells the window that this VS Code window is in front, so it can attach to it. Call it when
   * this VS Code window gets focus. Not buffered: by the time a starting window connected, the
   * foreground window may be a different one. `force` re-attaches even if already attached.
   */
  claimOwner(force = false): void {
    if (this.mode === 'insideVSCode' && this.sock && !this.sock.destroyed) {
      this.sock.write(JSON.stringify({ cmd: force ? 'reclaim' : 'claim' }) + '\n');
    }
  }

  setCount(count: number): void {
    this.count = count;
    this.send({ type: 'count', count });
  }

  idle(): void {
    this.last = { type: 'idle' };
    this.send(this.last);
  }

  /** Watching started; idle() or spawn() follows once the channel has been checked. */
  loading(): void {
    this.last = { type: 'loading' };
    this.send(this.last);
  }

  /**
   * A cat appeared. `surf` (or `rain`, during a cat rain) animates it in; without one, Nyan (or the
   * empty storm) keeps looping under the overlay.
   */
  spawn(id: string, title: string, surf?: SurfSet, rain?: RainCat, skipIntro = false): void {
    this.show();
    this.last = { type: 'spawn', id, title, surf, rain, skipIntro };
    this.send(this.last);
  }

  /** Spawn `id`'s clips arrived after it appeared (it is still out): the window animates it in. */
  gifs(id: string, surf?: SurfSet, rain?: RainCat): void {
    if (this.last.type === 'spawn' && this.last.id === id) {
      // In place: if this spawn is still queued for a launching window, it goes out with its clips.
      this.last.surf ??= surf;
      this.last.rain ??= rain;
    }
    this.send({ type: 'gifs', id, surf, rain });
  }

  /** A cat rain started (`scene`) or ended (undefined). `skipIntro`: it was already raining. */
  rain(scene: RainScene | undefined, skipIntro = false): void {
    if (scene) {
      this.show();
      this.rainMsg = { type: 'rain', on: true, scene, skipIntro };
      this.send(this.rainMsg);
    } else if (this.rainMsg) {
      this.rainMsg = undefined;
      this.send({ type: 'rain', on: false });
    }
  }

  tooSlow(text: string): void {
    this.last = { type: 'tooSlow', text };
    this.send(this.last);
  }

  result(text: string, caught: boolean): void {
    this.last = { type: 'result', text, caught };
    this.send(this.last);
  }

  /** Interim status text under the cat (e.g. while checking for a late catch). */
  status(text: string): void {
    this.send({ type: 'status', text });
  }

  /** Drives the minigame terminal popup inside the window. Not replayed on restart. */
  terminal(msg: TerminalMessage): void {
    this.show();
    this.send({ type: 'term', msg });
  }

  /** Closes the window process; resolves once it has exited (killed after 1 s if needed). */
  dispose(): Promise<void> {
    const proc = this.proc;
    if (!proc) {
      this.generation++; // cancels a launch that is still cleaning up stale windows
      this.reset();
      return Promise.resolve();
    }
    const exited = new Promise<void>((resolve) => {
      if (proc.exitCode !== null) {
        resolve();
        return;
      }
      proc.once('exit', () => resolve());
      setTimeout(() => {
        if (proc.exitCode === null) {
          if (process.platform === 'win32' && proc.pid) {
            // Take the window's GPU and renderer processes with it.
            cp.execFile('taskkill.exe', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true }, () => {});
          } else {
            proc.kill();
          }
        }
      }, 1000).unref();
      setTimeout(resolve, 2000).unref(); // never hang a reload or shutdown
    });
    this.cmd({ cmd: 'quit' });
    this.reset();
    return exited;
  }

  // ---- internals ----

  private electronPath(): string | undefined {
    const dir = path.join(this.extensionPath, 'node_modules', 'electron');
    try {
      const exe = path.join(dir, 'dist', fs.readFileSync(path.join(dir, 'path.txt'), 'utf8').trim());
      return fs.existsSync(exe) ? exe : undefined;
    } catch {
      return undefined;
    }
  }

  /** Appends a line to <storage>/window.log (last LOG_LINES lines kept). */
  private log(text: string): void {
    appendLog(path.join(this.storageDir, 'window.log'), text, LOG_LINES);
  }

  private launch(): boolean {
    const exe = this.electronPath();
    if (!exe) {
      if (!this.errorShown) {
        this.errorShown = true;
        void vscode.window.showErrorMessage(
          'Cat Yoink window unavailable: Electron is missing. Run "npm install" in the extension folder.'
        );
      }
      return false;
    }
    // Clear out windows left by an earlier build first (they'd keep answering with old code),
    // then spawn. Messages sent meanwhile are buffered in outbox/queue.
    const gen = ++this.generation;
    this.launching = true;
    void killStaleWindows(this.extensionPath)
      .catch(() => {})
      .then(() => {
        if (gen === this.generation) {
          this.spawnWindow(exe);
        }
      });
    return true;
  }

  private spawnWindow(exe: string): void {
    this.launching = false;
    const id = `cat-yoink-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    const pipe = process.platform === 'win32' ? `\\\\.\\pipe\\${id}` : path.join(os.tmpdir(), `${id}.sock`);

    const server = net.createServer((sock) => {
      if (this.sock) {
        sock.destroy(); // only one window per process
        return;
      }
      this.sock = sock;
      sock.setEncoding('utf8');
      let buf = '';
      sock.on('data', (chunk: string) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          try {
            this.onMessage(JSON.parse(line));
          } catch {
            // ignore malformed lines
          }
        }
      });
      sock.on('error', () => {});
      for (const line of this.outbox.splice(0)) {
        sock.write(line);
      }
    });
    server.on('error', () => {});
    server.listen(pipe);

    // The extension host runs with ELECTRON_RUN_AS_NODE set; Electron must not inherit it.
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CAT_YOINK_PIPE: pipe,
      CAT_YOINK_STATE: path.join(this.storageDir, 'window.json'),
      CAT_YOINK_USER_DATA: path.join(this.storageDir, 'window-profile'),
      CAT_YOINK_MODE: this.mode === 'floating' ? 'floating' : 'inside',
      // How window/tracker.cs recognizes this VS Code's windows: they belong to VS Code's main
      // process, which is the extension host's parent (or, failing that, to the same exe).
      CAT_YOINK_CODE_PID: String(process.ppid),
      CAT_YOINK_CODE_EXE: process.execPath,
      CAT_YOINK_OWNER_HINT: this.ownerHint(),
    };
    delete env.ELECTRON_RUN_AS_NODE;

    const proc = cp.spawn(exe, [path.join(this.extensionPath, 'window', 'main.js')], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: false,
    });
    // Keep the tail of the window's output so a window that dies on launch leaves a trace.
    let tail = '';
    const collect = (d: Buffer) => {
      tail = (tail + d.toString()).slice(-3000);
    };
    proc.stdout?.on('data', collect);
    proc.stderr?.on('data', collect);
    const startedAt = Date.now();
    this.log(`window started (pid ${proc.pid})`);
    proc.on('error', (err) => {
      this.log(`window failed to spawn: ${err.message}`);
      this.onExit(proc, startedAt, tail);
    });
    proc.on('exit', (code, signal) => {
      this.log(`window exited (code ${code}, signal ${signal})\n${tail}`);
      this.onExit(proc, startedAt, tail);
    });

    this.proc = proc;
    this.server = server;
    this.ready = false;
  }

  private onExit(proc: cp.ChildProcess, startedAt: number, tail: string): void {
    if (this.proc !== proc) {
      return; // we closed it ourselves (dispose) or it was already handled
    }
    const diedEarly = !this.ready && Date.now() - startedAt < EARLY_EXIT_MS;
    this.reset(); // respawned on the next show()
    if (diedEarly && !this.errorShown) {
      this.errorShown = true;
      void vscode.window.showErrorMessage(
        `Cat Yoink window failed to start: see window.log in the extension storage folder. ${tail.trim().split('\n').pop() ?? ''}`.trim()
      );
    }
  }

  private reset(): void {
    this.sock?.destroy();
    this.server?.close();
    this.proc = undefined;
    this.server = undefined;
    this.sock = undefined;
    this.outbox = [];
    this.ready = false;
    this.queue = [];
    this.launching = false;
  }

  private get ownerFile(): string {
    return path.join(this.storageDir, 'window-owner.json');
  }

  /**
   * The VS Code window handle the previous cat window attached to, if that was in this extension
   * host (a hot reload respawns the cat window, but the VS Code window and its PID stay).
   */
  private ownerHint(): string {
    try {
      const o = JSON.parse(fs.readFileSync(this.ownerFile, 'utf8'));
      return o.pid === process.pid && Number.isInteger(o.hwnd) ? String(o.hwnd) : '';
    } catch {
      return '';
    }
  }

  private onMessage(m: { type: string; hwnd?: number }): void {
    if (m.type === 'owner') {
      try {
        fs.mkdirSync(this.storageDir, { recursive: true });
        fs.writeFileSync(this.ownerFile, JSON.stringify({ pid: process.pid, hwnd: m.hwnd }));
      } catch {
        // only used to reattach faster after a hot reload
      }
      return;
    }
    if (m.type === 'closed') {
      this.wanted = false; // the user closed it; the next cat reopens it
      return;
    }
    if (m.type === 'ready') {
      this.ready = true;
      if (vscode.window.state.focused) {
        this.claimOwner();
      }
      this.post({ type: 'count', count: this.count });
      // A fresh window mid-rain or mid-cat (relaunched) shows the storm and that cat's loop straight
      // away. If a message is still queued, it's what launched the window, so it keeps its intro.
      if (this.rainMsg && !this.queue.includes(this.rainMsg)) {
        this.post({ ...this.rainMsg, skipIntro: true });
      }
      if (!this.queue.includes(this.last)) {
        this.post(this.last.type === 'spawn' ? { ...this.last, skipIntro: true } : this.last);
      }
      for (const q of this.queue.splice(0)) {
        this.post(q);
      }
    } else if (m.type === 'yoink') {
      this.onYoink();
    } else if (m.type.startsWith('mg')) {
      this.onTerminal(m);
    }
  }

  private send(m: PanelMessage): void {
    if (!this.proc && !this.launching) {
      return; // the window replays count and last state when it starts
    }
    if (this.ready) {
      this.post(m);
    } else {
      this.queue.push(m);
    }
  }

  private post(msg: PanelMessage): void {
    this.cmd({ cmd: 'post', msg });
  }

  private cmd(c: object): void {
    const line = JSON.stringify(c) + '\n';
    if (this.sock && !this.sock.destroyed) {
      this.sock.write(line);
    } else {
      this.outbox.push(line);
    }
  }
}
