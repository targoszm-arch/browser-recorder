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

## The review page

**Recordings sidebar.** Every completed recording is saved to a local library (`chrome.storage.local`,
capped at the 50 most recent — older ones are pruned automatically) and listed on the left, newest
first, with step count and file size. Click any entry to load it back into the editor; the **×** that
appears on hover deletes it. Nothing here ever leaves the browser.

**Formatting a step.** Each step shows a large screenshot — click it to open a full-size zoom view, or
click **Upload image** / **Replace image** to swap in your own file instead (nothing is uploaded
anywhere; it's read locally and embedded the same way a captured screenshot is) — an action badge
(`CLICK`, `FILL`, `SELECT`, …), an editable title, and an editable narration. The title defaults to the
first sentence of whatever was said near that step, if anything was; only when there's no narration does
it fall back to a mechanical description built from the action (e.g. "Click the button"), and it never
surfaces the raw recorded selector. Below that:

- **Sensitive** — check this to redact the step's captured value (`<REDACTED>`) in every export,
  the same way password/credit-card fields are redacted automatically during recording.
- **URL** — the page (or iframe) the action happened on.
- **Locator** (collapsible) — the CSS-ish selector the recorder captured, plus the element's
  accessible name/tag when available.

Reorder steps with **Move up** / **Move down**, or **Delete** ones that shouldn't appear in the export —
do this before exporting or generating a bug report, since both are built from the current step list.

**Exporting.** Above the step list, choose **Export as**: **Step-by-step guide** (title, intro, one
section per step, outro) or **Bug report** (Description of the bug, an auto-numbered Steps to Reproduce
built from the current step titles, and Expected behavior). The bug report's Description field is
pre-filled by joining all narration captured during the recording — edit it freely. **Export HTML** is
the primary action; **More formats** opens Markdown, Text, Playwright, and DevTools JSON — all of which
follow whichever export type is currently selected (Playwright/DevTools JSON are automation scripts and
are unaffected by it).

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
- Recording through native OS file-picker dialogs, drag/drop, and shadow-DOM interactions on the
  target page (unrelated to the review page's manual screenshot upload, which already works)
- Locator scoring with role/text/test-id fallbacks
- Drag-and-drop step reordering and thumbnail re-cropping in the review UI
- Automated Chrome Web Store packaging, privacy disclosures and end-to-end tests
