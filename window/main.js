// Electron main process for the Cat Yoink window: a frameless, resizable window that shows
// media/panel.html. The VS Code extension spawns this and talks to it over a named pipe using
// JSON lines. Plain JS (not compiled by tsc) because it runs inside Electron.
//
// Two modes (CAT_YOINK_MODE):
//  - inside (default, Windows only): the window lives inside the VS Code window that started it.
//    window/tracker.cs finds that VS Code window and reports its frame; we keep the cat within it,
//    anchored to its nearest corner, and the tracker keeps the cat stacked directly above it. The
//    cat is hidden while VS Code is minimized and until that VS Code window is known.
//  - floating: a free always-on-top window that remembers its screen position.
const { app, BrowserWindow, ipcMain, screen } = require('electron');
const cp = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');

// --test: a scripted run through every window event (window/testRun.js), no extension involved.
const TEST = process.argv.includes('--test');
const PIPE = TEST ? undefined : process.env.CAT_YOINK_PIPE;
const STATE = TEST ? undefined : process.env.CAT_YOINK_STATE; // a test run keeps its own layout out of the saved one
const MEDIA = path.join(__dirname, '..', 'media');
// The test run has no VS Code window to live inside.
let mode = !TEST && process.platform === 'win32' && process.env.CAT_YOINK_MODE !== 'floating' ? 'inside' : 'floating';

app.setName('Cat Yoink');
if (process.env.CAT_YOINK_USER_DATA && !TEST) {
  app.setPath('userData', process.env.CAT_YOINK_USER_DATA);
}

let win;
let sock;
let quitting = false;
/** What the extension (or the X button) last asked for; inside mode may still keep it hidden. */
let wantVisible = !PIPE; // started by hand for testing: show right away
let testRun; // the --test script, once the window exists

const send = (m) => {
  if (sock && !sock.destroyed) {
    sock.write(JSON.stringify(m) + '\n');
  }
};

// ---- saved layout ----
//
// window.json: { floating: {x, y, width, height}, inside: {width, height, ax, dx, ay, dy} }
// inside: the preferred size (only a manual resize changes it) and the offset from the nearest
// corner of the VS Code window (ax 'left'|'right', ay 'top'|'bottom').

const DEFAULT_SIZE = { width: 340, height: 380 };
const MIN_SIZE = 200;
const INSET = 24;
const DEFAULT_INSIDE = { ...DEFAULT_SIZE, ax: 'right', dx: INSET, ay: 'bottom', dy: INSET };

const isRect = (b) => !!b && ['x', 'y', 'width', 'height'].every((k) => Number.isFinite(b[k]));
const isInside = (s) =>
  !!s &&
  ['width', 'height', 'dx', 'dy'].every((k) => Number.isFinite(s[k])) &&
  (s.ax === 'left' || s.ax === 'right') &&
  (s.ay === 'top' || s.ay === 'bottom');
const sized = (w, h) => ({ width: Math.max(MIN_SIZE, Math.round(w)), height: Math.max(MIN_SIZE, Math.round(h)) });

function loadState() {
  let s = {};
  try {
    s = JSON.parse(fs.readFileSync(STATE, 'utf8')) || {};
  } catch {
    // no saved state yet
  }
  if (isRect(s)) {
    // Older versions saved just the floating bounds.
    return {
      floating: { x: s.x, y: s.y, ...sized(s.width, s.height) },
      inside: { ...DEFAULT_INSIDE, ...sized(s.width, s.height) },
    };
  }
  return {
    floating: isRect(s.floating) ? { x: s.floating.x, y: s.floating.y, ...sized(s.floating.width, s.floating.height) } : null,
    inside: isInside(s.inside)
      ? { ...s.inside, ...sized(s.inside.width, s.inside.height), dx: Math.max(0, s.inside.dx), dy: Math.max(0, s.inside.dy) }
      : { ...DEFAULT_INSIDE },
  };
}

const state = loadState();

function saveState() {
  if (!STATE || !win || win.isDestroyed()) {
    return;
  }
  if (mode === 'floating') {
    state.floating = win.getBounds();
  }
  // state.inside is kept current by the manual move/resize handlers.
  try {
    fs.mkdirSync(path.dirname(STATE), { recursive: true });
    fs.writeFileSync(STATE, JSON.stringify(state));
  } catch {
    // best effort
  }
}

