import * as fs from 'fs';
import * as path from 'path';
import type { PanelMessage } from './catWindow';
import type { RainCat, SurfSet } from './gifs';

/**
 * Where the Cat Yoink page (media/panel.html) is shown: the frameless window (src/nativeWindow.ts)
 * or a VS Code webview (src/catWindow.ts). src/catWindow.ts keeps the state and replays it when the
 * page says `ready`; a surface just shows the page and carries messages.
 */
export interface Surface {
  /** Opens it, or brings it back; never takes focus once it is open. */
  show(): void;
  /** Only surfaces that can hide without closing (the page keeps running and receiving messages). */
  hide?(): void;
  /** Delivers a message to the page (clip paths still absolute: the surface maps them to URLs). */
  post(m: PanelMessage): void;
  /** This VS Code window has focus now: a surface that follows its VS Code window may attach to it. */
  claimOwner?(): void;
  /** Whether it hides while its VS Code window is minimized (catYoink.minimizeWithVSCode). */
  setMinimizeWith?(on: boolean): void;
  /** Closes it for good. No events fire after this. */
  dispose(): void;
}

export interface SurfaceEvents {
  /** A message from the page: ready, yoink, close, mgGo, mgAnswer, mgClose. */
  onMessage(m: { type: string; answer?: unknown }): void;
  /** The user closed it (its X, its tab or window, Alt+F4). It may still exist, hidden. */
  onClosed(): void;
  /** It is gone without dispose() (closed by the user, or its process exited). */
  onGone(): void;
}

/** media/panel.html with its {{csp}}, {{nonce}} and {{media}} placeholders filled in. */
export function renderPanel(mediaDir: string, values: { csp: string; nonce: string; media: string }): string {
  const template = fs.readFileSync(path.join(mediaDir, 'panel.html'), 'utf8');
  return template.replace(/\{\{(\w+)\}\}/g, (all, key: string) => (values as Record<string, string>)[key] ?? all);
}

/** `m` with each GIF clip's absolute path turned into a URL the page may load. */
export function mapClipUrls(m: PanelMessage, url: (file: string) => string): PanelMessage {
  const surf = (s?: SurfSet): SurfSet | undefined => s && { ...s, surf: url(s.surf), loop: url(s.loop), ret: url(s.ret) };
  const rain = (r?: RainCat): RainCat | undefined =>
    r && { ...r, enter: url(r.enter), loop: url(r.loop), exit: url(r.exit) };
  switch (m.type) {
    case 'spawn':
    case 'gifs':
      return { ...m, surf: surf(m.surf), rain: rain(m.rain) };
    case 'rain':
      return m.scene
        ? { ...m, scene: { ...m.scene, start: url(m.scene.start), empty: url(m.scene.empty), clear: url(m.scene.clear) } }
        : m;
    default:
      return m;
  }
}
