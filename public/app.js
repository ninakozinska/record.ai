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
    return await new Promise((r) => canvas.toBlob(r, 'image/jpeg', maxSide <= 400 ? 0.7 : 0.85));
  } catch {
    return maxSide <= 400 ? null : file; // unsupported format for decoding; keep original
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
    // Full photo (1600 px) plus a small preview (320 px) for lists.
    const [blob, thumb] = await Promise.all([compressImage(file), compressImage(file, 320)]);
    const name = await local.addImage(blob, thumb);
    this.images.push(name);
    this.renderThumbs();
  }
  async renderThumbs() {
    const urls = await Promise.all(this.images.map((n) => local.imageUrl(n, { thumb: true })));
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
// Lines starting with "- ", "* ", "• ", "[ ]" or "☐" become list items.
const ITEM_LINE = /^\s*(?:[-*•]|\[ ?\]|☐)\s+(.+)$/;
function splitList(text) {
  const rest = [];
  const items = [];
  for (const line of text.split('\n')) {
    const m = line.match(ITEM_LINE);
    if (m) items.push(m[1].trim());
    else rest.push(line);
  }
  return { text: rest.join('\n').trim(), items };
}

async function addItems(parentId, texts) {
  for (const t of texts) await local.save(uuid(), { parent_id: parentId, text: t }, { send: false });
  local.flush();
}

// Pasting several lines (e.g. items copied from another note): ask whether
// they become one item each, or stay together. Bullets and numbers go.
const BULLET = /^\s*(?:[-*•·–]|\d+[.)]|\[[ xX]?\]|[☐☑✓✔])\s*/;
function pastedLines(e) {
  const text = e.clipboardData?.getData('text/plain') || '';
  const lines = text.split(/\r?\n/).map((l) => l.replace(BULLET, '').trim()).filter(Boolean);
  return lines.length > 1 ? { text, lines } : null;
}
// One question at a time. The window's "closed" signal comes a moment later;
// one that arrives after the window opened again belongs to the old question.
let pasteAnswer = null;
$('#pasteChoice').addEventListener('close', () => {
  if ($('#pasteChoice').open) return;
  const answer = pasteAnswer;
  pasteAnswer = null;
  answer?.($('#pasteChoice').returnValue);
});
/** Resolves to 'a' (the main choice), 'b', 'plain' (only when offered), or '' (closed). */
function askPaste(lines, { title, a, b, plain = false }) {
  const d = $('#pasteChoice');
  $('#pasteTitle').textContent = title;
  $('#pastePreview').innerHTML = lines.slice(0, 6).map((l) => `<li>${esc(l)}</li>`).join('') + (lines.length > 6 ? `<li>… ${lines.length - 6} more</li>` : '');
  $('#pasteA').textContent = a;
  $('#pasteB').textContent = b;
  $('#pastePlain').hidden = !plain;
  d.returnValue = '';
  d.showModal();
  pasteAnswer?.('');
  return new Promise((resolve) => (pasteAnswer = resolve));
}
/** Puts text where the cursor was when pasting (the question window moves the focus). */
function insertText(box, text, [start, end]) {
  box.setRangeText(text, start, end, 'end');
  box.dispatchEvent(new Event('input'));
  box.focus();
}
composer.text.addEventListener('paste', async (e) => {
  const pasted = pastedLines(e);
  if (!pasted || e.clipboardData.files?.length) return;
  e.preventDefault();
  const box = composer.text;
  const at = [box.selectionStart, box.selectionEnd];
  const n = pasted.lines.length;
  const choice = await askPaste(pasted.lines, {
    title: `Paste ${n} lines`,
    a: `One note with a checklist (${n} items)`,
    b: `${n} separate notes`,
    plain: true,
  });
  if (choice === 'b') {
    // Each line its own note, sorted by the AI on its own.
    for (const line of pasted.lines) await local.save(uuid(), { text: line }, { send: false });
    local.flush();
    toast(`${n} notes added`);
  } else if (choice === 'a') {
    // Each item on a line of its own, also when pasting into the middle of a line.
    const before = at[0] === 0 || box.value[at[0] - 1] === '\n' ? '' : '\n';
    const after = at[1] === box.value.length || box.value[at[1]] === '\n' ? '' : '\n';
    insertText(box, before + pasted.lines.map((l) => `- ${l}`).join('\n') + after, at);
  } else if (choice === 'plain') {
    insertText(box, pasted.text, at);
  }
});
$('#newItem').addEventListener('paste', async (e) => {
  const pasted = pastedLines(e);
  if (!pasted) return;
  e.preventDefault();
  const choice = await askPaste(pasted.lines, {
    title: `Paste ${pasted.lines.length} lines`,
    a: `Add ${pasted.lines.length} items`,
    b: 'Add as one item',
  });
  if (!choice) return;
  await addItems(editor.id, choice === 'a' ? pasted.lines : [pasted.lines.join(', ')]);
  editor.renderItems();
  $('#newItem').focus();
});

