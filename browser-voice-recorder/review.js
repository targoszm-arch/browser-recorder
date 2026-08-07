let session;
const q = (value) => JSON.stringify(value ?? '');
const slug = (value) => (value || 'workflow').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
const escapeHtml = (value) => { const el = document.createElement('span'); el.textContent = value ?? ''; return el.innerHTML; };

function playwright(s) {
  const lines = [`import { test, expect } from '@playwright/test';`, '', `test(${q(s.title)}, async ({ page }) => {`, `  await page.goto(${q(s.startUrl)});`];
  for (const step of s.steps) {
    if (step.action === 'click') lines.push(`  await page.locator(${q(step.selector)}).click();`);
    if (step.action === 'fill' && step.value !== '<REDACTED>') lines.push(`  await page.locator(${q(step.selector)}).fill(${q(step.value)});`);
    if (step.action === 'fill' && step.value === '<REDACTED>') lines.push(`  await page.locator(${q(step.selector)}).fill(process.env.RECORDED_SECRET ?? '');`);
    if (step.action === 'select') lines.push(`  await page.locator(${q(step.selector)}).selectOption(${q(step.value)});`);
    if (step.action === 'key') lines.push(`  await page.locator(${q(step.selector)}).press(${q(step.key)});`);
    if (step.action === 'navigate') lines.push(`  await page.waitForURL(${q(step.value)});`);
  }
  return [...lines, '});', ''].join('\n');
}

function devtools(s) {
  const steps = [{ type: 'navigate', url: s.startUrl, assertedEvents: [{ type: 'navigation', url: s.startUrl, title: s.title }] }];
  for (const step of s.steps) {
    const selectors = [[step.selector || 'body']];
    if (step.action === 'click') steps.push({ type: 'click', target: 'main', selectors, offsetX: 1, offsetY: 1 });
    if (step.action === 'fill') steps.push({ type: 'change', value: step.value === '<REDACTED>' ? '' : step.value, selectors, target: 'main' });
    if (step.action === 'select') steps.push({ type: 'change', value: step.value, selectors, target: 'main' });
    if (step.action === 'key') steps.push({ type: 'keyDown', key: step.key, target: 'main' });
    if (step.action === 'navigate') steps.push({ type: 'navigate', url: step.value });
  }
  return JSON.stringify({ title: s.title, steps }, null, 2);
}

function labelOf(step) {
  return step.name || step.selector || step.value || step.tag || 'this element';
}

function autoTitle(step) {
  switch (step.action) {
    case 'click': return `Click ${labelOf(step)}.`;
    case 'fill': return step.value === '<REDACTED>' ? `Fill in ${labelOf(step)}.` : `Type "${step.value}" into ${labelOf(step)}.`;
    case 'select': return `Select "${step.value}" from ${labelOf(step)}.`;
    case 'key': return `Press ${step.key} on ${labelOf(step)}.`;
    case 'submit': return `Submit the form.`;
    case 'navigate': return `Navigate to ${step.value}.`;
    default: return `Interact with ${labelOf(step)}.`;
  }
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
  list.innerHTML = session.steps.map((step, i) => `
    <li class="step-edit" data-index="${i}">
      <div class="step-edit-shot">${step.screenshot ? `<img src="${step.screenshot}" alt="">` : `<div class="no-shot">no screenshot</div>`}</div>
      <div class="step-edit-fields">
        <div class="step-edit-meta"><span>${escapeHtml(step.action)}</span><small>${(step.offsetMs / 1000).toFixed(1)}s</small></div>
        <label>Step title<input type="text" class="step-title" value="${escapeHtml(step.editTitle ?? (step.editTitle = autoTitle(step)))}"></label>
        <label>Narration (from voice transcription)<textarea class="step-desc" rows="2" placeholder="Say what you're doing while recording, or type it here">${escapeHtml(step.editDesc ?? (step.editDesc = narrationFor(step, i)))}</textarea></label>
      </div>
      <div class="step-edit-actions">
        <button data-act="up" title="Move up">↑</button>
        <button data-act="down" title="Move down">↓</button>
        <button data-act="remove" class="danger" title="Remove step">Remove</button>
      </div>
    </li>`).join('');
}

