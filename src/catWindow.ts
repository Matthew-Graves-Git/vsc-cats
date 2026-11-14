import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { RainCat, RainScene, SurfSet } from './gifs';
import type { MinigameForm } from './discordBrowser';
import { appendLog } from './discordBrowser';
import { NativeSurface, nativeUnavailable, WINDOW_LOG } from './nativeWindow';
import { mapClipUrls, renderPanel, Surface, SurfaceEvents } from './surface';

/** The webview panel's type; core.ts registers a serializer for it so VS Code restores the window. */
export const VIEW_TYPE = 'catYoink';

const MOVE_TO_NEW_WINDOW = 'workbench.action.moveEditorToNewWindow';
/** VS Code 1.100+: floating windows can be compact (less chrome) and always on top. */
const COMPACT = 'workbench.action.enableCompactAuxiliaryWindow';
const ALWAYS_ON_TOP = 'workbench.action.enableWindowAlwaysOnTop';

/** The frameless window closing by itself this often in a session switches to VS Code's floating window. */
const MAX_CRASHES = 3;

/** What the Electron cat window of earlier versions left in the storage folder (window.log is reused). */
const OLD_WINDOW_FILES = ['window-profile', 'window.json', 'window-owner.json'];

/** Deletes what the Electron cat window of earlier versions left in the storage folder. Best effort. */
export function removeOldWindowFiles(storageDir: string): void {
  for (const name of OLD_WINDOW_FILES) {
    void fs.promises.rm(path.join(storageDir, name), { recursive: true, force: true }).catch(() => {});
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
  /**
   * `id`: the spawn message's id, so two cats of the same type in a row are told apart.
   * `skipIntro`: for a page that starts while the cat is out, so it shows the cat's loop right
   * away (no surf-in / rain enter).
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

/** `catYoink.minimizeWithVSCode`: the frameless window hides while its VS Code window is minimized. */
export function minimizeWithSetting(): boolean {
  return vscode.workspace.getConfiguration('catYoink').get<boolean>('minimizeWithVSCode', true);
}

/**
 * The Cat Yoink window: media/panel.html, which shows the Nyan / surfing-cat GIFs and the Yoink
 * button. It keeps what the page shows and replays it whenever a page starts (says `ready`); the
 * page itself lives on a Surface: on Windows the frameless window (src/nativeWindow.ts), kept on
 * top; elsewhere, or if that can't start, a VS Code webview moved into its own VS Code window.
 */
export class CatWindow {
  private surface?: Surface;
  private ready = false;
  private queue: PanelMessage[] = [];
  private last: PanelMessage = { type: 'idle' };
  /** The rain message while a cat rain is on, replayed (before `last`) to a fresh page. */
  private rainMsg?: Extract<PanelMessage, { type: 'rain' }>;
  private count = 0;
  private minimizeWith = minimizeWithSetting();
  /** We asked for the window to be shown and the user hasn't closed it since. */
  private wanted = false;
  /** Why the frameless window isn't used this session (VS Code's floating window is used then). */
  private nativeOff?: string;
  private crashes = 0;
  private warned = false;

  onYoink: () => void = () => {};
  /** Messages from the minigame terminal: mgGo, mgAnswer { answer }, mgClose. */
  onTerminal: (m: { type: string; answer?: unknown }) => void = () => {};

  /** `gifDir`: the downloaded surf and rain GIFs (src/gifSync.ts), which the page may load. */
  constructor(private extensionUri: vscode.Uri, private gifDir: vscode.Uri, private storageDir: string) {}

  /** Shows the window (opening it if needed). Never takes focus once it is open. */
  show(): void {
    this.wanted = true;
    (this.surface ??= this.create()).show();
  }

  /** The frameless window just hides (the next cat shows it instantly); a webview closes. */
  hide(): void {
    this.wanted = false;
    const surface = this.surface;
    if (surface?.hide) {
      surface.hide();
    } else {
      this.dispose();
    }
  }

  /** Whether the frameless window hides while its VS Code window is minimized. */
  setMinimizeWith(on: boolean): void {
    this.minimizeWith = on;
    this.surface?.setMinimizeWith?.(on);
  }

  /** Call when this VS Code window gets focus: the frameless window learns which window it follows. */
  claimOwner(): void {
    this.surface?.claimOwner?.();
  }

  /**
   * Takes over a webview VS Code restored after a restart (in the window and place the user left
   * it). Closed instead if there is a cat window already, or the frameless window replaces it.
   */
  adopt(panel: vscode.WebviewPanel): void {
    if (this.surface || this.useNative()) {
      panel.dispose();
      return;
    }
    this.wanted = true;
    this.surface = this.webview(panel);
  }

  setCount(count: number): void {
    this.count = count;
    this.send({ type: 'count', count });
  }

  idle(): void {
    this.last = { type: 'idle' };
    this.send(this.last);
  }

  /**
   * A cat appeared. `surf` (or `rain`, during a cat rain) animates it in; without one, Nyan (or the
   * empty storm) keeps looping under the overlay.
   */
  spawn(id: string, title: string, surf?: SurfSet, rain?: RainCat): void {
    this.show();
    this.last = { type: 'spawn', id, title, surf, rain };
    this.send(this.last);
  }

  /** Spawn `id`'s clips arrived after it appeared (it is still out): the window animates it in. */
  gifs(id: string, surf?: SurfSet, rain?: RainCat): void {
    if (this.last.type === 'spawn' && this.last.id === id) {
      // In place: if this spawn is still queued for a loading page, it goes out with its clips.
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

  /** Drives the minigame terminal popup inside the window. Not replayed when the page reloads. */
  terminal(msg: TerminalMessage): void {
    this.show();
    this.send({ type: 'term', msg });
  }

  /** Closes the window. The count and last state are replayed when it opens again. */
  dispose(): void {
    const surface = this.surface;
    this.reset();
    surface?.dispose();
  }

  // ---- internals ----

  private get mediaUri(): vscode.Uri {
    return vscode.Uri.joinPath(this.extensionUri, 'media');
  }

  /** The frameless window, unless it can't run here or failed this session. */
  private useNative(): boolean {
    if (this.nativeOff) {
      return false;
    }
    const why = nativeUnavailable(this.extensionUri.fsPath);
    if (why) {
      this.nativeOff = why;
      if (process.platform === 'win32') {
        this.warnFallback(why); // expected elsewhere; on Windows it's a broken install
      }
      return false;
    }
    return true;
  }

  private create(): Surface {
    return this.useNative() ? this.native() : this.webview();
  }

  private native(): Surface {
    const surface: Surface = new NativeSurface(
      {
        extensionPath: this.extensionUri.fsPath,
        storageDir: this.storageDir,
        gifDir: this.gifDir.fsPath,
        minimizeWith: this.minimizeWith,
      },
      this.eventsFor(() => surface),
      (reason) => {
        if (this.surface === surface) {
          this.reset();
          this.fallBack(reason);
        }
      }
    );
    return surface;
  }

  private webview(restored?: vscode.WebviewPanel): Surface {
    const surface: Surface = new WebviewSurface(this.mediaUri, this.gifDir, this.eventsFor(() => surface), restored);
    return surface;
  }

  /** Events from `self()`, ignored once it is no longer the current surface. */
  private eventsFor(self: () => Surface): SurfaceEvents {
    const current = () => this.surface !== undefined && this.surface === self();
    return {
      onMessage: (m) => {
        if (current()) {
          this.onMessage(m);
        }
      },
      onClosed: () => {
        if (current()) {
          this.wanted = false; // the next cat reopens it
        }
      },
      onGone: () => {
        if (current()) {
          this.gone();
        }
      },
    };
  }

  /** The surface went away by itself: the user closed the webview, or the frameless window exited. */
  private gone(): void {
    const crashed = this.surface instanceof NativeSurface;
    this.reset();
    if (!crashed) {
      return;
    }
    if (++this.crashes >= MAX_CRASHES) {
      this.fallBack('it kept closing unexpectedly');
    } else if (this.wanted) {
      this.show(); // a fresh one, which gets the current state replayed
    }
  }

  /** The frameless window can't be used this session: VS Code's floating window is used instead. */
  private fallBack(reason: string): void {
    this.nativeOff = reason;
    this.warnFallback(reason);
    if (this.wanted) {
      this.show();
    }
  }

  private warnFallback(reason: string): void {
    appendLog(path.join(this.storageDir, WINDOW_LOG), `frameless window off for this session: ${reason}`);
    if (this.warned) {
      return;
    }
    this.warned = true;
    void vscode.window.showWarningMessage(
      `Cat Yoink: the cat window couldn't open frameless (${reason}), so it uses a VS Code floating window ` +
        `for now. Details are in ${WINDOW_LOG} in Cat Yoink's storage folder.`
    );
  }

  private reset(): void {
    this.surface = undefined;
    this.ready = false;
    this.queue = [];
  }

  private onMessage(m: { type: string; answer?: unknown }): void {
    switch (m.type) {
      case 'ready': {
        // Also after the page reloads (e.g. moving into its own window): replay the current state.
        this.ready = true;
        if (vscode.window.state.focused) {
          this.claimOwner(); // the foreground window is this VS Code window
        }
        this.post({ type: 'count', count: this.count });
        // A fresh page mid-rain or mid-cat shows the storm and that cat's loop straight away. If a
        // message is still queued, it's what opened the window, so it keeps its intro.
        if (this.rainMsg && !this.queue.includes(this.rainMsg)) {
          this.post({ ...this.rainMsg, skipIntro: true });
        }
        if (!this.queue.includes(this.last)) {
          this.post(this.last.type === 'spawn' ? { ...this.last, skipIntro: true } : this.last);
        }
        for (const q of this.queue.splice(0)) {
          this.post(q);
        }
        break;
      }
      case 'yoink':
        this.onYoink();
        break;
      case 'close':
        this.hide(); // watching continues; the next cat reopens the window
        break;
      case 'mgGo':
      case 'mgClose':
        this.onTerminal({ type: m.type });
        break;
      case 'mgAnswer':
        this.onTerminal({ type: m.type, answer: String(m.answer ?? '').slice(0, 4000) });
        break;
    }
  }

  private send(m: PanelMessage): void {
    if (!this.surface) {
      return; // the page replays count and last state when it opens
    }
    if (this.ready) {
      this.post(m);
    } else {
      this.queue.push(m);
    }
  }

  private post(m: PanelMessage): void {
    this.surface?.post(m);
  }
}

/**
 * The page in a VS Code webview, moved into its own VS Code window, made compact and always on top
 * where VS Code supports that. VS Code restores it where the user left it after a restart
 * (`restored`, via CatWindow.adopt()).
 */
class WebviewSurface implements Surface {
  private panel?: vscode.WebviewPanel;
  private subs: vscode.Disposable[] = [];

  constructor(
    private mediaUri: vscode.Uri,
    private gifDir: vscode.Uri,
    private events: SurfaceEvents,
    restored?: vscode.WebviewPanel
  ) {
    if (restored) {
      restored.webview.options = this.options();
      this.attach(restored);
    }
  }

  show(): void {
    if (!this.panel) {
      this.open();
    } else if (!this.panel.visible) {
      this.panel.reveal(undefined, true);
    }
  }

  post(m: PanelMessage): void {
    const webview = this.panel?.webview;
    if (webview) {
      void webview.postMessage(mapClipUrls(m, (file) => webview.asWebviewUri(vscode.Uri.file(file)).toString()));
    }
  }

  dispose(): void {
    const panel = this.panel;
    this.detach();
    panel?.dispose();
  }

  private options(): vscode.WebviewOptions {
    return { enableScripts: true, localResourceRoots: [this.mediaUri, this.gifDir] };
  }

  private open(): void {
    const panel = vscode.window.createWebviewPanel(
      VIEW_TYPE,
      'Cat Yoink',
      // It has to be the active editor for the move into its own window.
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      // Keeps the GIF sequence running while the tab is behind another one.
      { ...this.options(), retainContextWhenHidden: true }
    );
    this.attach(panel);
    void this.float(panel);
  }

  /** Moves a new panel into its own VS Code window, made compact and always on top where supported. */
  private async float(panel: vscode.WebviewPanel): Promise<void> {
    try {
      const commands = new Set(await vscode.commands.getCommands(true));
      if (this.panel !== panel || !commands.has(MOVE_TO_NEW_WINDOW)) {
        return; // closed meanwhile, or a VS Code without floating windows: it stays a tab
      }
      if (!panel.active) {
        panel.reveal(undefined, false); // the move acts on the active editor
      }
      await vscode.commands.executeCommand(MOVE_TO_NEW_WINDOW);
      // These act on the focused window, which is the new one now.
      for (const id of [COMPACT, ALWAYS_ON_TOP]) {
        if (this.panel === panel && commands.has(id)) {
          await vscode.commands.executeCommand(id);
        }
      }
    } catch {
      // it stays where it is
    }
  }

  private attach(panel: vscode.WebviewPanel): void {
    this.panel = panel;
    panel.iconPath = vscode.Uri.joinPath(this.mediaUri, 'icon.png');
    this.subs = [
      panel.webview.onDidReceiveMessage((m: unknown) => {
        if (panel === this.panel && m && typeof (m as { type?: unknown }).type === 'string') {
          this.events.onMessage(m as { type: string; answer?: unknown });
        }
      }),
      // Its X, its tab or its window was closed: the next cat reopens it.
      panel.onDidDispose(() => {
        if (this.panel === panel) {
          this.detach();
          this.events.onClosed();
          this.events.onGone();
        }
      }),
    ];
    panel.webview.html = renderPanel(this.mediaUri.fsPath, {
      csp: panel.webview.cspSource,
      nonce: crypto.randomBytes(16).toString('hex'),
      media: panel.webview.asWebviewUri(this.mediaUri).toString(),
    });
  }

  private detach(): void {
    for (const d of this.subs.splice(0)) {
      d.dispose();
    }
    this.panel = undefined;
  }
}
