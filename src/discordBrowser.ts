import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import puppeteer, { Browser, ElementHandle, Page } from 'puppeteer-core';

export type BrowserStatus = 'starting' | 'watching' | 'login' | 'error' | 'stopped';

export type DiscordEvent =
  /** `existing`: the cat was already in the channel when we attached (not a new spawn). */
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
  | { kind: 'rainEnd' };

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
  /** Where to write browser launch problems (the user only sees a one-line summary). */
  logFile?: string;
}

/** Thrown inside start() once stop() was called, to unwind a launch that is no longer wanted. */
class Stopped extends Error {}

type LaunchOptions = Parameters<typeof puppeteer.launch>[0];

/** The browser's own words in a puppeteer launch error (its stderr), without puppeteer's boilerplate. */
function launchDetail(e: any): string | undefined {
  return String(e?.message ?? e)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/^Failed to launch the browser process/i.test(l) && !/troubleshooting/i.test(l))[0];
}

/** Appends lines to a log file, keeping the last `maxLines`. Best effort. */
export function appendLog(file: string, text: string, maxLines = 200): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let lines: string[] = [];
    try {
      lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    } catch {
      // first entry
    }
    for (const l of text.split('\n').filter((s) => s.trim())) {
      lines.push(`${new Date().toISOString()} ${l.trim().slice(0, 500)}`);
    }
    fs.writeFileSync(file, lines.slice(-maxLines).join('\n') + '\n');
  } catch {
    // logging is best effort
  }
}

/**
 * Windows: true while a browser has the profile open. Chromium keeps <profile>\lockfile open while
 * it runs, so if we can delete it, nothing is running. Elsewhere always false (no such lock file).
 */
function profileInUse(profileDir: string): boolean {
  if (process.platform !== 'win32') {
    return false;
  }
  try {
    fs.rmSync(path.join(profileDir, 'lockfile'));
    return false;
  } catch (e: any) {
    return ['EBUSY', 'EPERM', 'EACCES'].includes(e?.code); // else ENOENT (never ran) or unrelated
  }
}

/** Waits up to `ms` for the profile to be free (killed browsers take a moment to let go of it). */
async function waitForProfileFree(profileDir: string, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (profileInUse(profileDir)) {
    if (Date.now() >= deadline) {
      return false;
    }
    await sleep(250);
  }
  return true;
}

/**
 * What a browser keeps in its data folder that we don't need, by name. Edge's downloaded components
 * (an image-recognition model, video DRM, ad-block lists, shopping and wallet data...: over 450 MB
 * in the Discord profile), which don't come back once it runs with --disable-component-update, and
 * metrics and crash files. The login is never on these lists: it is Local State (which holds the
 * cookie key) and Default's Network, Local Storage and IndexedDB.
 */
const COMPONENTS = /^(component_crx_cache|extensions_crx_cache|Provenance\w*|WidevineCdm|Subresource Filter|Speech Recognition|hyphen-data|ZxcvbnData|Typosquatting|Edge.*|BrowserMetrics.*|Crashpad)$/;
/** Caches, rebuilt on demand: in the data folder, and in Default. */
const CACHES = /^(GrShaderCache|ShaderCache|GPUPersistentCache)$/;
const PROFILE_CACHES = /^(Cache|Code Cache|GPUCache|Dawn\w*Cache|EdgeCoupons)$/;

/**
 * --disk-cache-size for Discord, which limits its Cache and Code Cache during a session (both are
 * deleted at each launch, so they only ever hold one session). With 4 MB, loading Discord left
 * about 12 MB in Cache and 1 MB in Code Cache, against 17 MB and 20 MB without a limit.
 */
const DISK_CACHE_BYTES = 4 * 1024 * 1024;

/**
 * The COMPONENTS (and with `caches`, the CACHES) in a browser data folder, for the caller to delete
 * before a browser starts on it. None while a browser has the folder open: deleting under it could
 * break it.
 */
export function browserJunk(dataDir: string, caches: boolean): string[] {
  if (profileInUse(dataDir)) {
    return [];
  }
  const matching = (dir: string, re: RegExp) => {
    try {
      return fs.readdirSync(dir).filter((n) => re.test(n)).map((n) => path.join(dir, n));
    } catch {
      return []; // not created yet
    }
  };
  return [
    ...matching(dataDir, COMPONENTS),
    ...(caches ? [...matching(dataDir, CACHES), ...matching(path.join(dataDir, 'Default'), PROFILE_CACHES)] : []),
  ];
}

