// Makes the one-shot transition clips in media/gifs play once: removes their NETSCAPE2.0 loop
// block. A clip that loops forever wraps back to its first frame (Nyan, for the surf intros and the
// rain start) if panel.js swaps in the next clip a frame late; one that plays once holds its last
// frame, which is the next clip's first. Loops (loops/*, *_rain.gif, rain_no_cat.gif) are left
// alone. Safe to run again: files without the block are skipped.
//
//   node scripts/fix-gif-loops.js
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'media', 'gifs');
const ONE_SHOT = /(_01_surf|_02_return|_rain_enter|_rain_exit)\.gif$|^nyan_(exits_rain_starts|enters_rain_clears)\.gif$/i;

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : [p];
  });
}

/** The file without its `21 FF 0B "NETSCAPE2.0" 03 01 lo hi 00` block, or null if it has none. */
function stripLoop(b) {
  const i = b.indexOf('NETSCAPE2.0');
  if (i < 3) {
    return null;
  }
  const start = i - 3;
  const end = i + 16;
  const ok =
    b[start] === 0x21 && b[start + 1] === 0xff && b[start + 2] === 0x0b &&
    b[i + 11] === 0x03 && b[i + 12] === 0x01 && b[i + 15] === 0x00;
  if (!ok) {
    throw new Error('unexpected bytes around the NETSCAPE2.0 block');
  }
  return Buffer.concat([b.subarray(0, start), b.subarray(end)]);
}

let changed = 0;
for (const file of walk(ROOT).filter((f) => ONE_SHOT.test(path.basename(f)))) {
  const rel = path.relative(ROOT, file);
  try {
    const out = stripLoop(fs.readFileSync(file));
    if (out) {
      fs.writeFileSync(file, out);
      changed++;
      console.log(`play once: ${rel}`);
    }
  } catch (err) {
    console.error(`skipped ${rel}: ${err.message}`);
    process.exitCode = 1;
  }
}
console.log(changed ? `${changed} clip(s) changed` : 'nothing to change');
