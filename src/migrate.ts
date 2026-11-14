// One-time upgrade from the 0.x builds, which were published as "local.cat-yoink". To VS Code that
// is a different extension from this one: with both installed, both start, and they register the
// same catYoink.* commands, so whichever loads second fails. While the old build is installed this
// one stays out of its way (activate() registers nothing) and offers to move the old build's data
// here and uninstall it.
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { killStaleBrowsers } from './discordBrowser';

export const OLD_ID = 'local.cat-yoink';

/** What moves over: the Discord login and the GIF cache. */
const ITEMS = ['browser-profile', 'gifs'];

/**
 * Left out when the login profile has to be copied rather than renamed: Chromium's lock files (a
 * copy would look like a browser still running on it) and its caches (rebuilt on demand; most of
 * the profile's size).
 */
const PROFILE_SKIP = /^(lockfile|Singleton\w*|DevToolsActivePort|Crashpad|(Code )?Cache|\w*(GPU|Shader|Dawn)\w*Cache)$/i;

const MOVE = 'Move & Uninstall';

const isOldBuild = (ctx: vscode.ExtensionContext) => ctx.extension.id.toLowerCase() === OLD_ID;

/** The old build's storage folder, next to ours. */
const oldDir = (ctx: vscode.ExtensionContext) => path.join(path.dirname(ctx.globalStorageUri.fsPath), OLD_ID);

/** True while the old build is installed and enabled: activate() then only calls offerMove(). */
export function oldBuildInstalled(ctx: vscode.ExtensionContext): boolean {
  return !isOldBuild(ctx) && !!vscode.extensions.getExtension(OLD_ID);
}

/** Asks (once per start) whether to move over. The old build keeps running until the user agrees. */
export function offerMove(ctx: vscode.ExtensionContext): void {
  const version = String(ctx.extension.packageJSON.version ?? '');
  void vscode.window
    .showInformationMessage(
      `Cat Yoink ${version} replaces the older Cat Yoink (${OLD_ID}) that is also installed. Move your Discord ` +
        'login and cat GIFs here and uninstall the old version? Your catch count starts again from 0.',
      MOVE,
      'Not Now'
    )
    .then((choice) => (choice === MOVE ? moveOver(ctx) : undefined));
}

/**
 * A normal start (the old build isn't installed): takes over the old build's data if it was
 * uninstalled by hand, then deletes what is left of its storage (the old cat window's Electron
 * profile, logs, lock files). Renames only: a slow copy here would hold up activation. The login
 * profile can't be renamed while a leftover browser has it open; adoptOldProfile() retries it.
 */
export function adoptOldData(ctx: vscode.ExtensionContext): void {
  const from = oldDir(ctx);
  if (isOldBuild(ctx) || !fs.existsSync(from)) {
    return;
  }
  if (renameOver(from, ctx.globalStorageUri.fsPath).length === 0) {
    void fs.promises.rm(from, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Before our first browser launch: if the old build's login profile is still there (a leftover
 * browser held it when adoptOldData ran), kill that browser and move the profile. It has to happen
 * before the launch, which would create our own profile and make the old one lose ("ours wins").
 * Call it while holding the OwnerLock.
 */
export async function adoptOldProfile(ctx: vscode.ExtensionContext): Promise<void> {
  const from = oldDir(ctx);
  const profile = path.join(from, 'browser-profile');
  if (isOldBuild(ctx) || !fs.existsSync(profile)) {
    return;
  }
  await killStaleBrowsers(profile).catch(() => 0);
  if (renameOver(from, ctx.globalStorageUri.fsPath).length === 0) {
    await fs.promises.rm(from, { recursive: true, force: true }).catch(() => {});
  }
}

async function moveOver(ctx: vscode.ExtensionContext): Promise<void> {
  const from = oldDir(ctx);
  const to = ctx.globalStorageUri.fsPath;
  // While the old build is installed the catYoink.* commands are its own: this stops its watching,
  // which closes its headless browser so the login profile can be moved.
  await Promise.resolve(vscode.commands.executeCommand('catYoink.stop')).catch(() => {});
  // A browser the old build left behind (a crashed window, or another window still running it)
  // would block the rename and force a copy, which loses the login.
  await killStaleBrowsers(path.join(from, 'browser-profile')).catch(() => 0);
  const failed = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Cat Yoink: moving your data from the old version…' },
    () => copyOver(from, to, renameOver(from, to))
  );
  try {
    await vscode.commands.executeCommand('workbench.extensions.uninstallExtension', OLD_ID);
  } catch (err: any) {
    void vscode.window.showErrorMessage(
      `Cat Yoink: couldn't uninstall ${OLD_ID} (${err?.message ?? err}). Uninstall it in the Extensions view, then reload the window.`
    );
    return;
  }
  const lost = failed.length
    ? ` Couldn't move ${failed.join(', ')}${failed.includes('browser-profile') ? ', so log in to Discord again' : ''}.`
    : '';
  const choice = await vscode.window.showInformationMessage(
    `Cat Yoink: the old version is uninstalled.${lost} Reload the window to start this one.`,
    'Reload Window'
  );
  if (choice) {
    void vscode.commands.executeCommand('workbench.action.reloadWindow');
  }
}

/**
 * Moves the old build's items that we don't have yet into `to` by renaming (same disk: instant).
 * Returns the items that failed.
 */
function renameOver(from: string, to: string): string[] {
  const failed: string[] = [];
  fs.mkdirSync(to, { recursive: true });
  for (const name of ITEMS) {
    const src = path.join(from, name);
    const dst = path.join(to, name);
    if (!fs.existsSync(src) || fs.existsSync(dst)) {
      continue; // nothing to move, or ours wins
    }
    try {
      fs.renameSync(src, dst);
    } catch {
      failed.push(name); // in use, or on another drive
    }
  }
  return failed;
}

/** Copies the items a rename couldn't move. Returns the ones that failed again. */
async function copyOver(from: string, to: string, names: string[]): Promise<string[]> {
  const failed: string[] = [];
  for (const name of names) {
    const dst = path.join(to, name);
    try {
      await fs.promises.cp(path.join(from, name), dst, {
        recursive: true,
        filter: (src) => name !== 'browser-profile' || !PROFILE_SKIP.test(path.basename(src)),
      });
    } catch {
      await fs.promises.rm(dst, { recursive: true, force: true }).catch(() => {}); // no half-copied profile
      failed.push(name);
    }
  }
  return failed;
}
