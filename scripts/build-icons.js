// Builds media/cat-icons.woff from media/icon-src/*.svg.
// fantasticon 3.x passes backslash paths to glob on Windows, which glob treats as
// escapes and finds nothing. Normalise path.join to forward slashes first.
const path = require('path');
const origJoin = path.join;
path.join = (...args) => origJoin(...args).split('\\').join('/');

const { generateFonts, FontAssetType } = require('fantasticon');

generateFonts({
  inputDir: path.resolve(__dirname, '../media/icon-src').split('\\').join('/'),
  outputDir: path.resolve(__dirname, '../media'),
  name: 'cat-icons',
  fontTypes: [FontAssetType.WOFF],
  assetTypes: [],
  codepoints: { cat: 0xf101 },
  normalize: true,
  fontHeight: 1000,
}).then(() => console.log('built media/cat-icons.woff'))
  .catch((e) => { console.error(e); process.exit(1); });
