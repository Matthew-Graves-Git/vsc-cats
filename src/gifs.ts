import * as fs from 'fs';
import * as path from 'path';

/** The GIFs for one surfing cat. Paths are relative to media/ (where panel.html lives). */
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
export function gifDurationMs(file: string): number {
  const cached = durations.get(file);
  if (cached !== undefined) {
    return cached;
  }
  let total = 0;
  try {
    const b = fs.readFileSync(file);
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
  durations.set(file, total);
  return total;
}

/** The GIFs for one cat during a cat rain. Paths are relative to media/. */
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

/** The storm clips every cat rain shares. Paths are relative to media/. */
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

/** Folder (under media/gifs) of the cat rain clips. */
const RAIN_DIR = 'cat_thunderstorm_event';

const catalogs = new Map<string, Map<string, string>>();

/**
 * Lowercased cat name -> file prefix, for the files in `dir` whose name matches `re`
 * (the prefix is the regex's first group).
 */
function catalog(dir: string, re: RegExp): Map<string, string> {
  const key = `${dir}|${re.source}`;
  let cats = catalogs.get(key);
  if (!cats) {
    cats = new Map<string, string>();
    try {
      for (const f of fs.readdirSync(dir)) {
        const m = re.exec(f);
        if (m) {
          cats.set(m[1].toLowerCase(), m[1]);
        }
      }
    } catch {
      // no such folder
    }
    catalogs.set(key, cats);
  }
  return cats;
}

/**
 * The cats that have GIFs: lowercased name -> file prefix, from media/gifs/<prefix>_01_surf.gif.
 * The prefix is the part of the file name before the first "_".
 */
export function surfCats(extensionPath: string): Map<string, string> {
  return catalog(path.join(extensionPath, 'media', 'gifs'), /^([^_]+)_01_surf\.gif$/i);
}

/** The cats that have rain GIFs, from media/gifs/cat_thunderstorm_event/<prefix>_rain_enter.gif. */
export function rainCats(extensionPath: string): Map<string, string> {
  return catalog(path.join(extensionPath, 'media', 'gifs', RAIN_DIR), /^([^_]+)_rain_enter\.gif$/i);
}

/** The rain GIFs for the word before "cat" in a spawn message, or undefined if there are none. */
export function rainSet(extensionPath: string, word: string | undefined): RainCat | undefined {
  const prefix = word ? rainCats(extensionPath).get(word.toLowerCase()) : undefined;
  if (!prefix) {
    return undefined;
  }
  const media = path.join(extensionPath, 'media');
  const enter = `gifs/${RAIN_DIR}/${prefix}_rain_enter.gif`;
  const loop = `gifs/${RAIN_DIR}/${prefix}_rain.gif`;
  const exit = `gifs/${RAIN_DIR}/${prefix}_rain_exit.gif`;
  const ms = (rel: string) => gifDurationMs(path.join(media, rel));
  const set: RainCat = { enter, loop, exit, enterMs: ms(enter), loopMs: ms(loop), exitMs: ms(exit) };
  return set.enterMs && set.loopMs && set.exitMs ? set : undefined;
}

/** The shared cat rain clips, or undefined if any is missing (then rain looks like any other time). */
export function rainScene(extensionPath: string): RainScene | undefined {
  const media = path.join(extensionPath, 'media');
  const start = `gifs/${RAIN_DIR}/nyan_exits_rain_starts.gif`;
  const empty = `gifs/${RAIN_DIR}/rain_no_cat.gif`;
  const clear = `gifs/${RAIN_DIR}/nyan_enters_rain_clears.gif`;
  const ms = (rel: string) => gifDurationMs(path.join(media, rel));
  const scene: RainScene = {
    start,
    empty,
    clear,
    startMs: ms(start),
    emptyMs: ms(empty),
    clearMs: ms(clear),
    nyanMs: ms('idle.gif'),
  };
  return scene.startMs && scene.emptyMs && scene.clearMs && scene.nyanMs ? scene : undefined;
}

/**
 * The surfing GIFs for the word before "cat" in a spawn message ("fine", "egirl", "8bit"),
 * or undefined if there's no GIF set for it.
 */
export function surfSet(extensionPath: string, word: string | undefined): SurfSet | undefined {
  const prefix = word ? surfCats(extensionPath).get(word.toLowerCase()) : undefined;
  if (!prefix) {
    return undefined;
  }
  const media = path.join(extensionPath, 'media');
  const surf = `gifs/${prefix}_01_surf.gif`;
  const loop = `gifs/loops/${prefix}_surf_loop.gif`;
  const ret = `gifs/${prefix}_02_return.gif`;
  const ms = (rel: string) => gifDurationMs(path.join(media, rel));
  const set: SurfSet = {
    key: prefix.toLowerCase(),
    surf,
    loop,
    ret,
    surfMs: ms(surf),
    loopMs: ms(loop),
    retMs: ms(ret),
    nyanMs: ms('idle.gif'),
  };
  // A missing file reads as 0ms.
  return set.surfMs && set.loopMs && set.retMs && set.nyanMs ? set : undefined;
}
