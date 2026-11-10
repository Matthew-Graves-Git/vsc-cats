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
  // loop" is then dur - (elapsed % dur). Some one-shot GIFs repeat forever on their own, so every
  // one-shot swap is timed too.

  const NYAN = 'idle.gif';
  // nyan | surf | loop | return | rainStart | rainEmpty | rainEnter | rainLoop | rainExit | rainClear
  let phase = 'nyan';
  let phaseStart = null; // performance.now() when the current GIF began, null until it has loaded
  let showing = null; // the spawn on screen ({ id, surf, rain }) while a cat is drawn, else null
  let target = null; // the spawn we want on screen, null = no cat
  let raining = false;
  let storm = null; // the shared rain clips (RainScene) of the current or last rain
  let timer;
  let playedAt = 0;
  let lag = 0; // how long a src swap takes to show its first frame; swaps fire this much early

  // By spawn id, not cat type: rain cats of one type come back to back and each exits and enters.
  const same = (a, b) => !!a && !!b && a.id === b.id;

  function play(src, nextPhase) {
    clearTimeout(timer);
    phase = nextPhase;
    phaseStart = null;
    playedAt = performance.now();
    scene.src = src + '?t=' + Date.now();
  }

  scene.addEventListener('load', () => {
    const now = performance.now();
    if (playedAt) {
      lag = Math.min(150, now - playedAt);
      playedAt = 0;
    }
    phaseStart = now;
    plan();
  });

  function at(ms, fn) {
    clearTimeout(timer);
    timer = setTimeout(fn, Math.max(0, ms - lag));
  }

  function plan() {
    clearTimeout(timer);
    if (phaseStart === null) {
      return; // the next GIF is still loading; its load event calls plan()
    }
    const elapsed = performance.now() - phaseStart;
    const toEnd = (dur) => dur - (elapsed % dur);

    switch (phase) {
      case 'nyan':
        if (raining) {
          const s = storm;
          at(toEnd(s.nyanMs), () => play(s.start, 'rainStart'));
        } else if (target && target.surf) {
          const t = target;
          at(toEnd(t.surf.nyanMs), () => {
            showing = t;
            play(t.surf.surf, 'surf');
          });
        }
        break;
      case 'surf':
        // Play the whole intro; then loop, or head straight home if the cat is already gone.
        at(showing.surf.surfMs - elapsed, () =>
          same(target, showing) ? play(showing.surf.loop, 'loop') : play(showing.surf.ret, 'return')
        );
        break;
      case 'loop':
        if (!same(target, showing)) {
          at(toEnd(showing.surf.loopMs), () => play(showing.surf.ret, 'return'));
        }
        break;
      case 'return':
        at(showing.surf.retMs - elapsed, () => {
          showing = null;
          play(NYAN, 'nyan');
        });
        break;

      case 'rainStart':
        at(storm.startMs - elapsed, next);
        break;
      case 'rainEmpty':
        // A cat type without rain GIFs leaves the empty storm looping under the caption.
        if (!raining || (target && target.rain)) {
          at(toEnd(storm.emptyMs), next);
        }
        break;
      case 'rainEnter':
        at(showing.rain.enterMs - elapsed, () =>
          same(target, showing) ? play(showing.rain.loop, 'rainLoop') : play(showing.rain.exit, 'rainExit')
        );
        break;
      case 'rainLoop':
        if (!same(target, showing)) {
          at(toEnd(showing.rain.loopMs), () => play(showing.rain.exit, 'rainExit'));
        }
        break;
      case 'rainExit':
        at(showing.rain.exitMs - elapsed, () => {
          showing = null;
          next();
        });
        break;
      case 'rainClear':
        at(storm.clearMs - elapsed, () => play(NYAN, 'nyan'));
        break;
    }
  }

  /** On the empty storm's first frame: bring in the waiting cat, clear up, or keep raining. */
  function next() {
    if (raining && target && target.rain) {
      showing = target;
      play(target.rain.enter, 'rainEnter');
    } else if (!raining) {
      play(storm.clear, 'rainClear');
    } else {
      play(storm.empty, 'rainEmpty');
    }
  }

  function setTarget(spawn) {
    target = spawn || null;
    plan();
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
        busy = false;
        status.textContent = '';
        setState('idle');
        stage.classList.remove('has-cat'); // back to "Yoinked N Cats"
        setTarget(null);
        break;
      case 'spawn': {
        busy = false;
        appeared.textContent = m.title || '';
        stage.classList.add('has-cat'); // the title replaces the counter until idle
        status.textContent = '';
        yoink.disabled = false;
        setState('spawn');
        const spawn = { id: m.id, surf: m.surf, rain: m.rain };
        const gifs = raining ? m.rain : m.surf;
        if (m.skipIntro && gifs && !showing) {
          // The cat was already there when Cat Yoink started: straight to its loop, no intro.
          target = showing = spawn;
          play(gifs.loop, raining ? 'rainLoop' : 'loop');
        } else {
          // A cat type without GIFs keeps Nyan (or the empty storm) looping under the overlay.
          setTarget(spawn);
        }
        break;
      }
      case 'rain':
        if (m.on && m.scene) {
          raining = true;
          storm = m.scene;
          if (m.skipIntro && phase === 'nyan' && !showing) {
            play(storm.empty, 'rainEmpty'); // it was already raining: straight to the storm
          } else {
            plan();
          }
        } else if (raining) {
          raining = false;
          plan();
        }
        break;
      case 'tooSlow':
        yoink.disabled = true;
        status.textContent = 'Too slow! ' + (m.text || '');
        setTarget(null);
        break;
      case 'result':
        status.textContent = m.text;
        setState('result');
        setTarget(null);
        break;
      case 'status':
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

  // The <img> in panel.html may have finished loading before the listener above existed, so
  // restart Nyan through play(): that way phaseStart is always set by a load event we see.
  play(NYAN, 'nyan');

  host.send({ type: 'ready' });
})();
