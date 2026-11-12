// `electron window/main.js --test`: a scripted run through every window event, with no VS Code or
// Discord. Plain JS (like main.js); it reuses the compiled helpers in out/ (run `npm run compile`).
//
//   1. a random cat surfs in; click Yoink (or it is yoinked for you after a while)
//   2. a bonus minigame is offered: play it, or let it expire
//   3. a cat rain starts and 2 random cats come through it (click Yoink, or they are yoinked for you)
//   4. the rain clears and Nyan returns
//
// Every step waits for you but times out, so a run always finishes. The X button quits.
const fs = require('fs');
const os = require('os');
const path = require('path');

const OUT = path.join(__dirname, '..', 'out');
const { surfCats, surfSet, rainCats, rainSet, rainScene } = require(path.join(OUT, 'gifs.js'));
const { spawnTitle } = require(path.join(OUT, 'catText.js'));
const { TEST_ROUNDS, testResultText } = require(path.join(OUT, 'testRounds.js'));

const ROOT = path.join(__dirname, '..');

/**
 * Where the surf and rain GIFs come from: $CAT_YOINK_GIFS, a local media/gifs (the repo no longer
 * has one), else the cache the installed extension downloaded (src/gifSync.ts).
 */
function findGifDir() {
  const appData =
    process.platform === 'win32'
      ? process.env.APPDATA
      : process.platform === 'darwin'
        ? path.join(os.homedir(), 'Library', 'Application Support')
        : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  const cache = (id) => appData && path.join(appData, 'Code', 'User', 'globalStorage', id, 'gifs');
  const candidates = [
    process.env.CAT_YOINK_GIFS,
    path.join(ROOT, 'media', 'gifs'),
    cache('matthewgraves.cat-yoink'),
    cache('local.cat-yoink'), // until the old build's data has moved over (src/migrate.ts)
  ];
  return candidates.find((d) => d && fs.existsSync(d)) || path.join(ROOT, 'media', 'gifs');
}

const GIFS = findGifDir();

const YOINK_WAIT_MS = 15_000;
const RAIN_YOINK_WAIT_MS = 9_000; // every rain clip is 2.5 s: ~9 s out shows enter, loop and exit
const OFFER_WAIT_MS = 12_000; // the terminal gives up on an unanswered offer after 10 s
const RESULT_WAIT_MS = 11_000; // the terminal closes its result screen after 10 s
const AFTER_RESULT_GAP_MS = 7_000; // after the first rain cat: leaves the empty storm on screen
const BETWEEN_CATS_GAP_MS = 1_500; // a cat waiting as the exit ends walks straight in

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

/**
 * Starts the run. `post(msg)` sends a message to the page; the returned `onPanel(msg)` must be
 * given every message the page sends (ready, yoink, mgGo, mgAnswer, mgClose).
 */
module.exports = function startTestRun({ post }) {
  let waiter = null;

  /** Resolves with the next page message whose type is in `types`, or null after `ms`. */
  function waitFor(types, ms) {
    return new Promise((resolve) => {
      const done = (m) => {
        clearTimeout(timer);
        waiter = null;
        resolve(m);
      };
      const timer = setTimeout(() => done(null), ms);
      waiter = { types, done };
    });
  }

  function onPanel(m) {
    if (waiter && waiter.types.includes(m.type)) {
      waiter.done(m);
    }
  }

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

  async function run() {
    log(`GIFs from ${GIFS}`);
    const surfNames = [...surfCats(ROOT, GIFS).keys()].filter((w) => surfSet(ROOT, w, GIFS));
    const rainNames = [...rainCats(ROOT, GIFS).keys()].filter((w) => rainSet(ROOT, w, GIFS));
    const scene = rainScene(ROOT, GIFS);
    if (!surfNames.length) {
      log('no surf GIFs found there; skipping the surfing cat (set CAT_YOINK_GIFS to a gifs folder)');
    }
    if (!scene || !rainNames.length) {
      log('no rain GIFs found there (cat_thunderstorm_event/); skipping the rain');
    }

    log('waiting for the window');
    await waitFor(['ready'], 30_000);
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

    // 3. A cat rain with 2 random cats.
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
      log('rain ends');
      post({ type: 'rain', on: false });
      post({ type: 'idle' });
    }

    log('done (close the window with its X button)');
  }

  run().catch((err) => console.error('[test] failed:', err));
  return { onPanel };
};
