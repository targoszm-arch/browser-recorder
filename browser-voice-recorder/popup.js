const toggle = document.querySelector('#toggle');
const status = document.querySelector('#status');
async function refresh() {
  const response = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
  toggle.textContent = response.recording ? 'Stop and export' : 'Start recording';
  toggle.classList.toggle('danger', response.recording);
}
toggle.addEventListener('click', async () => {
  toggle.disabled = true;
  const current = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
  const response = await chrome.runtime.sendMessage(current.recording ? { type: 'STOP' } : { type: 'START', options: { title: document.querySelector('#title').value, includeVoice: document.querySelector('#voice').checked } });
  if (response?.error) status.textContent = response.error;
  await refresh(); toggle.disabled = false;
});
document.querySelector('#review').addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('review.html') }));
refresh();
