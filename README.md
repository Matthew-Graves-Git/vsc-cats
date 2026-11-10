# Cat Yoink

Watches a Discord channel for **Cat Bot** spawns ("… appeared!") and shows the cat in a small always-on-top window with a pixel-art **YOINK!** button. When a cat appears, the Nyan Cat GIF finishes its current loop, the matching surf GIF plays once, and then that cat's surf loop repeats. Pressing YOINK types `cat` in the channel for you and, after the current loop finishes, the return GIF plays once and Nyan Cat is back. If someone else catches the cat or it gets away, the same return plays. The GIF is picked by the word right before "cat" in the spawn message ("Fine cat has appeared!" → `fine_01_surf.gif`); cat types without GIFs (e.g. Baby cat) keep Nyan on screen with just the caption and button. The window then says which cat was caught (e.g. "Yoinked! Fine cat caught!").

While no cat is around the window plays a looping Nyan Cat GIF with an animated "Loading cat..." and a "Yoinked N Cats" counter.

## The Cat Yoink window

- A frameless window (its own small Electron app, no title bar) that opens every time VS Code starts while `catYoink.autoStart` is on.
- Drag anywhere on the picture to move it; drag its edges to resize it. Its position and size are saved and reused every time it opens. The first time it opens in the bottom-right corner of your main screen.
- The **X** in the corner (shown only while the cursor is over the window) hides it. Watching continues, and the window pops back up when the next cat appears (or run **Cat Yoink: Show Panel**).
- It never takes focus when it appears, so it doesn't interrupt typing.

## Bonus-cat minigame terminal

When Cat Bot posts a **BONUS … CAT!** for a cat you caught (first or late), a green retro terminal grows out of the window's bottom-right corner, covering 95% of it, and types out the offer. Click **[ GO! ]** within Cat Bot's 10 seconds and Cat Yoink presses Go! in Discord, then types out the minigame question. Type your answer (or the option number) and press Enter; Cat Bot's reply is typed out, and the terminal closes itself after a few seconds (or click its X). The text shrinks to fit the box; at very small window sizes long questions scroll. **Cat Yoink: Test Minigame Terminal** runs the whole thing with made-up questions.

The first real minigame saves a copy of Discord's question dialog in the extension storage (`minigame-dumps/`), in case Discord's page structure needs the selectors adjusted.

## Setup

1. `npm install`, then `npm run compile`. (Electron 39 is used because newer Electron installers need Node 22.)
2. Install it once: `npm run package` and `code --install-extension cat-yoink-0.2.0.vsix`, then reload the window.
   After that, **F5** compiles, copies the build into the installed extension (`scripts/sync-install.js`) and Cat Yoink reloads itself in the open VS Code window(s) — no new window, and other extensions keep running. Changes to commands or settings in `package.json` still need a window reload (you'll be asked).
3. Run **Cat Yoink: Set Discord Channel** and paste the channel link (right-click the channel in Discord > Copy Link).
4. A browser window opens on the Discord login. Log in. The window closes itself and watching continues invisibly (headless Edge/Chrome).
5. If your Discord session expires, a notification offers **Log in**, which shows the browser again.

Uses your installed Edge or Chrome (auto-detected, or set `catYoink.browserPath`). The login is kept in a private browser profile inside VS Code's extension storage, not in your normal browser.

## Commands

`Cat Yoink: Set Discord Channel`, `Start Watching`, `Stop Watching`, `Log In To Discord`, `Show Panel`, `Reset Catch Count`, `Test Minigame Terminal`, `Menu` (also the status bar item).

## Settings

| Setting | Default | |
|---|---|---|
| `catYoink.channelUrl` | | Channel link |
| `catYoink.botName` | `Cat Bot` | Bot whose messages count |
| `catYoink.triggerText` | `appeared!` | Regex (case-insensitive) meaning a cat spawned |
| `catYoink.caughtText` | `\bc[a-z]*ught` | Regex (case-insensitive) meaning someone caught it; matches Cat Bot's "caught", "cought", "coought"… |
| `catYoink.replyText` | `cat` | What Yoink sends |
| `catYoink.browserPath` | auto | Edge/Chrome executable |
| `catYoink.autoStart` | `true` | Open the window and start watching every time VS Code starts |
| `catYoink.alwaysOnTop` | `true` | Keep the window above other windows |

## How the catch counter works

After you press Yoink, Cat Bot's "caught" message counts as yours when it names you. Cat Bot uses your Discord **username**, which can differ from the display name on your messages, so Cat Yoink learns it: when your `cat` was the first one after the spawn, the name Cat Bot printed is saved as your username.

If someone else was first, the panel says "… was first… checking late catch" and waits for Cat Bot's **Late … catchers** list (up to 3 people within 5 seconds still get the cat). If you're on it: "Late catch! +1 …" and the counter goes up; otherwise "Too slow!". Bonus-minigame wins (+3) don't change the counter.

## Notes

- Only one VS Code window watches at a time (the others show "Watching in another window").
- If VS Code crashes, its headless browser can be left running and would block the next start ("Failed to launch the browser process"). Cat Yoink now finds and closes such leftovers (only browsers using its own private profile) before launching.
- Fonts: [Press Start 2P](https://fonts.google.com/specimen/Press+Start+2P) by CodeMan38 (`media/fonts/OFL.txt`) and [VT323](https://fonts.google.com/specimen/VT323) by Peter Hull (`media/fonts/OFL-VT323.txt`), both SIL Open Font License.
- Discord's selectors change occasionally; if detection stops working, the selectors live in `src/discordBrowser.ts`.
- **Terms of service:** this automates a personal Discord account through a browser. Discord's ToS prohibits automating user accounts ("self-botting") and accounts can be actioned for it. It only sends after you click Yoink, but the risk is yours.
