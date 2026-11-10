import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import type { SurfSet } from './gifs';
import { run } from './discordBrowser';
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
    '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64'),
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
  /** `skipIntro`: the cat was already there, so show its surf loop right away (no Nyan → surf-in). */
  | { type: 'spawn'; title: string; surf?: SurfSet; skipIntro?: boolean }
  | { type: 'tooSlow'; text: string }
  | { type: 'status'; text: string }
  | { type: 'result'; text: string; caught: boolean }
  | { type: 'count'; count: number }
  | { type: 'term'; msg: TerminalMessage };

/**
 * The Cat Yoink window: a frameless, always-on-top Electron window (window/main.js) that shows
 * the Nyan / surfing-cat GIFs and the Yoink button. It remembers its own position and size.
 * We talk to it over a named pipe with JSON lines.
 */
export class CatWindow {
  private proc?: cp.ChildProcess;
  private server?: net.Server;
  private sock?: net.Socket;
  private outbox: string[] = [];
  private ready = false;
  private queue: PanelMessage[] = [];
  private last: PanelMessage = { type: 'idle' };
  private count = 0;
  private onTop = vscode.workspace.getConfiguration('catYoink').get<boolean>('alwaysOnTop', true);
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
    if (!this.proc && !this.launching && !this.launch()) {
      return;
    }
    this.cmd({ cmd: 'show' }); // buffered until the window connects if it is still starting
  }

  hide(): void {
    if (this.proc || this.launching) {
      this.cmd({ cmd: 'hide' });
    }
  }

  setAlwaysOnTop(onTop: boolean): void {
    this.onTop = onTop;
    if (this.proc) {
      this.cmd({ cmd: 'config', alwaysOnTop: onTop });
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

  /** A cat appeared. `surf` animates it in; without one, Nyan keeps looping under the overlay. */
  spawn(title: string, surf?: SurfSet, skipIntro = false): void {
    this.show();
    this.last = { type: 'spawn', title, surf, skipIntro };
    this.send(this.last);
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
    try {
      fs.mkdirSync(this.storageDir, { recursive: true });
      const file = path.join(this.storageDir, 'window.log');
      let lines: string[] = [];
      try {
        lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
      } catch {
        // first entry
      }
      for (const l of text.split('\n').filter((s) => s.trim())) {
        lines.push(`${new Date().toISOString()} ${l.trim().slice(0, 500)}`);
      }
      fs.writeFileSync(file, lines.slice(-LOG_LINES).join('\n') + '\n');
    } catch {
      // logging is best effort
    }
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
      CAT_YOINK_ON_TOP: this.onTop ? '1' : '0',
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

  private onMessage(m: { type: string }): void {
    if (m.type === 'ready') {
      this.ready = true;
      this.post({ type: 'count', count: this.count });
      // A fresh window mid-cat (relaunched) shows that cat's loop straight away. If the spawn is
      // still queued, it's what launched the window: a new cat, which keeps its surf-in intro.
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
