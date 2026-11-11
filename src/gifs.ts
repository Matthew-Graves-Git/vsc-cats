import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';

// The surf and rain clips live in a gif folder laid out like the repo's media/gifs (the extension
// uses its download cache, src/gifSync.ts; the scripted test run uses the repo's own copy). Each
// clip is handed to the window as an absolute file: URL. idle.gif (Nyan) is bundled in media/.

/** The GIFs for one surfing cat. Clips are file: URLs. */
export interface SurfSet {
  key: string;
  /** Nyan exits, the cat surfs in. Starts on idle.gif's last frame. Shown once. */
  surf: string;
  /** The cat surfing, no Nyan. Loops. */
  loop: string;
  /** The cat exits, Nyan returns. Ends on idle.gif's first frame. Shown once. */
  ret: string;
  surfMs: number;
  loopMs: number;
  retMs: number;
  /** Length of one idle.gif (Nyan) loop. */
  nyanMs: number;
}

const durations = new Map<string, number>();

/** Total length of one pass through a GIF, from its frame delays. 0 if it can't be read. */
export function gifDurationFromBuffer(b: Buffer): number {
  let total = 0;
  try {
    const skipSubBlocks = (p: number) => {
      while (p < b.length && b[p] !== 0) {
        p += b[p] + 1;
      }
      return p + 1;
    };
    let p = 13;
    if (b[10] & 0x80) {
      p += 3 * (1 << ((b[10] & 7) + 1)); // global color table
    }
    while (p < b.length) {
      const t = b[p];
      if (t === 0x21) {
        if (b[p + 1] === 0xf9) {
          // Graphic Control Extension: delay in hundredths of a second.
          // Browsers treat delays under 20ms as 100ms.
          const d = b.readUInt16LE(p + 4) * 10;
          total += d < 20 ? 100 : d;
        }
        p = skipSubBlocks(p + 2);
      } else if (t === 0x2c) {
        const flags = b[p + 9];
        p += 10;
        if (flags & 0x80) {
          p += 3 * (1 << ((flags & 7) + 1)); // local color table
        }
        p = skipSubBlocks(p + 1); // LZW minimum code size, then image data
      } else {
        break; // 0x3b trailer, or something unexpected
      }
    }
  } catch {
    total = 0;
  }
  return total;
}

/**
 * Length of one pass through the GIF at `file`. 0 if it can't be read; that isn't remembered, so a
 * clip that is still downloading is read again next time.
 */
export function gifDurationMs(file: string): number {
  const cached = durations.get(file);
  if (cached !== undefined) {
    return cached;
  }
  let total = 0;
  try {
    total = gifDurationFromBuffer(fs.readFileSync(file));
  } catch {
    total = 0;
  }
  if (total) {
    durations.set(file, total);
  }
  return total;
}

/** Records a clip's length (worked out when it was downloaded), so it is never read from disk. */
export function primeDuration(file: string, ms: number): void {
  if (ms > 0) {
    durations.set(file, ms);
  } else {
    durations.delete(file);
  }
}

/** The GIFs for one cat during a cat rain. Clips are file: URLs. */
export interface RainCat {
  /** The cat walks in from the right. Starts on rain_no_cat's first frame, ends on `loop`'s first frame. Shown once. */
  enter: string;
  /** The cat in the storm. Loops. */
  loop: string;
  /** The cat leaves to the left. Ends on rain_no_cat's first frame. Shown once. */
  exit: string;
  enterMs: number;
  loopMs: number;
  exitMs: number;
}

/** The storm clips every cat rain shares. Clips are file: URLs. */
export interface RainScene {
  /** Nyan leaves, the rain starts. Starts on idle.gif's last frame, ends on `empty`'s first frame. Shown once. */
  start: string;
  /** Storm with no cat. Loops. */
  empty: string;
  /** Nyan comes back, the rain stops. Ends on idle.gif's first frame. Shown once. */
  clear: string;
  startMs: number;
  emptyMs: number;
  clearMs: number;
  /** Length of one idle.gif (Nyan) loop. */
  nyanMs: number;
}

/** Folder (under the gif folder) of the cat rain clips. */
export const RAIN_DIR = 'cat_thunderstorm_event';

// File names relative to the gif folder, with "/" separators (as in the repo).

/** A surfing cat's intro, loop and return. */
export function surfFiles(prefix: string): string[] {
  return [`${prefix}_01_surf.gif`, `loops/${prefix}_surf_loop.gif`, `${prefix}_02_return.gif`];
}

/** A rain cat's enter, loop and exit. */
export function rainFiles(prefix: string): string[] {
  return [`${RAIN_DIR}/${prefix}_rain_enter.gif`, `${RAIN_DIR}/${prefix}_rain.gif`, `${RAIN_DIR}/${prefix}_rain_exit.gif`];
}

/** The shared storm: rain starts, empty storm, rain clears. */
export function sceneFiles(): string[] {
  return [`${RAIN_DIR}/nyan_exits_rain_starts.gif`, `${RAIN_DIR}/rain_no_cat.gif`, `${RAIN_DIR}/nyan_enters_rain_clears.gif`];
}