async function saveComposer() {
  composer.dictation.stop();
  if (composer.isEmpty()) return;
  const { text, images } = composer.value;
  const list = splitList(text);
  const id = uuid();
  // The list (its title line) goes first, so its items always have a parent.
  // A checklist without a title line gets its title from the AI.
  // The list and its items reach the server together, so the AI sees the items.
  await local.save(id, { text: list.items.length ? list.text : text, images }, { send: false });
  await addItems(id, list.items);
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
    $('#groupList').innerHTML = withMyGroups(ownGroups()).map((g) => `<option value="${esc(g)}">`).join('');
    const ai = [];
    if (n.summary) ai.push(`<p>${esc(n.summary)}</p>`);
    if (n.priority_reason) ai.push(`<p class="muted">Priority: ${esc(n.priority_reason)}</p>`);
    if (n.due_date) ai.push(`<p class="muted">Due ${esc(n.due_date)}</p>`);
    if (n.tags?.length) ai.push(`<p>${n.tags.map((t) => `<span class="tag">#${esc(t)}</span>`).join(' ')}</p>`);
    if (n.ai_status === 'error') ai.push(`<p class="error">AI error: ${esc(n.ai_error)}</p>`);
    if (n.ai_status === 'limit') ai.push(`<p class="muted">⏸️ ${esc(n.ai_error)}</p>`);
    $('#editorAi').innerHTML = ai.join('');
    $('#editorAi').hidden = !ai.length;
    // Shared with me: the owner's groups and priorities stay theirs; view only changes nothing.
    const shared = !!n.role;
    this.readOnly = n.role === 'view';
    $('#editorForm').classList.toggle('read-only', this.readOnly);
    this.composer.text.readOnly = this.readOnly;
    $('#editorForm .overrides').hidden = shared;
    $('#editorReanalyze').hidden = shared;
    $('#editorShare').hidden = shared;
    $('#editorDone').hidden = $('#editorSave').hidden = this.readOnly;
    $('#editorDelete').textContent = shared ? 'Leave' : 'Delete';
    this.renderShared();
    this.due = n.user_due ?? null;
    $('#editorDate').disabled = $('#editorTime').disabled = this.readOnly;
    this.renderWhen();
    $('#newItem').value = '';
    this.renderItems();
    this.dialog.showModal();
  },
  /** The note's date and time as shown in the editor: the person's choice, or the AI's. */
  when() {
    const n = local.notes.get(this.id);
    if (this.due != null) return { date: this.due.slice(0, 10) || null, time: this.due.slice(11, 16) || null, own: true };
    const e = effectiveDue({ ...n, user_due: null });
    return { date: e.due_date, time: e.due_time, own: false };
  },
  renderWhen() {
    const w = this.when();
    $('#editorDate').value = w.date || '';
    $('#editorTime').value = w.time || '';
    $('#whenHint').textContent = w.own ? (w.date ? '📌 Your choice' : '📌 No date') : w.date ? 'Found by AI' : 'None yet: the AI adds one when the note mentions it';
    $('#whenAuto').hidden = !w.own;
    $('#whenClear').hidden = !w.date;
    $('#calActions').hidden = !w.date;
    if (w.date) $('#calGoogle').href = googleCalendarUrl(this.noteForCalendar(), w);
  },
  noteForCalendar() {
    const n = local.notes.get(this.id);
    return { title: n.title || n.text.split('\n')[0].slice(0, 80) || 'Note', text: [n.text, ...local.items(n.id).map((i) => `${i.done ? '☑' : '☐'} ${i.text}`)].join('\n') };
  },

  /** Who this note is shared with, or who shared it with me. */
  renderShared() {
    const n = local.notes.get(this.id);
    if (!n) return;
    const people = sharesOf(effectiveNote(n));
    $('#editorShared').hidden = !n.role && !people.length;
    $('#editorShared').textContent = n.role
      ? `👥 Shared by ${n.owner_name}${n.role === 'view' ? ' · view only' : ' · you can edit'}`
      : `👥 Shared with ${people.map((p) => p.name || p.email).join(', ')}`;
  },
  renderItems() {
    const items = local.items(this.id);
    const off = this.readOnly ? 'disabled' : '';
    $('.items-box').hidden = this.readOnly && !items.length;
    const open = items.filter((i) => !i.done).length;
    $('#itemsCount').textContent = items.length ? `${items.length - open}/${items.length} done` : '';
    $('#itemList').innerHTML = items.map((i) => `
      <li class="item p-${i.priority} ${i.done ? 'done' : ''}" data-item="${esc(i.id)}">
        <button type="button" class="check" data-item-toggle title="${i.done ? 'Mark not done' : 'Mark done'}" ${off}>${i.done ? '✓' : ''}</button>
        <input class="item-text" data-item-text value="${esc(i.text)}" aria-label="Item" ${off}>
        <select class="item-priority" data-item-priority aria-label="Priority" ${off}>
          ${['urgent', 'high', 'normal', 'low'].map((p) => `<option value="${p}" ${i.priority === p ? 'selected' : ''}>${PRIORITY_LABEL[p]}</option>`).join('')}
        </select>
        <button type="button" class="icon-btn" data-item-delete title="Remove item">✕</button>
      </li>`).join('');
  },
  async save() {
    if (this.readOnly) return;
    const n = local.notes.get(this.id);
    const { text, images } = this.composer.value;
    const patch = {};
    if (text !== n.text) patch.text = text;
    if (JSON.stringify(images) !== JSON.stringify(n.images)) patch.images = images;
    const g = $('#editorGroup').value.trim() || null;
    if (g !== (n.user_group || null)) patch.user_group = g;
    const p = $('#editorPriority').value || null;
    if (p !== (n.user_priority || null)) patch.user_priority = p;
    if (this.due !== (n.user_due ?? null)) patch.user_due = this.due;
    if (Object.keys(patch).length) await local.save(this.id, patch);
  },
};
async function addEditorItem() {
  const input = $('#newItem');
  const texts = input.value.split('\n').map((t) => t.trim()).filter(Boolean);
  if (!texts.length) return;
  input.value = '';
  await addItems(editor.id, texts);
  editor.renderItems();
  input.focus();
}
$('#addItem').onclick = addEditorItem;

