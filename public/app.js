import { Local, uuid } from './local.js';

const PRIORITIES = ['urgent', 'high', 'normal', 'low'];
const PRIORITY_LABEL = { urgent: 'Urgent', high: 'High', normal: 'Normal', low: 'Low' };
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const local = new Local();
const ui = {
  view: localStorage.getItem('view') || 'priority',
  group: null,
  query: '',
  showDone: false,
};

// ---------------------------------------------------------------------------
// Images: shrink before storing so sync and AI calls stay fast.
// ---------------------------------------------------------------------------
async function compressImage(file, maxSide = 1600) {
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.85));
  } catch {
    return file; // unsupported format for decoding; keep original
  }
}

// ---------------------------------------------------------------------------
// Dictation (Web Speech API). Falls back to the OS keyboard's mic button.
// ---------------------------------------------------------------------------
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

class Dictation {
  constructor(onFinal, onInterim, onState) {
    this.onFinal = onFinal;
    this.onInterim = onInterim;
    this.onState = onState;
    this.active = false;
  }
  toggle() {
    this.active ? this.stop() : this.start();
  }
  start() {
    if (!SpeechRecognition) {
      toast('Dictation is not supported in this browser — use your keyboard\'s 🎤 button instead.');
      return;
    }
    const rec = new SpeechRecognition();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = navigator.language || 'en-US';
    rec.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) this.onFinal(r[0].transcript.trim());
        else interim += r[0].transcript;
      }
      this.onInterim(interim);
    };
    rec.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        toast('Microphone permission denied.');
        this.stop();
      }
    };
    // Some browsers (iOS) end the session after a pause; keep going.
    rec.onend = () => (this.active ? rec.start() : this.onInterim(''));
    this.rec = rec;
    this.active = true;
    rec.start();
    this.onState(true);
  }
  stop() {
    this.active = false;
    this.rec?.stop();
    this.onState(false);
    this.onInterim('');
  }
}

// ---------------------------------------------------------------------------
// Camera
// ---------------------------------------------------------------------------
const camera = {
  dialog: $('#camera'),
  video: $('#cameraVideo'),
  facing: 'environment',
  async open(onPhoto) {
    if (!navigator.mediaDevices?.getUserMedia) return false;
    this.onPhoto = onPhoto;
    this.count = 0;
    $('#cameraCount').textContent = '';
    try {
      await this.startStream();
    } catch {
      return false;
    }
    this.dialog.showModal();
    return true;
  },
  async startStream() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: this.facing, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false,
    });
    this.video.srcObject = this.stream;
  },
  close() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.dialog.close();
  },
  async shoot() {
    const v = this.video;
    if (!v.videoWidth) return;
    const canvas = document.createElement('canvas');
    canvas.width = v.videoWidth;
    canvas.height = v.videoHeight;
    canvas.getContext('2d').drawImage(v, 0, 0);
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.9));
    this.dialog.classList.add('flash');
    setTimeout(() => this.dialog.classList.remove('flash'), 150);
    this.count++;
    $('#cameraCount').textContent = `${this.count} photo${this.count > 1 ? 's' : ''} added`;
    this.onPhoto(blob);
  },
};
$('#cameraShoot').onclick = () => camera.shoot();
$('#cameraClose').onclick = () => camera.close();
$('#cameraFlip').onclick = () => {
  camera.facing = camera.facing === 'environment' ? 'user' : 'environment';
  camera.startStream().catch(() => toast('Could not switch camera'));
};
camera.dialog.addEventListener('cancel', () => camera.close());

