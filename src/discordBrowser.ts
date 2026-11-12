import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import puppeteer, { Browser, ElementHandle, Page } from 'puppeteer-core';

export type BrowserStatus = 'starting' | 'watching' | 'login' | 'error' | 'stopped';

export type DiscordEvent =
  /** `existing`: the cat was already in the channel when watching started (not a new spawn). */
  | { kind: 'spawn'; id: string; text: string; existing?: boolean }
  /** `firstAuthor`: display name on the earliest "cat" reply since the spawn (whoever Cat Bot saw first). */
  | { kind: 'caught'; text: string; firstAuthor?: string }
  | { kind: 'spawnGone'; id: string }
  | { kind: 'ownMessage'; author: string }
  /** Cat Bot's "Late Fine catchers:" list, one catcher per line. */
  | { kind: 'lateCatchers'; text: string }
  /** Cat Bot's "BONUS FINE CAT!" message with a Go! button. */
  | { kind: 'bonus'; id: string; text: string; mentionsMe: boolean }
  | { kind: 'bonusGone'; id: string }
  /** Cat Bot's answer to our minigame submission (✅ win, ❌ wrong / too slow / not eligible). */
  | { kind: 'minigameResult'; text: string; win: boolean }
  /**
   * Cat Bot started (or extended) a cat rain. `existing`: the newest rain message in the channel
   * when we attached was a start, so it was already raining.
   */
  | { kind: 'rainStart'; existing?: boolean }
  /** Cat Bot's "cat rain has ended" (or, when we attached, the newest rain message was one). */
  | { kind: 'rainEnd' }
  /**
   * The channel was scanned (on start, and again whenever Discord re-renders the list). A rain or
   * cat already there was emitted just before this.
   */
  | { kind: 'attached' };

/** The question in Cat Bot's minigame modal, as scraped from Discord. */
export interface MinigameForm {
  title: string;
  prompt: string;
  kind: 'text' | 'choice';
  /** For 'choice': the option labels, in order. */
  options?: string[];
  /** For 'text': a multi-line box (eGirl), and the length limits Discord enforces. */
  multiline?: boolean;
  minLength?: number;
  maxLength?: number;
  /** Cat Bot gives 45 seconds from the moment the modal opens. */
  timeLimitMs: number;
}

export interface BrowserOptions {
  profileDir: string;
  channelUrl: string;
  browserPath: string;
  botName: string;
  triggerText: string;
  caughtText: string;
  replyText: string;
  /** Case-insensitive regexes for Cat Bot's cat rain start and end messages. */
  rainStartText: string;
  rainEndText: string;
  /** Where to save a copy of each minigame modal's HTML (to fix selectors if Discord changes). */
  dumpDir?: string;
}

const TEXTBOX = 'div[role="textbox"][data-slate-editor="true"]';
const MINIGAME_MS = 45_000;

export function detectBrowser(configured: string): string | undefined {
  if (configured && fs.existsSync(configured)) {
    return configured;
  }
  const pf = process.env['ProgramFiles'] ?? 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
  const local = process.env['LOCALAPPDATA'] ?? '';
  const candidates = [
    path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ];
  return candidates.find((c) => c && fs.existsSync(c));
}

/** Runs a program and resolves to its stdout ('' on any failure). */
export function run(file: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    cp.execFile(file, args, { windowsHide: true, timeout: 20_000 }, (_err, stdout) => resolve(String(stdout ?? '')));
  });
}

/**
 * Kills browsers still running on our Discord profile. They are left behind when an extension
 * host dies without closing them (Windows doesn't kill child processes with their parent), and
 * while one runs, every new launch on the same profile hands off to it and exits, which
 * puppeteer reports as "Failed to launch the browser process".
 *
 * Only call this while holding the OwnerLock: then no live VS Code window is using the profile.
 */
