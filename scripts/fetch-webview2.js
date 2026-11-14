// Puts the WebView2 SDK files the frameless cat window (window/host.cs) needs into window/lib/:
//
//   Microsoft.Web.WebView2.Core.dll   the .NET Framework wrapper host.cs compiles against
//   win-x64/WebView2Loader.dll        the native loader, one per VS Code architecture
//   win-arm64/WebView2Loader.dll
//   LICENSE.txt, NOTICE.txt           the SDK's licence (BSD-style), shipped alongside
//
// Downloads the pinned Microsoft.Web.WebView2 NuGet package once, checks its SHA-256 and unpacks
// just those files (a .nupkg is a zip). Runs from `npm install` (postinstall) and
// `vscode:prepublish`; does nothing when window/lib already holds this version. No dependencies.
// The WebView2 runtime itself is not shipped: it comes with Windows 10/11.
const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const path = require('path');
const zlib = require('zlib');

const VERSION = '1.0.4314.35';
const SHA256 = '90778deb1b77e36292828b4b5833c9255c27533f40e0ddd55891ae718944edc4';
const PKG_URL = `https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/${VERSION}/microsoft.web.webview2.${VERSION}.nupkg`;

const LIB = path.join(__dirname, '..', 'window', 'lib');
/** Entry in the package -> file under window/lib. */
const FILES = {
  'lib/net462/Microsoft.Web.WebView2.Core.dll': 'Microsoft.Web.WebView2.Core.dll',
  'runtimes/win-x64/native/WebView2Loader.dll': 'win-x64/WebView2Loader.dll',
  'runtimes/win-arm64/native/WebView2Loader.dll': 'win-arm64/WebView2Loader.dll',
  'LICENSE.txt': 'LICENSE.txt',
  'NOTICE.txt': 'NOTICE.txt',
};
const VERSION_FILE = path.join(LIB, 'version.txt');

function upToDate() {
  try {
    return (
      fs.readFileSync(VERSION_FILE, 'utf8').trim() === VERSION &&
      Object.values(FILES).every((f) => fs.existsSync(path.join(LIB, f)))
    );
  } catch {
    return false;
  }
}

function download(url, redirects = 5) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { 'User-Agent': 'cat-yoink-build' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
          res.resume();
          resolve(download(new URL(res.headers.location, url).href, redirects - 1));
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`GET ${url}: HTTP ${res.statusCode}`));
          return;
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      })
      .on('error', reject);
  });
}

/** The zip's entries we want, as name -> contents. Plain zip only (no zip64): enough for a nupkg. */
function unzip(zip, wanted) {
  // End of central directory: the last 0x06054b50 within the trailing 64 KiB comment window.
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) {
    throw new Error('not a zip file');
  }
  const count = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  const out = {};
  for (let n = 0; n < count; n++) {
    if (zip.readUInt32LE(p) !== 0x02014b50) {
      throw new Error('bad central directory');
    }
    const method = zip.readUInt16LE(p + 10);
    const size = zip.readUInt32LE(p + 20);
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    const local = zip.readUInt32LE(p + 42);
    const name = zip.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (!wanted.includes(name)) {
      continue;
    }
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const data = zip.subarray(start, start + size);
    if (method === 0) {
      out[name] = Buffer.from(data);
    } else if (method === 8) {
      out[name] = zlib.inflateRawSync(data);
    } else {
      throw new Error(`${name}: unsupported compression method ${method}`);
    }
  }
  return out;
}

async function main() {
  if (upToDate()) {
    return;
  }
  console.log(`[fetch-webview2] downloading Microsoft.Web.WebView2 ${VERSION}...`);
  const pkg = await download(PKG_URL);
  const hash = crypto.createHash('sha256').update(pkg).digest('hex');
  if (hash !== SHA256) {
    throw new Error(`Microsoft.Web.WebView2 ${VERSION}: SHA-256 ${hash} doesn't match the pinned ${SHA256}`);
  }
  const entries = unzip(pkg, Object.keys(FILES));
  fs.rmSync(LIB, { recursive: true, force: true });
  for (const [entry, file] of Object.entries(FILES)) {
    if (!entries[entry]) {
      throw new Error(`Microsoft.Web.WebView2 ${VERSION}: ${entry} is missing from the package`);
    }
    const dst = path.join(LIB, file);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, entries[entry]);
  }
  fs.writeFileSync(VERSION_FILE, VERSION + '\n');
  console.log(`[fetch-webview2] window/lib now has the WebView2 SDK ${VERSION}`);
}

main().catch((e) => {
  console.error(`[fetch-webview2] ${e.message}`);
  process.exit(1);
});