/** Floating mode: the saved bounds if they still overlap a connected display, else bottom-right. */
function floatingBounds() {
  const b = state.floating;
  const visible =
    b &&
    screen.getAllDisplays().some(({ workArea: a }) =>
      b.x < a.x + a.width - 40 && b.x + b.width > a.x + 40 && b.y < a.y + a.height - 40 && b.y + b.height > a.y
    );
  if (visible) {
    return { ...b };
  }
  const area = screen.getPrimaryDisplay().workArea;
  return {
    ...DEFAULT_SIZE,
    x: area.x + area.width - DEFAULT_SIZE.width - INSET,
    y: area.y + area.height - DEFAULT_SIZE.height - INSET,
  };
}

// ---- inside mode: geometry ----

/** The VS Code window we live in: { hwnd, rect (DIP) | null, minimized }. */
let owner = null;

/** `b` moved (not resized) so it lies within `r`; shrunk first if it is bigger than `r`. */
function clampInto(b, r) {
  const width = Math.max(MIN_SIZE, Math.min(b.width, r.width));
  const height = Math.max(MIN_SIZE, Math.min(b.height, r.height));
  return {
    x: Math.round(Math.max(r.x, Math.min(b.x, r.x + r.width - width))),
    y: Math.round(Math.max(r.y, Math.min(b.y, r.y + r.height - height))),
    width: Math.round(width),
    height: Math.round(height),
  };
}

/** A resize: edges dragged past `r` stop at its edges. */
function clipInto(b, r) {
  const x1 = Math.max(b.x, r.x);
  const y1 = Math.max(b.y, r.y);
  const x2 = Math.min(b.x + b.width, r.x + r.width);
  const y2 = Math.min(b.y + b.height, r.y + r.height);
  return clampInto({ x: x1, y: y1, width: x2 - x1, height: y2 - y1 }, r);
}

/** Where the saved layout puts the cat in VS Code's frame `r`. */
function fitInside(pref, r) {
  const width = Math.min(pref.width, r.width);
  const height = Math.min(pref.height, r.height);
  return clampInto(
    {
      x: pref.ax === 'left' ? r.x + pref.dx : r.x + r.width - width - pref.dx,
      y: pref.ay === 'top' ? r.y + pref.dy : r.y + r.height - height - pref.dy,
      width,
      height,
    },
    r
  );
}

/** The offset of `b` from the nearest corner of `r`. */
function anchorOf(b, r) {
  const left = b.x - r.x;
  const right = r.x + r.width - (b.x + b.width);
  const top = b.y - r.y;
  const bottom = r.y + r.height - (b.y + b.height);
  return {
    ax: left <= right ? 'left' : 'right',
    dx: Math.max(0, Math.min(left, right)),
    ay: top <= bottom ? 'top' : 'bottom',
    dy: Math.max(0, Math.min(top, bottom)),
  };
}

const sameBounds = (a, b) => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

function layout() {
  if (mode !== 'inside' || !owner || !owner.rect || !win || win.isDestroyed()) {
    return;
  }
  const b = fitInside(state.inside, owner.rect);
  if (!sameBounds(b, win.getBounds())) {
    win.setBounds(b);
  }
}

// ---- visibility ----

/** The page has its first GIF on screen; until then the window stays hidden (no empty black box). */
let sceneReady = false;

function canShow() {
  return sceneReady && (mode === 'floating' || (!!owner && !!owner.rect && !owner.minimized));
}

/** Shows or hides the window to match wantVisible and (inside mode) the VS Code window. */
function updateVisibility() {
  if (!win || win.isDestroyed()) {
    return;
  }
  if (wantVisible && canShow()) {
    layout();
    if (!win.isVisible()) {
      win.showInactive(); // never steal focus from the editor
    }
  } else if (win.isVisible()) {
    saveState();
    win.hide();
  }
}

// ---- inside mode: the Win32 tracker ----

let tracker;
let trackerFails = 0;
let lastOwnerHwnd = process.env.CAT_YOINK_OWNER_HINT || '';

function toTracker(line) {
  if (tracker && tracker.stdin.writable) {
    tracker.stdin.write(line + '\n');
  }
}

function startTracker() {
  const cs = path.join(__dirname, 'tracker.cs').replace(/'/g, "''");
  const script =
    `$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'; ` +
    `Add-Type -Path '${cs}'; [CatTracker]::Run()`;
  const proc = cp.spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }
  );
  tracker = proc;
  proc.stdin.on('error', () => {});
  proc.stdout.setEncoding('utf8');
  let buf = '';
  proc.stdout.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      try {
        onTracker(JSON.parse(line));
      } catch {
        // ignore malformed lines
      }
    }
  });
  proc.stderr.on('data', (d) => console.error('[tracker]', String(d).trim().slice(0, 500)));
  const onGone = () => {
    if (tracker !== proc || quitting) {
      return;
    }
    tracker = undefined;
    owner = null;
    updateVisibility();
    if (++trackerFails <= 3) {
      setTimeout(() => !quitting && mode === 'inside' && startTracker(), 2000);
    } else {
      console.error('[tracker] keeps failing; falling back to a floating window');
      becomeFloating();
    }
  };
  proc.on('error', (err) => {
    console.error('[tracker] failed to start:', err.message);
    onGone();
  });
  proc.on('exit', onGone);

  const h = win.getNativeWindowHandle();
  toTracker(`cat ${h.length >= 8 ? h.readBigUInt64LE(0) : h.readUInt32LE(0)}`);
  if (lastOwnerHwnd) {
    toTracker(`hint ${lastOwnerHwnd}`);
  }
  toTracker('startup');
}