// Date and time: picking one makes it your choice (📌); Auto gives it back to the AI.
for (const id of ['#editorDate', '#editorTime']) {
  $(id).addEventListener('change', () => {
    const date = $('#editorDate').value;
    const time = $('#editorTime').value;
    editor.due = date ? (time ? `${date}T${time}` : date) : '';
    editor.renderWhen();
  });
}
$('#whenAuto').onclick = () => {
  editor.due = null;
  editor.renderWhen();
};
$('#whenClear').onclick = () => {
  editor.due = '';
  editor.renderWhen();
};
// The calendar file comes from the server, so save the date there first.
$('#calFile').onclick = async (e) => {
  e.preventDefault();
  await editor.save();
  // Wait (up to about 5 seconds) until the server has the latest date.
  for (let i = 0; i < 20 && local.pending.has(editor.id); i++) {
    await local.flush();
    if (local.pending.has(editor.id)) await new Promise((r) => setTimeout(r, 250));
  }
  if (local.pending.has(editor.id)) return toast('You need to be online to add it to a calendar.');
  location.href = `api/notes/${encodeURIComponent(editor.id)}/calendar.ics`;
};
$('#calGoogle').addEventListener('click', () => editor.save());
$('#newItem').addEventListener('keydown', (e) => {
  // Enter adds the item (instead of closing the editor).
  if (e.key === 'Enter') {
    e.preventDefault();
    addEditorItem();
  }
});
$('#itemList').addEventListener('click', async (e) => {
  const li = e.target.closest('[data-item]');
  if (!li) return;
  const id = li.dataset.item;
  if (e.target.closest('[data-item-toggle]')) await local.save(id, { done: !local.notes.get(id).done });
  else if (e.target.closest('[data-item-delete]')) await local.save(id, { deleted: true });
  else return;
  editor.renderItems();
});
$('#itemList').addEventListener('change', async (e) => {
  const li = e.target.closest('[data-item]');
  if (!li) return;
  const id = li.dataset.item;
  if (e.target.matches('[data-item-text]')) {
    const text = e.target.value.trim();
    if (text) await local.save(id, { text });
    else await local.save(id, { deleted: true });
  } else if (e.target.matches('[data-item-priority]')) {
    await local.save(id, { user_priority: e.target.value });
  } else return;
  editor.renderItems();
});
// Items typed into the list keep the editor open on Enter.
$('#itemList').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.matches('[data-item-text]')) {
    e.preventDefault();
    e.target.blur();
  }
});

editor.dialog.addEventListener('close', async () => {
  editor.composer.dictation.stop();
  if (editor.dialog.returnValue === 'save') await editor.save();
  editor.dialog.returnValue = '';
});
$('#editorDelete').onclick = async () => {
  const n = local.notes.get(editor.id);
  if (n.role) return leaveShared(n);
  if (!confirm('Delete this note?')) return;
  await local.save(editor.id, { deleted: true });
  editor.dialog.close();
};
$('#editorShare').onclick = async () => {
  await editor.save();
  await local.flush();
  const n = local.notes.get(editor.id);
  openShare('note', n.id, n.title || n.text.split('\n')[0].slice(0, 60) || 'this note');
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

// "My groups": groups the person made. They always show, even with no notes
// yet, and the AI files matching notes into them.
let myGroups = [];
async function loadMyGroups() {
  try {
    myGroups = (await local.api('groups/mine')).names;
    await local.metaSet('myGroups', myGroups);
  } catch {
    myGroups = (await local.metaGet('myGroups')) || myGroups;
  }
  render();
}
async function saveMyGroups(names) {
  myGroups = (await local.api('groups/mine', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ names }),
  })).names;
  await local.metaSet('myGroups', myGroups);
  render();
}
const withMyGroups = (groups) => [...groups, ...myGroups.filter((g) => !groups.includes(g))];

// ---------------------------------------------------------------------------
// Sharing: notes and groups I share (mine), and what others share with me.
// ---------------------------------------------------------------------------
let shares = { mine: [], withMe: [] };
async function loadShares() {
  try {
    shares = await local.api('shares');
    await local.metaSet('shares', shares);
  } catch {
    shares = (await local.metaGet('shares')) || shares;
  }
  if ($('#share').open) renderSharePeople();
  if (editor.dialog.open) editor.renderShared();
  render();
}
const SHARED_GROUP = 'Shared with me';
const effectiveNote = (n) => ({ ...n, group: n.user_group || n.ai_group || 'Inbox' });
const canEdit = (n) => n.role !== 'view';
/** Notes shared with me show in their own group: the owner's groups are theirs. */
const forMe = (n) => (n.role ? { ...n, group: SHARED_GROUP } : n);
const sameGroup = (a, b) => a.toLowerCase() === b.toLowerCase();
/** My shares that cover a note of mine: the note itself, or its group. */
const sharesOf = (n) => (n.role ? [] : shares.mine.filter((s) => (s.kind === 'note' ? s.target === n.id : sameGroup(s.target, n.group))));
const ownGroups = () => groupsOf(local.list().filter((n) => !n.role));

