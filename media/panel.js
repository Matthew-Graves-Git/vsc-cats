(function () {
  // Provided by window/preload.js.
  const host = window.catYoink;
  const stage = document.getElementById('stage');
  const close = document.getElementById('close');
  const scene = document.getElementById('scene');
  const appeared = document.getElementById('appeared');
  const status = document.getElementById('status');
  const yoink = document.getElementById('yoink');
  const countEl = document.getElementById('count');
  const catsWord = document.getElementById('catsWord');

  let busy = false;

  function setState(s) {
    stage.dataset.state = s;
  }

  // ---- GIF sequencer ----
  //
  //   nyan --(cat appears)--> [finish nyan loop] surf (once) -> loop ...
  //   loop --(yoink / cat gone)--> [finish loop] return (once) -> nyan ...
  //
  // During a cat rain (Cat Bot spawns the next cat 1-2 s after each catch) the storm replaces it:
  //
  //   nyan --(rain starts)--> [finish nyan loop] rainStart (once) -> next()
  //   rainEmpty --(cat appears / rain over)--> [finish loop] next()
  //   rainEnter (once) -> rainLoop --(yoink / cat gone)--> [finish loop] rainExit (once) -> next()
  //   rainClear (once) -> nyan
  //
  //   next(), on the empty storm's first frame: a cat is out ? rainEnter
  //                                           : rain over  ? rainClear
  //                                           :              rainEmpty
  //
  // A surfing cat still out when the rain starts keeps surfing; after its return, the rain starts
  // from Nyan.
  //
  // The scene <img> never reports "loop finished", so we time it: every GIF is restarted when it
  // is assigned (the ?t= makes the URL new), and we note when it started. "Finish the current
  // loop" is then dur - (elapsed % dur).
  //
  // A fresh URL means a fresh load and decode (the rain clips are ~2 MB), and until that is done
  // the old clip stays on screen; a loop that reaches its end meanwhile replays its first frames.
  // So the next clip is loaded and decoded LEAD ms before its handoff, in a detached Image that is
  // never painted (its animation hasn't started), and the swap to that same URL lands on the
  // boundary. If it still isn't ready: a loop plays one more cycle; a one-shot clip plays once and
  // holds its last frame (the next clip's first; scripts/fix-gif-loops.js), so it just waits.
  //
  // Before any of that, 'boot': nothing on screen until the extension says whether a cat is already
  // out (spawn with skipIntro: straight to its loop) or not (idle: Nyan).

  const NYAN = 'idle.gif';
  const LEAD = 600; // how long before a handoff the next clip starts loading (clips are >= 1.68 s)
  // Swaps land this much before the boundary. The incoming clip's first frame is the outgoing
  // clip's last (or, after a loop, its first), so early only shortens one frame; late lets the
  // outgoing loop paint its first frame again, and the timer and next repaint can each add ~16 ms.
  const EARLY = 30;
  // boot | nyan | surf | loop | return | rainStart | rainEmpty | rainEnter | rainLoop | rainExit | rainClear
  let phase = 'boot';
  let phaseStart = null; // performance.now() when the current GIF began, null until it has loaded
  let showing = null; // the spawn on screen ({ id, surf, rain }) while a cat is drawn, else null
  let target = null; // the spawn we want on screen, null = no cat
  let raining = false;
  let storm = null; // the shared rain clips (RainScene) of the current or last rain
  let timer; // the pending handoff's preload or swap timer
  let gen = 0; // bumped by every replan and swap, so callbacks from an older plan do nothing
  let pending = null; // the clip being preloaded for the next handoff
  let seq = 0;
  // A cat has spawned but isn't on screen yet (its clip starts at the next handoff): YOINK! stays
  // hidden (the stage keeps its idle state) until it is.
  let pendingSpawn = false;

  // By spawn id, not cat type: rain cats of one type come back to back and each exits and enters.
  const same = (a, b) => !!a && !!b && a.id === b.id;

  /** Starts loading and decoding `src` under a fresh URL; asking again for the same src reuses it. */
  function preload(src) {
    if (pending && pending.src === src) {
      return pending;
    }
    const img = new Image();
    const p = { src, url: `${src}?t=${Date.now()}-${++seq}`, img, done: false };
    img.src = p.url;
    p.ready = img
      .decode()
      .catch(() => {}) // a clip that won't decode must not stall the sequence
      .then(() => {
        p.done = true;
      });
    pending = p;
    return p;
  }

  /**
   * Makes `p` the current clip (as soon as it has loaded). `apply` runs first: the state change that
   * goes with the clip (which cat is on screen).
   */
  function show(p, nextPhase, apply) {
    clearTimeout(timer);
    const g = ++gen;
    if (apply) {
      apply();
    }
    phase = nextPhase;
    phaseStart = null; // plan() waits for this clip's load event
    if (pending === p) {
      pending = null;
    }
    const put = () => {
      if (g === gen) {
        scene.src = p.url;
        // Already decoded, so it can be on screen before its load event: start the clock now. Erring
        // early only trims the last frame; a late handoff would show a loop's first frame again.
        phaseStart = performance.now();
        if (pendingSpawn && same(showing, target)) {
          revealSpawn(); // the cat's own clip is on screen now
        }
      }
    };
    p.done ? put() : p.ready.then(put);
  }

  /** Switches to `src` right away (as soon as it has loaded), not on a clip boundary. */
  function play(src, nextPhase, apply) {
    show(preload(src), nextPhase, apply);
  }

  scene.addEventListener('load', () => {
    if (phaseStart === null) {
      phaseStart = performance.now();
    }
    plan();
  });

  /**
   * Hands off to the clip `choose()` picks ({ src, phase, apply? }) in `ms` (the current clip's end,
   * or the end of this loop cycle). `loopMs`: the current clip loops, so if the next one isn't
   * ready by then, wait for the following boundary instead of cutting in mid-cycle.
   */
  function handoff(ms, choose, loopMs) {
    const g = gen;
    const due = performance.now() + ms - EARLY;
    timer = setTimeout(() => {
      if (g !== gen) {
        return;
      }
      const c = choose();
      const p = preload(c.src);
      const swapAt = (t) => {
        timer = setTimeout(() => {
          if (g !== gen) {
            return;
          }
          if (!p.done && loopMs) {
            swapAt(t + loopMs);
          } else {
            show(p, c.phase, c.apply);
          }
        }, Math.max(0, t - performance.now()));
      };
      swapAt(due);
    }, Math.max(0, ms - LEAD));
  }

  function plan() {
    if (phaseStart === null) {
      return; // the next GIF is still loading; its load event calls plan()
    }
    clearTimeout(timer);
    gen++;
    const elapsed = performance.now() - phaseStart;
    const toEnd = (dur) => dur - (elapsed % dur);
    const cat = showing;

    switch (phase) {
      case 'nyan':
        if (raining) {
          const s = storm;
          handoff(toEnd(s.nyanMs), () => ({ src: s.start, phase: 'rainStart' }), s.nyanMs);
        } else if (target && target.surf) {
          const t = target;
          handoff(
            toEnd(t.surf.nyanMs),
            () => ({ src: t.surf.surf, phase: 'surf', apply: () => (showing = t) }),
            t.surf.nyanMs
          );
        }
        break;
      case 'surf':
        // Play the whole intro; then loop, or head straight home if the cat is already gone.
        handoff(cat.surf.surfMs - elapsed, () =>
          same(target, cat) ? { src: cat.surf.loop, phase: 'loop' } : { src: cat.surf.ret, phase: 'return' }
        );
        break;
      case 'loop':
        if (!same(target, cat)) {
          handoff(toEnd(cat.surf.loopMs), () => ({ src: cat.surf.ret, phase: 'return' }), cat.surf.loopMs);
        }
        break;
      case 'return':
        handoff(cat.surf.retMs - elapsed, () => ({ src: NYAN, phase: 'nyan', apply: () => (showing = null) }));
        break;

      case 'rainStart':
        handoff(storm.startMs - elapsed, next);
        break;
      case 'rainEmpty':
        // A cat type without rain GIFs leaves the empty storm looping under the caption.
        if (!raining || (target && target.rain)) {
          handoff(toEnd(storm.emptyMs), next, storm.emptyMs);
        }
        break;
      case 'rainEnter':
        handoff(cat.rain.enterMs - elapsed, () =>
          same(target, cat) ? { src: cat.rain.loop, phase: 'rainLoop' } : { src: cat.rain.exit, phase: 'rainExit' }
        );
        break;
      case 'rainLoop':
        if (!same(target, cat)) {
          handoff(toEnd(cat.rain.loopMs), () => ({ src: cat.rain.exit, phase: 'rainExit' }), cat.rain.loopMs);
        }
        break;
      case 'rainExit':
        handoff(cat.rain.exitMs - elapsed, () => {
          const n = next();
          return {
            ...n,
            apply: () => {
              showing = null;
              if (n.apply) {
                n.apply();
              }
            },
          };
        });
        break;
      case 'rainClear':
        handoff(storm.clearMs - elapsed, () => ({ src: NYAN, phase: 'nyan' }));
        break;
    }
  }

  /** What follows the empty storm's first frame: the waiting cat walks in, the rain clears, or it keeps raining. */
  function next() {
    if (raining && target && target.rain) {
      const t = target;
      return { src: t.rain.enter, phase: 'rainEnter', apply: () => (showing = t) };
    }
    if (!raining) {
      return { src: storm.clear, phase: 'rainClear' };
    }
    return { src: storm.empty, phase: 'rainEmpty' };
  }

  function setTarget(spawn) {
    target = spawn || null;
    plan();
  }

  /** The spawned cat is on screen (or never will be): show YOINK!. */
  function revealSpawn() {
    if (pendingSpawn) {
      pendingSpawn = false;
      setState('spawn');
    }
  }

  /** Reveals now if the waiting cat won't get a clip of its own (or is already drawn). */
  function checkReveal() {
    if (!pendingSpawn) {
      return;
    }
    const gifs = target && (raining ? target.rain : target.surf);
    if (!gifs || same(showing, target)) {
      revealSpawn(); // no GIFs for it: Nyan (or the empty storm) keeps looping under the overlay
    }
  }

  /** The first GIF after boot: the empty storm if it is raining, else Nyan. plan() takes it from there. */
  function leaveBoot() {
    if (phase === 'boot') {
      raining ? play(storm.empty, 'rainEmpty') : play(NYAN, 'nyan');
    }
  }

  yoink.addEventListener('click', () => {
    if (busy || yoink.disabled) {
      return;
    }
    busy = true;
    yoink.disabled = true;
    status.textContent = '';
    setTarget(null); // the cat is taken: finish this loop, then the return GIF
    host.send({ type: 'yoink' });
  });

  close.addEventListener('click', () => host.send({ type: 'close' }));

  // ---- window dragging ----
  //
  // Pressing the picture (or the terminal's title bar) moves the window: window/main.js follows the
  // cursor until we say the drag ended. Not a -webkit-app-region drag: that uses Windows' move
  // loop, and its Aero Shake minimizes VS Code when the cat is held against VS Code's edge.

  let dragging = false;

  function endDrag() {
    if (dragging) {
      dragging = false;
      host.send({ type: 'dragEnd' });
    }
  }

  stage.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !e.target.closest('.drag, .term-bar') || e.target.closest('button, textarea, input')) {
      return;
    }
    e.preventDefault(); // no text selection while dragging
    e.target.setPointerCapture(e.pointerId); // the release still reaches us if the cursor left the window
    dragging = true;
    host.send({ type: 'dragStart' });
  });
  stage.addEventListener('pointerup', endDrag);
  stage.addEventListener('pointercancel', endDrag);
  stage.addEventListener('lostpointercapture', endDrag);
  stage.addEventListener('pointermove', (e) => {
    if (dragging && e.buttons === 0) {
      endDrag(); // the release went missing
    }
  });
  window.addEventListener('blur', endDrag);

  window.addEventListener('message', (event) => {
    const m = event.data;
    switch (m.type) {
      case 'count':
        countEl.textContent = String(m.count);
        catsWord.textContent = m.count === 1 ? 'Cat' : 'Cats';
        break;
      case 'idle':
      case 'loading': // like idle, but stays on the blank boot screen until the channel is checked
        busy = false;
        pendingSpawn = false;
        status.textContent = '';
        setState('idle');
        stage.classList.remove('has-cat'); // back to "Yoinked N Cats"
        setTarget(null);
        if (m.type === 'idle') {
          leaveBoot();
        }
        break;
      case 'spawn': {
        busy = false;
        appeared.textContent = m.title || '';
        stage.classList.add('has-cat'); // the title replaces the counter until idle
        status.textContent = '';
        yoink.disabled = false;
        // YOINK! shows once the cat is on screen (revealSpawn), not when the message arrives.
        setState('idle');
        pendingSpawn = true;
        const spawn = { id: m.id, surf: m.surf, rain: m.rain };
        const gifs = raining ? m.rain : m.surf;
        if (m.skipIntro && gifs && !showing) {
          // The cat was already there when Cat Yoink started: straight to its loop, no intro
          // (revealed when that loop is put on screen).
          target = showing = spawn;
          play(gifs.loop, raining ? 'rainLoop' : 'loop');
        } else {
          // A cat type without GIFs keeps Nyan (or the empty storm) looping under the overlay.
          setTarget(spawn);
          leaveBoot();
          checkReveal();
        }
        break;
      }
      case 'rain':
        if (m.on && m.scene) {
          raining = true;
          storm = m.scene;
          // A rain reported before the first check is one that was already on.
          if ((phase === 'boot' || (m.skipIntro && phase === 'nyan')) && !showing) {
            play(storm.empty, 'rainEmpty'); // it was already raining: straight to the storm
          } else {
            plan();
          }
          checkReveal(); // a waiting cat with no rain GIFs never walks in
        } else if (raining) {
          raining = false;
          plan();
          checkReveal(); // ...and one with only rain GIFs never surfs in
        }
        stage.classList.toggle('raining', raining); // no "Loading cat..." over the storm
        break;
      case 'tooSlow':
        revealSpawn();
        yoink.disabled = true;
        status.textContent = 'Too slow! ' + (m.text || '');
        setTarget(null);
        break;
      case 'result':
        pendingSpawn = false;
        status.textContent = m.text;
        setState('result');
        setTarget(null);
        break;
      case 'status':
        revealSpawn();
        yoink.disabled = true;
        status.textContent = m.text;
        break;
      case 'hover':
        stage.classList.toggle('hovered', !!m.inside);
        break;
      case 'term':
        if (window.catTerminal) {
          window.catTerminal.handle(m.msg);
        } else {
          console.error('Cat Yoink: terminal.js did not load; dropping terminal message', m.msg && m.msg.type);
        }
        break;
    }
  });

  // No GIF yet ('boot'): the extension's first idle / spawn / rain message picks the first one.
  host.send({ type: 'ready' });
})();
