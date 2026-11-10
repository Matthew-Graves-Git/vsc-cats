// The Cat Yoink extension itself. Loaded (and hot-reloaded) by extension.ts.
import * as vscode from 'vscode';
import * as path from 'path';
import { BrowserStatus, DiscordBrowser, DiscordEvent, MinigameForm } from './discordBrowser';
import { CatWindow, TerminalMessage, windowModeSetting } from './catWindow';
import { rainCats, rainScene, rainSet, surfSet } from './gifs';
import { parseCatch, parseLateCatchers, sameName, spawnCaption, spawnTitle, spawnType, spawnWord } from './catText';
import { OwnerLock } from './lock';
import { TEST_ROUNDS, testResultText } from './testRounds';

const CHANNEL_RE = /^https:\/\/(?:\w+\.)?discord(?:app)?\.com\/channels\/(\d+|@me)\/\d+\/?$/;
const CONFIRM_TIMEOUT_MS = 30_000;
const RESET_DELAY_MS = 3_500;
/** Cat Bot posts the late-catcher list when its 5 s window closes; allow some slack. */
const LATE_WAIT_MS = 8_000;
/** A bonus message this soon after our catch is ours to play. */
const BONUS_AFTER_CATCH_MS = 120_000;
const RESULT_WAIT_MS = 15_000;
/**
 * A cat rain with no new cat for this long is over, even if we missed Cat Bot's "cat rain has
 * ended" (rain cats come 1-2 s after each catch, so this only fires when something went wrong).
 */
const RAIN_IDLE_MS = 5 * 60_000;
/** Show Nyan anyway if the first check of the channel (is a cat out?) takes longer than this. */
const FIRST_CHECK_MAX_MS = 20_000;
const RAIN_START_DEFAULT = 'cat rain was started|started a short rain|\\brain will start\\b|\\brain extended\\b';
const RAIN_END_DEFAULT = 'cat rain has ended';

interface ActiveCat {
  id: string;
  yoinked: boolean;
  resolved: boolean;
  /** e.g. "Fine cat", from the spawn message. */
  type?: string;
  timer?: NodeJS.Timeout;
  /** Someone else was first; waiting for Cat Bot's late-catcher list. */
  late?: { who: string; type: string; timer: NodeJS.Timeout };
}

interface Bonus {
  /** The bonus message's li id, or 'test' for the test command. */
  id: string;
  stage: 'offer' | 'question' | 'submitted';
  timer?: NodeJS.Timeout;
  test?: { form: MinigameForm; answer: string };
}

let ctx: vscode.ExtensionContext;
let statusItem: vscode.StatusBarItem;
let panel: CatWindow;
let lock: OwnerLock;
let browser: DiscordBrowser | undefined;
let active: ActiveCat | undefined;
let idleTimer: NodeJS.Timeout | undefined;
let lastCatch: { at: number; type: string } | undefined;
let bonus: Bonus | undefined;
let testRound = 0;
/** A cat rain is on (and its GIFs are installed). */
let raining = false;
let rainTimer: NodeJS.Timeout | undefined;
/** Cancels the running Test Rain, if any. */
let stopTestRain: (() => void) | undefined;
/** Watching started but the channel hasn't been checked for a cat yet; the window shows no Nyan. */
let waiting = false;
let waitTimer: NodeJS.Timeout | undefined;

const cfg = () => vscode.workspace.getConfiguration('catYoink');

