// Minigame terminal popup inside the cat window. Driven by { type: 'term', msg } panel messages
// (see TerminalMessage in src/catWindow.ts); talks back with mgGo / mgAnswer / mgClose.
(function () {
  const host = window.catYoink;
  const $ = (id) => document.getElementById(id);
  const term = $('term');
  const titleEl = $('termTitle');
  const timerEl = $('termTimer');
  const closeBtn = $('termClose');
  const screen = $('termScreen');
  const out = $('termOut');
  const optionsEl = $('termOptions');
  const goRow = $('termGoRow');
  const goBtn = $('termGo');
  const goBar = $('termGoBar');
  const promptRow = $('termPrompt');
  const input = $('termInput');
  const hint = $('termHint');

  const CHAR_MS = 18; // typewriter speed
  const MAX_TYPE_MS = 2500; // long texts type faster so the 45 s clock isn't wasted
  const GO_MS = 10000; // Cat Bot removes the Go! button after 10 s
  const MIN_FONT = 12;
  const MAX_FONT = 24;

  let stage = 'closed'; // offer | connecting | question | sent | done | closed
  let form = null;
  let screenText = ''; // full text of the current screen (for re-fitting)
  let typing = null;
  let tickTimer = null;
  let deadline = 0;
  let closeTimer = null;

  /** Discord text -> what the pixel font can show. */
  function clean(s) {
    return String(s == null ? '' : s)
      .replace(/✅/g, '[OK]')
      .replace(/❌/g, '[X]')
      .replace(/\u{1F381}/gu, '[*]')
      .replace(/\p{Extended_Pictographic}|️|‍/gu, '')
      .replace(/\*\*/g, '')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  // ---- open / close (grow out of / shrink into the bottom-right corner) ----

  function animate(cls) {
    term.classList.remove('opening', 'closing');
    void term.offsetWidth; // restart the animation
    term.classList.add(cls);
  }

  function open() {
    clearTimeout(closeTimer);
    if (term.hidden || term.classList.contains('closing')) {
      term.hidden = false;
      animate('opening');
    }
  }

  function close(tellHost) {
    clearTimeout(closeTimer);
    stopTick();
    finishTyping();
    if (tellHost) {
      host.send({ type: 'mgClose' });
    }
    stage = 'closed';
    form = null;
    if (!term.hidden) {
      animate('closing');
    }
  }

  function closeLater(ms) {
    clearTimeout(closeTimer);
    closeTimer = setTimeout(() => close(false), ms);
  }

  term.addEventListener('animationend', () => {
    if (term.classList.contains('closing')) {
      term.hidden = true;
    }
    term.classList.remove('opening', 'closing');
  });

  closeBtn.addEventListener('click', () => close(stage !== 'done' && stage !== 'closed'));

  // ---- typewriter ----

  function finishTyping() {
    if (!typing) {
      return;
    }
    const t = typing;
    typing = null;
    clearInterval(t.timer);
    out.textContent = t.target;
    t.done();
  }

  /** Types `text` into the screen left to right. Resolves when done (or skipped). */
  function type(text) {
    finishTyping();
    return new Promise((resolve) => {
      const per = Math.max(1, Math.ceil(text.length / (MAX_TYPE_MS / CHAR_MS)));
      let i = 0;
      out.textContent = '';
      const t = {
        target: text,
        done: resolve,
        timer: setInterval(() => {
          i = Math.min(text.length, i + per);
          out.textContent = text.slice(0, i);
          if (i >= text.length) {
            finishTyping();
          }
        }, CHAR_MS),
      };
      typing = t;
    });
  }

  // A click on the screen, or any key, shows the rest of the text at once.
  screen.addEventListener('mousedown', finishTyping);
  document.addEventListener('keydown', () => {
    if (!term.hidden) {
      finishTyping();
    }
  });

  // ---- fitting the text in the box ----

  /**
   * Picks the largest font size (MAX_FONT..MIN_FONT) at which the screen's full text, options and
   * bottom row fit without scrolling, by laying out the final text before it is typed.
   */
  function fit() {
    if (term.hidden) {
      return;
    }
    const typed = out.textContent;
    out.textContent = screenText;
    const start = Math.max(MIN_FONT, Math.min(MAX_FONT, Math.floor(term.clientWidth * 0.07), Math.floor(term.clientHeight * 0.09)));
    let size = start;
    for (; size > MIN_FONT; size--) {
      term.style.setProperty('--tfs', size + 'px');
      if (screen.scrollHeight <= screen.clientHeight + 1) {
        break;
      }
    }
    term.style.setProperty('--tfs', size + 'px');
    out.textContent = typing ? typed : screenText;
    screen.scrollTop = 0;
  }

  window.addEventListener('resize', fit);

  /** Clears the screen, fits `text` and types it. */
  function show(text) {
    screenText = text;
    fit();
    return type(text);
  }

  // ---- countdowns ----

  function stopTick() {
    clearInterval(tickTimer);
    tickTimer = null;
    timerEl.textContent = '';
  }

  function startTick(ms, onTick, onEnd) {
    stopTick();
    deadline = Date.now() + ms;
    const step = () => {
      const left = Math.max(0, deadline - Date.now());
      onTick(left);
      if (left <= 0) {
        stopTick();
        onEnd();
      }
    };
    tickTimer = setInterval(step, 100);
    step();
  }

  // ---- screens ----

  function resetBottom() {
    goRow.hidden = true;
    promptRow.hidden = true;
    input.disabled = true;
    input.value = '';
    hint.textContent = '';
    optionsEl.textContent = '';
    optionsEl.className = 'term-options';
  }

  function endScreen(title, text, closeMs) {
    stage = 'done';
    form = null;
    stopTick();
    resetBottom();
    titleEl.textContent = title;
    void show(text);
    closeLater(closeMs);
  }

  function offer(msg) {
    open();
    stage = 'offer';
    form = null;
    resetBottom();
    titleEl.textContent = 'CAT-BOT://BONUS';
    goRow.hidden = false;
    goBtn.disabled = false;
    void show('> INCOMING TRANSMISSION...\n\n' + clean(msg.text) + '\n\nPRESS GO TO PLAY.');
    startTick(
      GO_MS,
      (left) => {
        goBar.style.setProperty('width', (100 * left) / GO_MS + '%');
        timerEl.textContent = Math.ceil(left / 1000) + 's';
      },
      () => {
        if (stage === 'offer') {
          host.send({ type: 'mgClose' });
          endScreen('CAT-BOT://BONUS', 'SIGNAL LOST:\nMINIGAME EXPIRED.', 3000);
        }
      }
    );
  }

  goBtn.addEventListener('click', () => {
    if (stage !== 'offer') {
      return;
    }
    stage = 'connecting';
    stopTick();
    resetBottom();
    host.send({ type: 'mgGo' });
    void show('> GO\nCONNECTING...');
  });

  function question(f) {
    open();
    stage = 'question';
    form = f;
    resetBottom();
    titleEl.textContent = ((f.title || 'BONUS') + ' MINIGAME').toUpperCase();

    const choices = f.kind === 'choice' ? f.options || [] : [];
    if (choices.length) {
      const short = choices.every((o) => o.length <= 8);
      optionsEl.className = 'term-options' + (short ? ' grid' : '');
      // Grid columns as wide as the longest "25) 123456" label, so labels never wrap.
      const widest = Math.max(...choices.map((o, i) => (i + 1 + ') ' + clean(o)).length));
      optionsEl.style.setProperty('--optw', widest + 2 + 'ch');
      choices.forEach((label, i) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'term-opt';
        b.textContent = i + 1 + ') ' + clean(label);
        b.addEventListener('click', () => {
          input.value = String(i + 1);
          submit();
        });
        optionsEl.appendChild(b);
      });
    }

    promptRow.hidden = false;
    input.disabled = false;
    input.rows = f.multiline ? 3 : 1;
    input.placeholder = choices.length ? 'number' : 'answer';
    setHint();

    void show(clean(f.prompt) || 'ANSWER THE QUESTION.').then(() => optionsEl.classList.add('shown'));
    input.focus();

    startTick(
      f.timeLimitMs || 45000,
      (left) => {
        timerEl.textContent = 'T-' + Math.ceil(left / 1000) + 's';
      },
      () => {
        if (stage === 'question' || stage === 'sent') {
          host.send({ type: 'mgClose' });
          endScreen('TIME', "TIME'S UP.", 3000);
        }
      }
    );
  }

  function setHint(text) {
    if (text) {
      hint.textContent = text;
      return;
    }
    if (!form) {
      hint.textContent = '';
    } else if (form.kind === 'choice') {
      hint.textContent = 'TYPE 1-' + (form.options || []).length + ' + ENTER, OR CLICK';
    } else if (form.multiline) {
      const n = input.value.trim().length;
      hint.textContent = 'ENTER SENDS, SHIFT+ENTER = NEW LINE' + (form.minLength ? '  ' + n + '/' + form.minLength : '');
    } else {
      hint.textContent = 'TYPE YOUR ANSWER + ENTER';
    }
  }

  input.addEventListener('input', () => {
    if (stage === 'question' && form && form.multiline) {
      setHint();
    }
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !(form && form.multiline && e.shiftKey)) {
      e.preventDefault();
      submit();
    }
  });

  function submit() {
    if (stage !== 'question' || !form) {
      return;
    }
    finishTyping();
    optionsEl.classList.add('shown');
    let answer = input.value.trim();
    if (form.kind === 'choice') {
      const opts = form.options || [];
      const n = Number(answer);
      if (Number.isInteger(n) && n >= 1 && n <= opts.length) {
        answer = opts[n - 1];
      } else {
        const match = opts.find((o) => o.toLowerCase() === answer.toLowerCase());
        if (!match) {
          setHint('[!] PICK 1-' + opts.length);
          return;
        }
        answer = match;
      }
    } else if (!answer) {
      return;
    } else if (form.minLength && answer.length < form.minLength) {
      setHint('[!] NEED ' + form.minLength + '+ CHARACTERS (' + answer.length + ')');
      return;
    }
    stage = 'sent';
    input.disabled = true;
    setHint('> ' + clean(answer).slice(0, 80) + '\nTRANSMITTING...');
    host.send({ type: 'mgAnswer', answer });
  }

  // ---- messages from the extension ----

  function handle(msg) {
    if (!msg) {
      return;
    }
    switch (msg.type) {
      case 'offer':
        offer(msg);
        break;
      case 'question':
        question(msg.form || {});
        break;
      case 'submitted':
        if (stage === 'sent') {
          setHint(hint.textContent.split('\n')[0] + '\nWAITING FOR CAT BOT...');
        }
        break;
      case 'error':
        if (stage === 'sent' || stage === 'question') {
          stage = 'question';
          input.disabled = false;
          input.focus();
          setHint('[!] ' + clean(msg.text));
        }
        break;
      case 'result': {
        open();
        let text = clean(msg.text);
        if (!/^\[(OK|X)\]/.test(text)) {
          text = (msg.win ? '[OK] ' : '[X] ') + text;
        }
        endScreen(msg.win ? 'BONUS WON' : 'RESULT', text, 10000);
        break;
      }
      case 'expired':
        if (stage !== 'closed') {
          endScreen('CAT-BOT://BONUS', 'SIGNAL LOST:\nMINIGAME EXPIRED.', 3000);
        }
        break;
    }
  }

  window.catTerminal = { handle };
})();
