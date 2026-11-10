// Electron main process for the Cat Yoink window: a frameless, resizable, always-on-top window
// that shows media/panel.html. The VS Code extension spawns this and talks to it over a named
// pipe using JSON lines. Plain JS (not compiled by tsc) because it runs inside Electron.
const { app, BrowserWindow, ipcMain, screen } = require('electron');
const fs = require('fs');
const net = require('net');
const path = require('path');

const PIPE = process.env.CAT_YOINK_PIPE;
const STATE = process.env.CAT_YOINK_STATE;
const MEDIA = path.join(__dirname, '..', 'media');
let onTop = process.env.CAT_YOINK_ON_TOP !== '0';

app.setName('Cat Yoink');
if (process.env.CAT_YOINK_USER_DATA) {
  app.setPath('userData', process.env.CAT_YOINK_USER_DATA);
}

let win;
let sock;
let quitting = false;

const send = (m) => {
  if (sock && !sock.destroyed) {
    sock.write(JSON.stringify(m) + '\n');
  }
};

// ---- saved position and size ----

const DEFAULT_SIZE = { width: 340, height: 380 };

function defaultBounds() {
  const area = screen.getPrimaryDisplay().workArea;
  return {
    ...DEFAULT_SIZE,
    x: area.x + area.width - DEFAULT_SIZE.width - 24,
    y: area.y + area.height - DEFAULT_SIZE.height - 24,
  };
}

function loadBounds() {
  try {
    const b = JSON.parse(fs.readFileSync(STATE, 'utf8'));
    const ok = ['x', 'y', 'width', 'height'].every((k) => Number.isFinite(b[k]));
    // Only reuse it if it still overlaps a connected display (e.g. a monitor was unplugged).
    const visible =
      ok &&
      screen.getAllDisplays().some(({ workArea: a }) =>
        b.x < a.x + a.width - 40 && b.x + b.width > a.x + 40 && b.y < a.y + a.height - 40 && b.y + b.height > a.y
      );
    if (visible) {
      return { x: b.x, y: b.y, width: Math.max(200, b.width), height: Math.max(200, b.height) };
    }
  } catch {
    // no saved state yet
  }
  return defaultBounds();
}

function saveBounds() {
  if (!STATE || !win || win.isDestroyed()) {
    return;
  }
  try {
    fs.mkdirSync(path.dirname(STATE), { recursive: true });
    fs.writeFileSync(STATE, JSON.stringify(win.getBounds()));
  } catch {
    // best effort
  }
}

// ---- window ----

function createWindow() {
  win = new BrowserWindow({
    ...loadBounds(),
    minWidth: 200,
    minHeight: 200,
    frame: false,
    resizable: true,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: onTop,
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
  if (onTop) {
    win.setAlwaysOnTop(true, 'floating');
  }
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  let saveTimer;
  const scheduleSave = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveBounds, 300);
  };
  win.on('moved', scheduleSave);
  win.on('resized', scheduleSave);
  win.on('move', scheduleSave);
  win.on('resize', scheduleSave);

  // The X button and Alt+F4 hide the window; watching continues and the next cat reopens it.
  win.on('close', (e) => {
    saveBounds();
    if (!quitting) {
      e.preventDefault();
      hideWindow();
    }
  });

  // The page can't see hover itself: almost all of it is a drag region, which gets no mouse events.
  win.on('show', startHover);
  win.on('hide', stopHover);
  win.webContents.on('did-finish-load', () => {
    hoverInside = null; // resend the current state to the fresh page
    checkHover();
  });

  win.loadFile(path.join(MEDIA, 'panel.html'));
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

function hideWindow() {
  saveBounds();
  win.hide();
  send({ type: 'closed' });
}

function quit() {
  if (quitting) {
    return;
  }
  quitting = true;
  saveBounds();
  app.quit();
}

// Messages from the page (panel.js via preload.js).
ipcMain.on('panel', (_e, m) => {
  if (!m || typeof m.type !== 'string') {
    return;
  }
  if (m.type === 'close') {
    hideWindow();
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
      if (!win.isVisible()) {
        win.showInactive(); // never steal focus from the editor
      }
      win.moveTop();
      break;
    case 'hide':
      saveBounds();
      win.hide();
      break;
    case 'post':
      win.webContents.send('panel', c.msg);
      break;
    case 'config':
      onTop = !!c.alwaysOnTop;
      win.setAlwaysOnTop(onTop, 'floating');
      break;
    case 'quit':
      quit();
      break;
  }
}

app.whenReady().then(() => {
  createWindow();
  if (!PIPE) {
    win.show(); // started by hand for testing
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