export function activate(context: vscode.ExtensionContext) {
  ctx = context;
  lock = new OwnerLock(context.globalStorageUri.fsPath);
  panel = new CatWindow(context.extensionPath, context.globalStorageUri.fsPath);
  panel.setCount(context.globalState.get<number>('catCount', 0));
  panel.onYoink = () => void yoink();
  panel.onTerminal = (m) => void onTerminalMessage(m);
  // Earlier versions used a VS Code floating webview; close it if VS Code restores one.
  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer('catYoink', {
      deserializeWebviewPanel: async (p) => p.dispose(),
    })
  );

  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusItem.command = 'catYoink.menu';
  setStatus('Off');
  statusItem.show();

  const reg = (id: string, fn: (...a: any[]) => any) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  reg('catYoink.setChannel', setChannel);
  reg('catYoink.start', () => startWatching());
  reg('catYoink.stop', () => stopWatching());
  reg('catYoink.login', () => startWatching(true));
  reg('catYoink.showPanel', () => {
    if (!browser && lock.isHeldByOther()) {
      void vscode.window.showInformationMessage('Cat Yoink is running in another VS Code window.');
      return;
    }
    panel.show();
  });
  reg('catYoink.resetCount', () => {
    ctx.globalState.update('catCount', 0);
    panel.setCount(0);
  });
  reg('catYoink.testTerminal', testTerminal);
  reg('catYoink.testRain', testRain);
  reg('catYoink.attachWindow', () => {
    if (!browser && lock.isHeldByOther()) {
      void vscode.window.showInformationMessage('Cat Yoink is running in another VS Code window.');
      return;
    }
    if (windowModeSetting() === 'floating') {
      void vscode.window.showInformationMessage('Cat Yoink: "catYoink.windowMode" is "floating", so the window is not attached to VS Code.');
      return;
    }
    panel.show();
    panel.claimOwner(true); // the command palette just focused this window, so it is in front
  });
  reg('catYoink.menu', menu);

  context.subscriptions.push(
    statusItem,
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('catYoink.channelUrl') && browser) {
        void startWatching();
      }
      if (e.affectsConfiguration('catYoink.windowMode')) {
        void panel.setMode(windowModeSetting());
      }
    }),
    // The cat window attaches to the VS Code window that is in front when this one gets focus.
    vscode.window.onDidChangeWindowState((s) => {
      if (s.focused) {
        panel.claimOwner();
      }
    })
  );

  // Opens the Cat Yoink window and starts watching every time VS Code starts.
  if (cfg().get<boolean>('autoStart', true) && cfg().get<string>('channelUrl')) {
    void startWatching();
  }
}

/** Stops the browser and closes the cat window; resolves once both are gone. */
export async function deactivate(): Promise<void> {
  clearBonus();
  stopTestRain?.();
  await Promise.all([panel?.dispose(), shutdown()]);
}

// ---------- commands ----------

async function setChannel() {
  const url = await vscode.window.showInputBox({
    title: 'Cat Yoink: Discord channel link',
    prompt: 'Paste the channel link (right-click the channel in Discord > Copy Link).',
    placeHolder: 'https://discord.com/channels/123456789/987654321',
    value: cfg().get<string>('channelUrl', ''),
    ignoreFocusOut: true,
    validateInput: (v) =>
      CHANNEL_RE.test(v.trim()) ? undefined : 'Expected https://discord.com/channels/<server>/<channel>',
  });
  if (!url) {
    return;
  }
  await cfg().update('channelUrl', url.trim(), vscode.ConfigurationTarget.Global);
  await startWatching();
}

async function menu() {
  const running = !!browser;
  const pick = await vscode.window.showQuickPick(
    [
      running ? { label: 'Stop watching', id: 'catYoink.stop' } : { label: 'Start watching', id: 'catYoink.start' },
      { label: 'Log in to Discord (show browser)', id: 'catYoink.login' },
      { label: 'Show panel', id: 'catYoink.showPanel' },
      { label: 'Attach window here', id: 'catYoink.attachWindow' },
      { label: 'Set channel link', id: 'catYoink.setChannel' },
    ],
    { title: 'Cat Yoink' }
  );
  if (pick) {
    await vscode.commands.executeCommand(pick.id);
  }
}

// ---------- watching ----------

