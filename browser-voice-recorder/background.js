const state = { recording: false, tabId: null, session: null };
const MAX_LIBRARY_ENTRIES = 50;

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason === 'install') await chrome.storage.local.set({ sessionIndex: [] });
});

chrome.commands.onCommand.addListener((command) => {
  if (command === 'toggle-recording') state.recording ? stopRecording() : startRecording();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    await hydrateState();
    if (message.type === 'GET_STATE') return { recording: state.recording, session: state.session };
    if (message.type === 'START') return startRecording(message.options || {});
    if (message.type === 'STOP') return stopRecording();
    if (message.type === 'GET_LIBRARY') {
      const { sessionIndex, latestSessionId } = await chrome.storage.local.get(['sessionIndex', 'latestSessionId']);
      return { index: sessionIndex || [], latestSessionId: latestSessionId || null };
    }
    if (message.type === 'GET_SESSION') {
      const key = `session:${message.id}`;
      const stored = await chrome.storage.local.get(key);
      return { session: stored[key] || null };
    }
    if (message.type === 'DELETE_SESSION') {
      await deleteSessionFromLibrary(message.id);
      return { ok: true };
    }
    if (message.type === 'EVENT' && state.recording && sender.tab?.id === state.tabId) {
      const offsetMs = Date.now() - state.session.startedAt;
      if (message.event.action === 'narration') {
        state.session.transcript.push({ text: message.event.value, offsetMs });
      } else {
        const step = { ...message.event, offsetMs };
        step.screenshot = await captureStepScreenshot(sender.tab);
        state.session.steps.push(step);
      }
      // Persisted under its own key (not just the crash-recovery activeSession blob) so the
      // review page can load an in-progress session if it's opened mid-recording.
      await chrome.storage.local.set({ [`session:${state.session.id}`]: state.session });
      await persistActiveState();
      return { ok: true };
    }
  })().then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});

// Chrome throttles captureVisibleTab to roughly one call per second per window.
let lastCaptureAt = 0;
async function captureStepScreenshot(tab) {
  if (!tab?.windowId) return null;
  const wait = 1050 - (Date.now() - lastCaptureAt);
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastCaptureAt = Date.now();
  try {
    return await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 70 });
  } catch (error) {
    console.warn('Screenshot capture skipped', error);
    return null;
  }
}

async function hydrateState() {
  if (state.recording) return;
  const { activeSession } = await chrome.storage.local.get('activeSession');
  if (!activeSession) return;
  state.recording = true;
  state.tabId = activeSession.tabId;
  state.session = activeSession.session;
}

async function persistActiveState() {
  if (!state.recording) return chrome.storage.local.remove('activeSession');
  return chrome.storage.local.set({ activeSession: { tabId: state.tabId, session: state.session } });
}

// The recordings library is a small index (title/step count/size) plus one storage key per full
// session, so the review page's sidebar can list everything without loading every screenshot.
async function saveSessionToLibrary(session) {
  const key = `session:${session.id}`;
  await chrome.storage.local.set({ [key]: session });
  const { sessionIndex } = await chrome.storage.local.get('sessionIndex');
  const index = (sessionIndex || []).filter((entry) => entry.id !== session.id);
  index.unshift({
    id: session.id,
    title: session.title,
    stepCount: session.steps.length,
    sizeBytes: JSON.stringify(session).length,
    startedAt: session.startedAt,
  });
  const overflow = index.splice(MAX_LIBRARY_ENTRIES);
  await Promise.all(overflow.map((entry) => chrome.storage.local.remove(`session:${entry.id}`)));
  await chrome.storage.local.set({ sessionIndex: index, latestSessionId: session.id });
}

async function deleteSessionFromLibrary(id) {
  const { sessionIndex, latestSessionId } = await chrome.storage.local.get(['sessionIndex', 'latestSessionId']);
  await chrome.storage.local.remove(`session:${id}`);
  await chrome.storage.local.set({ sessionIndex: (sessionIndex || []).filter((entry) => entry.id !== id) });
  if (latestSessionId === id) await chrome.storage.local.remove('latestSessionId');
}

async function startRecording(options = {}) {
  if (state.recording) return { ok: false, error: 'A recording is already running.' };
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !/^https?:/.test(tab.url || '')) throw new Error('Open a normal web page before recording.');
  // allFrames is required so clicks inside same-origin AND cross-origin iframes are captured too —
  // many interactive apps (canvas/design tools, embedded editors) render their real UI in an iframe,
  // and a main-frame-only injection would silently record zero steps for the whole session.
  await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ['content.js'] });
  const id = crypto.randomUUID();
  const includeVoice = options.includeVoice !== false;
  state.recording = true;
  state.tabId = tab.id;
  state.session = { id, title: options.title || tab.title || 'Browser workflow', startedAt: Date.now(), startUrl: tab.url, includeVoice, steps: [], transcript: [] };
  await chrome.storage.local.set({ [`session:${id}`]: state.session, recordingTabId: tab.id });
  await persistActiveState();
  await chrome.tabs.sendMessage(tab.id, { type: 'RECORDER_STATE', recording: true, includeVoice });
  await chrome.action.setBadgeText({ text: 'REC', tabId: tab.id });
  await chrome.action.setBadgeBackgroundColor({ color: '#dc2626', tabId: tab.id });
  return { ok: true, session: state.session };
}

async function stopRecording() {
  await hydrateState();
  if (!state.recording) return { ok: false, error: 'No recording is running.' };
  const tabId = state.tabId;
  state.session.endedAt = Date.now();
  state.session.durationMs = state.session.endedAt - state.session.startedAt;
  await saveSessionToLibrary(state.session);
  try { await chrome.tabs.sendMessage(tabId, { type: 'RECORDER_STATE', recording: false }); } catch {}
  await chrome.action.setBadgeText({ text: '', tabId });
  state.recording = false;
  state.tabId = null;
  const session = state.session;
  state.session = null;
  await persistActiveState();
  await chrome.tabs.create({ url: chrome.runtime.getURL('review.html') });
  return { ok: true, session };
}
