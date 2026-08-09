let session = null;
let libraryIndex = [];
let latestSessionId = null;
let pendingUploadIndex = null;

const q = (value) => JSON.stringify(value ?? '');
const slug = (value) => (value || 'workflow').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
const escapeHtml = (value) => { const el = document.createElement('span'); el.textContent = value ?? ''; return el.innerHTML; };
const ACTION_LABELS = { click: 'Click', fill: 'Fill', select: 'Select', key: 'Key', submit: 'Submit', navigate: 'Navigation' };
const actionLabel = (step) => (ACTION_LABELS[step.action] || step.action || '').toUpperCase();
const effectiveValue = (step) => (step.sensitive ? '<REDACTED>' : step.value);

function formatBytes(n) {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = n, i = 0;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i++; }
  return `${i > 0 && value < 10 ? value.toFixed(1) : Math.round(value)} ${units[i]}`;
}

function playwright(s) {
  const lines = [`import { test, expect } from '@playwright/test';`, '', `test(${q(s.title)}, async ({ page }) => {`, `  await page.goto(${q(s.startUrl)});`];
  for (const step of s.steps) {
    const value = effectiveValue(step);
    if (step.action === 'click') lines.push(`  await page.locator(${q(step.selector)}).click();`);
    if (step.action === 'fill' && value !== '<REDACTED>') lines.push(`  await page.locator(${q(step.selector)}).fill(${q(value)});`);
    if (step.action === 'fill' && value === '<REDACTED>') lines.push(`  await page.locator(${q(step.selector)}).fill(process.env.RECORDED_SECRET ?? '');`);
    if (step.action === 'select') lines.push(`  await page.locator(${q(step.selector)}).selectOption(${q(value)});`);
    if (step.action === 'key') lines.push(`  await page.locator(${q(step.selector)}).press(${q(step.key)});`);
    if (step.action === 'navigate') lines.push(`  await page.waitForURL(${q(step.value)});`);
  }
  return [...lines, '});', ''].join('\n');
}

function devtools(s) {
  const steps = [{ type: 'navigate', url: s.startUrl, assertedEvents: [{ type: 'navigation', url: s.startUrl, title: s.title }] }];
  for (const step of s.steps) {
    const selectors = [[step.selector || 'body']];
    const value = effectiveValue(step);
    if (step.action === 'click') steps.push({ type: 'click', target: 'main', selectors, offsetX: 1, offsetY: 1 });
    if (step.action === 'fill') steps.push({ type: 'change', value: value === '<REDACTED>' ? '' : value, selectors, target: 'main' });
    if (step.action === 'select') steps.push({ type: 'change', value, selectors, target: 'main' });
    if (step.action === 'key') steps.push({ type: 'keyDown', key: step.key, target: 'main' });
    if (step.action === 'navigate') steps.push({ type: 'navigate', url: step.value });
  }
  return JSON.stringify({ title: s.title, steps }, null, 2);
}

// Never surface the raw recorded selector in a human-facing title — a nameless element falls
// back to its tag ("the button") rather than dumping something like "div > div:nth-of-type(6)".
function labelOf(step) {
  return step.name || effectiveValue(step) || (step.tag ? `the ${step.tag}` : 'an element');
}

function autoTitle(step) {
  const value = effectiveValue(step);
  switch (step.action) {
    case 'click': return `Click ${labelOf(step)}.`;
    case 'fill': return value === '<REDACTED>' ? `Fill in ${labelOf(step)}.` : `Type "${value}" into ${labelOf(step)}.`;
    case 'select': return `Select "${value}" from ${labelOf(step)}.`;
    case 'key': return `Press ${step.key} on ${labelOf(step)}.`;
    case 'submit': return `Submit the form.`;
    case 'navigate': return `Navigate to ${step.value}.`;
    default: return `Interact with ${labelOf(step)}.`;
  }
}

// Prefer a title derived from what was actually said over the mechanical action description —
// narration reads like "click the close icon to exit settings", which is a far better title than
// a selector-based fallback could ever produce.
function titleFromNarration(narration) {
  const trimmed = (narration || '').trim();
  if (!trimmed) return null;
  const firstSentence = trimmed.split(/(?<=[.!?])\s+/)[0];
  return firstSentence.length > 100 ? `${firstSentence.slice(0, 97).trim()}…` : firstSentence;
}