async function startWatching(forceLogin = false) {
  const channelUrl = (cfg().get<string>('channelUrl') ?? '').trim();
  if (!CHANNEL_RE.test(channelUrl)) {
    const choice = await vscode.window.showWarningMessage(
      'Cat Yoink needs a Discord channel link first.',
      'Set Channel'
    );
    if (choice) {
      await setChannel();
    }
    return;
  }

  await shutdown(false);

  if (!lock.acquire()) {
    setStatus('Watching in another window');
    return;
  }

  const c = cfg();
  const storage = ctx.globalStorageUri.fsPath;
  const b = new DiscordBrowser({
    profileDir: path.join(storage, 'browser-profile'),
    channelUrl,
    browserPath: c.get<string>('browserPath', ''),
    botName: c.get<string>('botName', 'Cat Bot'),
    triggerText: c.get<string>('triggerText', 'appeared!'),
    caughtText: c.get<string>('caughtText', '\\bc[a-z]*ught'),
    replyText: c.get<string>('replyText', 'cat'),
    rainStartText: c.get<string>('rainStartText', RAIN_START_DEFAULT),
    rainEndText: c.get<string>('rainEndText', RAIN_END_DEFAULT),
    dumpDir: path.join(storage, 'minigame-dumps'),
  });
  b.onEvent = (e) => void onDiscordEvent(e);
  b.onStatus = (s, d) => onBrowserStatus(b, s, d);
  browser = b;

  panel.show();
  beginWaiting();
  await b.start(forceLogin);
}

async function stopWatching() {
  await shutdown(true);
  panel.idle(); // so "Show panel" later opens on Nyan, not the loading screen
  panel.hide();
}

/** Holds off Nyan until the channel has been checked for a cat that is already out. */
function beginWaiting() {
  clearTimeout(waitTimer);
  waiting = true;
  panel.loading();
  waitTimer = setTimeout(endWaiting, FIRST_CHECK_MAX_MS);
}

/** The first check is done (or gave up): no cat was found, so show Nyan. */
function endWaiting() {
  if (!waiting) {
    return;
  }
  stopWaiting();
  if (!active) {
    panel.idle();
  }
}

function stopWaiting() {
  clearTimeout(waitTimer);
  waitTimer = undefined;
  waiting = false;
}

async function shutdown(updateStatus = true) {
  stopWaiting();
  clearTimers();
  active = undefined;
  endRain();
  const b = browser;
  browser = undefined;
  if (b) {
    b.onStatus = () => {};
    await b.stop();
  }
  lock?.release();
  if (updateStatus && statusItem) {
    setStatus('Off');
  }
}

function onBrowserStatus(b: DiscordBrowser, s: BrowserStatus, detail?: string) {
  if (b !== browser) {
    return;
  }
  switch (s) {
    case 'starting':
      setStatus('Starting…');
      break;
    case 'watching':
      setStatus('Watching');
      break;
    case 'login':
      endWaiting(); // Nyan while the user logs in
      setStatus('Login needed');
      if (detail) {
        void vscode.window
          .showWarningMessage('Discord session expired.', 'Log in')
          .then((c) => c && b.relogin());
      } else {
        void vscode.window.showInformationMessage(
          'Cat Yoink: log in to Discord in the browser window. It will hide itself afterwards.'
        );
      }
      break;
    case 'error':
      endWaiting();
      setStatus('Error');
      void vscode.window.showErrorMessage(`Cat Yoink: ${detail ?? 'unknown error'}`);
      break;
    case 'stopped':
      break;
  }
}

function setStatus(text: string) {
  statusItem.text = `$(cat-yoink-cat) ${text}`;
  statusItem.tooltip = 'Cat Yoink — click for menu';
}

// ---------- who is "me" ----------

/**
 * Cat Bot names catchers by Discord username; we also know the display name from our own
 * messages. Either one counts.
 */
function isMe(name: string | undefined): boolean {
  return (
    sameName(name, ctx.globalState.get<string>('username')) ||
    sameName(name, ctx.globalState.get<string>('displayName'))
  );
}

// ---------- cat flow ----------

