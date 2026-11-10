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
  // The scene <img> never reports "loop finished", so we time it: every GIF is restarted when it
  // is assigned (the ?t= makes the URL new), and we note when it started. "Finish the current
  // loop" is then dur - (elapsed % dur). The surf GIFs repeat forever on their own, so the surf
  // and return swaps are timed too.

  const NYAN = 'idle.gif';
  let phase = 'nyan'; // nyan | surf | loop | return
  let phaseStart = null; // performance.now() when the current GIF began, null until it has loaded
  let showing = null; // cat set on screen (surf/loop/return), null while Nyan
  let target = null; // cat set we want on screen, null = Nyan
  let timer;
  let playedAt = 0;
  let lag = 0; // how long a src swap takes to show its first frame; swaps fire this much early

  const same = (a, b) => !!a && !!b && a.key === b.key;

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
        if (target) {
          const t = target;
          at(toEnd(t.nyanMs), () => {
            showing = t;
            play(t.surf, 'surf');
          });
        }
        break;
      case 'surf':
        // Play the whole intro; then loop, or head straight home if the cat is already gone.
        at(showing.surfMs - elapsed, () =>
          same(target, showing) ? play(showing.loop, 'loop') : play(showing.ret, 'return')
        );
        break;
      case 'loop':
        if (!same(target, showing)) {
          at(toEnd(showing.loopMs), () => play(showing.ret, 'return'));
        }
        break;
      case 'return':
        at(showing.retMs - elapsed, () => {
          showing = null;
          play(NYAN, 'nyan');
        });
        break;
    }
  }

  function setTarget(set) {
    target = set || null;
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
      case 'spawn':
        busy = false;
        appeared.textContent = m.title || '';
        stage.classList.add('has-cat'); // the title replaces the counter until idle
        status.textContent = '';
        yoink.disabled = false;
        setState('spawn');
        if (m.skipIntro && m.surf && !showing) {
          // The cat was already there when Cat Yoink started: straight to its loop, no surf-in.
          target = showing = m.surf;
          play(m.surf.loop, 'loop');
        } else {
          // A cat type without GIFs has no surf set: Nyan keeps looping under the overlay.
          setTarget(m.surf);
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