// ---------------------------------------------------------------------------
// Composer (used inline and in the editor dialog)
// ---------------------------------------------------------------------------
class Composer {
  constructor(root) {
    this.root = root;
    this.text = $('[data-role=text]', root);
    this.thumbs = $('[data-role=thumbs]', root);
    this.interim = $('[data-role=interim]', root);
    this.file = $('[data-role=file]', root);
    this.mic = $('[data-role=mic]', root);
    this.images = [];
    this.dictation = new Dictation(
      (t) => this.insertText(t),
      (t) => (this.interim.textContent = t),
      (on) => this.mic.classList.toggle('recording', on),
    );
    this.mic.onclick = (e) => { e.preventDefault(); this.dictation.toggle(); };
    $('[data-role=photo]', root).onclick = (e) => { e.preventDefault(); this.file.removeAttribute('capture'); this.file.click(); };
    $('[data-role=camera]', root).onclick = async (e) => {
      e.preventDefault();
      const ok = await camera.open((blob) => this.addImage(blob));
      if (!ok) {
        // No live camera API (or denied): fall back to the OS camera picker.
        this.file.setAttribute('capture', 'environment');
        this.file.click();
      }
    };
    this.file.onchange = async () => {
      for (const f of this.file.files) await this.addImage(f);
      this.file.value = '';
    };
    this.text.addEventListener('paste', async (e) => {
      const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
      if (files.length) {
        e.preventDefault();
        for (const f of files) await this.addImage(f);
      }
    });
    root.addEventListener('dragover', (e) => { e.preventDefault(); root.classList.add('drop'); });
    root.addEventListener('dragleave', () => root.classList.remove('drop'));
    root.addEventListener('drop', async (e) => {
      e.preventDefault();
      root.classList.remove('drop');
      for (const f of e.dataTransfer.files) if (f.type.startsWith('image/')) await this.addImage(f);
    });
    this.text.addEventListener('input', () => this.autosize());
  }
  autosize() {
    this.text.style.height = 'auto';
    this.text.style.height = Math.min(this.text.scrollHeight + 2, window.innerHeight * 0.5) + 'px';
  }
  insertText(t) {
    if (!t) return;
    const el = this.text;
    const start = el.selectionStart ?? el.value.length;
    const before = el.value.slice(0, start);
    const sep = before && !/\s$/.test(before) ? ' ' : '';
    el.value = before + sep + t + el.value.slice(el.selectionEnd ?? start);
    const pos = (before + sep + t).length;
    el.setSelectionRange(pos, pos);
    this.autosize();
  }
  async addImage(file) {
    const blob = await compressImage(file);
    const name = await local.addImage(blob);
    this.images.push(name);
    this.renderThumbs();
  }
  async renderThumbs() {
    const urls = await Promise.all(this.images.map((n) => local.imageUrl(n)));
    this.thumbs.innerHTML = this.images
      .map((n, i) => `<div class="thumb"><img src="${esc(urls[i])}" alt=""><button type="button" data-remove="${esc(n)}" title="Remove">✕</button></div>`)
      .join('');
    this.thumbs.querySelectorAll('[data-remove]').forEach((b) => {
      b.onclick = () => {
        this.images = this.images.filter((x) => x !== b.dataset.remove);
        this.renderThumbs();
      };
    });
  }
  set(text, images) {
    this.text.value = text;
    this.images = [...images];
    this.renderThumbs();
    requestAnimationFrame(() => this.autosize());
  }
  get value() {
    return { text: this.text.value.trim(), images: [...this.images] };
  }
  isEmpty() {
    return !this.text.value.trim() && !this.images.length;
  }
  reset() {
    this.dictation.stop();
    this.set('', []);
  }
}

const composer = new Composer($('#composer'));
async function saveComposer() {
  composer.dictation.stop();
  if (composer.isEmpty()) return;
  await local.save(uuid(), composer.value);
  composer.reset();
  composer.text.focus();
}
$('[data-role=save]', $('#composer')).onclick = saveComposer;
composer.text.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    saveComposer();
  }
});