async function onDiscordEvent(e: DiscordEvent) {
  if (e.kind === 'spawn' || (e.kind === 'rainStart' && !raining)) {
    stopTestRain?.(); // the real channel wins
  }
  switch (e.kind) {
    case 'spawn':
      return onSpawn(e);
    case 'caught':
      return onCaught(e.text, e.firstAuthor);
    case 'lateCatchers':
      return onLateCatchers(e.text);
    case 'spawnGone':
      if (active && active.id === e.id && !active.yoinked && !active.resolved) {
        resolveTooSlow(`The ${active.type ?? 'cat'} got away.`);
      }
      return;
    case 'ownMessage':
      await ctx.globalState.update('displayName', e.author);
      return;
    case 'bonus':
      return onBonus(e.id, e.text, e.mentionsMe);
    case 'bonusGone':
      if (bonus && bonus.id === e.id && bonus.stage === 'offer') {
        clearBonus();
        panel.terminal({ type: 'expired' });
      }
      return;
    case 'minigameResult':
      if (bonus && bonus.stage !== 'offer') {
        clearBonus();
        panel.terminal({ type: 'result', text: e.text, win: e.win });
      }
      return;
    case 'rainStart':
      return startRain(!!e.existing);
    case 'rainEnd':
      return endRain();
    case 'attached':
      return endWaiting();
  }
}

// ---------- cat rain ----------

/** Cat Bot started (or extended) a cat rain. `existing`: it was already raining when we attached. */
function startRain(existing: boolean) {
  armRainTimer();
  if (raining) {
    return;
  }
  const scene = rainScene(ctx.extensionPath);
  if (!scene) {
    return; // no rain GIFs installed: rain looks like any other time
  }
  raining = true;
  panel.rain(scene, existing);
}

function endRain() {
  clearTimeout(rainTimer);
  rainTimer = undefined;
  if (raining) {
    raining = false;
    panel.rain(undefined);
  }
}

function armRainTimer() {
  clearTimeout(rainTimer);
  rainTimer = setTimeout(endRain, RAIN_IDLE_MS);
}

async function onSpawn(e: Extract<DiscordEvent, { kind: 'spawn' }>) {
  stopWaiting(); // the cat replaces the loading screen
  clearTimers();
  const trigger = cfg().get<string>('triggerText', 'appeared!');
  const caption = spawnCaption(e.text, trigger);
  const type = spawnType(caption, trigger);
  active = { id: e.id, yoinked: false, resolved: false, type };
  if (raining) {
    armRainTimer();
  }
  const word = spawnWord(caption, trigger);
  panel.spawn(e.id, spawnTitle(type), surfSet(ctx.extensionPath, word), rainSet(ctx.extensionPath, word), !!e.existing);
}

function countCatch(type: string) {
  const count = ctx.globalState.get<number>('catCount', 0) + 1;
  void ctx.globalState.update('catCount', count);
  panel.setCount(count);
  lastCatch = { at: Date.now(), type };
}

function onCaught(text: string, firstAuthor: string | undefined) {
  if (!active || active.resolved || active.late) {
    return;
  }
  const c = parseCatch(text, cfg().get<string>('caughtText', '\\bc[a-z]*ught'));
  const type = c.type ?? active.type ?? 'cat';
  const who = c.who ?? 'Someone';
  if (!active.yoinked) {
    resolveTooSlow(`${who} caught the ${type}.`);
    return;
  }
  clearTimeout(active.timer);

  // We clicked Yoink: is the catcher us?
  const displayName = ctx.globalState.get<string>('displayName') ?? '';
  let mine = isMe(c.who) || (!c.who && !!displayName && text.toLowerCase().includes(displayName.toLowerCase()));
  if (!mine && c.who && sameName(firstAuthor, displayName)) {
    // Our "cat" was the first one Cat Bot saw, so the name it printed is our username.
    mine = true;
    void ctx.globalState.update('username', c.who.replace(/\\_/g, '_'));
  }
  if (mine) {
    active.resolved = true;
    countCatch(type);
    panel.result(`${type} Yoinked!`, true);
    scheduleIdle();
    return;
  }

  // Someone else was first. We may still be a late catcher (+1); Cat Bot lists those when its
  // catch window closes.
  const a = active;
  panel.status(`${who} was first... checking late catch`);
  a.late = { who, type, timer: setTimeout(() => finishLate(a, false), LATE_WAIT_MS) };
}