const SURF_RE = /^([^_/]+)_01_surf\.gif$/i;
const RAIN_RE = new RegExp(`^${RAIN_DIR}/([^_/]+)_rain_enter\\.gif$`, 'i');

/** The cat prefix if `rel` (relative to the gif folder) is a cat's first surf or rain clip. */
export function catPrefix(kind: 'surf' | 'rain', rel: string): string | undefined {
  const m = (kind === 'surf' ? SURF_RE : RAIN_RE).exec(rel);
  return m ? m[1] : undefined;
}

const catalogs = new Map<string, Map<string, string>>();

/** Forgets the folder listings, so cats downloaded since show up. */
export function resetGifCache(): void {
  catalogs.clear();
}

/**
 * Lowercased cat name -> file prefix, for the cats of `kind` in `gifDir` (the prefix is the part
 * of the file name before the first "_").
 */
function catalog(gifDir: string, kind: 'surf' | 'rain', fresh = false): Map<string, string> {
  const key = `${gifDir}|${kind}`;
  let cats = fresh ? undefined : catalogs.get(key);
  if (!cats) {
    cats = new Map<string, string>();
    const sub = kind === 'surf' ? '' : `${RAIN_DIR}/`;
    try {
      for (const f of fs.readdirSync(path.join(gifDir, sub))) {
        const prefix = catPrefix(kind, sub + f);
        if (prefix) {
          cats.set(prefix.toLowerCase(), prefix);
        }
      }
    } catch {
      // no such folder
    }
    catalogs.set(key, cats);
  }
  return cats;
}

/** The prefix for `word`, listing the folder again on a miss (its clips may have just arrived). */
function lookup(gifDir: string, kind: 'surf' | 'rain', word: string): string | undefined {
  const w = word.toLowerCase();
  return catalog(gifDir, kind).get(w) ?? catalog(gifDir, kind, true).get(w);
}

const defaultDir = (extensionPath: string) => path.join(extensionPath, 'media', 'gifs');
const nyanMs = (extensionPath: string) => gifDurationMs(path.join(extensionPath, 'media', 'idle.gif'));

/** Each clip's file: URL and length, or undefined if any is missing (a missing file reads as 0ms). */
function clips(gifDir: string, rels: string[]): { url: string; ms: number }[] | undefined {
  const out = rels.map((rel) => {
    const abs = path.join(gifDir, rel);
    return { url: pathToFileURL(abs).href, ms: gifDurationMs(abs) };
  });
  return out.every((c) => c.ms) ? out : undefined;
}

/** The cats that have surf GIFs: lowercased name -> file prefix, from <gifDir>/<prefix>_01_surf.gif. */
export function surfCats(extensionPath: string, gifDir = defaultDir(extensionPath)): Map<string, string> {
  return catalog(gifDir, 'surf');
}

/** The cats that have rain GIFs, from <gifDir>/cat_thunderstorm_event/<prefix>_rain_enter.gif. */
export function rainCats(extensionPath: string, gifDir = defaultDir(extensionPath)): Map<string, string> {
  return catalog(gifDir, 'rain');
}

/** The rain GIFs for the word before "cat" in a spawn message, or undefined if there are none. */
export function rainSet(
  extensionPath: string,
  word: string | undefined,
  gifDir = defaultDir(extensionPath)
): RainCat | undefined {
  const prefix = word ? lookup(gifDir, 'rain', word) : undefined;
  const c = prefix ? clips(gifDir, rainFiles(prefix)) : undefined;
  if (!c) {
    return undefined;
  }
  const [enter, loop, exit] = c;
  return { enter: enter.url, loop: loop.url, exit: exit.url, enterMs: enter.ms, loopMs: loop.ms, exitMs: exit.ms };
}

/** The shared cat rain clips, or undefined if any is missing (then rain looks like any other time). */
export function rainScene(extensionPath: string, gifDir = defaultDir(extensionPath)): RainScene | undefined {
  const c = clips(gifDir, sceneFiles());
  const nyan = nyanMs(extensionPath);
  if (!c || !nyan) {
    return undefined;
  }
  const [start, empty, clear] = c;
  return {
    start: start.url,
    empty: empty.url,
    clear: clear.url,
    startMs: start.ms,
    emptyMs: empty.ms,
    clearMs: clear.ms,
    nyanMs: nyan,
  };
}

/**
 * The surfing GIFs for the word before "cat" in a spawn message ("fine", "egirl", "8bit"),
 * or undefined if there's no GIF set for it.
 */
export function surfSet(
  extensionPath: string,
  word: string | undefined,
  gifDir = defaultDir(extensionPath)
): SurfSet | undefined {
  const prefix = word ? lookup(gifDir, 'surf', word) : undefined;
  const c = prefix ? clips(gifDir, surfFiles(prefix)) : undefined;
  const nyan = nyanMs(extensionPath);
  if (!prefix || !c || !nyan) {
    return undefined;
  }
  const [surf, loop, ret] = c;
  return {
    key: prefix.toLowerCase(),
    surf: surf.url,
    loop: loop.url,
    ret: ret.url,
    surfMs: surf.ms,
    loopMs: loop.ms,
    retMs: ret.ms,
    nyanMs: nyan,
  };
}