// ---------------------------------------------------------------------------
// Editor dialog
// ---------------------------------------------------------------------------
const editor = {
  dialog: $('#editor'),
  composer: new Composer($('#editorComposer')),
  id: null,
  open(id) {
    const n = local.notes.get(id);
    if (!n) return;
    this.id = id;
    this.composer.set(n.text, n.images);
    $('#editorTitle').textContent = n.title || 'Note';
    $('#editorGroup').value = n.user_group || '';
    $('#editorGroup').placeholder = `Auto${n.ai_group ? ` (${n.ai_group})` : ''}`;
    $('#editorPriority').value = n.user_priority || '';
    $('#editorPriority').options[0].textContent = `Auto${n.ai_priority ? ` (${PRIORITY_LABEL[n.ai_priority]})` : ''}`;
    $('#editorDone').textContent = n.done ? 'Mark not done' : 'Mark done';
    $('#groupList').innerHTML = groupsOf(local.list()).map((g) => `<option value="${esc(g)}">`).join('');
    const ai = [];
    if (n.summary) ai.push(`<p>${esc(n.summary)}</p>`);
    if (n.priority_reason) ai.push(`<p class="muted">Priority: ${esc(n.priority_reason)}</p>`);
    if (n.due_date) ai.push(`<p class="muted">Due ${esc(n.due_date)}</p>`);
    if (n.tags?.length) ai.push(`<p>${n.tags.map((t) => `<span class="tag">#${esc(t)}</span>`).join(' ')}</p>`);
    if (n.ai_status === 'error') ai.push(`<p class="error">AI error: ${esc(n.ai_error)}</p>`);
    $('#editorAi').innerHTML = ai.join('');
    $('#editorAi').hidden = !ai.length;
    this.dialog.showModal();
  },
  async save() {
    const n = local.notes.get(this.id);
    const { text, images } = this.composer.value;
    const patch = {};
    if (text !== n.text) patch.text = text;
    if (JSON.stringify(images) !== JSON.stringify(n.images)) patch.images = images;
    const g = $('#editorGroup').value.trim() || null;
    if (g !== (n.user_group || null)) patch.user_group = g;
    const p = $('#editorPriority').value || null;
    if (p !== (n.user_priority || null)) patch.user_priority = p;
    if (Object.keys(patch).length) await local.save(this.id, patch);
  },
};
editor.dialog.addEventListener('close', async () => {
  editor.composer.dictation.stop();
  if (editor.dialog.returnValue === 'save') await editor.save();
  editor.dialog.returnValue = '';
});
$('#editorDelete').onclick = async () => {
  if (!confirm('Delete this note?')) return;
  await local.save(editor.id, { deleted: true });
  editor.dialog.close();
};
$('#editorDone').onclick = async () => {
  await editor.save();
  await local.save(editor.id, { done: !local.notes.get(editor.id).done });
  editor.dialog.close();
};
$('#editorReanalyze').onclick = async () => {
  await editor.save();
  try {
    await local.flush();
    await local.api(`notes/${editor.id}/reanalyze`, { method: 'POST' });
    toast('Re-analyzing…');
  } catch (err) {
    toast(err.message);
  }
  editor.dialog.close();
};

// ---------------------------------------------------------------------------
// List rendering
// ---------------------------------------------------------------------------
function groupsOf(notes) {
  const counts = new Map();
  for (const n of notes) if (!n.done) counts.set(n.group, (counts.get(n.group) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([g]) => g);
}

function sortNotes(a, b) {
  const p = PRIORITIES.indexOf(a.priority) - PRIORITIES.indexOf(b.priority);
  if (p) return p;
  if (a.due_date || b.due_date) {
    if (!a.due_date) return 1;
    if (!b.due_date) return -1;
    if (a.due_date !== b.due_date) return a.due_date < b.due_date ? -1 : 1;
  }
  return b.created_at - a.created_at;
}

function matches(n, q) {
  if (!q) return true;
  const hay = [n.text, n.title, n.summary, n.group, ...(n.tags || [])].join(' ').toLowerCase();
  return q.split(/\s+/).every((w) => hay.includes(w));
}

function relTime(ts) {
  const d = (Date.now() - ts) / 1000;
  if (d < 60) return 'just now';
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  if (d < 86400 * 7) return `${Math.floor(d / 86400)}d ago`;
  return new Date(ts).toLocaleDateString();
}

function dueLabel(date) {
  const days = Math.round((new Date(date + 'T00:00:00') - new Date(new Date().toDateString())) / 86400000);
  if (days < 0) return { text: `overdue ${-days}d`, cls: 'overdue' };
  if (days === 0) return { text: 'due today', cls: 'overdue' };
  if (days === 1) return { text: 'due tomorrow', cls: 'soon' };
  if (days < 7) return { text: `due in ${days}d`, cls: 'soon' };
  return { text: `due ${date}`, cls: '' };
}

function card(n, { showGroup }) {
  const title = n.title || n.text.split('\n')[0].slice(0, 80) || (n.images.length ? 'Photo' : 'Untitled');
  const body = n.title ? n.text : n.text.split('\n').slice(1).join('\n');
  const due = n.due_date ? dueLabel(n.due_date) : null;
  const status =
    n.ai_status === 'pending' ? '<span class="ai-pending" title="AI is organizing this note">✨</span>' :
    n.ai_status === 'error' ? '<span class="ai-error" title="AI could not process this note">⚠️</span>' : '';
  return `
    <article class="note card p-${n.priority} ${n.done ? 'done' : ''}" data-id="${esc(n.id)}">
      <button class="check" data-check title="${n.done ? 'Mark not done' : 'Mark done'}">${n.done ? '✓' : ''}</button>
      <div class="note-main">
        <div class="note-head">
          <h3>${esc(title)}</h3>${status}
        </div>
        ${body.trim() ? `<p class="note-text">${esc(body.trim())}</p>` : ''}
        ${n.images.length ? `<div class="note-images">${n.images.map((i) => `<img data-img="${esc(i)}" alt="" loading="lazy">`).join('')}</div>` : ''}
        <div class="meta">
          <span class="badge p-${n.priority}">${PRIORITY_LABEL[n.priority]}${n.user_priority ? ' 📌' : ''}</span>
          ${showGroup ? `<span class="group-chip">${esc(n.group)}${n.user_group ? ' 📌' : ''}</span>` : ''}
          ${due ? `<span class="due ${due.cls}">${esc(due.text)}</span>` : ''}
          ${(n.tags || []).slice(0, 4).map((t) => `<span class="tag">#${esc(t)}</span>`).join('')}
          <span class="time">${relTime(n.created_at)}</span>
        </div>
      </div>
    </article>`;
}

function section(title, notes, opts, extraClass = '') {
  if (!notes.length) return '';
  return `<section class="group ${extraClass}"><h2>${esc(title)} <span class="count">${notes.length}</span></h2>${notes.map((n) => card(n, opts)).join('')}</section>`;
}

let renderQueued = false;
function render() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    renderNow();
  });
}

function renderNow() {
  const all = local.list();
  const groups = groupsOf(all);
  if (ui.group && !groups.includes(ui.group)) ui.group = null;

  $('#groupChips').innerHTML =
    `<button class="chip ${!ui.group ? 'active' : ''}" data-group="">All</button>` +
    groups.map((g) => `<button class="chip ${ui.group === g ? 'active' : ''}" data-group="${esc(g)}">${esc(g)}</button>`).join('');

  const q = ui.query.toLowerCase().trim();
  const visible = all.filter((n) => matches(n, q) && (!ui.group || n.group === ui.group)).sort(sortNotes);
  const open = visible.filter((n) => !n.done);
  const done = visible.filter((n) => n.done).sort((a, b) => b.edited_at - a.edited_at);

  let html = '';
  if (ui.view === 'priority') {
    for (const p of PRIORITIES) html += section(PRIORITY_LABEL[p], open.filter((n) => n.priority === p), { showGroup: true }, `p-${p}`);
  } else {
    for (const g of groupsOf(open)) html += section(g, open.filter((n) => n.group === g), { showGroup: false });
  }
  if (!open.length) {
    html += all.length
      ? '<p class="empty">Nothing here. 🎉</p>'
      : '<p class="empty">No notes yet. Type, dictate 🎤 or snap a photo 📷 above — AI will title, prioritize and group them for you.</p>';
  }
  if (done.length) {
    html += `<button class="ghost done-toggle" data-toggle-done>${ui.showDone ? 'Hide' : 'Show'} done (${done.length})</button>`;
    if (ui.showDone) html += section('Done', done, { showGroup: true }, 'done-section');
  }
  $('#list').innerHTML = html;

  $('#list').querySelectorAll('img[data-img]').forEach(async (img) => {
    img.src = await local.imageUrl(img.dataset.img);
  });
}

$('#list').addEventListener('click', async (e) => {
  if (e.target.closest('[data-toggle-done]')) {
    ui.showDone = !ui.showDone;
    return render();
  }
  const img = e.target.closest('img[data-img]');
  if (img) {
    $('#viewerImg').src = img.src;
    $('#viewer').showModal();
    return;
  }
  const article = e.target.closest('.note');
  if (!article) return;
  const id = article.dataset.id;
  if (e.target.closest('[data-check]')) {
    await local.save(id, { done: !local.notes.get(id).done });
    return;
  }
  editor.open(id);
});
$('#viewer').addEventListener('click', () => $('#viewer').close());

$('#groupChips').addEventListener('click', (e) => {
  const b = e.target.closest('[data-group]');
  if (!b) return;
  ui.group = b.dataset.group || null;
  render();
});

document.querySelectorAll('.view-toggle button').forEach((b) => {
  b.classList.toggle('active', b.dataset.view === ui.view);
  b.onclick = () => {
    ui.view = b.dataset.view;
    localStorage.setItem('view', ui.view);
    document.querySelectorAll('.view-toggle button').forEach((x) => x.classList.toggle('active', x === b));
    render();
  };
});

$('#search').addEventListener('input', (e) => {
  ui.query = e.target.value;
  render();
});

$('#reorganizeBtn').onclick = async () => {
  const btn = $('#reorganizeBtn');
  btn.disabled = true;
  btn.textContent = '✨ Reorganizing…';
  try {
    const r = await local.api('reorganize', { method: 'POST' });
    toast(r.skipped ? 'Already reorganizing' : `Reorganized — ${r.updated} note${r.updated === 1 ? '' : 's'} moved`);
  } catch (err) {
    toast(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '✨ Reorganize';
  }
};

// ---------------------------------------------------------------------------
// Status, banner, login
// ---------------------------------------------------------------------------
function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.append(t);
  setTimeout(() => t.remove(), 3500);
}

function renderStatus() {
  const dot = $('#syncDot');
  dot.className = 'sync-dot ' + (local.online ? (local.unsent ? 'syncing' : 'ok') : 'offline');
  dot.title = local.online ? (local.unsent ? `Syncing ${local.unsent} change(s)…` : 'Synced') : 'Offline — changes are saved on this device and will sync later';
  const banner = $('#banner');
  if (local.ai && !local.ai.enabled) {
    banner.hidden = false;
    banner.textContent = 'AI organization is off: the server has no ANTHROPIC_API_KEY. Notes are saved and synced but not auto-organized.';
  } else {
    banner.hidden = true;
  }
  $('#reorganizeBtn').hidden = local.ai ? !local.ai.enabled : false;
  if (local.ai?.reorganizing) $('#reorganizeBtn').textContent = '✨ Reorganizing…';
  if (local.needsLogin && !$('#login').open) $('#login').showModal();
}

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await local.login($('#loginPassword').value);
    $('#login').close();
    $('#loginError').textContent = '';
  } catch (err) {
    $('#loginError').textContent = err.message;
  }
});
$('#login').addEventListener('cancel', (e) => e.preventDefault());

// Refresh relative times / due labels periodically.
setInterval(render, 60000);

await local.init();
local.addEventListener('change', render);
local.addEventListener('status', renderStatus);
render();
renderStatus();
local.start();

// Shared from another app (Android share sheet → installed PWA).
const shared = new URLSearchParams(location.search);
if (shared.has('text') || shared.has('url') || shared.has('title')) {
  composer.set([shared.get('title'), shared.get('text'), shared.get('url')].filter(Boolean).join('\n'), []);
  history.replaceState(null, '', location.pathname);
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