function onLateCatchers(text: string) {
  if (active?.late && !active.resolved) {
    finishLate(active, parseLateCatchers(text).some(isMe));
  }
}

function finishLate(a: ActiveCat, listed: boolean) {
  if (active !== a || !a.late || a.resolved) {
    return;
  }
  clearTimeout(a.late.timer);
  a.resolved = true;
  const { who, type } = a.late;
  if (listed) {
    countCatch(type);
    panel.result(`Late catch! +1 ${type}`, true);
  } else {
    panel.result(`Too slow! ${who} caught the ${type}.`, false);
  }
  scheduleIdle();
}

function resolveTooSlow(text: string) {
  if (!active) {
    return;
  }
  active.resolved = true;
  panel.tooSlow(text);
  scheduleIdle(5000);
}

async function yoink() {
  const a = active;
  if (!a || a.yoinked || a.resolved || !browser) {
    return;
  }
  a.yoinked = true;
  try {
    await browser.sendReply();
  } catch (err: any) {
    a.resolved = true;
    panel.result(`Couldn't send: ${err?.message ?? err}`, false);
    scheduleIdle(5000);
    return;
  }
  // Wait for Cat Bot's confirmation; give up after a while.
  a.timer = setTimeout(() => {
    if (active === a && !a.resolved && !a.late) {
      a.resolved = true;
      panel.result('Sent! No confirmation from Cat Bot, so it was not counted.', false);
      scheduleIdle();
    }
  }, CONFIRM_TIMEOUT_MS);
}

function scheduleIdle(ms = RESET_DELAY_MS) {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    active = undefined;
    panel.idle();
  }, ms);
}

function clearTimers() {
  clearTimeout(idleTimer);
  if (active?.timer) {
    clearTimeout(active.timer);
  }
  if (active?.late) {
    clearTimeout(active.late.timer);
  }
}

// ---------- bonus minigame ----------

/** "BONUS FINE CAT!\nAnyone who cought…\n@me @them" -> without the ping line and markdown. */
function cleanBonusText(text: string): string {
  return text
    .split('\n')
    .map((l) => l.replace(/\*\*/g, '').trim())
    .filter((l) => l && !l.startsWith('@') && !l.startsWith('-#')) // the ping line ("@Matt G @bob")
    .join('\n');
}

function onBonus(id: string, text: string, mentionsMe: boolean) {
  const recentCatch = !!lastCatch && Date.now() - lastCatch.at < BONUS_AFTER_CATCH_MS;
  if (!mentionsMe && !recentCatch) {
    return; // only for cats the user caught
  }
  clearBonus();
  bonus = { id, stage: 'offer' };
  panel.terminal({ type: 'offer', text: cleanBonusText(text) });
}

function clearBonus() {
  if (bonus?.timer) {
    clearTimeout(bonus.timer);
  }
  bonus = undefined;
}

/** After Go/submit, Cat Bot should answer with a message; don't wait forever. */
function waitForResult(b: Bonus) {
  clearTimeout(b.timer);
  b.timer = setTimeout(() => {
    if (bonus === b) {
      clearBonus();
      panel.terminal({ type: 'result', text: 'No reply from Cat Bot.', win: false });
    }
  }, RESULT_WAIT_MS);
}