function bindListEvents() {
  const list = document.querySelector('#steps');
  list.addEventListener('input', (e) => {
    const li = e.target.closest('.step-edit');
    if (!li) return;
    const step = session.steps[Number(li.dataset.index)];
    if (e.target.classList.contains('step-title')) step.editTitle = e.target.value;
    if (e.target.classList.contains('step-desc')) step.editDesc = e.target.value;
  });
  list.addEventListener('click', (e) => {
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

function htmlGuide() {
  const { title, intro, outro, steps } = docParts();
  const stepHtml = steps.map((step, i) => `
<div class="step">
  <div class="step-header">
    <span class="step-number">${i + 1}</span>
    <div>
      <div class="step-label">Step ${i + 1} of ${steps.length}</div>
      <h2 class="step-title">${escapeHtml(step.title)}</h2>
    </div>
  </div>
  ${step.description ? `<p class="step-description">${escapeHtml(step.description)}</p>` : ''}
  ${step.screenshot ? `<img src="${step.screenshot}" alt="${escapeHtml(step.title)}" />` : ''}
</div>`).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${escapeHtml(title)}</title>
<style>
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
</style>
</head>
<body>
<div class="container">
  <h1>${escapeHtml(title)}</h1>
  <p class="subtitle">${steps.length} steps</p>
${intro ? `<div class="intro">
  <h2>${escapeHtml(title)}</h2>
  <p>${escapeHtml(intro)}</p>
</div>` : ''}
${stepHtml}
${outro ? `<div class="outro">
  <h2>You're all set!</h2>
  <p>${escapeHtml(outro)}</p>
</div>` : ''}
  <div class="footer">Generated with Workflow Voice Recorder</div>
</div>
</body>
</html>
`;
}

function docParts() {
  const title = document.querySelector('#docTitle').value.trim() || session.title;
  const intro = document.querySelector('#docIntro').value.trim();
  const outro = document.querySelector('#docOutro').value.trim();
  const steps = session.steps.map((step) => ({
    title: step.editTitle || autoTitle(step),
    description: step.editDesc || '',
    screenshot: step.screenshot || null,
  }));
  return { title, intro, outro, steps };
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

async function download(filename, body, mime) {
  const blob = new Blob([body], { type: mime });
  const url = URL.createObjectURL(blob);
  await chrome.downloads.download({ url, filename, saveAs: true });
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

(async () => {
  session = (await chrome.storage.local.get('latestSession')).latestSession;
  if (!session) {
    document.querySelector('#title').textContent = 'No recording yet';
    document.querySelector('.exports').style.display = 'none';
    document.querySelector('#formatting').style.display = 'none';
    return;
  }
  session.transcript = session.transcript || [];
  document.querySelector('#docIntro').value = `Follow these steps to complete: ${session.title}.`;
  document.querySelector('#docOutro').value = `You've successfully completed ${session.title}.`;
  render();
  bindListEvents();
})();

document.querySelector('#playwright')?.addEventListener('click', () => download(`${slug(session.title)}.spec.ts`, playwright(session), 'text/typescript'));
document.querySelector('#devtools')?.addEventListener('click', () => download(`${slug(session.title)}.devtools.json`, devtools(session), 'application/json'));
document.querySelector('#exportHtml')?.addEventListener('click', () => download(`${slug(document.querySelector('#docTitle').value || session.title)}.html`, htmlGuide(), 'text/html'));
document.querySelector('#exportMarkdown')?.addEventListener('click', () => download(`${slug(document.querySelector('#docTitle').value || session.title)}.md`, markdownGuide(), 'text/markdown'));
document.querySelector('#exportText')?.addEventListener('click', () => download(`${slug(document.querySelector('#docTitle').value || session.title)}.txt`, textGuide(), 'text/plain'));