const TEXTBOX = 'div[role="textbox"][data-slate-editor="true"]';
const MINIGAME_MS = 45_000;
/** Discord's notice on every bot modal ("Warning: This form will be submitted to…"), not part of the question. */
const MODAL_NOTICE = /(?:warning:?\s*)?this form will be submitted to[\s\S]*?sensitive information\.?/i;

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
    if (!force && !profileInUse(profileDir)) {
      return 0;
    }
    // Normally just the browser processes (taskkill /T takes their children along). Forced, every
    // process on the profile, in case a browser died and left children holding its files.
    const needle = profileDir.toLowerCase().replace(/'/g, "''");
    const mainOnly = force ? '' : ` -and $_.CommandLine -notmatch '--type='`;
    const script =
      `Get-CimInstance Win32_Process -Filter 'Name=''msedge.exe'' OR Name=''chrome.exe''' | ` +
      `Where-Object { $_.CommandLine -and $_.CommandLine.ToLower().Contains('${needle}')${mainOnly} } | ` +
      `ForEach-Object { $_.ProcessId }`;
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
      await waitForProfileFree(profileDir, 5000);
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
  /** The running start(): stop() waits for it, so no browser it is still launching outlives stop(). */
  private starting?: Promise<void>;
  private loginLoop?: Promise<void>;
  private sessionExpiredShown = false;
  private modalTimer?: NodeJS.Timeout;

  onEvent: (e: DiscordEvent) => void = () => {};
  onStatus: (s: BrowserStatus, detail?: string) => void = () => {};

  constructor(private opts: BrowserOptions) {}

  start(forceLogin = false): Promise<void> {
    this.stopped = false;
    const run = this.run(forceLogin).finally(() => {
      if (this.starting === run) {
        this.starting = undefined;
      }
    });
    this.starting = run;
    return run;
  }

  private async run(forceLogin: boolean): Promise<void> {
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
      if (this.stopped) {
        return; // stop() closed the browser under us; nothing went wrong
      }
      if (/already running|user data directory|ProcessSingleton/i.test(String(e?.message))) {
        this.onStatus('error', 'Browser profile is in use by another window.');
      } else {
        this.onStatus('error', String(e?.message ?? e));
      }
    }
  }

  /** Stops watching; resolves once this instance has no browser left, even one it was still launching. */
  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.modalTimer);
    await this.close(); // a running launch then fails fast instead of waiting out its timeouts
    await Promise.all([this.starting, this.loginLoop]).catch(() => {});
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
      .replace(MODAL_NOTICE, '')
      .split('\n')
      .map((l) => l.trim())
      .filter(
        (l) =>
          l &&
          l !== scraped.title &&
          // "Answer*" is the answer box's label (with its required marker); a lone "," is a
          // screen-reader separator Discord puts between parts (see linesOf in observerScript).
          !/^(?:(?:answer|cancel|submit)\s*\*?|\*|,)$/i.test(l) &&
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
      const ok = await page.evaluate(modalScript, 'pick', answer);
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

  /** puppeteer.launch, unless stop() was called before or while it ran (then nothing is left open). */
  private async openBrowser(options: LaunchOptions): Promise<Browser> {
    if (this.stopped) {
      throw new Stopped();
    }
    const portFile = path.join(this.opts.profileDir, 'DevToolsActivePort');
    fs.rmSync(portFile, { force: true }); // a stale one would point at a browser that is gone
    let b: Browser;
    try {
      b = await puppeteer.launch(options);
    } catch (e: any) {
      // Edge can start a copy of itself and exit (seen with Edge 157 on Windows): puppeteer sees
      // its process quit without a word, while the copy runs on our profile with the same
      // arguments. Connect to the copy through the port file it writes.
      const silent = /Failed to launch the browser process/i.test(String(e?.message)) && !launchDetail(e);
      const copy = silent ? await this.connectToCopy(portFile, options) : undefined;
      if (!copy) {
        throw e;
      }
      this.log(`${path.basename(String(options?.executablePath))} relaunched itself; connected to the copy.`);
      b = copy;
    }
    if (this.stopped) {
      await b.close().catch(() => {});
      throw new Stopped();
    }
    return b;
  }

  /**
   * Waits (up to 10 s) for a browser on our profile to write its DevTools port, then connects.
   * Even after stop(): openBrowser() then closes the copy instead of leaving it running.
   */
  private async connectToCopy(portFile: string, options: LaunchOptions): Promise<Browser | undefined> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      let port = '';
      let wsPath = '';
      try {
        [port, wsPath] = fs.readFileSync(portFile, 'utf8').split(/\r?\n/).map((s) => s.trim());
      } catch {
        // not written yet
      }
      if (/^\d+$/.test(port) && wsPath.startsWith('/devtools/browser/')) {
        try {
          return await puppeteer.connect({
            browserWSEndpoint: `ws://127.0.0.1:${port}${wsPath}`,
            defaultViewport: options?.defaultViewport,
          });
        } catch {
          // still starting up; try again
        }
      }
      await sleep(200);
    }
    return undefined;
  }

  private log(text: string): void {
    if (this.opts.logFile) {
      appendLog(this.opts.logFile, text);
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
        // Keep the profile small (see COMPONENTS): no component downloads, a capped disk cache, and
        // no GPU shader cache (it is headless except while the user logs in).
        '--disable-component-update',
        `--disk-cache-size=${DISK_CACHE_BYTES}`,
        '--disable-gpu-shader-disk-cache',
        ...(headless ? [] : ['--window-size=1100,800']),
      ],
      ignoreDefaultArgs: ['--enable-automation'],
    };
    const profile = this.opts.profileDir;
    // A browser left over from a crashed VS Code window would block this launch.
    await killStaleBrowsers(profile).catch(() => 0);
    await Promise.all(browserJunk(profile, true).map((p) => fs.promises.rm(p, { recursive: true, force: true }).catch(() => {})));
    try {
      this.browser = await this.openBrowser(options);
    } catch (e: any) {
      if (e instanceof Stopped || !/Failed to launch the browser process/i.test(String(e?.message))) {
        throw e;
      }
      this.log(`${path.basename(exe)} failed to launch, killing browsers on the profile and retrying:\n${e?.message ?? e}`);
      await killStaleBrowsers(profile, true).catch(() => 0);
      try {
        this.browser = await this.openBrowser(options);
      } catch (e2: any) {
        if (e2 instanceof Stopped) {
          throw e2;
        }
        this.log(`${path.basename(exe)} failed to launch again:\n${e2?.message ?? e2}`);
        // A browser still on our profile makes the new one hand off to it and quit without a word,
        // so puppeteer's message has no detail; say what is actually wrong.
        const detail = profileInUse(profile)
          ? `another browser is still using the Cat Yoink profile (${profile}). Close it or restart VS Code.`
          : launchDetail(e2);
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
      if (this.stopped) {
        throw new Stopped();
      }
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
export function modalScript(action: string, arg?: string): unknown {
  // action: 'exists' | 'scrape' | 'kind' | 'submit' | 'cancel' | 'error' | 'pick' (arg = option label)
  const textOf = (el: Element) => ((el as HTMLElement).innerText || el.textContent || '').trim();
  // Discord's radio groups are native <input type="radio"> inside a <label>, labelled via aria-labelledby.
  const radioLabel = (el: Element): string => {
    const aria = el.getAttribute('aria-label');
    if (aria && aria.trim()) {
      return aria.trim();
    }
    const ids = (el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean);
    const byId = ids
      .map((id) => document.getElementById(id))
      .filter((x): x is HTMLElement => !!x)
      .map(textOf)
      .join(' ')
      .trim();
    if (byId) {
      return byId;
    }
    const label = el.closest('label');
    return label ? textOf(label) : textOf(el);
  };
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
  const radios = Array.from(d.querySelectorAll('[role="radio"], input[type="radio"]')).filter(
    (r) => !r.parentElement?.closest('[role="radio"]') // an input inside a role="radio" wrapper is the same option
  );
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
    case 'pick': {
      const r = radios.find((x) => radioLabel(x) === arg) as HTMLElement | undefined;
      if (!r) {
        return false;
      }
      const isChecked = () => (r as HTMLInputElement).checked === true || r.getAttribute('aria-checked') === 'true';
      ((r.closest('label') as HTMLElement | null) ?? r).click();
      if (!isChecked()) {
        r.click();
      }
      return true;
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
        ? radios.map(radioLabel).filter(Boolean)
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

  /**
   * innerText without the lone "," lines: Components V2 messages put a screen-reader separator
   * (<span class="hiddenVisually_…">,</span>) between their parts. It is clipped, not hidden, and
   * absolutely positioned, so innerText keeps it as a line of its own.
   */
  const cleanLines = (text: string): string =>
    text
      .split('\n')
      .filter((l) => !/^\s*,\s*$/.test(l))
      .join('\n')
      .trim();

  /** Like textOf, but with line breaks (innerText). */
  const linesOf = (li: Element): string =>
    cleanLines(
      [partOf(li, 'content'), partOf(li, 'accessories')]
        .map((n) => ((n as HTMLElement | null)?.innerText ?? '').trim())
        .filter(Boolean)
        .join('\n')
    );

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
  /** The spawn that was already in the channel when we attached. */
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