async function onTerminalMessage(m: { type: string; answer?: unknown }) {
  const b = bonus;
  switch (m.type) {
    case 'mgGo': {
      if (!b || b.stage !== 'offer') {
        panel.terminal({ type: 'result', text: 'That minigame is gone.', win: false });
        return;
      }
      b.stage = 'question';
      if (b.test) {
        panel.terminal({ type: 'question', form: b.test.form });
        return;
      }
      if (!browser) {
        clearBonus();
        panel.terminal({ type: 'result', text: 'Not connected to Discord.', win: false });
        return;
      }
      try {
        const form = await browser.pressBonusGo(b.id);
        if (bonus !== b) {
          return;
        }
        if (form) {
          panel.terminal({ type: 'question', form });
        } else {
          b.stage = 'submitted'; // Cat Bot replied with a message instead of a question
          waitForResult(b);
        }
      } catch (err: any) {
        if (bonus === b) {
          clearBonus();
          panel.terminal({ type: 'result', text: `ERROR: ${err?.message ?? err}`, win: false });
        }
      }
      return;
    }
    case 'mgAnswer': {
      if (!b || b.stage !== 'question') {
        return;
      }
      const answer = String(m.answer ?? '');
      if (b.test) {
        b.stage = 'submitted';
        panel.terminal({ type: 'submitted' });
        const result = testResultText(b.test, answer);
        setTimeout(() => {
          if (bonus === b) {
            clearBonus();
            panel.terminal({ type: 'result', ...result });
          }
        }, 900);
        return;
      }
      if (!browser) {
        return;
      }
      try {
        await browser.submitMinigame(answer);
        if (bonus === b) {
          b.stage = 'submitted';
          panel.terminal({ type: 'submitted' });
          waitForResult(b);
        }
      } catch (err: any) {
        if (bonus === b) {
          panel.terminal({ type: 'error', text: String(err?.message ?? err) }); // still answerable
        }
      }
      return;
    }
    case 'mgClose': {
      if (b && b.stage === 'question' && !b.test) {
        void browser?.cancelModal(); // don't leave the modal covering Discord's message box
      }
      clearBonus();
      return;
    }
  }
}

/** Runs the terminal popup with made-up questions, no Discord involved. */
function testTerminal() {
  const round = TEST_ROUNDS[testRound++ % TEST_ROUNDS.length];
  clearBonus();
  bonus = { id: 'test', stage: 'offer', test: round };
  panel.terminal({
    type: 'offer',
    text: `BONUS ${round.form.title.toUpperCase()} CAT! (test)\nAnyone who cought this cat can play a minigame and potentially get +3 more!`,
    test: true,
  } as TerminalMessage);
}

/**
 * Plays a short made-up cat rain in the window (no Discord involved): the storm starts, a few
 * random cats come and go, and the storm clears. Real Discord events cancel it.
 */
function testRain() {
  const scene = rainScene(ctx.extensionPath);
  if (!scene) {
    void vscode.window.showErrorMessage('Cat Yoink: the cat rain GIFs (media/gifs/cat_thunderstorm_event) are missing.');
    return;
  }
  if (raining || active) {
    void vscode.window.showInformationMessage('Cat Yoink: a real cat is out or a real rain is on; try again later.');
    return;
  }
  stopTestRain?.();
  const timers: NodeJS.Timeout[] = [];
  const later = (ms: number, fn: () => void) => timers.push(setTimeout(fn, ms));
  stopTestRain = () => {
    timers.forEach(clearTimeout);
    stopTestRain = undefined;
    panel.rain(undefined); // a real rain can't have started: it cancels the test first
    if (!active) {
      panel.idle(); // the test cat goes away; a real one is about to replace it otherwise
    }
  };

  const names = [...rainCats(ctx.extensionPath).keys()];
  const pick = () => names[Math.floor(Math.random() * names.length)];
  // Every clip is 2.5 s, so a cat needs ~9 s out to be seen looping between its enter and exit.
  // After each catch, the next cat comes 1.5 s later (a cat waiting as the exit ends walks straight
  // in), except once: a 7 s gap that leaves the empty storm on screen.
  const gaps = [1_500, 7_000, 1_500];
  const stamp = Date.now();
  panel.rain(scene);
  let t = 1_000; // the first cat is waiting by the end of the rain start transition
  gaps.forEach((gap, i) => {
    const word = pick();
    const name = word.charAt(0).toUpperCase() + word.slice(1);
    later(t, () =>
      panel.spawn(`test-rain-${stamp}-${i}`, spawnTitle(`${name} cat`), surfSet(ctx.extensionPath, word), rainSet(ctx.extensionPath, word))
    );
    t += 9_000;
    later(t, () => panel.result(`${name} cat Yoinked! (test)`, true));
    t += gap;
  });
  later(t, () => {
    panel.rain(undefined);
    panel.idle();
    stopTestRain = undefined;
  });
}