function defaultTitleFor(step, narration) {
  return titleFromNarration(narration) || autoTitle(step);
}

// The narration transcript is timestamped speech-to-text picked up while the user talked
// through the workflow; whatever was said between the previous step and this one (plus a
// short trailing window) becomes that step's default description.
function narrationFor(step, index) {
  const prevOffset = index > 0 ? session.steps[index - 1].offsetMs : -Infinity;
  return (session.transcript || [])
    .filter((t) => t.offsetMs > prevOffset && t.offsetMs <= step.offsetMs + 4000)
    .map((t) => t.text)
    .join(' ');
}

function render() {
  document.querySelector('#title').textContent = session.title;
  document.querySelector('#meta').textContent = `${session.steps.length} steps · ${Math.round((session.durationMs || 0) / 1000)} seconds · ${session.startUrl}`;
  document.querySelector('#docTitle').value = session.title;
  const list = document.querySelector('#steps');
  const total = session.steps.length;
  list.innerHTML = session.steps.map((step, i) => {
    const desc = step.editDesc ?? (step.editDesc = narrationFor(step, i));
    const title = step.editTitle ?? (step.editTitle = defaultTitleFor(step, desc));
    return `
    <li class="step-edit" data-index="${i}">
      <div class="step-shot">
        ${step.screenshot
          ? `<img class="zoomable" src="${step.screenshot}" alt="${escapeHtml(title)}"><span class="zoom-hint">🔍 Click to enlarge</span>`
          : `<div class="no-shot">No screenshot</div>`}
        <button type="button" class="upload-shot" data-act="upload">⤴ ${step.screenshot ? 'Replace image' : 'Upload image'}</button>
      </div>
      <div class="step-body">
        <div class="step-eyebrow">
          <span class="step-badge">${escapeHtml(actionLabel(step))}</span>
          <span class="step-count">Step ${i + 1} of ${total}</span>
        </div>
        <label>Title<input type="text" class="step-title" value="${escapeHtml(title)}"></label>
        <label>Narration (from voice transcription)<textarea class="step-desc" rows="2" placeholder="Say what you're doing while recording, or type it here">${escapeHtml(desc)}</textarea></label>
        <label class="chip-toggle"><input type="checkbox" class="step-sensitive" ${step.sensitive ? 'checked' : ''}> Sensitive (redact value in exports)</label>
        ${step.url ? `<div class="step-url"><span>URL</span><code>${escapeHtml(step.url)}</code></div>` : ''}
        <details class="locator">
          <summary>Locator</summary>
          <div class="locator-body">
            <div><span>Selector</span><code>${escapeHtml(step.selector || '—')}</code></div>
            ${step.name ? `<div><span>Name</span><code>${escapeHtml(step.name)}</code></div>` : ''}
            ${step.tag ? `<div><span>Tag</span><code>${escapeHtml(step.tag)}</code></div>` : ''}
          </div>
        </details>
        <div class="step-actions">
          <button data-act="up">Move up</button>
          <button data-act="down">Move down</button>
          <button data-act="remove" class="danger">Delete</button>
        </div>
      </div>
    </li>`;
  }).join('');
}

function bindListEvents() {
  const list = document.querySelector('#steps');
  list.addEventListener('input', (e) => {
    const li = e.target.closest('.step-edit');
    if (!li) return;
    const step = session.steps[Number(li.dataset.index)];
    if (e.target.classList.contains('step-title')) step.editTitle = e.target.value;
    if (e.target.classList.contains('step-desc')) step.editDesc = e.target.value;
    if (e.target.classList.contains('step-sensitive')) step.sensitive = e.target.checked;
  });
  list.addEventListener('click', (e) => {
    const uploadBtn = e.target.closest('.upload-shot');
    if (uploadBtn) {
      pendingUploadIndex = Number(uploadBtn.closest('.step-edit').dataset.index);
      document.querySelector('#stepImageInput').click();
      return;
    }
    const img = e.target.closest('img.zoomable');
    if (img) {
      const index = Number(img.closest('.step-edit').dataset.index);
      openLightbox(session.steps[index].screenshot, img.alt, index);
      return;
    }
    const button = e.target.closest('button[data-act]');
    if (!button) return;
    const li = button.closest('.step-edit');
    const index = Number(li.dataset.index);
    if (button.dataset.act === 'remove') session.steps.splice(index, 1);
    if (button.dataset.act === 'up' && index > 0) [session.steps[index - 1], session.steps[index]] = [session.steps[index], session.steps[index - 1]];
    if (button.dataset.act === 'down' && index < session.steps.length - 1) [session.steps[index + 1], session.steps[index]] = [session.steps[index], session.steps[index + 1]];
    render();
  });
}

