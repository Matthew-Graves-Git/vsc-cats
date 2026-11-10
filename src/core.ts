// The Cat Yoink extension itself. Loaded (and hot-reloaded) by extension.ts.
import * as vscode from 'vscode';
import * as path from 'path';
import { BrowserStatus, DiscordBrowser, DiscordEvent, MinigameForm } from './discordBrowser';
import { CatWindow, TerminalMessage } from './catWindow';
import { surfSet } from './gifs';
import { parseCatch, parseLateCatchers, sameName, spawnCaption, spawnType, spawnWord } from './catText';
import { OwnerLock } from './lock';

const CHANNEL_RE = /^https:\/\/(?:\w+\.)?discord(?:app)?\.com\/channels\/(\d+|@me)\/\d+\/?$/;
const CONFIRM_TIMEOUT_MS = 30_000;
const RESET_DELAY_MS = 3_500;
/** Cat Bot posts the late-catcher list when its 5 s window closes; allow some slack. */
const LATE_WAIT_MS = 8_000;
/** A bonus message this soon after our catch is ours to play. */
const BONUS_AFTER_CATCH_MS = 120_000;
const RESULT_WAIT_MS = 15_000;

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
  reg('catYoink.menu', menu);

  context.subscriptions.push(
    statusItem,
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('catYoink.channelUrl') && browser) {
        void startWatching();
      }
      if (e.affectsConfiguration('catYoink.alwaysOnTop')) {
        panel.setAlwaysOnTop(cfg().get<boolean>('alwaysOnTop', true));
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
    dumpDir: path.join(storage, 'minigame-dumps'),
  });
  b.onEvent = (e) => void onDiscordEvent(e);
  b.onStatus = (s, d) => onBrowserStatus(b, s, d);
  browser = b;

  panel.show();
  panel.idle();
  await b.start(forceLogin);
}

async function stopWatching() {
  await shutdown(true);
  panel.hide();
}

async function shutdown(updateStatus = true) {
  clearTimers();
  active = undefined;
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
  }
}

async function onSpawn(e: Extract<DiscordEvent, { kind: 'spawn' }>) {
  clearTimers();
  const trigger = cfg().get<string>('triggerText', 'appeared!');
  const caption = spawnCaption(e.text, trigger);
  active = { id: e.id, yoinked: false, resolved: false, type: spawnType(caption, trigger) };
  panel.spawn(caption, surfSet(ctx.extensionPath, spawnWord(caption, trigger)), !!e.existing);
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
    panel.result(`Yoinked! ${type} caught!`, true);
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
        const right = answer.trim().toLowerCase() === b.test.answer.toLowerCase();
        setTimeout(() => {
          if (bonus === b) {
            clearBonus();
            panel.terminal({
              type: 'result',
              win: right,
              text: right
                ? `@you got +3 ${b.test!.form.title} bonus cats. (test)`
                : `Better luck next time!\nCorrect answer: ${b.test!.answer}\nYour answer: ${answer}`,
            });
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
  const rounds: { form: MinigameForm; answer: string }[] = [
    {
      form: {
        title: 'Fine',
        prompt:
          "Count the amount of E's in this text\n\nThe quick brown fox jumps over the lazy dog. She sells sea shells by the sea shore.",
        kind: 'text',
        maxLength: 2,
        timeLimitMs: 45_000,
      },
      answer: '10',
    },
    {
      form: {
        title: 'Brave',
        prompt: 'Find the number whose digits only ascend',
        kind: 'choice',
        options: [
          '918273', '123789', '554321', '987123', '135792', '246813', '112358', '975310', '864209',
          '192837', '273645', '384756', '495867', '516273', '627384', '738495', '849516', '951627',
          '162738', '273849', '384951', '495162', '516384', '627495', '738516',
        ],
        timeLimitMs: 45_000,
      },
      answer: '123789',
    },
    {
      form: {
        title: 'Corrupt',
        prompt: 'How many 1s are in this binary number?\n\n10110010111000101101001110100101100111010010110100',
        kind: 'text',
        maxLength: 2,
        timeLimitMs: 45_000,
      },
      answer: '26',
    },
    {
      form: {
        title: 'Real',
        prompt: 'Which planet in our solar system has the most confirmed moons as of the latest count?',
        kind: 'choice',
        options: ['Saturn', 'Jupiter', 'Uranus, the ice giant tipped on its side', 'Neptune'],
        timeLimitMs: 45_000,
      },
      answer: 'Saturn',
    },
  ];
  const round = rounds[testRound++ % rounds.length];
  clearBonus();
  bonus = { id: 'test', stage: 'offer', test: round };
  panel.terminal({
    type: 'offer',
    text: `BONUS ${round.form.title.toUpperCase()} CAT! (test)\nAnyone who cought this cat can play a minigame and potentially get +3 more!`,
    test: true,
  } as TerminalMessage);
}