export async function killStaleBrowsers(profileDir: string, force = false): Promise<number> {
  if (process.platform === 'win32') {
    if (!force) {
      // Chromium keeps <profile>\lockfile open while it runs; if we can delete it, nothing is running.
      try {
        fs.rmSync(path.join(profileDir, 'lockfile'));
        return 0;
      } catch (e: any) {
        if (!['EBUSY', 'EPERM', 'EACCES'].includes(e?.code)) {
          return 0; // ENOENT (never ran) or something unrelated
        }
      }
    }
    const needle = profileDir.toLowerCase().replace(/'/g, "''");
    const script =
      `Get-CimInstance Win32_Process -Filter 'Name=''msedge.exe'' OR Name=''chrome.exe''' | ` +
      `Where-Object { $_.CommandLine -and $_.CommandLine.ToLower().Contains('${needle}') -and ` +
      `$_.CommandLine -notmatch '--type=' } | ForEach-Object { $_.ProcessId }`;
    const out = await run('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      script,
    ]);
    const pids = out
      .split(/\s+/)
      .map(Number)
      .filter((n) => Number.isInteger(n) && n > 0);
    for (const pid of pids) {
      await run('taskkill.exe', ['/PID', String(pid), '/T', '/F']);
    }
    if (pids.length) {
      await sleep(700); // let the profile lock go
    }
    return pids.length;
  }
  const out = await run('ps', ['-axo', 'pid=,args=']);
  let killed = 0;
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (m && m[2].includes(`--user-data-dir=${profileDir}`) && !m[2].includes('--type=')) {
      try {
        process.kill(Number(m[1]), 'SIGKILL');
        killed++;
      } catch {
        // already gone
      }
    }
  }
  if (killed) {
    await sleep(700);
  }
  return killed;
}

/**
 * Drives Discord in a real browser. Headless while watching; a visible window only
 * while the user needs to log in.
 */
export class DiscordBrowser {
  private browser?: Browser;
  private page?: Page;
  private stopped = true;
  private loginLoop?: Promise<void>;
  private sessionExpiredShown = false;
  private modalTimer?: NodeJS.Timeout;

  onEvent: (e: DiscordEvent) => void = () => {};
  onStatus: (s: BrowserStatus, detail?: string) => void = () => {};

  constructor(private opts: BrowserOptions) {}

  async start(forceLogin = false): Promise<void> {
    this.stopped = false;
    this.onStatus('starting');
    try {
      if (!forceLogin) {
        const loggedIn = await this.launch(true);
        if (loggedIn) {
          await this.beginWatching();
          return;
        }
        await this.close();
      }
      await this.loginFlow();
    } catch (e: any) {
      await this.close();
      if (/already running|user data directory|ProcessSingleton/i.test(String(e?.message))) {
        this.onStatus('error', 'Browser profile is in use by another window.');
      } else {
        this.onStatus('error', String(e?.message ?? e));
      }
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.modalTimer);
    await this.close();
    this.onStatus('stopped');
  }

  /** Types the reply into the channel's message box and presses Enter. */
  async sendReply(): Promise<void> {
    if (!this.page) {
      throw new Error('Browser is not running.');
    }
    await this.cancelModal(); // an open minigame modal would cover the message box
    await this.page.bringToFront().catch(() => {});
    await this.page.waitForSelector(TEXTBOX, { timeout: 5000 });
    await this.page.evaluate(() => (window as any).__catYoinkAwaitOwn?.()).catch(() => {});
    await this.page.click(TEXTBOX);
    await this.page.keyboard.type(this.opts.replyText, { delay: 40 });
    await this.page.keyboard.press('Enter');
  }

  // ---- bonus minigame ----

  /**
   * Presses Go! on a bonus message and reads the minigame modal Discord opens. Resolves to
   * undefined if no modal shows up (Cat Bot answered with a message instead, e.g. "not eligible").
   */
  async pressBonusGo(id: string): Promise<MinigameForm | undefined> {
    const page = this.requirePage();
    await this.cancelModal();
    const handle = await page.evaluateHandle((liId: string) => {
      const li = document.getElementById(liId);
      const buttons = li ? Array.from(li.querySelectorAll('button')) : [];
      return buttons.find((b) => /^\s*go!?\s*$/i.test(b.textContent ?? '')) ?? null;
    }, id);
    const button = handle.asElement() as ElementHandle<Element> | null;
    if (!button) {
      throw new Error('The Go! button is gone (Cat Bot removes it after 10 seconds).');
    }
    await page.evaluate(() => (window as any).__catYoinkAwaitMinigame?.()).catch(() => {});
    await button.click();
    const opened = await page
      .waitForFunction(modalScript, { timeout: 5000 }, 'exists')
      .then(() => true)
      .catch(() => false);
    if (!opened) {
      return undefined;
    }
    await sleep(250); // let the modal finish rendering
    const scraped = (await page.evaluate(modalScript, 'scrape')) as ScrapedModal | null;
    if (!scraped) {
      return undefined;
    }
    this.dump(scraped.html);

    // Cat Bot closes the minigame after 45s; don't leave the modal covering the chat.
    clearTimeout(this.modalTimer);
    this.modalTimer = setTimeout(() => void this.cancelModal(), MINIGAME_MS + 2000);

    let options = scraped.options;
    if (scraped.kind === 'select') {
      options = await this.readSelectOptions();
    }
    const cleanPrompt = scraped.prompt
      .split('\n')
      .map((l) => l.trim())
      .filter(
        (l) =>
          l &&
          l !== scraped.title &&
          !/^(answer|cancel|submit|\*)$/i.test(l) &&
          !/^time'?s up/i.test(l) &&
          !l.startsWith('-#') &&
          l.toLowerCase() !== this.opts.botName.toLowerCase() &&
          !(options ?? []).includes(l)
      )
      .join('\n');
    return {
      title: scraped.title || 'Bonus Cat Minigame',
      prompt: cleanPrompt,
      kind: scraped.kind === 'text' ? 'text' : 'choice',
      options: scraped.kind === 'text' ? undefined : options,
      multiline: scraped.multiline,
      minLength: scraped.minLength,
      maxLength: scraped.maxLength,
      timeLimitMs: MINIGAME_MS,
    };
  }

