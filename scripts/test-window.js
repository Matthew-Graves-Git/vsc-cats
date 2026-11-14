// npm run test-window: builds what the cat window needs, then opens it by itself (no VS Code, no
// Discord) and runs through every event, so changes to media/ and window/host.cs can be seen quickly:
//
//   1. a random cat surfs in; click Yoink (or it is yoinked for you after a while)
//   2. a bonus minigame is offered: play it, or let it expire
//   3. a cat that someone else catches first ("Too slow!")
//   4. a cat rain starts and 2 random cats come through it (click Yoink, or they are yoinked for you)
//   5. the rain clears and Nyan returns
//
// It runs the same NativeSurface the extension uses (out/nativeWindow.js), so the exe, the staged
// WebView2 files and the page messages are the real ones. Every step waits for you but times out,
// so a run always finishes. The window's X button quits. Windows only.
//
// The window's own files (position, WebView2 data, window.log) go to a temp folder, so your real
// window position is left alone. GIFs come from $CAT_YOINK_GIFS, a local media/gifs, or the cache
// the installed extension downloaded.
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'out');
const STORAGE = path.join(os.tmpdir(), 'cat-yoink-test-window');

const log = (...a) => console.log('[test]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pickOne = (list) => list[Math.floor(Math.random() * list.length)];
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function shuffled(list) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Runs a node script (or the TypeScript compiler) and exits with its code if it fails. */
function build(file, args = []) {
  const r = cp.spawnSync(process.execPath, [file, ...args], { stdio: 'inherit' });
  if (r.status !== 0) {
    process.exit(r.status || 1);
  }
}

/** Where the surf and rain GIFs come from (the repo itself has none). */
function findGifDir() {
  const cache = (id) => process.env.APPDATA && path.join(process.env.APPDATA, 'Code', 'User', 'globalStorage', id, 'gifs');
  const candidates = [
    process.env.CAT_YOINK_GIFS,
    path.join(ROOT, 'media', 'gifs'),
    cache('matthewgraves.cat-yoink'),
    cache('local.cat-yoink'), // until the old build's data has moved over (src/migrate.ts)
  ];
  return candidates.find((d) => d && fs.existsSync(d)) || path.join(ROOT, 'media', 'gifs');
}

const YOINK_WAIT_MS = 15_000;
const TOO_SLOW_WAIT_MS = 6_000; // how long you get to click Yoink before the other catcher wins
const RAIN_YOINK_WAIT_MS = 9_000; // every rain clip is 2.5 s: ~9 s out shows enter, loop and exit
const OFFER_WAIT_MS = 12_000; // the terminal gives up on an unanswered offer after 10 s
const RESULT_WAIT_MS = 11_000; // the terminal closes its result screen after 10 s
const AFTER_RESULT_GAP_MS = 7_000; // after the first rain cat: leaves the empty storm on screen
const BETWEEN_CATS_GAP_MS = 1_500; // a cat waiting as the exit ends walks straight in

async function main() {
  if (process.platform !== 'win32') {
    console.error('npm run test-window needs Windows (the frameless cat window).');
    process.exit(1);
  }
  build(path.join(ROOT, 'scripts', 'build-host.js'));
  build(path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), ['-p', ROOT]);

  const { NativeSurface, nativeUnavailable } = require(path.join(OUT, 'nativeWindow.js'));
  const { surfCats, surfSet, rainCats, rainSet, rainScene } = require(path.join(OUT, 'gifs.js'));
  const { spawnTitle } = require(path.join(OUT, 'catText.js'));
  const { TEST_ROUNDS, testResultText } = require(path.join(OUT, 'testRounds.js'));

  const unavailable = nativeUnavailable(ROOT);
  if (unavailable) {
    console.error(`The cat window can't run here: ${unavailable} (npm install fetches window/lib).`);
    process.exit(1);
  }
  fs.mkdirSync(STORAGE, { recursive: true });
  const GIFS = findGifDir();

  // ---- the window ----
  let waiter = null;
  /** Resolves with the next page message whose type is in `types`, or null after `ms`. */
  const waitFor = (types, ms) =>
    new Promise((resolve) => {
      const done = (m) => {
        clearTimeout(timer);
        waiter = null;
        resolve(m);
      };
      const timer = setTimeout(() => done(null), ms);
      waiter = { types, done };
    });

  let surface;
  const quit = (code = 0) => {
    surface?.dispose();
    setTimeout(() => process.exit(code), 500);
  };
  surface = new NativeSurface(
    { extensionPath: ROOT, storageDir: STORAGE, gifDir: GIFS, minimizeWith: false },
    {
      onMessage: (m) => waiter && waiter.types.includes(m.type) && waiter.done(m),
      onClosed: () => {
        log('window closed');
        quit();
      },
      onGone: () => {
        log('window exited');
        quit();
      },
    },
    (reason) => {
      console.error(`[test] the cat window didn't start: ${reason} (see ${path.join(STORAGE, 'window.log')})`);
      quit(1);
    }
  );
  process.on('SIGINT', () => quit());
  const post = (m) => surface.post(m);

  let count = 0;
  const yoinked = (text) => {
    post({ type: 'result', text: `${text} (test)`, caught: true });
    post({ type: 'count', count: ++count });
  };

  async function bonus() {
    const round = pickOne(TEST_ROUNDS);
    log(`bonus minigame: ${round.form.title}`);
    post({
      type: 'term',
      msg: {
        type: 'offer',
        text: `BONUS ${round.form.title.toUpperCase()} CAT! (test)\nAnyone who cought this cat can play a minigame and potentially get +3 more!`,
        test: true,
      },
    });
    const go = await waitFor(['mgGo', 'mgClose'], OFFER_WAIT_MS);
    if (go && go.type === 'mgGo') {
      post({ type: 'term', msg: { type: 'question', form: round.form } });
      const a = await waitFor(['mgAnswer', 'mgClose'], round.form.timeLimitMs + 2_000);
      if (a && a.type === 'mgAnswer') {
        post({ type: 'term', msg: { type: 'submitted' } });
        await sleep(900);
        post({ type: 'term', msg: { type: 'result', ...testResultText(round, String(a.answer ?? '')) } });
        await waitFor(['mgClose'], RESULT_WAIT_MS);
      }
    }
    await sleep(3_500); // the terminal's end screen and closing animation
  }

  // ---- the run ----
  log(`GIFs from ${GIFS}`);
  const surfNames = [...surfCats(ROOT, GIFS).keys()].filter((w) => surfSet(ROOT, w, GIFS));
  const rainNames = [...rainCats(ROOT, GIFS).keys()].filter((w) => rainSet(ROOT, w, GIFS));
  const scene = rainScene(ROOT, GIFS);
  if (!surfNames.length) {
    log('no surf GIFs found there; skipping the surfing cats (set CAT_YOINK_GIFS to a gifs folder)');
  }
  if (!scene || !rainNames.length) {
    log('no rain GIFs found there (cat_thunderstorm_event/); skipping the rain');
  }

  log('opening the window');
  surface.show();
  if (!(await waitFor(['ready'], 30_000))) {
    console.error('[test] the page never said ready');
    quit(1);
    return;
  }
  post({ type: 'count', count: 0 });
  post({ type: 'idle' });
  await sleep(2_000);

  // 1. A random cat surfs in; Yoink it.
  if (surfNames.length) {
    const word = pickOne(surfNames);
    const name = cap(word);
    log(`spawn: ${name} cat`);
    post({ type: 'spawn', id: `test-surf-${Date.now()}`, title: spawnTitle(`${name} cat`), surf: surfSet(ROOT, word, GIFS) });
    const clicked = await waitFor(['yoink'], YOINK_WAIT_MS);
    log(clicked ? 'yoinked' : 'no click: yoinking it for you');
    await sleep(800);
    yoinked(`${name} cat Yoinked!`);
    await sleep(2_000);
  }

  // 2. The bonus minigame that follows the catch.
  await bonus();
  post({ type: 'idle' });
  await sleep(1_000);

  // 3. Someone else catches a cat first. Clicking Yoink in time gets "was first... checking late
  //    catch" and then "Too slow!" (the real late-catch path); not clicking gets the plain "Too slow!".
  if (surfNames.length) {
    const word = pickOne(surfNames);
    const name = cap(word);
    log(`spawn: ${name} cat (someone else catches it)`);
    post({ type: 'spawn', id: `test-slow-${Date.now()}`, title: spawnTitle(`${name} cat`), surf: surfSet(ROOT, word, GIFS) });
    const clicked = await waitFor(['yoink'], TOO_SLOW_WAIT_MS);
    if (clicked) {
      log('yoinked, but someone was first');
      post({ type: 'status', text: 'Someone was first... checking late catch' });
      await sleep(2_000);
      post({ type: 'result', text: `Too slow! Someone caught the ${name} cat. (test)`, caught: false });
    } else {
      log('no click: someone else caught it');
      post({ type: 'tooSlow', text: `Someone caught the ${name} cat. (test)` });
    }
    await sleep(5_000);
    post({ type: 'idle' });
    await sleep(1_000);
  }

  // 4. A cat rain with 2 random cats.
  if (scene && rainNames.length) {
    log('rain starts');
    post({ type: 'rain', on: true, scene });
    await sleep(1_000); // the first cat is waiting by the end of the rain start transition
    const words = shuffled(rainNames).slice(0, 2);
    const stamp = Date.now();
    for (let i = 0; i < words.length; i++) {
      const name = cap(words[i]);
      log(`rain cat ${i + 1}/${words.length}: ${name} cat`);
      post({
        type: 'spawn',
        id: `test-rain-${stamp}-${i}`,
        title: spawnTitle(`${name} cat`),
        surf: surfSet(ROOT, words[i], GIFS),
        rain: rainSet(ROOT, words[i], GIFS),
      });
      const clicked = await waitFor(['yoink'], RAIN_YOINK_WAIT_MS);
      if (clicked) {
        log('yoinked');
      }
      yoinked(`${name} cat Yoinked!`);
      await sleep(i === 0 ? AFTER_RESULT_GAP_MS : BETWEEN_CATS_GAP_MS);
    }
    // 5. The rain clears.
    log('rain ends');
    post({ type: 'rain', on: false });
    post({ type: 'idle' });
  }

  log('done (close the window with its X button)');
}

main().catch((err) => {
  console.error('[test] failed:', err);
  process.exit(1);
});