// --- Manual screenshot upload (replaces or fills in a step's image; recording itself never
// prompts for this — it's an explicit edit made from the review page) ---

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function bindImageUpload() {
  document.querySelector('#stepImageInput').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file || pendingUploadIndex == null || !session) return;
    session.steps[pendingUploadIndex].screenshot = await fileToDataUrl(file);
    pendingUploadIndex = null;
    render();
  });
}

// --- Zoom + annotation lightbox. Opens on a screenshot click; annotations only ever touch the
// step's screenshot when "Save annotation" is clicked — closing any other way discards them. ---

let lightboxStepIndex = null;
let annotationHistory = [];
let annotationBaseImage = null;
let annotationTool = 'pen';
let annotationColor = '#ff3b30';
let annotationWidth = 4;
let annotationDrawing = false;
let annotationDragStart = null;
let annotationCurrentStroke = null;

function openLightbox(src, alt, index) {
  lightboxStepIndex = index ?? null;
  annotationHistory = [];
  annotationBaseImage = null;
  document.querySelector('#lightbox').classList.remove('hidden');
  const img = new Image();
  img.onload = () => {
    annotationBaseImage = img;
    const canvas = document.querySelector('#lightboxCanvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    canvas.setAttribute('aria-label', alt || '');
    redrawAnnotationCanvas();
  };
  img.src = src;
}

function closeLightbox() {
  document.querySelector('#lightbox').classList.add('hidden');
  lightboxStepIndex = null;
  annotationHistory = [];
  annotationBaseImage = null;
}

function redrawAnnotationCanvas(preview) {
  const canvas = document.querySelector('#lightboxCanvas');
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (annotationBaseImage) ctx.drawImage(annotationBaseImage, 0, 0, canvas.width, canvas.height);
  for (const item of annotationHistory) drawAnnotationItem(ctx, item);
  if (preview) drawAnnotationItem(ctx, preview);
}

function drawAnnotationItem(ctx, item) {
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.globalAlpha = 1;
  if (item.type === 'pen' || item.type === 'highlighter') {
    ctx.strokeStyle = item.color;
    ctx.lineWidth = item.width;
    ctx.globalAlpha = item.type === 'highlighter' ? 0.35 : 1;
    ctx.beginPath();
    item.points.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
    ctx.stroke();
    ctx.globalAlpha = 1;
  } else if (item.type === 'rect') {
    ctx.strokeStyle = item.color;
    ctx.lineWidth = item.width;
    ctx.strokeRect(item.x, item.y, item.w, item.h);
  } else if (item.type === 'arrow') {
    drawAnnotationArrow(ctx, item);
  } else if (item.type === 'text') {
    ctx.fillStyle = item.color;
    ctx.font = `700 ${item.size}px -apple-system, BlinkMacSystemFont, sans-serif`;
    ctx.textBaseline = 'top';
    ctx.fillText(item.text, item.x, item.y);
  }
}

function drawAnnotationArrow(ctx, { x1, y1, x2, y2, color, width }) {
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const headLen = Math.max(12, width * 3);
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - headLen * Math.cos(angle - Math.PI / 6), y2 - headLen * Math.sin(angle - Math.PI / 6));
  ctx.lineTo(x2 - headLen * Math.cos(angle + Math.PI / 6), y2 - headLen * Math.sin(angle + Math.PI / 6));
  ctx.closePath();
  ctx.fill();
}

