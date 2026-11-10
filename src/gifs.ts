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

let catalog: { dir: string; cats: Map<string, string> } | undefined;

/**
 * The cats that have GIFs: lowercased name -> file prefix, from media/gifs/<prefix>_01_surf.gif.
 * The prefix is the part of the file name before the first "_".
 */
export function surfCats(extensionPath: string): Map<string, string> {
  const dir = path.join(extensionPath, 'media', 'gifs');
  if (catalog?.dir !== dir) {
    const cats = new Map<string, string>();
    try {
      for (const f of fs.readdirSync(dir)) {
        const m = /^([^_]+)_01_surf\.gif$/i.exec(f);
        if (m) {
          cats.set(m[1].toLowerCase(), m[1]);
        }
      }
    } catch {
      // no gifs folder
    }
    catalog = { dir, cats };
  }
  return catalog.cats;
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
