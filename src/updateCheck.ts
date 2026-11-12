// Cat Yoink is shared as a .vsix on GitHub Releases, not through the Marketplace, so nothing
// updates it. Once a day this asks GitHub for the latest release and, if it is newer than this
// build, offers its download page. Nothing is downloaded or installed here.
import * as vscode from 'vscode';

const LATEST_URL = 'https://api.github.com/repos/Matthew-Graves-Git/vsc-cats/releases/latest';
const RELEASES_PAGE = 'https://github.com/Matthew-Graves-Git/vsc-cats/releases/latest';
const HEADERS = { 'User-Agent': 'cat-yoink', Accept: 'application/vnd.github+json' };
const DAY_MS = 24 * 60 * 60_000;
const TIMEOUT_MS = 15_000;

/** Positive if version `a` is newer than `b` ("v1.2.3" and "1.2.3" alike; a "-beta" suffix is ignored). */
export function compareVersions(a: string, b: string): number {
  const nums = (v: string) =>
    v
      .trim()
      .replace(/^v/i, '')
      .split(/[-+]/)[0]
      .split('.')
      .map((n) => parseInt(n, 10) || 0);
  const x = nums(a);
  const y = nums(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) {
      return d;
    }
  }
  return 0;
}

/**
 * `manual` (the Check for Updates command): ignores the once-a-day limit, the setting and "Skip
 * This Version", and always says what it found. Otherwise it stays quiet unless there is an update.
 */
export async function checkForUpdates(ctx: vscode.ExtensionContext, manual: boolean): Promise<void> {
  if (!manual) {
    if (!vscode.workspace.getConfiguration('catYoink').get<boolean>('checkForUpdates', true)) {
      return;
    }
    if (Date.now() - ctx.globalState.get<number>('updateCheckedAt', 0) < DAY_MS) {
      return;
    }
  }
  const say = (text: string) => {
    if (manual) {
      void vscode.window.showInformationMessage(`Cat Yoink: ${text}`);
    }
  };

  let release: { tag_name?: unknown; html_url?: unknown };
  try {
    const res = await fetch(LATEST_URL, { headers: HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) });
    await ctx.globalState.update('updateCheckedAt', Date.now()); // GitHub answered: not again today
    if (!res.ok) {
      // 404: no release yet (or the repo isn't public).
      say(res.status === 404 ? 'no release found on GitHub yet.' : `GitHub answered HTTP ${res.status}; try again later.`);
      return;
    }
    release = (await res.json()) as typeof release;
  } catch {
    say("couldn't reach GitHub to check for updates.");
    return; // offline: tried again at the next start
  }

  const current = String(ctx.extension.packageJSON.version ?? '0.0.0');
  const latest = typeof release.tag_name === 'string' ? release.tag_name.trim().replace(/^v/i, '') : '';
  if (!latest || compareVersions(latest, current) <= 0) {
    say(`you have the latest version (${current}).`);
    return;
  }
  if (!manual && ctx.globalState.get<string>('updateSkipped') === latest) {
    return;
  }
  const page =
    typeof release.html_url === 'string' && release.html_url.startsWith('https://github.com/')
      ? release.html_url
      : RELEASES_PAGE;
  const choice = await vscode.window.showInformationMessage(
    `Cat Yoink ${latest} is available (you have ${current}). Download the .vsix, then install it with "Extensions: Install from VSIX...".`,
    'Download',
    ...(manual ? [] : ['Skip This Version'])
  );
  if (choice === 'Download') {
    void vscode.env.openExternal(vscode.Uri.parse(page));
  } else if (choice === 'Skip This Version') {
    void ctx.globalState.update('updateSkipped', latest);
  }
}
