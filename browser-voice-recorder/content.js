(() => {
  if (window.__workflowVoiceRecorderLoaded) return;
  window.__workflowVoiceRecorderLoaded = true;
  let recording = false;
  let lastUrl = location.href;
  let recognizer = null;

  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'RECORDER_STATE') {
      recording = message.recording;
      recording && message.includeVoice ? startNarration() : stopNarration();
    }
  });

  const send = (event) => recording && chrome.runtime.sendMessage({ type: 'EVENT', event: { url: location.href, ...event } });

  function startNarration() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition || recognizer) return;
    recognizer = new SpeechRecognition();
    recognizer.continuous = true;
    recognizer.interimResults = false;
    recognizer.lang = navigator.language || 'en-US';
    recognizer.onresult = (event) => {
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) send({ action: 'narration', value: result[0].transcript.trim() });
      }
    };
    recognizer.onerror = () => {};
    recognizer.onend = () => { if (recording && recognizer) { try { recognizer.start(); } catch {} } };
    try { recognizer.start(); } catch {}
  }

  function stopNarration() {
    if (!recognizer) return;
    const active = recognizer;
    recognizer = null;
    try { active.onend = null; active.stop(); } catch {}
  }
  const cssEscape = (value) => CSS.escape(String(value));
  function selector(el) {
    if (!(el instanceof Element)) return 'body';
    if (el.id) return `#${cssEscape(el.id)}`;
    const testId = el.getAttribute('data-testid') || el.getAttribute('data-test');
    if (testId) return `[data-testid="${cssEscape(testId)}"]`;
    if (el.getAttribute('aria-label')) return `${el.tagName.toLowerCase()}[aria-label="${cssEscape(el.getAttribute('aria-label'))}"]`;
    const parts = [];
    for (let node = el; node && node !== document.body && parts.length < 5; node = node.parentElement) {
      let part = node.tagName.toLowerCase();
      const siblings = node.parentElement ? [...node.parentElement.children].filter((x) => x.tagName === node.tagName) : [];
      if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
      parts.unshift(part);
    }
    return parts.join(' > ');
  }
  const nameOf = (el) => el.getAttribute?.('aria-label') || el.innerText?.trim().replace(/\s+/g, ' ').slice(0, 80) || el.getAttribute?.('name') || '';
  const sensitive = (el) => el.matches?.('input[type=password],input[autocomplete*=password],input[autocomplete*=cc-]');

  document.addEventListener('click', (e) => send({ action: 'click', selector: selector(e.target), name: nameOf(e.target), tag: e.target.tagName?.toLowerCase() }), true);
  document.addEventListener('change', (e) => {
    const el = e.target;
    if (!el.matches?.('input,textarea,select')) return;
    send({ action: el.tagName === 'SELECT' ? 'select' : 'fill', selector: selector(el), name: nameOf(el), value: sensitive(el) ? '<REDACTED>' : el.value });
  }, true);
  document.addEventListener('keydown', (e) => {
    if (['Enter', 'Escape', 'Tab'].includes(e.key)) send({ action: 'key', selector: selector(e.target), key: e.key });
  }, true);
  document.addEventListener('submit', (e) => send({ action: 'submit', selector: selector(e.target) }), true);
  const observeUrl = () => {
    if (location.href !== lastUrl) { lastUrl = location.href; send({ action: 'navigate', value: lastUrl }); }
  };
  setInterval(observeUrl, 500);
})();