function annotationCanvasPoint(e) {
  const canvas = document.querySelector('#lightboxCanvas');
  const rect = canvas.getBoundingClientRect();
  return [(e.clientX - rect.left) * (canvas.width / rect.width), (e.clientY - rect.top) * (canvas.height / rect.height)];
}

function placeTextAnnotation(x, y) {
  const text = window.prompt('Annotation text:');
  if (!text || !text.trim()) return;
  annotationHistory.push({ type: 'text', color: annotationColor, size: Math.max(18, annotationWidth * 6), text: text.trim(), x, y });
  redrawAnnotationCanvas();
}

function bindAnnotationCanvas() {
  const canvas = document.querySelector('#lightboxCanvas');
  canvas.addEventListener('pointerdown', (e) => {
    const [x, y] = annotationCanvasPoint(e);
    if (annotationTool === 'text') { placeTextAnnotation(x, y); return; }
    annotationDrawing = true;
    annotationDragStart = [x, y];
    if (annotationTool === 'pen' || annotationTool === 'highlighter') {
      annotationCurrentStroke = { type: annotationTool, color: annotationColor, width: annotationWidth, points: [[x, y]] };
    }
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!annotationDrawing) return;
    const [x, y] = annotationCanvasPoint(e);
    if (annotationTool === 'pen' || annotationTool === 'highlighter') {
      annotationCurrentStroke.points.push([x, y]);
      redrawAnnotationCanvas(annotationCurrentStroke);
    } else if (annotationTool === 'rect') {
      annotationCurrentStroke = {
        type: 'rect', color: annotationColor, width: annotationWidth,
        x: Math.min(annotationDragStart[0], x), y: Math.min(annotationDragStart[1], y),
        w: Math.abs(x - annotationDragStart[0]), h: Math.abs(y - annotationDragStart[1]),
      };
      redrawAnnotationCanvas(annotationCurrentStroke);
    } else if (annotationTool === 'arrow') {
      annotationCurrentStroke = { type: 'arrow', color: annotationColor, width: annotationWidth, x1: annotationDragStart[0], y1: annotationDragStart[1], x2: x, y2: y };
      redrawAnnotationCanvas(annotationCurrentStroke);
    }
  });
  canvas.addEventListener('pointerup', () => {
    if (!annotationDrawing) return;
    annotationDrawing = false;
    if (annotationCurrentStroke) { annotationHistory.push(annotationCurrentStroke); annotationCurrentStroke = null; }
    redrawAnnotationCanvas();
  });
}

function saveAnnotation() {
  if (lightboxStepIndex == null || !session) { closeLightbox(); return; }
  const canvas = document.querySelector('#lightboxCanvas');
  session.steps[lightboxStepIndex].screenshot = canvas.toDataURL('image/jpeg', 0.92);
  closeLightbox();
  render();
}

function bindLightbox() {
  document.querySelector('#lightboxClose').addEventListener('click', closeLightbox);
  document.querySelector('#lightbox').addEventListener('click', (e) => {
    if (e.target.id === 'lightbox' || e.target.classList.contains('lightbox-canvas-wrap')) closeLightbox();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !document.querySelector('#lightbox').classList.contains('hidden')) closeLightbox();
  });
  document.querySelectorAll('.tool-btn').forEach((btn) => btn.addEventListener('click', () => {
    annotationTool = btn.dataset.tool;
    document.querySelectorAll('.tool-btn').forEach((b) => b.classList.toggle('active', b === btn));
  }));
  document.querySelector('#annotationColor').addEventListener('input', (e) => { annotationColor = e.target.value; });
  document.querySelector('#annotationWidth').addEventListener('change', (e) => { annotationWidth = Number(e.target.value); });
  document.querySelector('#annotationUndo').addEventListener('click', () => { annotationHistory.pop(); redrawAnnotationCanvas(); });
  document.querySelector('#annotationClear').addEventListener('click', () => { annotationHistory = []; redrawAnnotationCanvas(); });
  document.querySelector('#annotationSave').addEventListener('click', saveAnnotation);
  bindAnnotationCanvas();
}

function bindFormatsMenu() {
  const button = document.querySelector('#moreFormatsBtn');
  const menu = document.querySelector('#moreFormatsMenu');
  button.addEventListener('click', (e) => { e.stopPropagation(); menu.classList.toggle('hidden'); });
  menu.addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', () => menu.classList.add('hidden'));
}