  /** Fills in the open minigame modal and submits it. `answer` is the text, or the chosen option's label. */
  async submitMinigame(answer: string): Promise<void> {
    const page = this.requirePage();
    const kind = (await page.evaluate(modalScript, 'kind')) as ScrapedModal['kind'] | null;
    if (!kind) {
      throw new Error('The minigame window is closed (the 45 seconds may be up).');
    }
    if (kind === 'text') {
      const field = await page.$('[role="dialog"] textarea, [role="dialog"] input[type="text"], [role="dialog"] input:not([type])');
      if (!field) {
        throw new Error('Could not find the answer box.');
      }
      await field.click({ clickCount: 3 });
      await page.keyboard.press('Backspace');
      await page.keyboard.type(answer);
    } else if (kind === 'radio') {
      const ok = await page.evaluate((label: string) => {
        const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
        for (const d of dialogs.reverse()) {
          for (const r of Array.from(d.querySelectorAll<HTMLElement>('[role="radio"]'))) {
            const text = (r.getAttribute('aria-label') || r.innerText || '').trim();
            if (text === label) {
              r.click();
              return true;
            }
          }
        }
        return false;
      }, answer);
      if (!ok) {
        throw new Error(`No option "${answer}".`);
      }
    } else {
      await this.pickSelectOption(answer);
    }
    await page.evaluate(() => (window as any).__catYoinkAwaitMinigame?.()).catch(() => {});
    const clicked = await page.evaluate(modalScript, 'submit');
    if (!clicked) {
      throw new Error('Could not find the Submit button.');
    }
    // The modal closes once Discord accepts the answer; if it stays, show why.
    const closed = await page
      .waitForFunction(modalClosed, { timeout: 4000 })
      .then(() => true)
      .catch(() => false);
    if (!closed) {
      const err = (await page.evaluate(modalScript, 'error')) as string | null;
      throw new Error(err ? `Discord: ${err}` : 'Discord did not accept the answer.');
    }
    clearTimeout(this.modalTimer);
  }

  /** Closes the minigame modal if one is open (Cancel, or Escape as a fallback). */
  async cancelModal(): Promise<void> {
    const page = this.page;
    if (!page) {
      return;
    }
    clearTimeout(this.modalTimer);
    const open = await page.evaluate(modalScript, 'exists').catch(() => false);
    if (!open) {
      return;
    }
    const cancelled = await page.evaluate(modalScript, 'cancel').catch(() => false);
    if (!cancelled) {
      await page.keyboard.press('Escape').catch(() => {});
    }
    await page
      .waitForFunction(modalClosed, { timeout: 2000 })
      .catch(() => {});
  }

  // ---- internals ----

  private requirePage(): Page {
    if (!this.page) {
      throw new Error('Browser is not running.');
    }
    return this.page;
  }

  private async readSelectOptions(): Promise<string[]> {
    const page = this.requirePage();
    const combo = await page.$('[role="dialog"] [role="combobox"], [role="dialog"] [aria-haspopup="listbox"]');
    if (!combo) {
      return [];
    }
    await combo.click();
    await page.waitForSelector('[role="option"]', { timeout: 2000 }).catch(() => {});
    const labels = await page.$$eval('[role="option"]', (els) =>
      els.map((e) => ((e as HTMLElement).innerText || e.textContent || '').trim()).filter(Boolean)
    );
    await combo.click().catch(() => {}); // close the list again (Escape would close the modal)
    return labels;
  }