function onTracker(m) {
  switch (m.t) {
    case 'owner':
      trackerFails = 0;
      owner = { hwnd: m.hwnd, rect: null, minimized: false };
      lastOwnerHwnd = String(m.hwnd);
      send({ type: 'owner', hwnd: m.hwnd });
      break;
    case 'rect':
      if (owner) {
        const r = screen.screenToDipRect(null, { x: m.x, y: m.y, width: m.w, height: m.h });
        owner.rect = { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
        layout();
        updateVisibility();
      }
      break;
    case 'min':
      if (owner) {
        owner.minimized = !!m.v;
        updateVisibility();
      }
      break;
    case 'gone':
      owner = null; // hidden until VS Code claims a window again
      updateVisibility();
      break;
  }
}

/** The tracker can't run: behave like the floating mode rather than never showing up. */
function becomeFloating() {
  mode = 'floating';
  owner = null;
  if (win && !win.isDestroyed()) {
    win.setBounds(floatingBounds());
    win.setAlwaysOnTop(true, 'floating');
    updateVisibility();
  }
}

// ---- window ----

function createWindow() {
  const floating = mode === 'floating';
  win = new BrowserWindow({
    // Inside mode stays hidden until the VS Code window's frame is known; layout() places it.
    ...(floating ? floatingBounds() : { ...floatingBounds(), width: state.inside.width, height: state.inside.height }),
    minWidth: MIN_SIZE,
    minHeight: MIN_SIZE,
    frame: false,
    resizable: true,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: floating,
    show: false,
    title: 'Cat Yoink',
    icon: path.join(MEDIA, 'icon.png'),
    backgroundColor: '#000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  if (floating) {
    win.setAlwaysOnTop(true, 'floating');
  }
  // Page errors go to stderr, which the extension keeps in window.log.
  win.webContents.on('console-message', (...a) => {
    const d = a[0] && typeof a[0] === 'object' && 'message' in a[0] ? a[0] : { level: a[1], message: a[2] };
    if (d.level === 'error' || d.level === 'warning' || d.level === 2 || d.level === 3) {
      console.error('[page]', d.message);
    }
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  let saveTimer;
  const scheduleSave = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveState, 300);
  };
  win.on('moved', scheduleSave);
  win.on('resized', scheduleSave);
  win.on('move', scheduleSave);
  win.on('resize', scheduleSave);

  // Inside mode: manual resizes stop at VS Code's frame. This event only fires for manual
  // resizes; after preventDefault Electron applies whatever bounds the window has by then, so
  // setting the clipped bounds here is what the resize ends up doing. (Moves are ours: see drag.)
  win.on('will-resize', (e, nb) => {
    if (mode !== 'inside' || !owner || !owner.rect) {
      return;
    }
    e.preventDefault();
    const b = clipInto(nb, owner.rect);
    win.setBounds(b);
    state.inside = { width: b.width, height: b.height, ...anchorOf(b, owner.rect) };
    scheduleSave();
  });

  // The X button and Alt+F4 hide the window; watching continues and the next cat reopens it.
  win.on('close', (e) => {
    saveState();
    if (!quitting) {
      e.preventDefault();
      hideWindow();
    }
  });

  win.on('show', startHover);
  win.on('hide', () => {
    stopHover();
    endDrag();
  });
  win.webContents.on('did-finish-load', () => {
    hoverInside = null; // resend the current state to the fresh page
    checkHover();
  });

  win.loadFile(path.join(MEDIA, 'panel.html'));
}

// ---- dragging: the page says when a press on the picture starts and ends; we follow the cursor ----
//
// Not Windows' own move loop (a -webkit-app-region drag): holding the cat against VS Code's edge
// made that loop's position bounce, and Aero Shake then minimized every other window, VS Code too.

const DRAG_TICK_MS = 16;
let drag;

function startDrag() {
  endDrag();
  if (!win || win.isDestroyed() || !win.isVisible()) {
    return;
  }
  drag = { cursor: screen.getCursorScreenPoint(), bounds: win.getBounds() };
  drag.timer = setInterval(dragTick, DRAG_TICK_MS);
}

function dragTick() {
  if (!drag || !win || win.isDestroyed()) {
    return endDrag();
  }
  const p = screen.getCursorScreenPoint();
  let b = { ...drag.bounds, x: drag.bounds.x + p.x - drag.cursor.x, y: drag.bounds.y + p.y - drag.cursor.y };
  if (mode === 'inside' && owner && owner.rect) {
    // Stops flush at VS Code's edges and slides along them; follows again once the cursor is back.
    b = clampInto(b, owner.rect);
    state.inside = { ...state.inside, ...anchorOf(b, owner.rect) };
  }
  if (!sameBounds(b, win.getBounds())) {
    win.setBounds(b);
  }
}

function endDrag() {
  if (!drag) {
    return;
  }
  clearInterval(drag.timer);
  drag = undefined;
  saveState();
}

// ---- hover: the page shows its X buttons only while the cursor is over the window ----

let hoverTimer;
let hoverInside = null;

function startHover() {
  if (!hoverTimer) {
    hoverTimer = setInterval(checkHover, 100);
  }
  checkHover();
}

function stopHover() {
  clearInterval(hoverTimer);
  hoverTimer = undefined;
  setHover(false);
}

function checkHover() {
  if (!win || win.isDestroyed() || !win.isVisible()) {
    return;
  }
  const p = screen.getCursorScreenPoint();
  const b = win.getBounds();
  setHover(p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height);
}

function setHover(inside) {
  if (inside === hoverInside || !win || win.isDestroyed()) {
    return;
  }
  hoverInside = inside;
  win.webContents.send('panel', { type: 'hover', inside });
}

/** The user closed the window (X / Alt+F4). */
function hideWindow() {
  if (TEST) {
    quit(); // nothing would ever reopen it
    return;
  }
  wantVisible = false;
  saveState();
  win.hide();
  send({ type: 'closed' });
}

function quit() {
  if (quitting) {
    return;
  }
  quitting = true;
  saveState();
  if (tracker) {
    tracker.stdin.end(); // it exits on EOF
    tracker.kill();
  }
  app.quit();
}

// Messages from the page (panel.js via preload.js).
ipcMain.on('panel', (_e, m) => {
  if (!m || typeof m.type !== 'string') {
    return;
  }
  if (testRun) {
    testRun.onPanel(m);
  }
  if (m.type === 'close') {
    hideWindow();
  } else if (m.type === 'dragStart') {
    startDrag();
  } else if (m.type === 'dragEnd') {
    endDrag();
  } else if (m.type === 'sceneReady') {
    if (!sceneReady) {
      sceneReady = true;
      updateVisibility();
      if (mode === 'floating' && win.isVisible()) {
        win.moveTop();
      }
    }
  } else if (m.type === 'ready' || m.type === 'yoink' || m.type === 'mgGo' || m.type === 'mgClose') {
    send({ type: m.type });
  } else if (m.type === 'mgAnswer') {
    send({ type: m.type, answer: String(m.answer ?? '').slice(0, 4000) });
  }
});

// Commands from the extension.
function handle(c) {
  switch (c.cmd) {
    case 'show':
      wantVisible = true;
      updateVisibility();
      if (mode === 'floating' && win.isVisible()) {
        win.moveTop();
      }
      break;
    case 'hide':
      wantVisible = false;
      updateVisibility();
      break;
    case 'post':
      win.webContents.send('panel', c.msg);
      break;
    case 'claim': // this VS Code window just got focus
    case 'reclaim': // the Attach command
      if (mode === 'inside') {
        toTracker(c.cmd);
      }
      break;
    case 'quit':
      quit();
      break;
  }
}

app.whenReady().then(() => {
  createWindow();
  if (mode === 'inside') {
    startTracker();
  }
  if (!PIPE) {
    updateVisibility(); // started by hand for testing
    if (TEST) {
      testRun = require('./testRun')({ post: (m) => win.webContents.send('panel', m) });
    } else {
      // No extension to say whether a cat is out: the page waits on a blank screen for that.
      win.webContents.on('did-finish-load', () => win.webContents.send('panel', { type: 'idle' }));
    }
    return;
  }
  sock = net.connect(PIPE);
  sock.setEncoding('utf8');
  let buf = '';
  sock.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      try {
        handle(JSON.parse(line));
      } catch {
        // ignore malformed lines
      }
    }
  });
  // VS Code went away (closed or crashed): don't leave an orphan window behind.
  sock.on('close', quit);
  sock.on('error', quit);
});

app.on('window-all-closed', quit);
