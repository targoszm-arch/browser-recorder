# Workflow Voice Recorder

An installable Chrome/Chromium Manifest V3 extension that records a browser workflow — clicks, form
input, navigation — with an automatic screenshot per step and live speech-to-text narration, then lets
you edit and export it as:

- A formatted, self-contained step-by-step **HTML guide** (screenshots embedded inline)
- A **Markdown** guide (`.md`)
- A plain-text guide (`.txt`)
- A **Playwright** test (`.spec.ts`)
- A **Chrome DevTools Recorder** flow (`.devtools.json`)

Everything stays local — no server, no account, no uploaded recordings. Password and payment-card
fields are redacted. No audio or video file is produced; spoken narration is transcribed to text only,
using the browser's built-in Web Speech API.

## Install (load unpacked)

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top right).
3. Choose **Load unpacked** and select this `browser-voice-recorder` folder.
4. Pin **Workflow Voice Recorder** from the extensions toolbar menu.
5. Open a normal `http(s)://` page, click the extension icon, optionally set a title, leave
   **Transcribe voice narration while recording** checked, and click **Start recording**.
6. Narrate what you're doing out loud as you click through the workflow — each action captures a
   screenshot automatically, and Chrome will prompt for microphone access the first time.
7. Click the extension icon again and choose **Stop and export**. A review tab opens.

After editing the workflow, use the buttons on the review tab to export it.

## Formatting the workflow before export

The review tab lists every recorded step with its screenshot, an editable title, and an editable
description (pre-filled from whatever was transcribed near that step, if anything was said). From
there you can:

- Rewrite any step's title or narration
- Reorder steps with the ↑ / ↓ buttons
- Remove steps that shouldn't appear in the guide
- Set the guide's title, intro paragraph and outro paragraph

Then export with **Export HTML Guide**, **Export Markdown**, or **Export Text** — all three follow the
same structure: a title, an intro, one section per step (step number, title, narration, screenshot),
and an outro. **Export Playwright** and **Export DevTools JSON** turn the same recorded actions into
automation scripts instead.

## Current scope

The recorder captures clicks, changed form values, select changes, Enter/Escape/Tab keys, submissions,
and same-tab URL changes, in the page and in every iframe on it (so canvas/design tools and embedded
editors are covered, not just the top-level document), each paired with a screenshot of the visible tab
at that moment. It masks password and credit-card autocomplete fields. Narration transcription requires
a Chromium build with the Web Speech API (`webkitSpeechRecognition`) and an active microphone permission
grant for the page (only requested once, from the top frame); if unavailable, steps simply have no
pre-filled description and can be typed in manually.

## Troubleshooting

**"0 steps" after stopping a recording** — the session (title/duration/URL) is saved but no clicks were
captured. Usually one of:

- The page's interactive content lives inside a `<canvas>`-based widget that doesn't dispatch real
  `click`/`change` DOM events (rare, but some drag-only design tools do this).
- The extension was reloaded/updated in `chrome://extensions` *after* the tab was already open — Chrome
  won't re-inject a fresh content script into an existing tab. Refresh the target page after updating the
  extension, then start recording again.
- You recorded on a `chrome://`, `chrome-extension://`, or Chrome Web Store page — these are off-limits
  to content scripts by design; use a normal `http(s)://` page.

## Production hardening backlog

- IndexedDB session store and recovery after service-worker restart
- File upload, drag/drop, native dialog and shadow-DOM handling
- Locator scoring with role/text/test-id fallbacks
- Drag-and-drop step reordering and thumbnail re-cropping in the review UI
- Automated Chrome Web Store packaging, privacy disclosures and end-to-end tests