  private async pickSelectOption(label: string): Promise<void> {
    const page = this.requirePage();
    const combo = await page.$('[role="dialog"] [role="combobox"], [role="dialog"] [aria-haspopup="listbox"]');
    if (!combo) {
      throw new Error('Could not find the list of options.');
    }
    await combo.click();
    await page.waitForSelector('[role="option"]', { timeout: 2000 });
    const ok = await page.$$eval(
      '[role="option"]',
      (els, want) => {
        const el = els.find((e) => ((e as HTMLElement).innerText || e.textContent || '').trim() === want);
        (el as HTMLElement | undefined)?.click();
        return !!el;
      },
      label
    );
    if (!ok) {
      throw new Error(`No option "${label}".`);
    }
  }

  private dump(html: string): void {
    if (!this.opts.dumpDir) {
      return;
    }
    try {
      fs.mkdirSync(this.opts.dumpDir, { recursive: true });
      const name = new Date().toISOString().replace(/[:.]/g, '-') + '.html';
      fs.writeFileSync(path.join(this.opts.dumpDir, name), html);
    } catch {
      // best effort
    }
  }

  private async close(): Promise<void> {
    const b = this.browser;
    this.browser = undefined;
    this.page = undefined;
    if (b) {
      await b.close().catch(() => {});
    }
  }

  /** Launches the browser and navigates to the channel. Resolves to whether we're logged in. */
  private async launch(headless: boolean): Promise<boolean> {
    const exe = detectBrowser(this.opts.browserPath);
    if (!exe) {
      throw new Error('No Edge or Chrome found. Set catYoink.browserPath.');
    }
    const options = {
      executablePath: exe,
      headless,
      userDataDir: this.opts.profileDir,
      defaultViewport: headless ? { width: 1280, height: 900 } : null,
      args: [
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding',
        '--disable-backgrounding-occluded-windows',
        '--no-first-run',
        '--no-default-browser-check',
        ...(headless ? [] : ['--window-size=1100,800']),
      ],
      ignoreDefaultArgs: ['--enable-automation'],
    };
    // A browser left over from a crashed VS Code window would block this launch.
    await killStaleBrowsers(this.opts.profileDir).catch(() => 0);
    try {
      this.browser = await puppeteer.launch(options);
    } catch (e: any) {
      if (!/Failed to launch the browser process/i.test(String(e?.message))) {
        throw e;
      }
      await killStaleBrowsers(this.opts.profileDir, true).catch(() => 0);
      try {
        this.browser = await puppeteer.launch(options);
      } catch (e2: any) {
        const detail = String(e2?.message ?? e2)
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l && !/^Failed to launch the browser process/i.test(l) && !/troubleshooting/i.test(l))[0];
        throw new Error(`Couldn't start ${path.basename(exe)} for Discord${detail ? `: ${detail}` : '.'}`);
      }
    }
    this.browser.on('disconnected', () => {
      if (!this.stopped && this.browser) {
        this.browser = undefined;
        this.page = undefined;
        this.onStatus('error', 'The browser closed unexpectedly.');
      }
    });
    const pages = await this.browser.pages();
    this.page = pages[0] ?? (await this.browser.newPage());
    if (headless) {
      const ua = (await this.browser.userAgent()).replace('HeadlessChrome', 'Chrome');
      await this.page.setUserAgent(ua);
    }
    await this.page.goto(this.opts.channelUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    return this.waitForState();
  }