// --- Recordings library (sidebar) ---

async function loadLibrary() {
  const res = await chrome.runtime.sendMessage({ type: 'GET_LIBRARY' });
  libraryIndex = res.index || [];
  latestSessionId = res.latestSessionId || null;
  renderLibrary();
}

function renderLibrary() {
  const list = document.querySelector('#libraryList');
  if (!libraryIndex.length) {
    list.innerHTML = `<p class="muted library-empty">No recordings yet.</p>`;
    return;
  }
  list.innerHTML = libraryIndex.map((entry) => `
    <div class="library-item ${session?.id === entry.id ? 'active' : ''}" data-id="${entry.id}">
      <button class="library-select" data-id="${entry.id}">
        <span class="library-title">${escapeHtml(entry.title)}</span>
        <span class="library-meta">${entry.stepCount} steps · ${formatBytes(entry.sizeBytes)}</span>
      </button>
      <button class="library-delete" data-id="${entry.id}" title="Delete recording">×</button>
    </div>`).join('');
}

function bindLibraryEvents() {
  document.querySelector('#libraryList').addEventListener('click', async (e) => {
    const del = e.target.closest('.library-delete');
    if (del) {
      e.stopPropagation();
      const deletedId = del.dataset.id;
      const wasActive = session?.id === deletedId;
      await chrome.runtime.sendMessage({ type: 'DELETE_SESSION', id: deletedId });
      await loadLibrary();
      if (wasActive) {
        if (libraryIndex.length) await selectSession(libraryIndex[0].id);
        else { session = null; showEmptyState(); }
      }
      return;
    }
    const item = e.target.closest('.library-item');
    if (item) await selectSession(item.dataset.id);
  });
}

async function selectSession(id) {
  const res = await chrome.runtime.sendMessage({ type: 'GET_SESSION', id });
  if (!res.session) { session = null; showEmptyState(); return; }
  session = res.session;
  session.transcript = session.transcript || [];
  document.querySelector('.exports').style.display = '';
  document.querySelector('#formatting').style.display = '';
  document.querySelector('#docIntro').value = `Follow these steps to complete: ${session.title}.`;
  document.querySelector('#docOutro').value = `You've successfully completed ${session.title}.`;
  document.querySelector('#bugDescription').value = (session.transcript || []).map((t) => t.text).join(' ').trim();
  document.querySelector('#bugExpected').value = '';
  render();
  renderLibrary();
}

function showEmptyState() {
  document.querySelector('#title').textContent = libraryIndex.length ? 'Select a recording' : 'No recordings yet';
  document.querySelector('#meta').textContent = '';
  document.querySelector('.exports').style.display = 'none';
  document.querySelector('#formatting').style.display = 'none';
  document.querySelector('#steps').innerHTML = '';
}

// --- Shared export document parts ---

function docParts() {
  const title = document.querySelector('#docTitle').value.trim() || session.title;
  const intro = document.querySelector('#docIntro').value.trim();
  const outro = document.querySelector('#docOutro').value.trim();
  const steps = session.steps.map((step) => ({
    title: step.editTitle || defaultTitleFor(step, step.editDesc),
    description: step.editDesc || '',
    screenshot: step.screenshot || null,
  }));
  return { title, intro, outro, steps };
}

function bugReportParts() {
  const title = document.querySelector('#docTitle').value.trim() || session.title;
  const description = document.querySelector('#bugDescription').value.trim();
  const expected = document.querySelector('#bugExpected').value.trim();
  const steps = session.steps.map((step) => ({
    title: step.editTitle || defaultTitleFor(step, step.editDesc),
    screenshot: step.screenshot || null,
  }));
  return { title, description, expected, steps };
}