const share = { kind: null, target: null };
function openShare(kind, target, label) {
  Object.assign(share, { kind, target });
  $('#shareTitle').textContent = `Share "${label}"`;
  $('#shareIntro').textContent = (kind === 'group'
    ? `Everything in ${label}, also what goes there later, with its lists.`
    : 'This note, with its list.') +
    ' Only the people below see it. They need a record.ai account with this email.';
  $('#shareEmail').value = '';
  $('#shareRole').value = 'edit';
  $('#shareError').textContent = '';
  renderSharePeople();
  if (!$('#share').open) $('#share').showModal();
  $('#shareEmail').focus();
}
function renderSharePeople() {
  const people = shares.mine.filter((s) => s.kind === share.kind && (s.kind === 'note' ? s.target === share.target : sameGroup(s.target, share.target)));
  $('#sharePeople').innerHTML = people.length
    ? people.map((p) => `
      <li data-share="${esc(p.id)}">
        <span class="who"><strong>${esc(p.name || p.email)}</strong>
          <small>${p.name ? esc(p.email) : 'No account yet: they see it once they sign up with this email.'}</small></span>
        <select data-share-role aria-label="What ${esc(p.name || p.email)} can do">
          <option value="edit" ${p.role === 'edit' ? 'selected' : ''}>Can edit</option>
          <option value="view" ${p.role === 'view' ? 'selected' : ''}>View only</option>
        </select>
        <button type="button" class="icon-btn" data-share-remove title="Stop sharing with ${esc(p.name || p.email)}">✕</button>
      </li>`).join('')
    : '<li class="muted">Not shared with anyone yet.</li>';
}
$('#shareForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = $('#shareEmail').value.trim();
  // Share pressed again after sharing, with the box empty: nothing to do.
  if (!email) return $('#shareEmail').focus();
  $('#shareSubmit').disabled = true;
  try {
    const r = await local.api('shares', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: share.kind, target: share.target, email, role: $('#shareRole').value }),
    });
    $('#shareEmail').value = '';
    $('#shareError').textContent = '';
    toast(r.hasAccount ? `Shared with ${email}` : `Shared. ${email} sees it after signing up with this email.`);
    await loadShares();
  } catch (err) {
    $('#shareError').textContent = err.status ? err.message : 'You need to be online to share.';
  } finally {
    $('#shareSubmit').disabled = false;
  }
});
$('#sharePeople').addEventListener('change', async (e) => {
  const li = e.target.closest('[data-share]');
  if (!li || !e.target.matches('[data-share-role]')) return;
  try {
    await local.api(`shares/${li.dataset.share}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: e.target.value }),
    });
  } catch (err) {
    toast(err.message);
  }
  loadShares();
});
$('#sharePeople').addEventListener('click', async (e) => {
  const li = e.target.closest('[data-share]');
  if (!li || !e.target.closest('[data-share-remove]')) return;
  const p = shares.mine.find((x) => x.id === li.dataset.share);
  if (!confirm(`Stop sharing with ${p?.name || p?.email}? It disappears from their devices.`)) return;
  try {
    await local.api(`shares/${li.dataset.share}`, { method: 'DELETE' });
  } catch (err) {
    toast(err.message);
  }
  loadShares();
});
$('#shareClose').onclick = () => $('#share').close();

/** Stop seeing something shared with me (the share that gives me this note). */
async function leaveShared(n) {
  const group = effectiveNote(n).group;
  const via = shares.withMe.filter((s) => s.owner.id === n.user_id && (s.kind === 'note' ? s.target === n.id : sameGroup(s.target, group)));
  const what = via.some((s) => s.kind === 'group') ? `the group "${group}"` : `"${n.title || n.text.split('\n')[0]}"`;
  if (!confirm(`Stop seeing ${what}, shared by ${n.owner_name}? Only ${n.owner_name} can share it with you again.`)) return;
  try {
    for (const s of via) await local.api(`shares/${s.id}`, { method: 'DELETE' });
    editor.dialog.close();
    await local.pull();
    loadShares();
  } catch (err) {
    toast(err.message);
  }
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
  const hay = [n.text, n.title, n.summary, n.group, ...(n.tags || []), ...local.items(n.id).map((i) => i.text)].join(' ').toLowerCase();
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

/** A note's date and time: the person's own choice, or the AI's. */
function effectiveDue(n) {
  if (n.user_due != null) return { due_date: n.user_due.slice(0, 10) || null, due_time: n.user_due.slice(11, 16) || null };
  return { due_date: n.ai_due_date !== undefined ? n.ai_due_date : n.due_date, due_time: n.ai_due_time !== undefined ? n.ai_due_time : n.due_time ?? null };
}

/** Google Calendar's "new event" page, filled in: all day, or one hour from the time. */
function googleCalendarUrl({ title, text }, { date, time }) {
  const day = (d) => d.toISOString().slice(0, 10).replaceAll('-', '');
  const start = new Date(`${date}T${time || '00:00'}:00Z`);
  const dates = time
    ? [start, new Date(+start + 3600e3)].map((d) => `${day(d)}T${d.toISOString().slice(11, 16).replace(':', '')}00`).join('/')
    : `${day(start)}/${day(new Date(+start + 86400e3))}`;
  const q = new URLSearchParams({ action: 'TEMPLATE', text: title, dates, details: text });
  if (time) q.set('ctz', Intl.DateTimeFormat().resolvedOptions().timeZone);
  return `https://calendar.google.com/calendar/render?${q}`;
}

function dueLabel(date) {
  const days = Math.round((new Date(date + 'T00:00:00') - new Date(new Date().toDateString())) / 86400000);
  if (days < 0) return { text: `overdue ${-days}d`, cls: 'overdue' };
  if (days === 0) return { text: 'due today', cls: 'overdue' };
  if (days === 1) return { text: 'due tomorrow', cls: 'soon' };
  if (days < 7) return { text: `due in ${days}d`, cls: 'soon' };
  return { text: `due ${date}`, cls: '' };
}

/** A list's progress and its first open items, tickable from the card. */
function listPreview(n) {
  const items = local.items(n.id);
  const off = canEdit(n) ? '' : 'disabled';
  if (!items.length) return '';
  const done = items.filter((i) => i.done).length;
  const open = items.filter((i) => !i.done).slice(0, 4);
  return `<div class="list-preview">
    <div class="list-progress"><span style="width:${Math.round((done / items.length) * 100)}%"></span></div>
    <span class="list-count">☑ ${done}/${items.length}</span>
    <ul>${open.map((i) => `<li class="p-${i.priority}"><button class="check small" data-item-check="${esc(i.id)}" title="Mark done" ${off}></button>${esc(i.text)}</li>`).join('')}
    ${items.length - done > open.length ? `<li class="more">+ ${items.length - done - open.length} more</li>` : ''}</ul>
  </div>`;
}

function card(n, { showGroup }) {
  const title = n.title || n.text.split('\n')[0].slice(0, 80) || local.items(n.id)[0]?.text || (n.images.length ? 'Photo' : 'Untitled');
  // The text under the title, unless it just repeats the title (a list called "Groceries").
  const body = !n.title ? n.text.split('\n').slice(1).join('\n') : n.text.trim() === n.title.trim() ? '' : n.text;
  const due = n.due_date ? dueLabel(n.due_date) : null;
  const status =
    n.ai_status === 'pending' ? '<span class="ai-pending" title="AI is organizing this note">✨</span>' :
    n.ai_status === 'error' ? '<span class="ai-error" title="AI could not process this note">⚠️</span>' :
    n.ai_status === 'limit' ? `<span class="ai-limit" title="${esc(n.ai_error)}">⏸️</span>` : '';
  return `
    <article class="note card p-${n.priority} ${n.done ? 'done' : ''}" data-id="${esc(n.id)}">
      <div class="note-main">
        <div class="note-head">
          <h3>${esc(title)}</h3>${status}
        </div>
        ${body.trim() ? `<p class="note-text">${esc(body.trim())}</p>` : ''}
        ${listPreview(n)}
        ${n.images.length ? `<div class="note-images">${n.images.map((i) => `<img data-img="${esc(i)}" alt="" loading="lazy">`).join('')}</div>` : ''}
        <div class="meta">
          <span class="badge p-${n.priority}">${PRIORITY_LABEL[n.priority]}${n.user_priority ? ' 📌' : ''}</span>
          ${showGroup ? `<span class="group-chip">${esc(n.group)}${n.user_group ? ' 📌' : ''}</span>` : ''}
          ${n.role ? `<span class="shared-badge">👥 ${esc(n.owner_name)}${n.role === 'view' ? ' · view only' : ''}</span>`
            : sharesOf(n).length ? '<span class="shared-badge" title="Shared">👥 Shared</span>' : ''}
          ${due ? `<span class="due ${due.cls}">${esc(due.text)}${n.due_time ? ` · ${esc(n.due_time)}` : ''}${n.user_due ? ' 📌' : ''}</span>` : ''}
          ${(n.tags || []).slice(0, 4).map((t) => `<span class="tag">#${esc(t)}</span>`).join('')}
          <span class="time">${relTime(n.created_at)}</span>
          ${canEdit(n) ? `<button class="done-btn" data-check>${n.done ? '↩ Not done' : '✓ Done'}</button>` : ''}
        </div>
      </div>
    </article>`;
}

function section(title, notes, opts, extraClass = '', action = '') {
  if (!notes.length) return '';
  return `<section class="group ${extraClass}"><h2>${esc(title)} <span class="count">${notes.length}</span>${action}</h2>${notes.map((n) => card(n, opts)).join('')}</section>`;
}

/** "Share" on one of my groups (how many people, once shared). */
function shareGroupButton(g) {
  if (g === SHARED_GROUP) return '';
  const people = shares.mine.filter((s) => s.kind === 'group' && sameGroup(s.target, g)).length;
  return `<button class="ghost share-group" data-share-group="${esc(g)}">👥 ${people ? `Shared · ${people}` : 'Share'}</button>`;
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
  const all = local.list().map(forMe);
  const groups = withMyGroups(groupsOf(all));
  if (ui.group && !groups.includes(ui.group)) ui.group = null;

  $('#groupChips').innerHTML =
    `<button class="chip ${!ui.group ? 'active' : ''}" data-group="">All</button>` +
    groups.map((g) => `<button class="chip ${ui.group === g ? 'active' : ''}" data-group="${esc(g)}">${esc(g)}</button>`).join('') +
    `<button class="chip add-chip" data-add-group title="Add a group of your own. The AI will put matching notes in it.">＋ Group</button>`;

  const q = ui.query.toLowerCase().trim();
  const visible = all.filter((n) => matches(n, q) && (!ui.group || n.group === ui.group)).sort(sortNotes);
  const open = visible.filter((n) => !n.done);
  const done = visible.filter((n) => n.done).sort((a, b) => b.edited_at - a.edited_at);

  let html = '';
  if (ui.view === 'priority') {
    for (const p of PRIORITIES) html += section(PRIORITY_LABEL[p], open.filter((n) => n.priority === p), { showGroup: true }, `p-${p}`);
  } else {
    for (const g of groupsOf(open)) html += section(g, open.filter((n) => n.group === g), { showGroup: false }, '', shareGroupButton(g));
  }
  if (!open.length) {
    html += all.length
      ? '<p class="empty">Nothing here. 🎉</p>'
      : '<p class="empty">No notes yet. Type, dictate 🎤 or snap a photo 📷 above — AI will title, prioritize and group them for you.</p>';
  }
  if (done.length) {
    const clearable = done.filter((n) => !n.role).length;
    html += `<div class="done-bar">
      <button class="ghost" data-toggle-done title="Right-click (two-finger click) to clear them">${ui.showDone ? 'Hide' : 'Show'} done (${done.length})</button>
      ${clearable ? '<button class="ghost danger" data-clear-done>🗑 Clear done</button>' : ''}
    </div>`;
    if (ui.showDone) html += section('Done', done, { showGroup: true }, 'done-section');
  }
  $('#list').innerHTML = html;
  // This month's AI sortings are used up: say so once, above the notes.
  const limited = all.find((n) => !n.role && n.ai_status === 'limit');
  $('#limitBanner').hidden = !limited;
  if (limited) $('#limitBanner').textContent = `⏸️ ${limited.ai_error}`;

  $('#list').querySelectorAll('img[data-img]').forEach(async (img) => {
    img.src = await local.imageUrl(img.dataset.img, { thumb: true });
  });
}

/**
 * Deletes the done notes shown (yours; shared ones stay), lists with their
 * items, after asking; Undo brings them all back.
 */
async function clearDone() {
  // The same done notes the page shows (search and group filter apply).
  const ids = local.list()
    .filter((n) => n.done && !n.role && matches(n, ui.query.toLowerCase().trim()) && (!ui.group || forMe(n).group === ui.group))
    .map((n) => n.id);
  if (!ids.length) return;
  if (!confirm(`Delete ${ids.length} done note${ids.length === 1 ? '' : 's'}? You can undo this for a few seconds.`)) return;
  const removed = [];
  for (const id of ids) {
    for (const item of local.items(id)) removed.push(item.id);
    removed.push(id);
    await local.save(id, { deleted: true }, { send: false });
  }
  local.flush();
  toast(`${ids.length} done note${ids.length === 1 ? '' : 's'} deleted`, async () => {
    for (const id of removed) await local.save(id, { deleted: false }, { send: false });
    local.flush();
  });
}

$('#list').addEventListener('contextmenu', (e) => {
  // Right-click / two-finger click on "Show done": offer to clear them.
  if (!e.target.closest('[data-toggle-done]') || !document.querySelector('[data-clear-done]')) return;
  e.preventDefault();
  clearDone();
});

$('#list').addEventListener('click', async (e) => {
  if (e.target.closest('[data-clear-done]')) return clearDone();
  if (e.target.closest('[data-toggle-done]')) {
    ui.showDone = !ui.showDone;
    return render();
  }
  const img = e.target.closest('img[data-img]');
  if (img) {
    $('#viewerImg').src = img.src;
    local.imageUrl(img.dataset.img).then((full) => ($('#viewerImg').src = full));
    $('#viewer').showModal();
    return;
  }
  const shareGroup = e.target.closest('[data-share-group]');
  if (shareGroup) return openShare('group', shareGroup.dataset.shareGroup, shareGroup.dataset.shareGroup);
  const article = e.target.closest('.note');
  if (!article) return;
  const id = article.dataset.id;
  if (e.target.closest('button:disabled')) return;
  const itemCheck = e.target.closest('[data-item-check]');
  // Done (or not done) right from the card, with Undo for a wrong tap.
  const markDone = async (noteId, done, what) => {
    await local.save(noteId, { done });
    toast(`${done ? 'Marked done' : 'Marked not done'}: ${what}`, () => local.save(noteId, { done: !done }));
  };
  if (itemCheck) {
    const item = local.notes.get(itemCheck.dataset.itemCheck);
    return markDone(item.id, true, item.text.slice(0, 40));
  }
  if (e.target.closest('[data-check]')) {
    const n = local.notes.get(id);
    return markDone(id, !n.done, (n.title || n.text.split('\n')[0]).slice(0, 40));
  }
  editor.open(id);
});
$('#viewer').addEventListener('click', () => $('#viewer').close());

$('#groupChips').addEventListener('click', async (e) => {
  if (e.target.closest('[data-add-group]')) {
    const name = prompt('New group (for example Baby or Work).\nThe AI will put matching notes in it:')?.trim();
    if (!name) return;
    try {
      await saveMyGroups([...myGroups, name]);
      toast(`"${name}" added. New notes that fit go there; tap ✨ Reorganize to sort older ones.`);
    } catch (err) {
      toast(err.message);
    }
    return;
  }
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
/** A short message at the bottom; with `undo`, it has an Undo button and stays a little longer. */
function toast(msg, undo) {
  document.querySelector('.toast')?.remove(); // one message at a time
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  if (undo) {
    const b = document.createElement('button');
    b.className = 'toast-undo';
    b.textContent = 'Undo';
    b.onclick = () => {
      t.remove();
      undo();
    };
    t.append(' · ', b);
  }
  document.body.append(t);
  setTimeout(() => t.remove(), undo ? 6000 : 3500);
}

function renderStatus() {
  const dot = $('#syncDot');
  dot.className = 'sync-dot ' + (local.online ? (local.unsent ? 'syncing' : 'ok') : 'offline');
  dot.title = local.online ? (local.unsent ? `Syncing ${local.unsent} change(s)…` : 'Synced') : 'Offline — changes are saved on this device and will sync later';
  const banner = $('#banner');
  if (local.ai && !local.ai.enabled) {
    banner.hidden = false;
    // On the Mac the launcher turns the AI on; online, the server's owner adds a key.
    const onMac = ['localhost', '127.0.0.1'].includes(location.hostname);
    banner.textContent = 'AI organization is off. Notes are saved and synced but not auto-organized. ' +
      (onMac ? 'Double-click "Change AI.command" to turn it on.' : 'The server needs an AI key to turn it on.');
  } else {
    banner.hidden = true;
  }
  $('#reorganizeBtn').hidden = local.ai ? !local.ai.enabled : false;
  if (local.ai?.reorganizing) $('#reorganizeBtn').textContent = '✨ Reorganizing…';
  $('#accountBtn').hidden = !local.user;
  if (local.user) $('#accountBtn').textContent = initials(local.user.name);
  if (local.needsLogin && !$('#login').open && !auth.opening) {
    auth.opening = true;
    auth.open().finally(() => (auth.opening = false));
  }
}

// ---------------------------------------------------------------------------
// Accounts: log in / sign up / account menu
// ---------------------------------------------------------------------------
// Small brand-coloured marks for the "Continue with …" buttons.
const PROVIDER_MARK = {
  google: ['G', '#4285f4'], apple: ['A', '#000'], microsoft: ['M', '#2f6fde'], facebook: ['f', '#1877f2'],
  linkedin: ['in', '#0a66c2'], x: ['𝕏', '#000'], github: ['GH', '#24292f'],
};
const providerMark = (id) => {
  const [text, color] = PROVIDER_MARK[id] || [id[0].toUpperCase(), '#555'];
  return `<span class="provider-mark" style="background:${color}">${esc(text)}</span>`;
};

const auth = {
  mode: 'login', // or 'signup'
  policy: null,
  providers: [],
  error: '',
  async open() {
    try {
      const state = await local.api('auth/state');
      this.policy = state.signup;
      this.providers = state.providers || [];
      if (state.user) {
        // Still logged in (e.g. after a network hiccup).
        await local.useAccount(state.user);
        local.setStatus({ needsLogin: false, user: state.user });
        local.start();
        return;
      }
    } catch {
      this.policy = this.policy || { open: false };
    }
    this.show(this.policy.firstAccount ? 'signup' : 'login');
  },
  show(mode) {
    this.mode = mode;
    const signup = mode === 'signup';
    const p = this.policy || {};
    $('#loginTitle').textContent = signup ? (p.firstAccount ? 'Create your account' : 'Create an account') : 'Log in';
    $('#loginIntro').textContent = signup && p.firstAccount
      ? 'This is the first account on this server. It will own all notes already saved here.'
      : signup ? 'Your notes are private to your account.' : 'Welcome back. Log in to see your notes.';
    $('#nameField').hidden = !signup;
    $('#codeField').hidden = !(signup && p.needsCode);
    $('#loginPassword').autocomplete = signup ? 'new-password' : 'current-password';
    $('#loginSubmit').textContent = signup ? 'Create account' : 'Log in';
    $('#loginError').textContent = this.error;
    this.error = '';
    this.renderProviders();
    const sw = $('#loginSwitch');
    if (signup && !p.firstAccount) sw.innerHTML = 'Already have an account? <button type="button" data-mode="login">Log in</button>';
    else if (!signup && p.open) sw.innerHTML = 'New here? <button type="button" data-mode="signup">Create an account</button>';
    else sw.textContent = '';
    if (!$('#login').open) $('#login').showModal();
    (signup ? $('#loginName') : $('#loginEmail')).focus();
  },
};
auth.renderProviders = function () {
  const box = $('#providerButtons');
  box.hidden = $('#loginOr').hidden = !this.providers.length;
  // When signing up with an invite code, the code goes along with the button.
  const invite = this.mode === 'signup' ? $('#loginCode').value.trim() : '';
  box.innerHTML = this.providers.map((p) => {
    const q = invite ? `?invite=${encodeURIComponent(invite)}` : '';
    return `<a class="provider-btn" href="api/auth/oauth/${encodeURIComponent(p.id)}/start${q}">${providerMark(p.id)}Continue with ${esc(p.name)}</a>`;
  }).join('');
};
$('#loginCode').addEventListener('input', () => auth.renderProviders());
$('#loginSwitch').addEventListener('click', (e) => {
  const b = e.target.closest('[data-mode]');
  if (b) auth.show(b.dataset.mode);
});
$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fields = { email: $('#loginEmail').value.trim(), password: $('#loginPassword').value };
  if (auth.mode === 'signup') Object.assign(fields, { name: $('#loginName').value.trim(), code: $('#loginCode').value.trim() });
  $('#loginSubmit').disabled = true;
  try {
    await local.authenticate(auth.mode, fields);
    $('#login').close();
    $('#loginPassword').value = '';
  } catch (err) {
    $('#loginError').textContent = err.status === 0 || !err.status ? 'Cannot reach the server. Is it running?' : err.message;
  } finally {
    $('#loginSubmit').disabled = false;
  }
});
$('#login').addEventListener('cancel', (e) => e.preventDefault());

// Show / Hide on password fields, so people can check what they typed.
function showPassword(button, show) {
  button.previousElementSibling.type = show ? 'text' : 'password';
  button.textContent = show ? 'Hide' : 'Show';
  button.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
  button.setAttribute('aria-pressed', String(show));
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-pw-toggle]');
  if (b) showPassword(b, b.previousElementSibling.type === 'password');
});
// Passwords are hidden again when the window closes or a new password is saved.
function hidePasswords() {
  for (const b of document.querySelectorAll('[data-pw-toggle]')) showPassword(b, false);
}
for (const id of ['#login', '#account']) $(id).addEventListener('close', hidePasswords);

function initials(name) {
  return (name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
}

$('#accountBtn').onclick = async () => {
  const u = local.user;
  $('#accountName').textContent = u.name;
  $('#accountEmail').textContent = u.email;
  $('#pwMessage').textContent = '';
  $('#pwCurrent').value = $('#pwNext').value = '';
  $('#account').showModal();
  loadSigninOptions();
  loadAiUsage();
  $('#calendarLink').hidden = true;
  $('#calendarShow').hidden = false;
  renderMyGroups();
  applyTheme(currentTheme());
  try {
    const { addresses } = await local.api('server-info');
    const here = location.origin;
    const list = [...new Set([here.startsWith('http://localhost') ? null : here, ...addresses].filter(Boolean))];
    $('#appAddress').hidden = !list.length;
    $('#appAddress').innerHTML = '<p><strong>iPhone app:</strong> to connect it, enter this server address:</p>' +
      list.map((a) => `<p><code>${esc(a)}</code></p>`).join('');
  } catch {
    $('#appAddress').hidden = true;
  }
};
async function loadSigninOptions() {
  try {
    const me = await local.api('auth/me');
    $('#pwTitle').textContent = me.hasPassword ? 'Change password' : 'Set a password';
    $('#pwCurrentField').hidden = !me.hasPassword;
    const connected = new Map(me.identities.map((i) => [i.provider, i]));
    const all = [...me.providers];
    for (const i of me.identities) if (!all.some((p) => p.id === i.provider)) all.push({ id: i.provider, name: i.name });
    $('#signinOptions').hidden = !all.length;
    $('#identityList').innerHTML = all.map((p) => {
      const c = connected.get(p.id);
      return `<li>${providerMark(p.id)}<span class="who">${esc(p.name)}${c?.email ? ` <span class="muted">· ${esc(c.email)}</span>` : ''}</span>` +
        (c ? `<button class="ghost" data-disconnect="${esc(p.id)}">Disconnect</button>`
           : `<a class="ghost button" href="api/auth/oauth/${encodeURIComponent(p.id)}/start?link=1">Connect</a>`) + '</li>';
    }).join('');
  } catch {
    $('#signinOptions').hidden = true;
  }
}
// Appearance: Auto (follow the device), Light or Dark. Kept on this device.
function currentTheme() {
  try { return localStorage.getItem('theme') || 'auto'; } catch { return 'auto'; }
}
function applyTheme(choice) {
  if (choice === 'light' || choice === 'dark') document.documentElement.dataset.theme = choice;
  else delete document.documentElement.dataset.theme;
  try {
    if (choice === 'auto') localStorage.removeItem('theme');
    else localStorage.setItem('theme', choice);
  } catch { /* private mode: applies until the page is closed */ }
  $('#themeSwitch').querySelectorAll('[data-theme-choice]').forEach((b) => b.classList.toggle('active', b.dataset.themeChoice === choice));
}
$('#themeSwitch').addEventListener('click', (e) => {
  const b = e.target.closest('[data-theme-choice]');
  if (b) applyTheme(b.dataset.themeChoice);
});

function renderMyGroups() {
  $('#myGroupsBox').hidden = !myGroups.length;
  $('#myGroupsList').innerHTML = myGroups.map((g) =>
    `<li><span class="who">${esc(g)}</span><button class="ghost" data-remove-group="${esc(g)}">Remove</button></li>`).join('');
}
$('#myGroupsList').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-remove-group]');
  if (!b) return;
  try {
    await saveMyGroups(myGroups.filter((g) => g !== b.dataset.removeGroup));
    renderMyGroups();
  } catch (err) {
    toast(err.message);
  }
});
$('#identityList').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-disconnect]');
  if (!b) return;
  try {
    await local.api(`auth/identities/${encodeURIComponent(b.dataset.disconnect)}`, { method: 'DELETE' });
    loadSigninOptions();
  } catch (err) {
    toast(err.message);
  }
});
// Calendar link under your initials: dated notes in Google / Apple / Outlook calendars.
function showCalendarLink({ url, webcal }) {
  $('#calendarLink').hidden = false;
  $('#calendarShow').hidden = true;
  $('#calendarGoogle').href = `https://calendar.google.com/calendar/render?cid=${encodeURIComponent(webcal)}`;
  $('#calendarApple').href = webcal;
  $('#calendarCopy').onclick = async () => {
    try {
      await navigator.clipboard.writeText(url);
      toast('Link copied');
    } catch {
      prompt('Copy this link:', url);
    }
  };
}
$('#calendarShow').onclick = async () => {
  try {
    showCalendarLink(await local.api(`calendar-link?tz=${encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone)}`));
  } catch (err) {
    toast(err.status ? err.message : 'You need to be online for this.');
  }
};
$('#calendarReset').onclick = async () => {
  if (!confirm('Make a new link? Calendars that use the old one stop showing your notes until you add the new one.')) return;
  try {
    showCalendarLink(await local.api('calendar-link/reset', { method: 'POST' }));
    toast('New link made');
  } catch (err) {
    toast(err.message);
  }
};

/** "AI this month: 12 of 300" under your initials (nothing when there's no limit). */
async function loadAiUsage() {
  try {
    const { usage } = (await local.api('status')).ai;
    $('#aiUsage').hidden = !usage?.limit;
    if (usage?.limit) {
      const resets = new Date(usage.resets + 'T00:00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'long' });
      $('#aiUsage').textContent = `AI sortings this month: ${usage.used} of ${usage.limit} (starts again on ${resets})`;
    }
  } catch {
    $('#aiUsage').hidden = true;
  }
}
$('#accountClose').onclick = () => $('#account').close();
$('#passwordForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('#pwMessage');
  try {
    await local.api('auth/password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ current: $('#pwCurrent').value, next: $('#pwNext').value }),
    });
    msg.className = 'ok';
    msg.textContent = 'Password saved. Your other devices need to log in again.';
    $('#pwCurrent').value = $('#pwNext').value = '';
    hidePasswords();
    loadSigninOptions();
  } catch (err) {
    msg.className = 'err';
    msg.textContent = err.message;
  }
});
$('#logoutOthers').onclick = async () => {
  try {
    await local.api('auth/logout-others', { method: 'POST' });
    toast('Other devices are logged out.');
  } catch (err) {
    toast(err.message);
  }
};
$('#logoutBtn').onclick = async () => {
  await local.flush();
  const unsent = await local.unsentCount();
  if (unsent && !confirm(`${unsent} change(s) haven't reached the server yet and will be lost. Log out anyway?`)) return;
  $('#account').close();
  await local.logout();
  render();
  auth.open();
};

// Refresh relative times / due labels periodically.
setInterval(render, 60000);

await local.init();
local.addEventListener('change', render);
local.addEventListener('status', renderStatus);
local.addEventListener('started', loadMyGroups);
local.addEventListener('started', loadShares);
local.addEventListener('shares', loadShares);
local.addEventListener('wiped', () => { myGroups = []; shares = { mine: [], withMe: [] }; });
render();
renderStatus();
// Coming back from "Continue with …": show what happened, then tidy the address bar.
const back = new URLSearchParams(location.search);
if (back.has('login_error') || back.has('linked')) {
  auth.error = back.get('login_error') || '';
  if (back.has('linked')) setTimeout(() => toast('Connected. You can now log in with it too.'), 300);
  history.replaceState(null, '', location.pathname);
}

// Restore the account this device last used, then check with the server.
try {
  const state = await local.api('auth/state');
  auth.providers = state.providers || [];
  if (state.user) {
    await local.useAccount(state.user);
    local.setStatus({ user: state.user });
    local.start();
  } else {
    auth.policy = state.signup;
    local.setStatus({ needsLogin: true });
  }
} catch {
  // Offline: show what's saved on this device; sync resumes when the server is back.
  const saved = await local.metaGet('user');
  if (saved) {
    local.setStatus({ user: saved });
    local.start();
  }
}

// Shared from another app (Android share sheet → installed PWA).
const shared = new URLSearchParams(location.search);
if (shared.has('text') || shared.has('url') || shared.has('title')) {
  composer.set([shared.get('title'), shared.get('text'), shared.get('url')].filter(Boolean).join('\n'), []);
  history.replaceState(null, '', location.pathname);
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
