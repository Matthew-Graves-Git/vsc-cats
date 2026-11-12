# Cat Yoink

Watches a Discord channel for **Cat Bot** spawns ("… appeared!") and shows the cat in a small always-on-top window with a pixel-art **YOINK!** button. When a cat appears, the Nyan Cat GIF finishes its current loop, the matching surf GIF plays once, and then that cat's surf loop repeats. Pressing YOINK types `cat` in the channel for you and, after the current loop finishes, the return GIF plays once and Nyan Cat is back. If someone else catches the cat or it gets away, the same return plays. The GIF is picked by the word right before "cat" in the spawn message ("Fine cat has appeared!" → `fine_01_surf.gif`); cat types without GIFs (e.g. Baby cat) keep Nyan on screen with just the caption and button. The window then says which cat was caught (e.g. "Yoinked! Fine cat caught!"). If a cat is already waiting when Cat Yoink starts (or the window is reopened mid-cat), its surf loop shows right away instead of the surf-in.

While no cat is around the window plays a looping Nyan Cat GIF with an animated "Loading cat..." and a "Yoinked N Cats" counter. While a cat is out, the counter is replaced by "<Type> Cat Appeared!".

### Where the GIFs come from

Only the Nyan Cat loop (`media/idle.gif`) ships with the extension. The surf and rain GIFs (about 183 MB) are downloaded from [`gifs/` in the vsc_cat_extension repo](https://github.com/Matthew-Graves-Git/vsc_cat_extension/tree/main/gifs) into VS Code's global storage (`globalStorage/matthewgraves.cat-yoink/gifs`), in the background:

- The status bar shows the progress. The shared storm clips and every cat's surf set download first, then the rain sets. Rain sets move up while a rain is on.
- A cat that appears before its GIFs are downloaded jumps the queue. Until they arrive it is shown over Nyan with its caption and YOINK!; if it is still out once they have, it surfs (or walks) in at the next loop.
- On every start, one request checks the repo for changes (free when nothing changed). New or changed GIFs are downloaded again, and deleted ones are removed from the cache. Once downloaded, everything works offline.

To change a GIF, edit it in that repo's `gifs/` folder and push to `main`: installed copies pick it up the next time VS Code starts. `npm run test-window` uses a local `media/gifs` if you have one, otherwise the GIFs the installed extension downloaded (or the folder named in `CAT_YOINK_GIFS`).

## Install

Cat Yoink runs on Windows only (the cat window is a bundled Electron app) and isn't on the VS Code Marketplace. It's shared as a `.vsix` file on this repo's [GitHub Releases](https://github.com/Matthew-Graves-Git/vsc-cats/releases).

1. Download `cat-yoink-win32-x64-<version>.vsix` from the [latest release](https://github.com/Matthew-Graves-Git/vsc-cats/releases/latest).
2. In VS Code, open the Extensions view › `…` menu › **Install from VSIX…** and pick the file (or run `code --install-extension cat-yoink-win32-x64-<version>.vsix`).
3. Run **Cat Yoink: Set Discord Channel** and paste the channel link (right-click the channel in Discord > Copy Link).
4. A browser window opens on the Discord login. Log in. The window closes itself and watching continues invisibly (headless Edge/Chrome).
5. If your Discord session expires, a notification offers **Log in**, which shows the browser again.

Uses your installed Edge or Chrome (auto-detected, or set `catYoink.browserPath`). The login is kept in a private browser profile inside VS Code's extension storage, not in your normal browser.

**Updates:** once a day Cat Yoink asks GitHub whether a newer release is out, and if so offers its download page. Install the new `.vsix` the same way; it replaces the old version. **Cat Yoink: Check for Updates** (also in the menu) checks right away, and `catYoink.checkForUpdates` turns the daily check off.

**Upgrading from 0.x:** the old builds were installed as `local.cat-yoink`, which VS Code treats as a separate extension. While it's still installed, the new version waits and offers **Move & Uninstall**. That moves your Discord login, downloaded GIFs and window layout over and uninstalls the old version; the catch count starts again from 0. Reload the window afterwards.

## The Cat Yoink window

- A frameless window (its own small Electron app, no title bar) that opens every time VS Code starts while `catYoink.autoStart` is on.
- It lives inside the VS Code window that is watching (`catYoink.windowMode` = `insideVSCode`, the default; Windows only):
  - It can't be dragged or resized past that window's edges. It keeps its distance from the nearest corner when VS Code moves or resizes. The first time, it opens 24px in from VS Code's bottom-right corner.
  - If VS Code gets smaller than the cat window, the cat window shrinks with it (down to 200×200) and grows back to its own size afterwards.
  - It stays stacked just above VS Code, so other apps in front of VS Code cover it too. It hides while VS Code is minimized, including when a cat appears, and comes back when VS Code is restored.
  - It stays hidden until Cat Yoink knows which VS Code window is watching. That's immediate when only one VS Code window is open; otherwise it's the first time the watching window gets focus.
  - It sticks to that window, even when you focus other VS Code windows or floating editor windows. If it ever picks the wrong one, run **Cat Yoink: Attach Window Here** in the right window.
- With `catYoink.windowMode` = `floating`, it is a free always-on-top window that remembers its own screen position instead. The first time, it opens in the bottom-right corner of your main screen.
- Drag anywhere on the picture to move it; drag its edges to resize it. Its position and size are saved and reused every time it opens.
- The **X** in the corner (shown only while the cursor is over the window) hides it. Watching continues, and the window pops back up when the next cat appears (or run **Cat Yoink: Show Panel**).
- It never takes focus when it appears, so it doesn't interrupt typing.

## Cat rain

When Cat Bot starts a cat rain in the channel (`/rain`, Catnip's "started a short rain!", a rain boost, or "RAIN EXTENDED"), the window switches to the thunderstorm GIFs (`cat_thunderstorm_event/`):

1. Nyan finishes its current loop, then `nyan_exits_rain_starts.gif` plays once.
2. If a cat is already out, its `<cat>_rain_enter.gif` plays straight away; otherwise `rain_no_cat.gif` loops until one appears (the cat enters at the end of the current storm loop).
3. The cat's `<cat>_rain.gif` loops until it is gone (yoinked, or caught by someone else). Then the loop finishes and `<cat>_rain_exit.gif` plays once.
4. After the exit, the next cat's enter plays if one is already out, otherwise `rain_no_cat.gif` again.
5. When Cat Bot says "cat rain has ended", the last cat exits as usual and `nyan_enters_rain_clears.gif` brings Nyan back.

A surfing cat that is still out when a rain starts keeps surfing; once it has returned, the rain starts from Nyan. Cat types without rain GIFs keep the empty storm on screen under the caption. If watching starts (or the window reopens) mid-rain, it goes straight to the storm. If Cat Bot's end message is missed, the storm clears after 5 minutes without a new cat. Yoinking and counting work the same as for any other cat. **Cat Yoink: Test Cat Rain** plays a short made-up rain (three cats) in the window, without Discord. `npm run test-window` (or `electron window/main.js --test`) opens a window by itself, with no VS Code or Discord, and runs through every event: a random cat to Yoink, a bonus minigame, then a cat rain with two random cats. Each step waits for your click and moves on by itself after a timeout.

## Bonus-cat minigame terminal

When Cat Bot posts a **BONUS … CAT!** for a cat you caught (first or late), a green retro terminal grows out of its bottom-right corner, ending up centered in the window with an equal 8px margin on every side and a slightly see-through (80% opaque) background, and types out the offer. Click **[ GO! ]** within Cat Bot's 10 seconds and Cat Yoink presses Go! in Discord, then types out the minigame question. Type your answer (or the option number) and press Enter; Cat Bot's reply is typed out, and the terminal closes itself after a few seconds (or click its X). The text shrinks to fit the box; at very small window sizes long questions scroll. **Cat Yoink: Test Minigame Terminal** runs the whole thing with made-up questions.

The first real minigame saves a copy of Discord's question dialog in the extension storage (`minigame-dumps/`), in case Discord's page structure needs the selectors adjusted.

## Development

1. Use Node 24 or newer (`@vscode/vsce` 4 needs Node 22+, Electron 45's installer 22.12+). Run `npm install`, then `npm run compile`. Since Electron 42 the `electron` package no longer downloads its binary on install: `npm run package` fetches it (`install-electron`), and so does `npm run test-window` on first use.
2. Install it once: `npm run package` and `code --install-extension cat-yoink-win32-x64-<version>.vsix`, then reload the window.
   After that, **F5** compiles, copies the build into the installed extension (`scripts/sync-install.js`) and Cat Yoink reloads itself in the open VS Code window(s) — no new window, and other extensions keep running. Changes to commands or settings in `package.json` still need a window reload (you'll be asked).

## Releasing

Releases are built by GitHub Actions ([`.github/workflows/release.yml`](.github/workflows/release.yml)) on a Windows runner, so the `.vsix` carries the Windows build of Electron.

1. Commit and push everything: the workflow only sees what's on GitHub.
2. Run `npm version patch` (or `minor` / `major`). It bumps the version in `package.json` and `package-lock.json`, commits, and tags `v<version>`.
3. Run `git push --follow-tags`. The workflow builds `cat-yoink-win32-x64-<version>.vsix` and publishes it as the release **Cat Yoink v&lt;version&gt;**. Installed copies see it at their next daily update check.

The tag has to match the version in `package.json`: the workflow stops otherwise, and the update check compares the two. **Actions › Release › Run workflow** builds the `.vsix` as a downloadable artifact without releasing anything.

## Commands

`Cat Yoink: Set Discord Channel`, `Start Watching`, `Stop Watching`, `Log In To Discord`, `Show Panel`, `Attach Window Here`, `Reset Catch Count`, `Test Minigame Terminal`, `Test Cat Rain`, `Check for Updates`, `Menu` (also the status bar item).

The menu also has one-click toggles for **Start with VS Code** (`catYoink.autoStart`) and the **window mode** (inside VS Code or always on top, `catYoink.windowMode`).

## Settings

| Setting | Default | |
|---|---|---|
| `catYoink.channelUrl` | | Channel link |
| `catYoink.botName` | `Cat Bot` | Bot whose messages count |
| `catYoink.triggerText` | `appeared!` | Regex (case-insensitive) meaning a cat spawned |
| `catYoink.caughtText` | `\bc[a-z]*ught` | Regex (case-insensitive) meaning someone caught it; matches Cat Bot's "caught", "cought", "coought"… |
| `catYoink.replyText` | `cat` | What Yoink sends |
| `catYoink.rainStartText` | `cat rain was started\|started a short rain\|\brain will start\b\|\brain extended\b` | Regex (case-insensitive) meaning a cat rain started |
| `catYoink.rainEndText` | `cat rain has ended` | Regex (case-insensitive) meaning the cat rain is over |
| `catYoink.browserPath` | auto | Edge/Chrome executable |
| `catYoink.autoStart` | `true` | Open the window and start watching every time VS Code starts |
| `catYoink.windowMode` | `insideVSCode` | `insideVSCode`: kept inside the watching VS Code window (Windows only). `floating`: free and always on top |
| `catYoink.checkForUpdates` | `true` | Once a day, check GitHub Releases for a newer version and offer its download page |

## How the catch counter works

After you press Yoink, Cat Bot's "caught" message counts as yours when it names you. Cat Bot uses your Discord **username**, which can differ from the display name on your messages, so Cat Yoink learns it: when your `cat` was the first one after the spawn, the name Cat Bot printed is saved as your username.

If someone else was first, the panel says "… was first… checking late catch" and waits for Cat Bot's **Late … catchers** list (up to 3 people within 5 seconds still get the cat). If you're on it: "Late catch! +1 …" and the counter goes up; otherwise "Too slow!". Bonus-minigame wins (+3) don't change the counter.

## Notes

- Only one VS Code window watches at a time (the others show "Watching in another window").
- If VS Code crashes, its headless browser can be left running and would block the next start ("Failed to launch the browser process"). Cat Yoink now finds and closes such leftovers (only browsers using its own private profile) before launching.
- Fonts: [Press Start 2P](https://fonts.google.com/specimen/Press+Start+2P) by CodeMan38 (`media/fonts/OFL.txt`) and [VT323](https://fonts.google.com/specimen/VT323) by Peter Hull (`media/fonts/OFL-VT323.txt`), both SIL Open Font License.
- Discord's selectors change occasionally; if detection stops working, the selectors live in `src/discordBrowser.ts`.
- **Terms of service:** this automates a personal Discord account through a browser. Discord's ToS prohibits automating user accounts ("self-botting") and accounts can be actioned for it. It only sends after you click Yoink, but the risk is yours.

## License

MIT, see [LICENSE](LICENSE).