const EXPORT_STYLE = `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    background: #f8f9fb; color: #1a1a2e; line-height: 1.6;
    -webkit-font-smoothing: antialiased;
  }
  .container { max-width: 720px; margin: 0 auto; padding: 48px 24px 64px; }
  h1 {
    font-size: 28px; font-weight: 700; letter-spacing: -0.02em;
    margin-bottom: 8px; color: #111;
  }
  .subtitle { font-size: 14px; color: #888; margin-bottom: 40px; }
  .intro, .outro {
    background: #fff; border: 1px solid #e8e8ec; border-radius: 12px;
    padding: 24px; margin-bottom: 20px;
  }
  .intro h2, .outro h2 { font-size: 18px; font-weight: 600; margin-bottom: 8px; color: #111; }
  .intro p, .outro p { font-size: 15px; color: #555; }
  .outro { margin-top: 12px; background: linear-gradient(135deg, #f0f4ff, #faf0ff); border-color: #e0d8f0; }
  .step {
    background: #fff; border: 1px solid #e8e8ec; border-radius: 12px;
    padding: 24px; margin-bottom: 20px;
    transition: box-shadow 0.15s ease;
  }
  .step:hover { box-shadow: 0 2px 12px rgba(0,0,0,0.06); }
  .step-header { display: flex; align-items: flex-start; gap: 14px; margin-bottom: 16px; }
  .step-number {
    display: flex; align-items: center; justify-content: center;
    width: 32px; height: 32px; border-radius: 50%;
    background: #111; color: #fff; font-size: 14px; font-weight: 600;
    flex-shrink: 0; margin-top: 2px;
  }
  .step-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: #999; font-weight: 500; }
  .step-title { font-size: 17px; font-weight: 600; color: #111; margin-top: 2px; }
  .step-description { font-size: 15px; color: #555; margin-bottom: 16px; }
  .step img {
    width: 100%; border-radius: 8px; border: 1px solid #e8e8ec;
    display: block;
  }
  .footer {
    text-align: center; margin-top: 40px; padding-top: 20px;
    border-top: 1px solid #e8e8ec; font-size: 12px; color: #aaa;
  }
`;

function htmlDocument(title, subtitle, bodyHtml) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${escapeHtml(title)}</title>
<style>${EXPORT_STYLE}</style>
</head>
<body>
<div class="container">
  <h1>${escapeHtml(title)}</h1>
  <p class="subtitle">${escapeHtml(subtitle)}</p>
${bodyHtml}
  <div class="footer">Generated with Workflow Voice Recorder</div>
</div>
</body>
</html>
`;
}

function stepCardsHtml(steps, { withDescription } = {}) {
  return steps.map((step, i) => `
<div class="step">
  <div class="step-header">
    <span class="step-number">${i + 1}</span>
    <div>
      <div class="step-label">Step ${i + 1} of ${steps.length}</div>
      <h2 class="step-title">${escapeHtml(step.title)}</h2>
    </div>
  </div>
  ${withDescription && step.description ? `<p class="step-description">${escapeHtml(step.description)}</p>` : ''}
  ${step.screenshot ? `<img src="${step.screenshot}" alt="${escapeHtml(step.title)}" />` : ''}
</div>`).join('\n');
}

function htmlGuide() {
  const { title, intro, outro, steps } = docParts();
  const body = `${intro ? `<div class="intro">
  <h2>${escapeHtml(title)}</h2>
  <p>${escapeHtml(intro)}</p>
</div>` : ''}
${stepCardsHtml(steps, { withDescription: true })}
${outro ? `<div class="outro">
  <h2>You're all set!</h2>
  <p>${escapeHtml(outro)}</p>
</div>` : ''}`;
  return htmlDocument(title, `${steps.length} steps`, body);
}

function htmlBugReport() {
  const { title, description, expected, steps } = bugReportParts();
  const body = `${description ? `<div class="intro">
  <h2>Description of the bug</h2>
  <p>${escapeHtml(description)}</p>
</div>` : ''}
<div class="intro"><h2>Steps to Reproduce</h2></div>
${stepCardsHtml(steps, { withDescription: false })}
${expected ? `<div class="outro">
  <h2>Expected behavior</h2>
  <p>${escapeHtml(expected)}</p>
</div>` : ''}`;
  return htmlDocument(title, `Bug report · ${steps.length} repro steps`, body);
}

function markdownGuide() {
  const { title, intro, outro, steps } = docParts();
  const lines = [`# ${title}`, ''];
  if (intro) lines.push('## Introduction', '', `**${title}**`, '', intro, '');
  steps.forEach((step, i) => {
    lines.push(`## Step ${i + 1}: ${step.title}`, '');
    if (step.description) lines.push(step.description, '');
    if (step.screenshot) lines.push(`![${step.title}](${step.screenshot})`, '');
  });
  if (outro) lines.push('---', '', `## You're all set!`, '', outro, '');
  return lines.join('\n');
}