  /** Waits until we can tell if Discord shows the chat (true) or the login screen (false). */
  private async waitForState(): Promise<boolean> {
    const page = this.page!;
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      const url = page.url();
      if (/discord\.com\/login/.test(url)) {
        return false;
      }
      const state = await page
        .evaluate(
          (tb: string) => {
            if (document.querySelector('input[name="email"]')) {
              return 'login';
            }
            if (document.querySelector(tb)) {
              return 'chat';
            }
            return 'unknown';
          },
          TEXTBOX
        )
        .catch(() => 'unknown');
      if (state === 'chat') {
        return true;
      }
      if (state === 'login') {
        return false;
      }
      await sleep(500);
    }
    // Neither appeared (e.g. no permission to type). Treat as logged out only on login URL.
    return !/discord\.com\/login/.test(page.url());
  }

  private async loginFlow(): Promise<void> {
    await this.close();
    this.onStatus('login');
    await this.launch(false);
    const page = this.page!;
    // Poll until the user has logged in and the chat is showing.
    for (;;) {
      if (this.stopped || !this.browser) {
        return;
      }
      const ok = await page
        .evaluate(
          (tb: string) => !!document.querySelector(tb) && /\/channels\//.test(location.pathname),
          TEXTBOX
        )
        .catch(() => false);
      if (ok) {
        break;
      }
      await sleep(1000);
    }
    // Give Discord a moment to flush the session to the profile, then go hidden.
    await sleep(2000);
    await this.close();
    if (this.stopped) {
      return;
    }
    this.onStatus('starting');
    const loggedIn = await this.launch(true);
    if (!loggedIn) {
      this.onStatus('error', 'Still not logged in after login.');
      return;
    }
    await this.beginWatching();
  }

  private async beginWatching(): Promise<void> {
    const page = this.page!;
    this.sessionExpiredShown = false;

    await page.exposeFunction('__catYoinkEvent', (e: DiscordEvent) => this.onEvent(e));

    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame() && /discord\.com\/login/.test(frame.url()) && !this.stopped) {
        if (!this.sessionExpiredShown) {
          this.sessionExpiredShown = true;
          this.onStatus('login', 'Discord session expired.');
        }
      }
    });

    await page.evaluate(observerScript, {
      bot: this.opts.botName,
      trigger: this.opts.triggerText,
      caught: this.opts.caughtText,
      reply: this.opts.replyText,
      rainStart: this.opts.rainStartText,
      rainEnd: this.opts.rainEndText,
    });

    this.onStatus('watching');
  }

  /** Called when the session expired and the user chose to log in again. */
  async relogin(): Promise<void> {
    if (this.loginLoop) {
      return this.loginLoop;
    }
    this.stopped = false;
    this.loginLoop = this.loginFlow()
      .catch((e) => this.onStatus('error', String(e?.message ?? e)))
      .finally(() => {
        this.loginLoop = undefined;
      });
    return this.loginLoop;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface ScrapedModal {
  title: string;
  prompt: string;
  kind: 'text' | 'radio' | 'select';
  options?: string[];
  multiline?: boolean;
  minLength?: number;
  maxLength?: number;
  html: string;
}

/** Runs inside the Discord page: true once no minigame modal (a dialog with a Submit button) is open. */
export function modalClosed(): boolean {
  return !Array.from(document.querySelectorAll('[role="dialog"]')).some((d) =>
    Array.from(d.querySelectorAll('button')).some((b) => /submit/i.test((b as HTMLElement).innerText || b.textContent || ''))
  );
}

/**
 * Runs inside the Discord page: finds Cat Bot's minigame modal (the newest dialog with a Submit
 * button) and does one thing with it. Self-contained so it can be passed to page.evaluate.
 */
export function modalScript(action: string): unknown {
  // action: 'exists' | 'scrape' | 'kind' | 'submit' | 'cancel' | 'error'
  const textOf = (el: Element) => ((el as HTMLElement).innerText || el.textContent || '').trim();
  const dialogs = Array.from(document.querySelectorAll('[role="dialog"]')).reverse();
  const d = dialogs.find((x) => Array.from(x.querySelectorAll('button')).some((b) => /submit/i.test(textOf(b))));
  if (action === 'exists') {
    return !!d;
  }
  if (!d) {
    return action === 'scrape' || action === 'kind' || action === 'error' ? null : false;
  }
  const buttons = Array.from(d.querySelectorAll('button'));
  const field = d.querySelector<HTMLInputElement | HTMLTextAreaElement>(
    'textarea, input[type="text"], input:not([type])'
  );
  const radios = Array.from(d.querySelectorAll('[role="radio"]'));
  const combo = d.querySelector('[role="combobox"], [aria-haspopup="listbox"]');
  const kind: 'text' | 'radio' | 'select' = radios.length ? 'radio' : combo && !field ? 'select' : 'text';

  switch (action) {
    case 'kind':
      return kind;
    case 'submit': {
      const b = buttons.find((x) => /submit/i.test(textOf(x)));
      b?.click();
      return !!b;
    }
    case 'cancel': {
      const b = buttons.find((x) => /cancel|close/i.test(textOf(x) || x.getAttribute('aria-label') || ''));
      b?.click();
      return !!b;
    }
    case 'error': {
      const err = d.querySelector('[class*="error"], [role="alert"]');
      return err ? textOf(err) : null;
    }
  }
  const heading = d.querySelector('h1, h2, [class*="title"]');
  const num = (v: string | null) => (v && /^\d+$/.test(v) ? Number(v) : undefined);
  return {
    title: heading ? textOf(heading) : '',
    prompt: textOf(d),
    kind,
    options:
      kind === 'radio'
        ? radios.map((r) => (r.getAttribute('aria-label') || textOf(r)).trim()).filter(Boolean)
        : undefined,
    multiline: field?.tagName === 'TEXTAREA',
    minLength: num(field?.getAttribute('minlength') ?? null),
    maxLength: num(field?.getAttribute('maxlength') ?? null),
    html: d.outerHTML,
  };
}

/**
 * Runs inside the Discord page. Written as a plain function so it can be passed to
 * page.evaluate; it must not reference anything outside its own scope.
 */
export function observerScript(cfg: {
  bot: string;
  trigger: string;
  caught: string;
  reply: string;
  rainStart: string;
  rainEnd: string;
}): void {
  const w = window as any;
  if (w.__catYoinkObserver) {
    w.__catYoinkObserver.disconnect();
  }
  const emit = (e: unknown) => w.__catYoinkEvent(e);
  const seen = new Set<string>();
  const spawnIds = new Set<string>();
  const bonusIds = new Set<string>();
  const botLower = cfg.bot.toLowerCase();
  const replyLower = cfg.reply.toLowerCase();

  // Settings are case-insensitive regexes; fall back to a plain substring if one doesn't compile.
  const toMatcher = (s: string): ((text: string) => boolean) => {
    try {
      const re = new RegExp(s, 'i');
      return (text) => re.test(text);
    } catch {
      const lower = s.toLowerCase();
      return (text) => text.toLowerCase().includes(lower);
    }
  };
  /** On attach, a cat counts as already out only if its spawn is among the newest this many messages. */
  const RECENT_MESSAGES = 5;
  const isTrigger = toMatcher(cfg.trigger);
  const isCaught = toMatcher(cfg.caught);
  const isRainStart = toMatcher(cfg.rainStart);
  const isRainEnd = toMatcher(cfg.rainEnd);
  /** 'start' / 'end' for Cat Bot's cat rain messages, else null. The end is checked first. */
  const rainKind = (text: string): 'start' | 'end' | null =>
    isRainEnd(text) ? 'end' : isRainStart(text) ? 'start' : null;
  const isLate = (text: string) => /\bLate\b.+\bcatchers:/i.test(text);
  const isBonus = (text: string) => /\bBONUS\b[\s\S]*\bCAT!/i.test(text);
  const isMinigameWin = (text: string) => /\bgot \+\d+\b[\s\S]*\bbonus cats?\b/i.test(text);
  const isMinigameLoss = (text: string) =>
    /better luck next time|weren't fast enough|not eligible to play|minigame has expired|no active minigame/i.test(text);

  let awaitingOwn = false;
  w.__catYoinkAwaitOwn = () => {
    awaitingOwn = true;
  };
  let awaitingMinigame = false;
  w.__catYoinkAwaitMinigame = () => {
    awaitingMinigame = true;
  };

  /** The author's name from the message header, skipping the "replying to" preview above it. */
  const authorOf = (li: Element): string => {
    let el: Element | null = li;
    while (el) {
      const name = Array.from(el.querySelectorAll('[class*="username"]')).find(
        (n) => !n.closest('[id^="message-reply-context"], [class*="repliedMessage"]')
      );
      if (name && name.textContent) {
        return name.textContent.trim();
      }
      el = el.previousElementSibling;
    }
    return '';
  };

  // li ids look like "chat-messages-<channelId>-<messageId>".
  const partOf = (li: Element, kind: 'content' | 'accessories'): Element | null =>
    li.querySelector(`[id="message-${kind}-${li.id.split('-').pop()}"]`);

  /**
   * The message's own text. Components V2 messages (Cat Bot's spawns) leave message-content
   * empty and render their text inside message-accessories, which also holds legacy embeds.
   */
  const textOf = (li: Element): string =>
    [partOf(li, 'content'), partOf(li, 'accessories')]
      .map((n) => n?.textContent ?? '')
      .join(' ')
      .trim();

  /** Like textOf, but with line breaks (innerText). */
  const linesOf = (li: Element): string =>
    [partOf(li, 'content'), partOf(li, 'accessories')]
      .map((n) => ((n as HTMLElement | null)?.innerText ?? '').trim())
      .filter(Boolean)
      .join('\n');

  /** Discord marks messages that ping the logged-in user. */
  const mentionsMe = (li: Element): boolean =>
    /mentioned/.test(li.className) || !!li.querySelector('[class*="mentioned"]');

  const snowflake = (li: Element): bigint | null => {
    try {
      return BigInt(li.id.split('-').pop() ?? '');
    } catch {
      return null;
    }
  };
  let lastSpawn: bigint | null = null;
  /** The spawn that was already on screen when we attached; it skips the surf-in intro. */
  let existingId = '';

  /** Display name on the earliest "cat" reply after the latest spawn, i.e. who Cat Bot saw first. */
  const firstReplyAuthor = (): string | undefined => {
    const list = document.querySelector('ol[data-list-id="chat-messages"]');
    if (!list || lastSpawn === null) {
      return undefined;
    }
    let best: { id: bigint; author: string } | undefined;
    list.querySelectorAll('li[id^="chat-messages-"]').forEach((li) => {
      const id = snowflake(li);
      if (id === null || id <= (lastSpawn as bigint) || textOf(li).toLowerCase() !== replyLower) {
        return;
      }
      const author = authorOf(li);
      if (!author || author.toLowerCase() === botLower) {
        return;
      }
      if (!best || id < best.id) {
        best = { id, author };
      }
    });
    return (best as { id: bigint; author: string } | undefined)?.author;
  };

  const isSpawn = (li: Element): boolean =>
    authorOf(li).toLowerCase() === botLower && isTrigger(textOf(li));

  const handle = (li: Element, attempt = 0): void => {
    const id = li.id;
    if (!id) {
      return;
    }
    const author = authorOf(li);
    const text = textOf(li);
    const lower = text.toLowerCase();
    const isBot = author.toLowerCase() === botLower;

    // Rain first, and without returning: Catnip's "started a short rain!" is added to the end of a
    // catch message, which still has to be handled as a catch below.
    if (isBot && !seen.has(id + ':rain')) {
      const rain = rainKind(text);
      if (rain) {
        seen.add(id + ':rain');
        emit({ kind: rain === 'end' ? 'rainEnd' : 'rainStart' });
      }
    }

    if (isBot && isTrigger(text)) {
      if (seen.has(id + ':spawn')) {
        return;
      }
      seen.add(id + ':spawn');
      spawnIds.add(id);
      lastSpawn = snowflake(li);
      emit({ kind: 'spawn', id, text, existing: id === existingId });
      return;
    }
    // Checked before "caught": Cat Bot's bonus text says "Anyone who cought this cat", and the
    // rain version of the late list says "Everyone who caught it".
    if (isBot && isLate(text)) {
      if (!seen.has(id + ':late')) {
        seen.add(id + ':late');
        emit({ kind: 'lateCatchers', text: linesOf(li) });
      }
      return;
    }
    if (isBot && isBonus(text)) {
      if (seen.has(id + ':bonus')) {
        return;
      }
      const go = Array.from(li.querySelectorAll('button')).some((b) => /^\s*go!?\s*$/i.test(b.textContent ?? ''));
      if (!go && attempt < 8) {
        setTimeout(() => handle(li, attempt + 1), 250); // the button can render after the text
        return;
      }
      seen.add(id + ':bonus');
      if (go) {
        bonusIds.add(id);
        emit({ kind: 'bonus', id, text: linesOf(li), mentionsMe: mentionsMe(li) });
      }
      return;
    }
    if (isBot && awaitingMinigame && !seen.has(id + ':result')) {
      const win = isMinigameWin(text) && mentionsMe(li);
      if (win || isMinigameLoss(text)) {
        seen.add(id + ':result');
        awaitingMinigame = false;
        emit({ kind: 'minigameResult', text: linesOf(li), win });
        return;
      }
    }
    if (isBot && isCaught(text)) {
      if (seen.has(id + ':caught')) {
        return;
      }
      seen.add(id + ':caught');
      emit({ kind: 'caught', text, firstAuthor: firstReplyAuthor() });
      return;
    }
    if (awaitingOwn && author && lower === replyLower && !isBot) {
      awaitingOwn = false;
      emit({ kind: 'ownMessage', author });
    }
  };

  const scan = (root: ParentNode, markOnly: boolean) => {
    root.querySelectorAll('li[id^="chat-messages-"]').forEach((li) => {
      if (markOnly) {
        for (const k of [':spawn', ':caught', ':late', ':bonus', ':result', ':rain']) {
          seen.add(li.id + k);
        }
      } else {
        handle(li);
      }
    });
  };

  const attach = (): boolean => {
    const list = document.querySelector('ol[data-list-id="chat-messages"]');
    if (!list) {
      return false;
    }
    // Is a cat already out? Walk the newest RECENT_MESSAGES messages back: a spawn we haven't
    // reported is still catchable (Cat Bot deletes a spawn once its catch window ends); a catch
    // message first means the last cat is gone. Everything else is history.
    const items = Array.from(list.querySelectorAll('li[id^="chat-messages-"]'));
    let pending: Element | undefined;
    for (const li of items.slice(-RECENT_MESSAGES).reverse()) {
      if (isSpawn(li)) {
        if (!seen.has(li.id + ':spawn')) {
          pending = li;
        }
        break;
      }
      const text = textOf(li);
      if (authorOf(li).toLowerCase() === botLower && isCaught(text) && !isLate(text) && !isBonus(text)) {
        break;
      }
    }
    // Is it raining? The newest rain message on screen says (it's also how a missed start or end
    // is caught up on after Discord re-renders the list). Core ignores a state it is already in.
    let rainNow: 'start' | 'end' | null = null;
    for (let i = items.length - 1; i >= 0 && !rainNow; i--) {
      if (authorOf(items[i]).toLowerCase() === botLower) {
        rainNow = rainKind(textOf(items[i]));
      }
    }
    scan(list, true);
    if (rainNow) {
      emit(rainNow === 'end' ? { kind: 'rainEnd' } : { kind: 'rainStart', existing: true });
    }
    if (pending) {
      existingId = pending.id;
      seen.delete(pending.id + ':spawn');
    }
    const obs = new MutationObserver((muts) => {
      for (const m of muts) {
        m.addedNodes.forEach((n) => {
          if (!(n instanceof Element)) {
            return;
          }
          if (n.matches('li[id^="chat-messages-"]')) {
            handle(n);
          } else {
            scan(n, false);
          }
        });
        m.removedNodes.forEach((n) => {
          if (!(n instanceof Element)) {
            return;
          }
          if (spawnIds.has(n.id)) {
            spawnIds.delete(n.id);
            emit({ kind: 'spawnGone', id: n.id });
          }
          if (bonusIds.has(n.id)) {
            bonusIds.delete(n.id);
            emit({ kind: 'bonusGone', id: n.id });
          }
        });
        // Edits re-render message content in place.
        const target = m.target instanceof Element ? m.target.closest('li[id^="chat-messages-"]') : null;
        if (target && m.type === 'childList') {
          handle(target);
        }
      }
    });
    obs.observe(list, { childList: true, subtree: true });
    w.__catYoinkObserver = obs;
    if (pending) {
      handle(pending);
    }
    emit({ kind: 'attached' });
    return true;
  };

  /**
   * Resolves once Discord has rendered the recent history into `list`: it appears before its
   * messages do, and attach() must see the last RECENT_MESSAGES of them.
   */
  const settled = (list: Element): Promise<void> =>
    new Promise((resolve) => {
      const start = Date.now();
      let last = -1;
      let since = start;
      const tick = () => {
        const n = list.querySelectorAll('li[id^="chat-messages-"]').length;
        const now = Date.now();
        if (n !== last) {
          last = n;
          since = now;
        }
        const quiet = now - since;
        if ((n >= RECENT_MESSAGES && quiet >= 500) || (n > 0 && quiet >= 1500) || now - start >= 6000) {
          resolve();
        } else {
          setTimeout(tick, 250);
        }
      };
      tick();
    });

  // Re-attach if Discord re-renders the list (channel switch, reconnect).
  let current: Element | null = null;
  setInterval(() => {
    const list = document.querySelector('ol[data-list-id="chat-messages"]');
    if (list && list !== current) {
      current = list;
      if (w.__catYoinkObserver) {
        w.__catYoinkObserver.disconnect();
      }
      void settled(list).then(() => {
        if (current === list) {
          attach();
        }
      });
    }
  }, 1000);
}
