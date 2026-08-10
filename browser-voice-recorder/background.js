const state = { recording: false, tabId: null, session: null };
const MAX_LIBRARY_ENTRIES = 50;
// Writing the whole (growing) session blob to storage on every single click scales O(n^2) with
// step count — by step 200 that's re-serializing and re-writing 200 screenshots just to add one
// more. That's the likely cause of the extension becoming unresponsive on long recordings, so the
// crash-recovery checkpoint is throttled instead of firing on every event.
const CHECKPOINT_INTERVAL_MS = 4000;
let lastCheckpointAt = 0;

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason === 'install') await chrome.storage.local.set({ sessionIndex: [] });
});

chrome.commands.onCommand.addListener((command) => {
  if (command === 'toggle-recording') state.recording ? stopRecording() : startRecording();
});

// If the recorded tab is closed or crashes mid-recording, nothing would otherwise clear
// `activeSession`/the recording flag — the popup would show "Stop and export" indefinitely with
// no tab left to message. Finalize and save whatever was captured instead.
chrome.tabs.onRemoved.addListener(async (tabId) => {
  await hydrateState();
  if (state.recording && state.tabId === tabId) await stopRecording();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    await hydrateState();
    if (message.type === 'GET_STATE') return { recording: state.recording, stepCount: state.session?.steps.length ?? 0 };
    if (message.type === 'START') return startRecording(message.options || {});
    if (message.type === 'STOP') return stopRecording();
    if (message.type === 'FORCE_RESET') return forceReset();
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
      await checkpoint();
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

// Persists just enough for a killed/restarted service worker to recover the in-progress
// recording. `force` bypasses the throttle for the initial write and the final save at stop time,
// so no data is ever actually lost — only the crash-recovery checkpoint granularity is coarsened.
async function checkpoint(force = false) {
  const now = Date.now();
  if (!force && now - lastCheckpointAt < CHECKPOINT_INTERVAL_MS) return;
  lastCheckpointAt = now;
  try {
    await chrome.storage.local.set({
      [`session:${state.session.id}`]: state.session,
      activeSession: { tabId: state.tabId, sessionId: state.session.id },
    });
  } catch (error) {
    console.warn('Checkpoint skipped', error);
  }
}

async function clearActiveState() {
  return chrome.storage.local.remove('activeSession');
}

async function hydrateState() {
  if (state.recording) return;
  const { activeSession } = await chrome.storage.local.get('activeSession');
  if (!activeSession) return;
  const key = `session:${activeSession.sessionId}`;
  const stored = await chrome.storage.local.get(key);
  if (!stored[key]) { await clearActiveState(); return; }
  state.recording = true;
  state.tabId = activeSession.tabId;
  state.session = stored[key];
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
  lastCheckpointAt = 0;
  await checkpoint(true);
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
  try { await chrome.action.setBadgeText({ text: '', tabId }); } catch {}
  state.recording = false;
  state.tabId = null;
  const session = state.session;
  state.session = null;
  await clearActiveState();
  await chrome.tabs.create({ url: chrome.runtime.getURL('review.html') });
  return { ok: true, session };
}

// Manual escape hatch for when recording state is stuck (e.g. the service worker wedged on a
// slow write, or something else went wrong) — best-effort save whatever was captured and fully
// clear state, without requiring the user to refresh the whole browser.
async function forceReset() {
  await hydrateState();
  if (state.recording && state.session?.steps?.length) {
    state.session.endedAt = Date.now();
    state.session.durationMs = state.session.endedAt - state.session.startedAt;
    try { await saveSessionToLibrary(state.session); } catch (error) { console.warn('Force-reset save failed', error); }
  }
  const tabId = state.tabId;
  state.recording = false;
  state.tabId = null;
  state.session = null;
  await clearActiveState();
  if (tabId != null) {
    try { await chrome.action.setBadgeText({ text: '', tabId }); } catch {}
  }
  return { ok: true };
}