function markdownBugReport() {
  const { title, description, expected, steps } = bugReportParts();
  const lines = [`# ${title}`, ''];
  if (description) lines.push('## Description of the bug', '', description, '');
  lines.push('## Steps to Reproduce', '');
  steps.forEach((step, i) => {
    lines.push(`${i + 1}. ${step.title}`);
    if (step.screenshot) lines.push('', `   ![${step.title}](${step.screenshot})`);
    lines.push('');
  });
  if (expected) lines.push('## Expected behavior', '', expected, '');
  return lines.join('\n');
}

function textGuide() {
  const { title, intro, outro, steps } = docParts();
  const rule = (text, char) => char.repeat(text.length);
  const lines = [title, rule(title, '='), ''];
  if (intro) lines.push(`Introduction: ${title}`, '', intro, '');
  steps.forEach((step, i) => {
    const heading = `Step ${i + 1}: ${step.title}`;
    lines.push(heading, rule(heading, '-'), '');
    if (step.description) lines.push(step.description, '');
    if (step.screenshot) lines.push(`Screenshot: ${step.screenshot}`, '');
  });
  if (outro) lines.push('---', '', `You're all set!`, '', outro, '');
  return lines.join('\n');
}

function textBugReport() {
  const { title, description, expected, steps } = bugReportParts();
  const rule = (text, char) => char.repeat(text.length);
  const lines = [title, rule(title, '='), ''];
  if (description) lines.push('Description of the bug', rule('Description of the bug', '-'), '', description, '');
  lines.push('Steps to Reproduce', rule('Steps to Reproduce', '-'), '');
  steps.forEach((step, i) => {
    lines.push(`${i + 1}. ${step.title}`);
    if (step.screenshot) lines.push(`   Screenshot: ${step.screenshot}`);
  });
  lines.push('');
  if (expected) lines.push('Expected behavior', rule('Expected behavior', '-'), '', expected, '');
  return lines.join('\n');
}

function currentDocType() {
  return document.querySelector('#docType').value;
}

async function download(filename, body, mime) {
  const blob = new Blob([body], { type: mime });
  const url = URL.createObjectURL(blob);
  await chrome.downloads.download({ url, filename, saveAs: true });
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

(async () => {
  bindListEvents();
  bindLibraryEvents();
  bindLightbox();
  bindFormatsMenu();
  bindImageUpload();
  await loadLibrary();
  if (libraryIndex.length) {
    const preferred = latestSessionId && libraryIndex.some((e) => e.id === latestSessionId) ? latestSessionId : libraryIndex[0].id;
    await selectSession(preferred);
  } else {
    showEmptyState();
  }
})();

document.querySelector('#playwright')?.addEventListener('click', () => session && download(`${slug(session.title)}.spec.ts`, playwright(session), 'text/typescript'));
document.querySelector('#devtools')?.addEventListener('click', () => session && download(`${slug(session.title)}.devtools.json`, devtools(session), 'application/json'));
document.querySelector('#exportHtml')?.addEventListener('click', () => session && download(
  `${slug(document.querySelector('#docTitle').value || session.title)}.html`,
  currentDocType() === 'bug-report' ? htmlBugReport() : htmlGuide(),
  'text/html'
));
document.querySelector('#exportMarkdown')?.addEventListener('click', () => session && download(
  `${slug(document.querySelector('#docTitle').value || session.title)}.md`,
  currentDocType() === 'bug-report' ? markdownBugReport() : markdownGuide(),
  'text/markdown'
));
document.querySelector('#exportText')?.addEventListener('click', () => session && download(
  `${slug(document.querySelector('#docTitle').value || session.title)}.txt`,
  currentDocType() === 'bug-report' ? textBugReport() : textGuide(),
  'text/plain'
));
