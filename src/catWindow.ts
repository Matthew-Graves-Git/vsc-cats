import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import type { SurfSet } from './gifs';
import type { MinigameForm } from './discordBrowser';

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
  | { type: 'spawn'; caption: string; surf?: SurfSet }
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

  onYoink: () => void = () => {};
  /** Messages from the minigame terminal: mgGo, mgAnswer { answer }, mgClose. */
  onTerminal: (m: { type: string; answer?: unknown }) => void = () => {};

  constructor(private extensionPath: string, private storageDir: string) {}

  /** Shows the window (starting it if needed) without taking focus. */
  show(): void {
    if (!this.proc && !this.launch()) {
      return;
    }
    this.cmd({ cmd: 'show' });
  }

  hide(): void {
    if (this.proc) {
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
  spawn(caption: string, surf?: SurfSet): void {
    this.show();
    this.last = { type: 'spawn', caption, surf };
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
          proc.kill();
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
      stdio: 'ignore',
      windowsHide: false,
    });
    proc.on('error', () => this.onExit(proc));
    proc.on('exit', () => this.onExit(proc));

    this.proc = proc;
    this.server = server;
    this.ready = false;
    return true;
  }

  private onExit(proc: cp.ChildProcess): void {
    if (this.proc === proc) {
      this.reset(); // respawned on the next show()
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
  }

  private onMessage(m: { type: string }): void {
    if (m.type === 'ready') {
      this.ready = true;
      this.post({ type: 'count', count: this.count });
      this.post(this.last);
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
    if (!this.proc) {
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
