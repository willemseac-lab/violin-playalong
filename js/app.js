// Violin Play-Along: UI, library, song view, editing.
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const h = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const k in attrs) {
    if (k === 'class') e.className = attrs[k];
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), attrs[k]);
    else if (attrs[k] !== false && attrs[k] != null) e.setAttribute(k, attrs[k] === true ? '' : attrs[k]);
  }
  for (const c of kids.flat()) if (c != null && c !== false) e.append(c.nodeType ? c : document.createTextNode(c));
  return e;
};

const S = {
  isPC: false,           // running in a browser on the PC itself
  where: null,           // 'server' | 'local' for the open song
  song: null, urls: {}, layout: null,
  sel: null, editing: false, curDur: 4, dotNext: false,
  undo: [], redo: [],
  view: { zoom: 1, showLyrics: true, showChords: true, chordMode: 'both', follow: true },
  loopPick: null,
  player: new Player.P(),
  saveTimer: null, pollTimer: null,
};
try { Object.assign(S.view, JSON.parse(localStorage.getItem('vpa-view') || '{}')); } catch (e) { }
const saveView = () => { try { localStorage.setItem('vpa-view', JSON.stringify(S.view)); } catch (e) { } };

// ---------------------------------------------------------------- helpers
// A short message at the bottom; `action` adds a button to it, e.g. { label: 'Undo', fn: undo }.
function toast(msg, ms = 2600, action) {
  const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden');
  if (action) {
    t.append(h('button', { class: 'toast-act', onclick: () => { t.classList.add('hidden'); action.fn(); } }, action.label));
    ms = Math.max(ms, 6000);
  }
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add('hidden'), ms);
}
function modal(body, buttons) {
  return new Promise(res => {
    const m = $('#modal'), b = $('#modalBody'), bt = $('#modalBtns');
    b.innerHTML = ''; bt.innerHTML = '';
    b.append(typeof body === 'string' ? h('p', {}, body) : body);
    for (const [label, val, cls] of buttons) {
      bt.append(h('button', { class: 'btn ' + (cls || ''), onclick: () => { m.classList.add('hidden'); res(val); } }, label));
    }
    m.classList.remove('hidden');
    const inp = b.querySelector('input,select');
    if (inp) { inp.focus(); inp.select && inp.select();
      inp.addEventListener('keydown', e => { if (e.key === 'Enter') bt.querySelector('.primary')?.click(); }); }
  });
}
async function ask(title, label, value) {
  const inp = h('input', { type: 'text', value: value || '' });
  const ok = await modal(h('div', {}, h('h3', {}, title), label ? h('p', { class: 'muted' }, label) : null, inp),
    [['Cancel', false], ['OK', true, 'primary']]);
  return ok ? inp.value : null;
}
const confirmBox = (title, text, yes = 'Yes') => modal(h('div', {}, h('h3', {}, title), h('p', {}, text)), [['Cancel', false], [yes, true, 'primary']]);
const safeName = t => (t || 'song').replace(/[^\w\- ]+/g, '').trim() || 'song';

// ---------------------------------------------------------------- startup
async function start() {
  await Store.server.ping();
  const host = location.hostname;
  S.isPC = Store.server.available && (host === 'localhost' || host === '127.0.0.1');
  document.body.classList.toggle('pc', S.isPC);
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => { });
  bindLibrary();
  bindSong();
  showLibrary();
}

// ---------------------------------------------------------------- library
function bindLibrary() {
  $('#libSearch').value = S.view.libQuery || '';
  $('#libSort').value = S.view.libSort || 'changed';
  let st;
  $('#libSearch').addEventListener('input', e => { S.view.libQuery = e.target.value; clearTimeout(st); st = setTimeout(() => { saveView(); renderLibrary(); }, 150); });
  $('#libSort').addEventListener('change', e => { S.view.libSort = e.target.value; saveView(); renderLibrary(); });
  $('#addFile').addEventListener('change', e => {
    const f = e.target.files[0];
    if (!f) return;
    $('#addForm').classList.remove('hidden');
    $('#addTitle').value = Tools.baseName(f.name).replace(/[_-]+/g, ' ');
    $('#addFile').nextElementSibling.textContent = f.name;
    $('#optVideo').closest('label').classList.toggle('hidden', !f.type.startsWith('video'));
  });
  $('#addGo').addEventListener('click', () => uploadSong($('#addFile').files[0]));
  $('#openSongFile').addEventListener('change', async e => {
    const f = e.target.files[0]; e.target.value = '';
    if (f) await importSongFile(f);
  });
  $('#toolMp3').addEventListener('change', e => { const f = e.target.files[0]; e.target.value = ''; if (f) toolConvert(f); });
  $('#toolVoice').addEventListener('change', e => { const f = e.target.files[0]; e.target.value = ''; if (f) toolRecorded(f, 'voice'); });
  $('#toolVideo').addEventListener('change', e => { const f = e.target.files[0]; e.target.value = ''; if (f) toolRecorded(f, 'video'); });
}

function uploadOpts() {
  return {
    title: $('#addTitle').value, keep_video: $('#optVideo').checked ? '1' : '0',
    analyse: $('#optAnalyse').checked ? '1' : '0', separate: $('#optSeparate').checked ? '1' : '0',
    lyrics: $('#optLyrics').checked ? '1' : '0', whisper_model: $('#optWhisper').value, language: $('#optLang').value,
  };
}

async function uploadSong(file, fields) {
  if (!file) return toast('Choose a file first');
  const bar = $('#addProgress'); bar.classList.remove('hidden');
  $('#addGo').disabled = true;
  try {
    await Store.server.upload(file, fields || uploadOpts(), p => bar.firstElementChild.style.width = (p * 100) + '%');
    toast('Saved. Working on it on the PC…');
    $('#addForm').classList.add('hidden');
    $('#addFile').value = '';
    $('#addFile').nextElementSibling.textContent = 'Choose video or recording…';
  } catch (e) { toast('Upload failed: ' + e.message, 5000); }
  $('#addGo').disabled = false;
  bar.classList.add('hidden'); bar.firstElementChild.style.width = 0;
  renderLibrary();
}

async function importSongFile(file, where) {
  where = where || (S.isPC ? 'server' : 'local');
  const st = where === 'server' ? Store.server : Store.local;
  try {
    let r = await st.importFile(file);
    if (r.conflict) {
      const choice = await modal(h('div', {}, h('h3', {}, 'You already have this song'),
        h('p', {}, `"${r.title}" is already here. Use the version from the file, or keep both?`),
        h('p', { class: 'muted' }, `Here: changed ${r.pcModified || r.deviceModified || '?'} · File: changed ${r.fileModified || '?'}`)),
        [['Cancel', null], ['Keep both', 'copy'], ['Use the file', 'replace', 'primary']]);
      if (!choice) return;
      r = await st.importFile(file, choice);
    }
    toast(where === 'server' ? 'Song added to your PC' : 'Song saved on this phone');
    renderLibrary();
    return r.id;
  } catch (e) { toast(e.message || 'Could not open that file', 5000); }
}

function showLibrary() {
  S.player.pause();
  S.song = null;
  setEditing(false);
  $('#library').classList.remove('hidden');
  $('#songView').classList.add('hidden');
  $('#transport').classList.add('hidden');
  ['#backBtn', '#songTitle', '#editBtn', '#shareBtn', '#stageBtn', '#undoBtn', '#redoBtn'].forEach(s => $(s).classList.add('hidden'));
  $('#brand').classList.remove('hidden');
  $('#saveState').textContent = '';
  renderLibrary();
}

// Search and sort for every song list on the start screen.
function libFilter(list) {
  const q = (S.view.libQuery || '').trim().toLowerCase(), sort = S.view.libSort || 'changed';
  let out = list.filter(s => !q || (s.title || '').toLowerCase().includes(q) || (s.desc || '').toLowerCase().includes(q));
  if (out.length === 0 && q) return out;
  const key = s => (sort === 'added' ? s.created : s.modified || s.created) || '';
  if (sort === 'name') out.sort((a, b) => (a.title || '').localeCompare(b.title || '', undefined, { sensitivity: 'base' }));
  else if (!out.some(s => s.isDemo)) out.sort((a, b) => key(b).localeCompare(key(a)));
  return out;
}
async function renderLibrary() {
  const srv = Store.server.available;
  $('#addCard').classList.toggle('hidden', !srv);
  $('#pcSongsCard').classList.toggle('hidden', !srv);
  $('#toolsCard').classList.toggle('hidden', S.isPC);
  $('#addHint').textContent = S.isPC
    ? 'Pick a video or a recording. It\'s saved on this PC; tick "Work out the music" to get lyrics, key, chords and the melody.'
    : 'Send a video or recording straight to your PC to be worked out (you\'re on the same Wi-Fi).';
  $('#localSongsTitle').textContent = S.isPC ? 'Songs in this browser' : 'Songs on this phone';
  $('#lanHint').textContent = S.isPC && Store.server.info?.lan?.length
    ? `On your phone (same Wi-Fi), open ${Store.server.info.lan[0]}` : '';

  let local = [];
  try { local = await Store.local.list(); } catch (e) { }
  $('#localSongsCard').classList.toggle('hidden', S.isPC && !local.length);
  const lc = $('#localSongs'); lc.innerHTML = '';
  for (const s of libFilter(local)) lc.append(songRow(s, 'local'));
  const demo = $('#demoBox'); demo.innerHTML = '';
  for (const d of libFilter((window.VPA_DEMOS || []).map(x => ({ ...x, isDemo: true })))) {
    demo.append(h('div', { class: 'song' }, h('div', { class: 'info' }, h('div', { class: 't' }, d.title), h('div', { class: 'sub' }, d.desc)),
      h('div', { class: 'acts' }, h('button', { class: 'btn small primary', onclick: () => loadDemo(d) }, 'Open demo'))));
  }
  $('#demoCard').classList.toggle('hidden', !libFilter((window.VPA_DEMOS || []).map(x => ({ ...x, isDemo: true }))).length);
  const q = (S.view.libQuery || '').trim();
  $('#libTools').classList.toggle('filtered', !!q);

  if (srv) {
    let list = [];
    try { list = await Store.server.list(); } catch (e) { }
    const pc = $('#pcSongs'); pc.innerHTML = '';
    for (const s of libFilter(list)) pc.append(songRow(s, 'server'));
    clearTimeout(S.pollTimer);
    if (list.some(s => s.state === 'running' || s.state === 'queued')) {
      S.pollTimer = setTimeout(() => { if (!S.song) renderLibrary(); }, 2500);
    }
  }
}

function songRow(s, where) {
  const busy = s.state === 'running' || s.state === 'queued';
  const badge = busy ? h('span', { class: 'badge work' }, s.state === 'queued' ? 'waiting' : `working ${Math.round((s.progress || 0) * 100)}%`)
    : s.state === 'failed' ? h('span', { class: 'badge' }, 'problem')
      : s.analysed ? h('span', { class: 'badge ok' }, 'ready') : h('span', { class: 'badge' }, 'audio only');
  const acts = h('div', { class: 'acts' });
  const open = () => openSong(s.id, where);
  if (!busy) acts.append(h('button', { class: 'btn small primary', onclick: open }, 'Open'));
  if (where === 'server') {
    const u = n => `/api/songs/${s.id}/files/${n}`;
    if (s.files.audio) acts.append(h('a', { class: 'btn small', href: u('audio.mp3'), download: safeName(s.title) + '.mp3' }, 'MP3'));
    if (s.files.video) acts.append(h('a', { class: 'btn small', href: u('video.mp4'), download: safeName(s.title) + '.mp4' }, 'MP4'));
    if (!busy && s.files.audio) {
      if (S.isPC) acts.append(h('a', { class: 'btn small', href: Store.server.exportUrl(s.id), title: 'Song file to send to your phone (WhatsApp/email)' }, 'Song file ⇩'));
      else acts.append(h('button', { class: 'btn small', onclick: () => saveToPhone(s) }, 'Save to phone'));
      if (!s.analysed || s.state === 'failed') acts.append(h('button', { class: 'btn small', onclick: () => analyseSong(s) }, 'Work out music'));
    }
    if (!busy) acts.append(h('button', { class: 'btn small danger', onclick: () => deleteSong(s, where) }, 'Delete'));
  } else {
    acts.append(h('button', { class: 'btn small', onclick: () => shareSong(s.id, 'local', s.title) }, 'Share'));
    if (Store.server.available && !S.isPC) acts.append(h('button', { class: 'btn small', onclick: () => sendToPC(s) }, 'Send to PC'));
    acts.append(h('button', { class: 'btn small danger', onclick: () => deleteSong(s, where) }, 'Delete'));
  }
  const row = h('div', { class: 'song' },
    h('div', { class: 'info', onclick: busy ? null : open },
      h('div', { class: 't' }, s.title, badge),
      h('div', { class: 'sub' }, s.modified ? 'Changed ' + s.modified : (s.created || ''))),
    acts);
  if (busy && where === 'server') {
    const steps = h('div', { class: 'steps' }, '…');
    row.append(steps);
    Store.server.status(s.id).then(st => {
      steps.innerHTML = '';
      (st.steps || []).forEach((x, i) => {
        if (i) steps.append(' · ');
        steps.append(h('span', { class: x.state }, (x.state === 'done' ? '✓ ' : x.state === 'failed' ? '✗ ' : '') + x.name +
          (x.state === 'running' && x.msg ? ` (${x.msg})` : '')));
      });
      if (!st.steps?.length) steps.textContent = 'Waiting for the PC…';
    }).catch(() => { });
  }
  return row;
}

async function analyseSong(s) {
  const sep = h('input', { type: 'checkbox', checked: true }), lyr = h('input', { type: 'checkbox', checked: true });
  const ok = await modal(h('div', {}, h('h3', {}, 'Work out the music'),
    h('p', { class: 'muted' }, 'Lyrics, key, chords and melody. Takes a few minutes on the PC.'),
    h('div', { class: 'checks' }, h('label', {}, sep, ' Separate vocals (recommended)'), h('label', {}, lyr, ' Write out the lyrics'))),
    [['Cancel', false], ['Start', true, 'primary']]);
  if (!ok) return;
  await Store.server.reprocess(s.id, { separate: sep.checked ? '1' : '0', lyrics: lyr.checked ? '1' : '0',
    whisper_model: $('#optWhisper').value, language: $('#optLang').value });
  renderLibrary();
}

async function deleteSong(s, where) {
  if (!await confirmBox('Delete song?', `"${s.title}" will be removed ${where === 'server' ? 'from your PC' : 'from this phone'}.`, 'Delete')) return;
  try { await (where === 'server' ? Store.server : Store.local).remove(s.id); } catch (e) { toast(e.message); }
  renderLibrary();
}

async function loadDemo(d) {
  toast('Loading the demo song…');
  try {
    const where = S.isPC ? 'server' : 'local';
    const st = where === 'server' ? Store.server : Store.local;
    const sj = await (await fetch(d.dir + 'song.json')).json();
    const z = new JSZip();
    z.file('song.json', JSON.stringify(sj));
    for (const f of Object.values(sj.files || {})) {
      const r = await fetch(d.dir + f);
      if (!r.ok) throw new Error('missing ' + f);
      z.file(f, await r.arrayBuffer());
    }
    const blob = await z.generateAsync({ type: 'blob', compression: 'STORE' });
    await st.importFile(blob, 'replace');
    await renderLibrary();
    openSong(sj.id, where);
  } catch (e) { toast('Could not load the demo: ' + e.message, 5000); }
}

async function saveToPhone(s) {
  toast('Copying to phone…');
  const blob = await Store.server.exportBlob(s.id);
  await importSongFile(blob, 'local');
}
async function sendToPC(s) {
  toast('Sending to PC…');
  const blob = await Store.local.exportBlob(s.id);
  await importSongFile(blob, 'server');
}
async function shareSong(id, where, title) {
  if (where === 'server' && S.isPC) { location.href = Store.server.exportUrl(id); return; }
  toast('Packing song file…');
  const blob = await (where === 'server' ? Store.server : Store.local).exportBlob(id);
  const r = await shareOrDownload(blob, safeName(title) + '.vsong', 'Violin play-along song');
  if (r === 'downloaded' || r === 'saved') toast('Saved to your phone\'s Downloads. Send it from there with WhatsApp or email.', 4500);
  if (r === 'failed') toast('Saving isn\'t available here.', 4000);
}

// ---- phone tools
async function toolConvert(file) {
  const out = $('#toolOut'); out.innerHTML = '';
  const bar = h('div', { class: 'progress' }, h('div'));
  out.append(h('div', { class: 'out-box' }, h('div', {}, `Converting "${file.name}" to MP3…`), bar));
  try {
    const mp3 = await Tools.toMp3(file, p => bar.firstChild.style.width = (p * 100) + '%');
    const name = Tools.baseName(file.name) + '.mp3';
    out.innerHTML = '';
    const box = h('div', { class: 'out-box' }, h('b', {}, name + ` (${(mp3.size / 1048576).toFixed(1)} MB)`),
      h('audio', { class: 'preview', controls: true, src: URL.createObjectURL(mp3) }),
      h('div', { class: 'acts' },
        h('button', { class: 'btn primary', onclick: () => shareOrDownload(mp3, name, name) }, 'Share / save MP3'),
        Store.server.available ? h('button', { class: 'btn', onclick: () => sendRecordingToPC(new File([mp3], name, { type: 'audio/mpeg' })) }, 'Send to PC') : null));
    out.append(box);
  } catch (e) { out.innerHTML = ''; out.append(h('div', { class: 'out-box' }, '⚠ ' + e.message)); }
}
function toolRecorded(file, kind) {
  const out = $('#toolOut'); out.innerHTML = '';
  const name = file.name || (kind + '.dat');
  out.append(h('div', { class: 'out-box' }, h('b', {}, `${kind === 'voice' ? 'Voice recording' : 'Video'} ready (${(file.size / 1048576).toFixed(1)} MB)`),
    kind === 'voice' ? h('audio', { class: 'preview', controls: true, src: URL.createObjectURL(file) }) : null,
    h('div', { class: 'acts' },
      h('button', { class: 'btn primary', onclick: () => shareOrDownload(file, name, 'For Violin Play-Along') }, 'Send (WhatsApp / email)'),
      kind === 'video' ? h('button', { class: 'btn', onclick: () => toolConvert(file) }, 'Convert to MP3') : null,
      Store.server.available ? h('button', { class: 'btn', onclick: () => sendRecordingToPC(file) }, 'Send to PC') : null)));
}
async function sendRecordingToPC(file) {
  const title = await ask('Send to PC', 'Song name', Tools.baseName(file.name));
  if (title == null) return;
  await uploadSong(file, { title, keep_video: '1', analyse: '1', separate: '1', lyrics: '1', whisper_model: 'small', language: '' });
}

// ---------------------------------------------------------------- song view
async function openSong(id, where) {
  try {
    const { song, urls } = await (where === 'server' ? Store.server : Store.local).load(id);
    S.where = where; S.song = normalise(song); S.urls = urls;
  } catch (e) { return toast('Could not open: ' + e.message); }
  S.undo = []; S.redo = []; S.sel = null; S.loopPick = null;
  undoState();
  S.player.load(S.song, S.urls);
  $('#library').classList.add('hidden');
  $('#songView').classList.remove('hidden');
  $('#transport').classList.remove('hidden');
  ['#backBtn', '#songTitle', '#editBtn', '#shareBtn', '#stageBtn', '#undoBtn', '#redoBtn'].forEach(s => $(s).classList.remove('hidden'));
  $('#brand').classList.add('hidden');
  $('#songTitle').textContent = S.song.title;
  $('#saveState').textContent = '';
  const ts = $('#tTrack'); ts.innerHTML = '';
  for (const k of TRACK_KEYS) if (S.urls[k]) ts.append(h('option', { value: k }, TRACK_NAMES[k]));
  ts.value = 'audio';
  $('#tSpeed').value = 100; $('#tSpeedVal').textContent = '100%'; S.player.setRate(1);
  $('#tLoop').classList.remove('on'); $('#tLoop').textContent = '⟲ Loop';
  $('#tSynth').classList.toggle('on', S.player.synthOn);
  window.scrollTo(0, 0);
  $('#keyPanel').open = window.innerWidth > 900;
  renderAll();
}

function normalise(song) {
  song.parts = song.parts || [];
  if (!song.parts.some(p => p.editable)) song.parts.unshift({ id: 'violin', name: 'My violin part', instrument: 'violin', editable: true, visible: true, notes: [] });
  song.parts.forEach(p => { p.notes.sort((a, b) => a.b - b.b); if (p.visible == null) p.visible = true; if (!p.instrument) p.instrument = 'violin'; });
  song.chords = song.chords || []; song.lyrics = song.lyrics || [];
  song.key = song.key || { tonic: 0, mode: 'major' };
  song.beatsPerBar = song.beatsPerBar || 4;
  song.sections = song.sections || [];
  if (!song.beats) song.tempo = song.tempo || 90;
  // first time a song is opened: put my part on my usual instrument
  const mine = song.parts.find(p => p.editable), def = S.view.myInstrument || 'violin';
  if (!song.instChosen && mine && mine.instrument === 'violin' && def !== 'violin' && Theory.INSTRUMENTS[def]) {
    mine.notes = Arrange.fitRange(mine.notes, Theory.INSTRUMENTS[def], 6).map((n, i) => ({ ...mine.notes[i], p: n.p }));
    mine.instrument = def;
  }
  song.instChosen = true;
  return song;
}
const shortName = k => Theory.INSTRUMENTS[k] ? Theory.INSTRUMENTS[k].name.replace(/ \(.*\)| in .*/, '').toLowerCase() : 'violin';
const myPart = () => S.song.parts.find(p => p.editable);

function renderAll() { renderKeyPanel(); renderLayers(); renderSettings(); renderTabs(); renderScore(); }

// Which sheet is shown: one part's id, or 'all'.
function shownPartId() {
  const v = S.view.partView;
  if (v === 'all' && S.song.parts.length > 1) return 'all';
  return S.song.parts.some(p => p.id === v) ? v : myPart().id;
}
function shownParts() {
  const id = shownPartId();
  return id === 'all' ? S.song.parts.slice() : [S.song.parts.find(p => p.id === id)];
}
function renderTabs() {
  const box = $('#partTabs'); box.innerHTML = '';
  const cur = shownPartId();
  const tabs = S.song.parts.map(p => [p.id, partLabel(p), p.editable]);
  if (S.song.parts.length > 1) tabs.push(['all', 'Both', false]);
  if (S.song.parts.length > 2) tabs[tabs.length - 1][1] = 'All parts';
  for (const [id, label, mine] of tabs) {
    box.append(h('button', { class: 'tab' + (id === cur ? ' on' : ''), onclick: () => {
      S.view.partView = id; saveView(); S.sel = null;
      if (S.player.synthOn) S.player.setSynth(true, null, synthPartId());
      renderTabs(); renderScore(); updateEditHint(); Practice.partChanged && Practice.partChanged();
    } }, label, mine ? h('span', { class: 'tab-tag' }, '✎') : null,
      id !== 'all' && !fixedPart(S.song.parts.find(p => p.id === id))
        ? h('span', { class: 'tab-x', title: 'Delete this part', role: 'button',
            onclick: e => { e.stopPropagation(); deletePart(S.song.parts.find(p => p.id === id)); } }, '✕') : null));
  }
  box.append(h('button', { class: 'tab add', onclick: () => addPartDialog() }, '+ Add part'));
  updateEditHint();
}
function partLabel(p) {
  if (p === myPart()) return `My ${shortName(p.instrument)} part`;
  if (p.id === 'melody') return !p.name || p.name === 'Melody (as sung)' ? 'Melody' : p.name;
  return p.name;
}
function synthPartId() { const id = shownPartId(); return id === 'all' ? myPart().id : id; }
function updateEditHint() {
  const hint = $('#editHint'); if (!hint) return;
  const id = shownPartId();
  hint.innerHTML = '';
  const shown = S.song.parts.find(x => x.id === id);
  if (id === 'all' || (shown && shown.editable)) hint.append('Tap on the staff to put a note there (choose the length first). Tap a note to select it; drag it up or down. ' +
    (window.matchMedia('(pointer: fine)').matches ? 'Or type A–G. ' : '') + 'Tap words or chords to fix them.');
  else hint.append('This sheet is for reference and can\'t be edited. ',
    h('button', { class: 'btn small', onclick: () => { S.view.partView = myPart().id; saveView(); renderTabs(); renderScore(); } }, 'Edit my part'));
}

function renderKeyPanel() {
  const s = S.song, k = s.key, box = $('#keyInfo');
  box.innerHTML = '';
  if (!s.analysed && !s.chords.length) {
    box.append(h('p', { class: 'muted' }, 'The music hasn\'t been worked out for this song yet. Use "Work out music" in the song list on the PC.'));
    return;
  }
  const comfort = Theory.comfort(k, myPart().instrument);
  const prog = Theory.mainProgression(s.chords, k, s.beatsPerBar);
  const summary = Theory.chordSummary(s.chords, k);
  const keySel = h('select', { onchange: e => { const [t, m] = e.target.value.split(':'); edit(() => { s.key = { tonic: +t, mode: m }; }); } });
  for (const mode of ['major', 'minor']) for (let t = 0; t < 12; t++) {
    const kk = { tonic: t, mode };
    keySel.append(h('option', { value: `${t}:${mode}`, selected: t === k.tonic && mode === k.mode }, Theory.keyName(kk)));
  }
  box.append(h('div', { class: 'key-grid' },
    h('div', {},
      h('div', { class: 'mini-label' }, 'Key'),
      h('div', { class: 'key-name' }, Theory.keyName(k), h('span', { class: 'lvl ' + comfort.level },
        { easy: 'easy on ' + shortName(myPart().instrument), ok: 'comfortable', harder: 'a bit harder', hard: 'hard' }[comfort.level])),
      h('div', {}, Theory.accidentalText(k)),
      h('div', { class: 'scale-notes' }, Theory.scale(k).map(n => h('span', {}, n))),
      h('p', { class: 'muted', style: 'margin:6px 0 0' }, comfort.text, ' ', comfort.ringText),
      s.transpose ? h('p', { style: 'margin:4px 0 0;color:var(--warn)' }, `Transposed ${s.transpose > 0 ? '+' : ''}${s.transpose} semitones. The recording still plays in the original key.`) : null,
      h('div', { class: 'inline-ctl' },
        h('button', { class: 'btn small', onclick: () => transpose(-1) }, '♭ Transpose down'),
        h('button', { class: 'btn small', onclick: () => transpose(1) }, '♯ Transpose up'),
        h('span', { class: 'muted', style: 'font-size:12px' }, 'Wrong key?'), keySel)),
    h('div', {},
      h('div', { class: 'mini-label' }, 'Main chord progression'),
      prog ? h('div', {}, h('div', { class: 'prog' }, prog.numbers.join(' – ')), h('div', {}, prog.names.join(' – '),
        h('span', { class: 'muted' }, `  (repeats ${prog.times}×)`))) : h('div', { class: 'muted' }, 'No clear repeating pattern.'),
      h('div', { class: 'mini-label' }, 'Chords in this song'),
      h('div', { class: 'chips' }, summary.map(c => h('span', {}, c.name, h('small', {}, c.num)))),
      h('p', { class: 'muted', style: 'font-size:12.5px;margin:6px 0 0' },
        'Numbers show each chord\'s place in the key (1 = home chord). Same numbers, same pattern, in any key.'))));
}

function renderLayers() {
  const s = S.song, box = $('#layers');
  box.innerHTML = '';
  const list = h('div', { class: 'layer-list' });
  const me = myPart();
  const insSel = h('select', { onchange: e => changeMyInstrument(e.target.value) }, instrumentOptions(me.instrument));
  const defChk = h('input', { type: 'checkbox', checked: (S.view.myInstrument || 'violin') === me.instrument,
    onchange: e => { S.view.myInstrument = e.target.checked ? me.instrument : 'violin'; saveView();
      toast(e.target.checked ? `New songs will start on ${shortName(me.instrument)}` : 'New songs will start on violin'); } });
  list.append(h('div', { class: 'mini-label' }, 'My instrument'),
    h('div', { class: 'inline-ctl' }, insSel, h('label', {}, defChk, ' Use for new songs')));
  if (Theory.inst(me).open) list.append(h('div', { class: 'inline-ctl' },
    h('button', { class: 'btn small', onclick: () => autoFingering(me) }, 'Suggest fingerings (1st position)'),
    h('button', { class: 'btn small', onclick: () => edit(() => me.notes.forEach(n => delete n.fing)) }, 'Clear fingerings')));
  list.append(h('div', { class: 'mini-label' }, 'Parts'));
  for (const p of s.parts) {
    const ins = Theory.inst(p);
    const fixed = p.id === 'melody' || p === myPart();
    list.append(h('div', { class: 'part-row' },
      h('div', { class: 'pr-name' }, partLabel(p), h('span', { class: 'muted' }, ' · ' + ins.name),
        p.editable ? null : h('span', { class: 'badge' }, 'reference')),
      h('div', { class: 'acts' },
        h('button', { class: 'btn small', onclick: () => { S.view.partView = p.id; saveView(); renderTabs(); renderScore(); } }, 'Show'),
        h('button', { class: 'btn small', onclick: () => addPartDialog({ kind: 'easy', src: p.id, inst: p.instrument }) }, 'Easier version'),
        fixed ? null : h('button', { class: 'btn small', onclick: () => renamePart(p) }, 'Rename'),
        fixed ? null : h('button', { class: 'btn small danger', onclick: () => deletePart(p) }, 'Delete'))));
  }
  list.append(h('div', {}, h('button', { class: 'btn small primary', onclick: () => addPartDialog() }, '+ Add a part')));
  list.append(h('div', { class: 'mini-label' }, 'Display'));
  const tog = (label, key, def, after) => h('label', {}, h('input', { type: 'checkbox', checked: S.view[key] ?? def,
    onchange: e => { S.view[key] = e.target.checked; saveView(); (after || renderScore)(); } }), label);
  list.append(tog('Fingerings', 'showFing', true), tog('Tempo marking', 'showTempo', true),
    tog('Realistic instrument sounds', 'realSounds', true, () => { Samples.on = S.view.realSounds !== false; S.player._stopSynth(); }));
  list.append(h('label', {}, h('input', { type: 'checkbox', checked: S.view.showLyrics,
    onchange: e => { S.view.showLyrics = e.target.checked; saveView(); renderScore(); } }), 'Lyrics'));
  list.append(h('label', {}, h('input', { type: 'checkbox', checked: S.view.showChords,
    onchange: e => { S.view.showChords = e.target.checked; saveView(); renderScore(); } }), 'Chords'));
  const cm = h('select', { onchange: e => { S.view.chordMode = e.target.value; saveView(); renderScore(); } },
    ['names', 'numbers', 'both'].map(v => h('option', { value: v, selected: S.view.chordMode === v },
      { names: 'Chord names (G, D, Em)', numbers: 'Numbers (1, 5, 6m)', both: 'Names + numbers' }[v])));
  list.append(h('div', { class: 'inline-ctl' }, 'Show chords as', cm));
  const mel = s.parts.find(p => p.id === 'melody');
  if (mel) list.append(h('div', { class: 'inline-ctl' },
    h('button', { class: 'btn small', onclick: async () => {
      if (!await confirmBox('Start my part again?', 'Your part will be replaced with the melody. You can undo this.', 'Replace')) return;
      edit(() => { myPart().notes = mel.notes.map(n => ({ b: n.b, d: n.d, p: n.p })); S.view.partView = myPart().id; });
    } }, 'Reset my part to the melody')));
  box.append(list);
}

function renderSettings() {
  const s = S.song, box = $('#settings');
  box.innerHTML = '';
  box.append(h('div', { class: 'layer-list' },
    h('div', {}, `Tempo about ${Math.round(s.tempo || 0)} beats per minute${s.duration ? ` · ${Math.floor(s.duration / 60)}:${String(Math.round(s.duration % 60)).padStart(2, '0')} long` : ''}`),
    h('div', { class: 'inline-ctl' }, 'Time signature',
      h('select', { onchange: e => changeMeter(e.target.value) },
        ['2/4', '3/4', '4/4', '5/4', '6/8', '9/8', '12/8'].map(t => h('option', { value: t, selected: Theory.meter(s).text === t },
          t + ({ '6/8': ' (2 beats a bar)', '9/8': ' (3 beats a bar)', '12/8': ' (4 beats a bar)' }[t] || ''))))),
    h('div', { class: 'inline-ctl' }, 'Tempo marking',
      h('input', { type: 'text', value: s.tempoText || '', placeholder: 'e.g. Steady, Gently, Driving', style: 'max-width:200px',
        onchange: e => edit(() => { s.tempoText = e.target.value.trim(); }, { light: true }) }),
      h('span', { class: 'muted' }, `♩ = ${Math.round(s.tempo || 0)}`)),
    h('div', { class: 'inline-ctl' }, 'Cursor not on the note when you hear it?',
      h('button', { class: 'btn small', onclick: () => nudge(-25) }, '◀ Cursor earlier'),
      h('button', { class: 'btn small', onclick: () => nudge(25) }, 'Cursor later ▶'),
      h('span', { class: 'muted' }, s.nudgeMs ? `${s.nudgeMs > 0 ? '+' : ''}${s.nudgeMs} ms` : 'not adjusted')),
    h('div', { class: 'inline-ctl' }, 'Bar lines in the wrong place?',
      h('button', { class: 'btn small', onclick: () => shiftBars(-1) }, '◀ 1 beat earlier'),
      h('button', { class: 'btn small', onclick: () => shiftBars(1) }, '1 beat later ▶')),
    S.where === 'server' && S.urls.audio ? h('div', { class: 'inline-ctl' },
      h('a', { class: 'btn small', href: S.urls.audio, download: safeName(s.title) + '.mp3' }, 'Download MP3'),
      S.urls.video ? h('a', { class: 'btn small', href: S.urls.video, download: safeName(s.title) + '.mp4' }, 'Download MP4') : null) : null));
}

function renderScore() {
  const s = S.song;
  const parts = shownParts();
  const empty = $('#emptyScore');
  const hasNotes = parts.some(p => p.notes.length) || s.lyrics.length || s.chords.length;
  if (!s.beats && !hasNotes) {
    $('#score').innerHTML = '';
    empty.classList.remove('hidden');
    empty.innerHTML = '';
    empty.append(h('p', {}, 'This song only has the audio so far. You can listen and loop, but there\'s no sheet music yet.'),
      h('p', {}, S.where === 'server' ? 'Go back to the song list and tap "Work out music".' : 'Send it to the PC to work out the music.'));
    S.layout = null;
    return;
  }
  empty.classList.add('hidden');
  if (!parts.length) parts.push(myPart());
  const scrollY = window.scrollY;
  const width = Math.min($('#scoreWrap').clientWidth - 16, 1400);
  try {
    S.layout = Score.render($('#score'), s, { width: (typeof Stage !== 'undefined' && Stage.on) ? window.innerWidth - 24 : width, zoom: (typeof Stage !== 'undefined' && Stage.on) ? Stage.zoom() : S.view.zoom, parts, showLyrics: S.view.showLyrics,
      showChords: S.view.showChords, chordMode: S.view.chordMode, sel: S.sel, showFing: S.view.showFing !== false,
      showTempo: S.view.showTempo !== false, colorOf: Practice.colorOf });
  } catch (e) {
    console.error(e);
    toast('Drawing problem: ' + e.message, 5000);
  }
  window.scrollTo(0, scrollY);
  if ((typeof Stage !== 'undefined' && Stage.on)) Stage.layout();
  drawOverlays();
  renderSecChips();
  updateCursor(true);
}

// ---------------------------------------------------------------- sections, instrument, time signature
function sectionAt(beat) { return [...(S.song.sections || [])].sort((a, b) => a.b - b.b).filter(x => x.b <= beat + 1e-6).pop(); }
function sectionRange(sec) {
  const all = [...S.song.sections].sort((a, b) => a.b - b.b), i = all.indexOf(sec);
  const end = all[i + 1] ? all[i + 1].b : (S.layout ? S.layout.m1 * S.song.beatsPerBar : sec.b + 4 * S.song.beatsPerBar);
  return { from: sec.b, to: end };
}
function renderSecChips() {
  const box = $('#secChips'), secs = [...(S.song.sections || [])].sort((a, b) => a.b - b.b);
  box.innerHTML = '';
  box.classList.toggle('hidden', !secs.length);
  for (const sc of secs) box.append(h('button', { class: 'chip', title: 'Jump here', onclick: () => {
    S.player.seekBeat(sc.b); updateCursor(true);
    const pos = S.layout && Score.beatToX(S.layout, sc.b);
    if (pos && pos.sys >= 0) { const r = S.layout.systems[pos.sys].div.getBoundingClientRect(); window.scrollTo({ top: window.scrollY + r.top - 130, behavior: 'smooth' }); }
  } }, sc.name));
}
async function editSection(sec, beat) {
  const names = ['Intro', 'Verse 1', 'Verse 2', 'Verse 3', 'Pre-chorus', 'Chorus', 'Bridge', 'Instrumental', 'Solo', 'Tag', 'Ending'];
  const inp = h('input', { type: 'text', value: sec ? sec.name : '', list: 'secNames', placeholder: 'e.g. Chorus' });
  const dl = h('datalist', { id: 'secNames' }, names.map(n => h('option', { value: n })));
  const quick = h('div', { class: 'chips-row' }, names.map(n => h('button', { class: 'chip', onclick: () => { inp.value = n; } }, n)));
  const r = await modal(h('div', {}, h('h3', {}, sec ? 'Section' : `New section at bar ${barNo(Math.floor(beat / S.song.beatsPerBar))}`), inp, dl, quick),
    sec ? [['Delete', 'del', 'danger'], ['Cancel', null], ['Save', 'ok', 'primary']] : [['Cancel', null], ['Add', 'ok', 'primary']]);
  if (r === 'del') edit(() => S.song.sections.splice(S.song.sections.indexOf(sec), 1));
  else if (r === 'ok' && inp.value.trim()) edit(() => {
    if (sec) sec.name = inp.value.trim();
    else { S.song.sections = S.song.sections.filter(x => Math.abs(x.b - beat) > 1e-6); S.song.sections.push({ b: beat, name: inp.value.trim() }); }
  });
}
function instrumentOptions(sel) {
  return ['Strings', 'Woodwind', 'Brass', 'Other'].map(gr => h('optgroup', { label: gr },
    Object.entries(Theory.INSTRUMENTS).filter(([, v]) => v.group === gr).map(([k, v]) => h('option', { value: k, selected: k === sel }, v.name))));
}
function changeMyInstrument(k) {
  const me = myPart(), ins = Theory.INSTRUMENTS[k];
  edit(() => {
    const moved = Arrange.fitRange(me.notes, ins, 6);
    me.notes.forEach((n, i) => { n.p = moved[i].p; if (!ins.open) delete n.fing; });
    me.instrument = k;
    if (me.name && /^My .* part$/.test(me.name)) me.name = `My ${shortName(k)} part`;
  });
  if (S.player.synthOn) S.player.setSynth(true, null, synthPartId());
  toast(`Your part is now for ${ins.name}${ins.tr ? `, written in ${Theory.keyName(Theory.writtenKey(S.song.key, ins))}` : ''}`, 3500);
}
function autoFingering(p) {
  edit(() => { for (const n of p.notes) { const f = Theory.fingering(n.p, p.instrument); if (f !== '') n.fing = f; else delete n.fing; } });
  const missing = p.notes.filter(n => n.fing == null).length;
  toast(missing ? `Fingerings added. ${missing} notes are above 1st position and were left blank.` : 'Fingerings added', 4000);
}
// Change the time signature. Between x/4 and compound x/8 with a different number of beats
// per bar (3/4 <-> 6/8) the bar lines stay where they are and the beats are re-spaced.
function changeMeter(ts) {
  const s = S.song, old = Theory.meter(s);
  const [num, den] = ts.split('/').map(Number);
  const nb = den === 8 && num % 3 === 0 ? num / 3 : num;
  edit(() => {
    s.meterSetByUser = true;
    if (den === 4) delete s.timeSig; else s.timeSig = ts;
    if (nb !== old.bpb && (den === 8 || old.den === 8)) {
      const ob = old.bpb, f = nb / ob;
      const conv = b => { const bar = Math.floor(b / ob + 1e-9); return +(bar * nb + (b - bar * ob) * f).toFixed(4); };
      if (s.beats) {
        const T = b => Timeline.oTime(s, b), n = Math.ceil(s.beats.length / ob) * nb + nb;
        s.beats = Array.from({ length: n }, (_, i) => +T(Math.floor(i / nb) * ob + (i % nb) / f).toFixed(4));
        s.tempo = +(s.tempo / f).toFixed(1);
      }
      for (const p of s.parts) for (const n of p.notes) { const e = conv(n.b + n.d); n.b = conv(n.b); n.d = +(e - n.b).toFixed(4); }
      for (const c of s.chords) { const e = conv(c.beat + c.dur); c.beat = conv(c.beat); c.dur = +(e - c.beat).toFixed(4); }
      for (const w of s.lyrics) w.b = conv(w.b);
      for (const x of s.sections || []) x.b = conv(x.b);
      for (const i of s.inserts || []) { i.len = Math.round(i.len * f); i.at = conv(i.at); if (i.fill) i.fill.from = conv(i.fill.from); }
    }
    s.beatsPerBar = nb;
  });
  S.player.song = S.song;
}

function drawOverlays() {
  if (!S.layout) return;
  const z = S.layout.zoom, bpb = S.song.beatsPerBar;
  const hasIns = (S.song.inserts || []).length > 0;
  for (const sys of S.layout.systems) {
    sys.overlay.querySelectorAll('.loop-hl, .ins-hl').forEach(e => e.remove());
    const lp = S.player.loop;
    for (const m of sys.measures) {
      const mb = m.m * bpb;
      const st = `left:${m.x0 * z}px;width:${(m.x1 - m.x0) * z}px`;
      if (hasIns && Timeline.locate(S.song, mb).gap) sys.overlay.append(h('div', { class: 'ins-hl', style: st }, h('span', {}, 'added')));
      if ((lp && mb >= lp.from && mb < lp.to) || (S.loopPick != null && m.m === S.loopPick)) sys.overlay.append(h('div', { class: 'loop-hl', style: st }));
    }
  }
}

let lastSys = -1;
function updateCursor(force) {
  if (!S.song) return;
  const beat = S.player.beat;
  const bpb = S.song.beatsPerBar;
  const m0 = S.layout ? S.layout.m0 : 0;
  $('#tBar').textContent = `Bar ${Math.max(1, Math.floor(beat / bpb) - m0 + 1)}${S.layout ? ' / ' + (S.layout.m1 - m0) : ''}`;
  $('#tPlay').textContent = S.player.playing ? '❚❚' : '▶';
  if (!S.layout) return;
  const pos = Score.beatToX(S.layout, beat);
  let cur = $('#score .cursor');
  if (pos.sys < 0) { if (cur) cur.remove(); return; }
  const sys = S.layout.systems[pos.sys];
  if (!cur || cur.parentElement !== sys.overlay) {
    if (cur) cur.remove();
    $$('#score .bar-hl').forEach(e => e.remove());
    cur = h('div', { class: 'cursor' });
    sys.overlay.append(cur);
  }
  cur.style.left = ((pos.x + Score.HEAD) * S.layout.zoom - 1) + 'px';
  let hl = sys.overlay.querySelector('.bar-hl');
  if (!hl) { hl = h('div', { class: 'bar-hl' }); sys.overlay.prepend(hl); }
  hl.style.left = pos.meas.x0 * S.layout.zoom + 'px';
  hl.style.width = (pos.meas.x1 - pos.meas.x0) * S.layout.zoom + 'px';
  if ((typeof Stage !== 'undefined' && Stage.on)) Stage.follow(pos.sys);
  else if (S.view.follow && S.player.playing && (pos.sys !== lastSys || force)) {
    const r = sys.div.getBoundingClientRect();
    const top = 60 + $('.score-head').offsetHeight;
    const bottom = window.innerHeight - $('#transport').offsetHeight;
    if (r.top < top || r.bottom > bottom - 10 || pos.sys !== lastSys) {
      window.scrollTo({ top: window.scrollY + r.top - top - 10, behavior: 'smooth' });
    }
  }
  lastSys = pos.sys;
}
S.player.onTick = () => updateCursor();

// ---------------------------------------------------------------- insert bars
function barNo(m) { return m - (S.layout ? S.layout.m0 : 0) + 1; }
function mOf(no) { return no - 1 + (S.layout ? S.layout.m0 : 0); }

async function insertBarsDialog() {
  const s = S.song, bpb = s.beatsPerBar, part = curPart();
  const nBars = S.layout ? S.layout.m1 - S.layout.m0 : 1;
  let def = Math.floor(S.player.beat / bpb);
  const sn = selNote();
  if (sn) def = Math.floor(sn.b / bpb); else if (S.sel && S.sel.rest) def = Math.floor(S.sel.rest.s / bpb);
  const num = (v, min, max) => h('input', { type: 'number', value: v, min, max, inputmode: 'numeric' });
  const atInp = num(Math.max(1, Math.min(nBars + 1, barNo(def))), 1, nBars + 1), cntInp = num(2, 1, 32);
  const sndSel = h('select', {}, h('option', { value: 'silence' }, 'Silence (only the parts you write)'),
    TRACK_KEYS.filter(k => S.urls[k]).map(k => h('option', { value: k }, 'Repeat the music: ' + TRACK_NAMES[k].toLowerCase())));
  const fromInp = num(Math.max(1, barNo(def) - 2), 1, nBars);
  const chordChk = h('input', { type: 'checkbox' });
  const notesSel = h('select', {}, h('option', { value: 'empty' }, 'Empty bars (I\'ll write the notes)'),
    h('option', { value: 'suggest' }, `Suggest a fill for "${partLabel(part)}"`),
    h('option', { value: 'copy' }, 'Copy the notes and words from the model bars'));
  const fromRow = h('label', {}, 'Model bars start at bar', fromInp);
  const chordRow = h('label', { class: 'chk' }, chordChk, ' Copy the chords from the model bars');
  const upd = () => {
    const need = sndSel.value !== 'silence' || notesSel.value === 'copy' || chordChk.checked;
    fromRow.classList.toggle('hidden', !need);
  };
  [sndSel, notesSel].forEach(e => e.addEventListener('change', () => { if (sndSel.value !== 'silence' || notesSel.value !== 'empty') chordChk.checked = true; upd(); }));
  chordChk.addEventListener('change', upd);
  const existing = Timeline.gaps(s);
  const list = existing.length ? h('div', {}, h('div', { class: 'mini-label' }, 'Bars you added'),
    existing.map(g => h('div', { class: 'part-row' },
      h('div', {}, `Bars ${barNo(g.nb0 / bpb)}–${barNo((g.nb0 + g.ins.len) / bpb) - 1}`, h('span', { class: 'muted' }, g.ins.fill ? ' · repeats music' : ' · silent')),
      h('button', { class: 'btn small danger', onclick: () => { $('#modal').classList.add('hidden'); removeInsert(g); } }, 'Remove')))) : null;
  const body = h('div', { class: 'add-part' }, h('h3', {}, 'Add empty bars'),
    h('p', { class: 'muted' }, 'Makes room anywhere in the song, for an intro, a solo or a fill. The recording waits while these bars play.'),
    h('div', { class: 'row' }, h('label', {}, 'How many bars', cntInp), h('label', {}, 'Put them before bar', atInp)),
    h('div', { class: 'row' }, h('label', {}, 'Sound during these bars', sndSel), h('label', {}, 'Notes', notesSel)),
    h('div', { class: 'row' }, fromRow), chordRow, list);
  upd();
  if (!await modal(body, [['Cancel', false], ['Add bars', true, 'primary']])) return;
  const cnt = Math.max(1, Math.min(32, +cntInp.value || 1));
  const at = Math.max(1, Math.min(nBars + 1, +atInp.value || 1));
  const from = Math.max(1, Math.min(nBars, +fromInp.value || 1));
  insertBars(mOf(at), cnt, { sound: sndSel.value, from: mOf(from), chords: chordChk.checked, notes: notesSel.value, part });
}

function insertBars(m, nBars, o) {
  const s = S.song, bpb = s.beatsPerBar, L = nBars * bpb, nb0 = m * bpb, srcB = o.from * bpb;
  const loc = Timeline.locate(s, nb0);
  const srcOrig = Timeline.locate(s, srcB).orig;
  const cut = (b, d) => Math.min(b + d, srcB + L) - Math.max(b, srcB);
  const useModel = o.sound !== 'silence' || o.notes === 'copy' || o.chords;
  S.player.pause();
  edit(() => {
    const srcChords = s.chords.filter(c => c.beat < srcB + L && c.beat + c.dur > srcB)
      .map(c => ({ ...c, beat: Math.max(c.beat, srcB) - srcB, dur: cut(c.beat, c.dur) }));
    const srcNotes = s.parts.map(p => p.notes.filter(n => n.b >= srcB && n.b < srcB + L)
      .map(n => ({ b: n.b - srcB, d: Math.min(n.d, srcB + L - n.b), p: n.p })));
    const srcLyr = s.lyrics.filter(w => w.b >= srcB && w.b < srcB + L).map(w => ({ ...w, b: w.b - srcB }));
    const before = [...s.chords].sort((a, b) => a.beat - b.beat).filter(c => c.beat < nb0).pop();
    // make room
    const push = (b, d) => b >= nb0 ? [b + L, d] : [b, b + d > nb0 ? nb0 - b : d];
    for (const p of s.parts) for (const n of p.notes) { [n.b, n.d] = push(n.b, n.d); if (n.slur && n.b < nb0) delete n.slur; }
    for (const c of s.chords) [c.beat, c.dur] = push(c.beat, c.dur);
    for (const w of s.lyrics) if (w.b >= nb0) w.b += L;
    s.inserts = s.inserts || [];
    const same = s.inserts.find(i => i.at === loc.orig);
    if (same) same.len += L;
    else s.inserts.push({ at: loc.orig, len: L, fill: o.sound !== 'silence' ? { from: srcOrig, track: o.sound } : null });
    // fill them
    let newChords = [];
    if (o.chords && useModel) newChords = srcChords.map(c => ({ ...c, beat: c.beat + nb0 }));
    s.chords.push(...newChords);
    s.chords.sort((a, b) => a.beat - b.beat);
    if (o.notes === 'copy') {
      s.parts.forEach((p, i) => p.notes.push(...srcNotes[i].map(n => ({ ...n, b: n.b + nb0 }))));
      s.lyrics.push(...srcLyr.map(w => ({ ...w, b: w.b + nb0 })));
      s.lyrics.sort((a, b) => a.b - b.b);
    }
    if (o.notes === 'suggest') {
      const ch = newChords.length ? newChords : [{ beat: nb0, dur: L, root: before ? before.root : s.key.tonic, quality: before ? before.quality : (s.key.mode === 'minor' ? 'min' : 'maj') }];
      const near = o.part.notes.filter(n => n.b < nb0).slice(-6).map(n => n.p);
      const center = near.length ? near.sort((a, b) => a - b)[Math.floor(near.length / 2)] : Theory.inst(o.part).center;
      o.part.notes.push(...Arrange.fill(s, Theory.inst(o.part), nb0, nb0 + L, ch, center));
    }
    S.sel = null;
  });
  S.player.loop = null; $('#tLoop').classList.remove('on'); $('#tLoop').textContent = '⟲ Loop';
  S.player.seekBeat(Math.max(0, nb0 - bpb));
  toast(`Added ${nBars} bar${nBars > 1 ? 's' : ''}. Press play to hear how it fits.`, 6000, { label: 'Undo', fn: undo });
}

function removeInsert(g) {
  const s = S.song, nb0 = g.nb0, L = g.ins.len;
  S.player.pause();
  edit(() => {
    for (const p of s.parts) {
      p.notes = p.notes.filter(n => !(n.b >= nb0 && n.b < nb0 + L));
      for (const n of p.notes) if (n.b >= nb0 + L) n.b -= L;
    }
    s.chords = s.chords.filter(c => !(c.beat >= nb0 && c.beat < nb0 + L));
    for (const c of s.chords) if (c.beat >= nb0 + L) c.beat -= L;
    s.lyrics = s.lyrics.filter(w => !(w.b >= nb0 && w.b < nb0 + L));
    for (const w of s.lyrics) if (w.b >= nb0 + L) w.b -= L;
    s.inserts = s.inserts.filter(i => i !== g.ins && i.at !== g.ins.at);
    S.sel = null;
  });
  S.player.loop = null; $('#tLoop').classList.remove('on'); $('#tLoop').textContent = '⟲ Loop';
  S.player.seekBeat(Math.max(0, nb0 - s.beatsPerBar));
  toast('Removed the added bars');
}

// ---------------------------------------------------------------- video export
// "Which bars" picker shared by video and PDF export: whole song, a section, or bars a-b.
function rangePicker() {
  const s = S.song, bpb = s.beatsPerBar, full = Score.songRange(s);
  const secs = [...(s.sections || [])].sort((a, b) => a.b - b.b);
  const sel = h('select', {}, h('option', { value: 'all' }, 'Whole song'),
    secs.map((sc, i) => h('option', { value: 's' + i }, 'Section: ' + sc.name)),
    S.player.loop ? h('option', { value: 'loop' }, 'The looped bars') : null,
    h('option', { value: 'bars' }, 'Bars…'));
  const a = h('input', { type: 'number', min: 1, value: 1, style: 'width:70px' }), b = h('input', { type: 'number', min: 1, value: full.m1 - full.m0, style: 'width:70px' });
  const bars = h('span', { class: 'inline-ctl hidden' }, 'from', a, 'to', b);
  sel.addEventListener('change', () => bars.classList.toggle('hidden', sel.value !== 'bars'));
  const get = () => {
    const v = sel.value;
    if (v === 'all') return null;
    if (v === 'loop') return { m0: Math.floor(S.player.loop.from / bpb), m1: Math.ceil(S.player.loop.to / bpb) };
    if (v === 'bars') { const x = Math.max(1, +a.value || 1), y = Math.max(x, +b.value || x); return { m0: full.m0 + x - 1, m1: full.m0 + y }; }
    const sc = secs[+v.slice(1)], r = sectionRange(sc);
    return { m0: Math.floor(r.from / bpb), m1: Math.ceil(r.to / bpb), name: sc.name };
  };
  return { el: h('label', {}, 'Which bars', sel, bars), get, label: () => sel.options[sel.selectedIndex].textContent.replace('Section: ', '') };
}

async function exportVideoDialog() {
  if (!Video.supported()) return toast('This browser can\'t make videos. Use Chrome or Edge.', 5000);
  const s = S.song, cur = shownPartId();
  const showSel = h('select', {}, s.parts.map(p => h('option', { value: p.id, selected: p.id === cur }, partLabel(p))),
    s.parts.length > 1 ? h('option', { value: 'all', selected: cur === 'all' }, 'All parts together') : null);
  const trkSel = h('select', {}, TRACK_KEYS.filter(k => S.urls[k]).map(k => h('option', { value: k, selected: k === S.player.track }, 'Recording: ' + TRACK_NAMES[k].toLowerCase())),
    h('option', { value: 'none' }, 'No recording (only the parts below)'));
  const hear = s.parts.map(p => h('input', { type: 'checkbox', value: p.id, checked: S.player.synthOn && S.player.synthParts.includes(p.id) }));
  const sizeSel = h('select', {}, h('option', { value: '1920x1080', selected: window.innerWidth > 900 }, 'Full HD (1080p)'),
    h('option', { value: '1280x720', selected: window.innerWidth <= 900 }, 'HD (720p), smaller and faster'));
  const denSel = h('select', {}, h('option', { value: 10 }, 'Whole page: about 10 bars a line'),
    h('option', { value: 6, selected: true }, 'Medium: about 6 bars a line'), h('option', { value: 4 }, 'Big notes: about 4 bars a line'));
  const rp = rangePicker();
  const corner = h('input', { type: 'checkbox', checked: !!S.urls.video });
  const body = h('div', { class: 'add-part' }, h('h3', {}, 'Make a play-along video'),
    h('div', { class: 'row' }, h('label', {}, 'Sheet music to show', showSel), h('label', {}, 'Sound', trkSel)),
    h('div', { class: 'row' }, rp.el),
    S.urls.video ? h('label', { class: 'chk' }, corner, ' Show the original video in the corner') : null,
    h('div', { class: 'mini-label' }, 'Also play these parts (instrument sound)'),
    h('div', { class: 'checks' }, s.parts.map((p, i) => h('label', {}, hear[i], ` ${partLabel(p)} · ${Theory.inst(p).name}`))),
    h('div', { class: 'row' }, h('label', {}, 'Layout', denSel), h('label', {}, 'Size', sizeSel)),
    h('p', { class: 'muted' }, 'Tip: show your part and choose "no vocals" to practise carrying the tune, or untick your part to play it yourself.'));
  if (!await modal(body, [['Cancel', false], ['Make video', true, 'primary']])) return;
  const hearParts = hear.filter(c => c.checked).map(c => c.value);
  if (trkSel.value === 'none' && !hearParts.length) return toast('Choose a recording or at least one part to hear');
  const [w, hgt] = sizeSel.value.split('x').map(Number);
  const parts = showSel.value === 'all' ? s.parts.slice() : [s.parts.find(p => p.id === showSel.value)];
  const opts = { parts, track: trkSel.value, hearParts, width: w, height: hgt, perLine: +denSel.value, fps: 24,
    range: rp.get(), corner: !!S.urls.video && corner.checked, showFing: S.view.showFing !== false,
    showLyrics: S.view.showLyrics, showChords: S.view.showChords, chordMode: S.view.chordMode,
    partLabel: showSel.value === 'all' ? 'All parts' : partLabel(parts[0]) };

  S.player.pause();
  let cancelled = false;
  const bar = h('div', { class: 'progress' }, h('div')), msg = h('p', {}, 'Getting ready…');
  modal(h('div', {}, h('h3', {}, 'Making your video'), msg, bar,
    h('p', { class: 'muted' }, 'Keep this page open. A 4-minute song takes a few minutes.')), [['Cancel', 'c']]).then(v => { if (v === 'c') cancelled = true; });
  let blob = null;
  try {
    blob = await Video.make(s, S.urls, opts, (t, f) => { msg.textContent = t; bar.firstChild.style.width = (f * 100) + '%'; }, () => cancelled);
  } catch (e) {
    console.error(e);
    $('#modal').classList.add('hidden');
    return toast('Could not make the video: ' + (e.message || e), 6000);
  }
  $('#modal').classList.add('hidden');
  if (!blob) return toast('Video cancelled');
  const name = safeName(s.title) + (showSel.value === 'all' ? '' : ' - ' + safeName(partLabel(parts[0]))) + (opts.range ? ' - ' + safeName(rp.label()) : '') + '.mp4';
  const url = URL.createObjectURL(blob);
  const again = async () => {
    const r = await modal(h('div', {}, h('h3', {}, 'Your video is ready'),
      h('video', { src: url, controls: true, playsinline: true, style: 'width:100%;border-radius:8px;background:#000' }),
      h('p', { class: 'muted' }, `${name} · ${(blob.size / 1048576).toFixed(1)} MB`)), [['Close', null], ['Save / share video', 'save', 'primary']]);
    if (r === 'save') {
      const res = await shareOrDownload(blob, name, s.title);
      if (res === 'failed') toast('Saving isn\'t available here.', 4000);
      else if (res === 'downloaded' || res === 'saved') toast('Video saved', 3000);
      return again();
    }
    URL.revokeObjectURL(url);
  };
  again();
}

async function exportPdfDialog() {
  const s = S.song, cur = shownPartId();
  const showSel = h('select', {}, s.parts.map(p => h('option', { value: p.id, selected: p.id === cur }, partLabel(p))),
    s.parts.length > 1 ? h('option', { value: 'all', selected: cur === 'all' }, 'All parts together (score)') : null);
  const denSel = h('select', {}, h('option', { value: 5 }, 'Normal: about 5 bars a line'), h('option', { value: 4, selected: true }, 'Bigger: about 4 bars a line'),
    h('option', { value: 3 }, 'Large print: about 3 bars a line'));
  const rp = rangePicker();
  if (!await modal(h('div', { class: 'add-part' }, h('h3', {}, 'Sheet music PDF'),
    h('div', { class: 'row' }, h('label', {}, 'Part', showSel), h('label', {}, 'Size', denSel)), h('div', { class: 'row' }, rp.el),
    h('p', { class: 'muted' }, 'Shows what\'s switched on under Parts & display: chords, lyrics, fingerings.')),
    [['Cancel', false], ['Make PDF', true, 'primary']])) return;
  const parts = showSel.value === 'all' ? s.parts.slice() : [s.parts.find(p => p.id === showSel.value)];
  toast('Making the PDF…', 10000);
  try {
    const blob = await Exports.pdf(s, { parts, perLine: +denSel.value, range: rp.get(), showLyrics: S.view.showLyrics, showChords: S.view.showChords,
      chordMode: S.view.chordMode, showFing: S.view.showFing !== false, subtitle: showSel.value === 'all' ? 'Score' : partLabel(parts[0]) });
    const name = safeName(s.title) + (showSel.value === 'all' ? '' : ' - ' + safeName(partLabel(parts[0]))) + '.pdf';
    const r = await shareOrDownload(blob, name, s.title);
    toast(r === 'failed' ? 'Saving isn\'t available here.' : r === 'cancelled' ? 'Cancelled' : 'PDF saved', 3000);
  } catch (e) { console.error(e); toast('Could not make the PDF: ' + e.message, 5000); }
}

// ---------------------------------------------------------------- parts
const newPartId = () => 'p' + Math.random().toString(36).slice(2, 8);

function renamePart(p) {
  ask('Rename part', '', p.name).then(t => { if (t && t.trim()) edit(() => { p.name = t.trim(); }); });
}
function deletePart(p) {
  edit(() => {
    S.song.parts.splice(S.song.parts.indexOf(p), 1);
    if (S.view.partView === p.id) S.view.partView = myPart().id;
    S.sel = null;
  });
  saveView();
  toast(`Deleted "${partLabel(p)}"`, 6000, { label: 'Undo', fn: undo });
}
const fixedPart = p => p.id === 'melody' || p === myPart();

const PART_KINDS = [
  ['counter', 'Countermelody', 'A second tune that moves when the singer holds a note or breathes, and stays still when the singer is busy.'],
  ['duet', 'Duet / harmony', 'Harmony in 3rds and 6ths with the same rhythm as the melody. Great for two violins.'],
  ['easy', 'Easier version', 'A simpler copy of a part: fewer, longer notes, in 1st position.'],
  ['copy', 'Copy of a part', 'The melody or your part, set up for another instrument.'],
  ['empty', 'Empty part', 'Start from rests and write your own.'],
  ['import', "Someone else's part", 'From a song file a bandmate or teacher sent you (.vsong or .zip).'],
];

async function addPartDialog(preset = {}) {
  const s = S.song;
  const hasChords = s.chords.length > 0;
  const mel = s.parts.find(p => p.id === 'melody') || myPart();
  let kind = preset.kind || (hasChords ? 'counter' : 'copy');

  const kindBox = h('div', { class: 'kind-list' });
  const instSel = h('select', {}, ['Strings', 'Woodwind', 'Brass', 'Other'].map(gr => h('optgroup', { label: gr },
    Object.entries(Theory.INSTRUMENTS).filter(([, v]) => v.group === gr).map(([k, v]) =>
      h('option', { value: k, selected: k === (preset.inst || 'violin') }, v.name)))));
  const partOpts = sel => s.parts.map(p => h('option', { value: p.id, selected: p.id === sel }, partLabel(p)));
  const srcSel = h('select', {}, partOpts(preset.src || (preset.kind === 'easy' || !preset.kind ? myPart().id : mel.id)));
  const lvlSel = h('select', {},
    h('option', { value: 1 }, '1 · A bit easier (no 16ths, 1st position)'),
    h('option', { value: 2, selected: true }, '2 · Easier (one note per beat)'),
    h('option', { value: 3 }, '3 · Very easy (long notes)'));
  const posSel = h('select', {}, h('option', { value: 'below' }, 'Below the melody'), h('option', { value: 'above' }, 'Above the melody'));
  const fileInp = h('input', { type: 'file', accept: '.vsong,.zip,application/zip,application/octet-stream' });
  const nameInp = h('input', { type: 'text' });
  let nameTouched = false;
  nameInp.addEventListener('input', () => nameTouched = true);

  const rows = {
    inst: h('label', {}, 'Instrument', instSel),
    src: h('label', {}, 'Based on', srcSel),
    lvl: h('label', {}, 'How easy', lvlSel),
    pos: h('label', {}, 'Where', posSel),
    file: h('label', {}, 'Song file', fileInp),
    name: h('label', {}, 'Name', nameInp),
  };
  const show = {
    counter: ['inst', 'pos', 'name'], duet: ['inst', 'pos', 'name'], easy: ['src', 'lvl', 'inst', 'name'],
    copy: ['src', 'inst', 'name'], empty: ['inst', 'name'], import: ['file'],
  };
  const autoName = () => {
    if (nameTouched) return;
    const ins = Theory.INSTRUMENTS[instSel.value].name;
    const sfx = instSel.value === 'violin' ? '' : ` (${ins})`;
    const src = s.parts.find(p => p.id === srcSel.value);
    nameInp.value = {
      counter: `Countermelody${posSel.value === 'above' ? ' (high)' : ''}${sfx}`, duet: `Duet ${posSel.value === 'above' ? 'above' : 'below'}${sfx}`,
      easy: `${src ? partLabel(src) : 'Part'}, easy ${lvlSel.value}${sfx}`,
      copy: `${src ? partLabel(src) : 'Part'} (${ins})`, empty: `${ins} part`, import: '',
    }[kind];
  };
  const refresh = () => {
    for (const k in rows) rows[k].classList.toggle('hidden', !show[kind].includes(k));
    kindBox.querySelectorAll('.kind').forEach(el => el.classList.toggle('on', el.dataset.k === kind));
    autoName();
  };
  for (const [k, title, desc] of PART_KINDS) {
    const disabled = (k === 'counter' || k === 'duet') && !hasChords;
    kindBox.append(h('button', { class: 'kind', 'data-k': k, disabled, onclick: () => { kind = k; nameTouched = false; refresh(); } },
      h('b', {}, title), h('span', {}, disabled ? 'Needs the chords worked out first.' : desc)));
  }
  [instSel, srcSel, lvlSel, posSel].forEach(e => e.addEventListener('change', autoName));
  srcSel.addEventListener('change', () => {
    if (kind === 'easy') { const sp = s.parts.find(p => p.id === srcSel.value); if (sp) instSel.value = sp.instrument || 'violin'; autoName(); }
  });
  refresh();

  const ok = await modal(h('div', { class: 'add-part' }, h('h3', {}, 'Add a part'), kindBox,
    h('div', { class: 'row' }, ...Object.values(rows))), [['Cancel', false], ['Add part', true, 'primary']]);
  if (!ok) return;

  if (kind === 'import') {
    const f = fileInp.files[0];
    if (!f) return toast('Choose the song file first');
    return importParts(f);
  }
  const instKey = instSel.value, ins = Theory.INSTRUMENTS[instKey];
  const src = s.parts.find(p => p.id === srcSel.value) || mel;
  const above = posSel.value === 'above';
  let notes = [];
  if (kind === 'counter') notes = Arrange.fitRange(Arrange.countermelody(s, mel, { above }), ins, 8);
  if (kind === 'duet') notes = Arrange.fitRange(Arrange.harmony(s, mel, { above }), ins, 8);
  if (kind === 'copy') notes = Arrange.fitRange(src.notes, ins, 0);
  if (kind === 'easy') notes = Arrange.simplify(Arrange.fitRange(src.notes, ins, 20), +lvlSel.value, ins);
  if ((kind === 'counter' || kind === 'duet') && !notes.length) return toast('Not enough chords or melody to work from');
  const part = { id: newPartId(), name: nameInp.value.trim() || ins.name, instrument: instKey, editable: true, visible: true,
    notes: notes.map(n => ({ b: n.b, d: n.d, p: n.p })), made: kind };
  edit(() => { s.parts.push(part); S.view.partView = part.id; S.sel = null; });
  saveView();
  toast(`Added "${part.name}". Tap Edit to change it, or ✕ on its tab to remove it.`, 6000, { label: 'Undo', fn: undo });
}

async function importParts(file) {
  let other;
  try {
    const zip = await JSZip.loadAsync(file);
    other = JSON.parse(await zip.file('song.json').async('string'));
  } catch (e) { return toast("That isn't a song file"); }
  const parts = (other.parts || []).filter(p => p.notes && p.notes.length);
  if (!parts.length) return toast('That song file has no parts with notes');
  const checks = parts.map(p => h('input', { type: 'checkbox', checked: p.editable }));
  const same = (other.title || '') === (S.song.title || '') || other.id === S.song.id;
  const ok = await modal(h('div', {}, h('h3', {}, `Parts in "${other.title || 'song file'}"`),
    same ? null : h('p', { style: 'color:var(--warn)' }, 'This file looks like a different song. The parts will only line up if it\'s the same recording.'),
    h('div', { class: 'checks' }, parts.map((p, i) => h('label', {}, checks[i], ` ${p.name} · ${Theory.inst(p).name} (${p.notes.length} notes)`)))),
    [['Cancel', false], ['Add these parts', true, 'primary']]);
  if (!ok) return;
  const from = other.title && !same ? ` (${other.title})` : ' (imported)';
  const added = [];
  edit(() => {
    parts.forEach((p, i) => {
      if (!checks[i].checked) return;
      const np = { id: newPartId(), name: (p.id === 'violin' ? 'Violin part' : p.name) + from, instrument: p.instrument || 'violin',
        editable: true, visible: true, notes: p.notes.map(n => ({ ...n })) };
      S.song.parts.push(np); added.push(np);
    });
    if (added.length) S.view.partView = added[0].id;
  });
  toast(added.length ? `Added ${added.length} part${added.length > 1 ? 's' : ''}` : 'Nothing added');
}

// ---------------------------------------------------------------- edits
function snapshot() { return JSON.stringify({ parts: S.song.parts, chords: S.song.chords, lyrics: S.song.lyrics, key: S.song.key,
  beats: S.song.beats, sections: S.song.sections || [], tempoText: S.song.tempoText || '', timeSig: S.song.timeSig, tempo: S.song.tempo, meterSetByUser: !!S.song.meterSetByUser, nudgeMs: S.song.nudgeMs || 0, inserts: S.song.inserts || [], beatsPerBar: S.song.beatsPerBar, transpose: S.song.transpose || 0, title: S.song.title }); }
function restore(js) { Object.assign(S.song, JSON.parse(js)); }
function edit(fn, opts = {}) {
  S.undo.push(snapshot()); if (S.undo.length > 100) S.undo.shift();
  S.redo = [];
  fn();
  undoState();
  S.song.parts.forEach(pp => pp.notes.sort((a, b) => a.b - b.b));
  scheduleSave();
  if (opts.light) renderScore(); else renderAll();
}
function resync() { const b = S.player.beat; S.player.pause(); S.player.seekBeat(Math.max(0, b)); }
function undoState() {
  const u = $('#undoBtn'), r = $('#redoBtn'); if (!u) return;
  u.disabled = !S.undo.length; r.disabled = !S.redo.length;
}
function undo() { if (!S.undo.length) return toast('Nothing to undo'); S.redo.push(snapshot()); restore(S.undo.pop()); S.sel = null; scheduleSave(); resync(); renderAll(); undoState(); toast('Undone', 1500); }
function redo() { if (!S.redo.length) return; S.undo.push(snapshot()); restore(S.redo.pop()); S.sel = null; scheduleSave(); resync(); renderAll(); undoState(); toast('Redone', 1500); }

function scheduleSave() {
  $('#saveState').textContent = 'Saving…';
  clearTimeout(S.saveTimer);
  S.saveTimer = setTimeout(async () => {
    try {
      const st = S.where === 'server' ? Store.server : Store.local;
      const r = await st.save(S.song);
      if (r && r.modified) S.song.modified = r.modified;
      $('#saveState').textContent = 'Saved ✓';
    } catch (e) { $('#saveState').textContent = '⚠ Not saved'; toast('Could not save: ' + e.message, 5000); }
  }, 600);
}

function transpose(n) {
  edit(() => {
    const s = S.song;
    s.key.tonic = Theory.mod(s.key.tonic + n, 12);
    s.transpose = (s.transpose || 0) + n;
    for (const c of s.chords) if (c.root != null) c.root = Theory.mod(c.root + n, 12);
    for (const p of s.parts) for (const nt of p.notes) {
      nt.p += n;
      while (nt.p < 55) nt.p += 12;
      while (nt.p > 96) nt.p -= 12;
    }
  });
  toast(`Now in ${Theory.keyName(S.song.key)}`);
}

// Move the whole beat grid earlier/later against the recording (cursor, parts and videos follow).
function nudge(ms) {
  const s = S.song;
  if (!s.beats) return toast('Work out the music first');
  edit(() => { s.beats = s.beats.map(b => +(b + ms / 1000).toFixed(4)); s.nudgeMs = (s.nudgeMs || 0) + ms; });
  S.player.song = S.song;
}

function shiftBars(n) {
  const s = S.song;
  edit(() => {
    if (n > 0) { if (s.beats) s.beats = s.beats.slice(1); }
    else if (s.beats) { const st = s.beats[1] - s.beats[0]; s.beats = [+(s.beats[0] - st).toFixed(4), ...s.beats]; }
    const d = -n;
    for (const p of s.parts) for (const nt of p.notes) nt.b += d;
    for (const c of s.chords) c.beat += d;
    for (const w of s.lyrics) w.b += d;
    for (const ins of s.inserts || []) { ins.at += d; if (ins.fill) ins.fill.from += d; }
  });
  S.player.song = S.song;
}

function selNote() {
  if (!S.sel || S.sel.idx == null) return null;
  const p = S.song.parts.find(pp => pp.id === S.sel.partId);
  return p && p.editable ? p.notes[S.sel.idx] : null;
}
function selectNote(note) {
  const p = S.song.parts.find(x => x.notes.includes(note)) || myPart();
  S.sel = { partId: p.id, idx: p.notes.indexOf(note) };
}
// The part being edited: the selected one, else the one on screen, else mine.
function curPart() {
  if (S.sel) { const p = S.song.parts.find(x => x.id === S.sel.partId); if (p && p.editable) return p; }
  const p = S.song.parts.find(x => x.id === shownPartId());
  return p && p.editable ? p : myPart();
}

function act(a) {
  const p = curPart();
  const ins = Theory.inst(p);
  const n = selNote();
  const needNote = () => { if (!n) { toast('Tap a note in your part first'); return false; } return true; };
  switch (a) {
    case 'bars': return insertBarsDialog();
    case 'undo': return undo();
    case 'redo': return redo();
    case 'up': case 'down': case 'octUp': case 'octDown': {
      if (!needNote()) return;
      const d = { up: 1, down: -1, octUp: 12, octDown: -12 }[a];
      if (n.p + d < ins.lo) return toast(`That's below the lowest note of the ${ins.name.toLowerCase()}`);
      if (n.p + d > ins.hi) return toast(`That's too high for the ${ins.name.toLowerCase()}`);
      edit(() => { n.p += d; selectNote(n); }, { light: true });
      previewNote(n.p);
      return;
    }
    case 'dot': case 'trip': {
      if (!needNote()) return;
      const q = Theory.meter(S.song).q, quarters = n.d * q, t = Math.round(quarters * 12);
      const isTrip = t % 3 !== 0, isDot = !isTrip && [18, 9, 36, 72].includes(t);
      let nq;
      if (a === 'dot') nq = isDot ? quarters / 1.5 : (isTrip ? quarters * 1.5 * 1.5 : quarters * 1.5);
      else nq = isTrip ? quarters * 1.5 : (isDot ? quarters / 1.5 : quarters) * 2 / 3;
      return setLen(nq / q);
    }
    case 'add': {
      if (!S.sel || !S.sel.rest) return toast('Tap a rest first, then "+ Note"');
      const r = S.sel.rest, q = Theory.meter(S.song).q;
      const onTrip = Math.round(r.s * q * 12) % 3 !== 0;
      const len = Math.min(S.curDur / 4 / q * (onTrip ? 2 / 3 : 1), r.e - r.s);
      const prev = [...p.notes].reverse().find(x => x.b < r.s);
      const nn = { b: r.s, d: +len.toFixed(4), p: prev ? prev.p : ins.center };
      edit(() => { p.notes.push(nn); p.notes.sort((a1, b1) => a1.b - b1.b); selectNote(nn); }, { light: true });
      previewNote(nn.p);
      return;
    }
    case 'del': {
      if (!needNote()) return;
      const r = { s: n.b, e: n.b + n.d };
      edit(() => { p.notes.splice(p.notes.indexOf(n), 1); S.sel = { partId: p.id, rest: r }; }, { light: true });
      return;
    }
    case 'cresc': case 'dim': {
      if (!needNote()) return;
      return edit(() => { n.hp = n.hp && n.hp.type === a ? { type: a, n: n.hp.n + 1 } : { type: a, n: 1 }; selectNote(n); }, { light: true });
    }
    case 'unhp': if (!needNote()) return; return edit(() => { delete n.hp; selectNote(n); }, { light: true });
    case 'ferm': if (!needNote()) return; return edit(() => { if (n.ferm) delete n.ferm; else n.ferm = true; selectNote(n); }, { light: true });
    case 'suggest': return suggestDialog();
    case 'section': {
      const beat = n ? n.b : (S.sel && S.sel.rest ? S.sel.rest.s : S.player.beat);
      const bpb = S.song.beatsPerBar, bar = Math.floor(beat / bpb + 1e-9) * bpb;
      return editSection(S.song.sections.find(x => Math.abs(x.b - bar) < 1e-6), bar);
    }
    case 'slur': if (!needNote()) return; return edit(() => { n.slur = (n.slur || 0) + 1; selectNote(n); }, { light: true });
    case 'unslur': if (!needNote()) return; return edit(() => { delete n.slur; selectNote(n); }, { light: true });
    case 'bowDown': case 'bowUp': {
      if (!needNote()) return;
      const v = a === 'bowDown' ? 'down' : 'up';
      return edit(() => { n.bow = n.bow === v ? undefined : v; selectNote(n); }, { light: true });
    }
    case 'text': {
      if (!needNote()) return;
      ask('Text marking', 'For example: fill, hold, pizz., arco, solo', n.text || '').then(t => {
        if (t == null) return;
        edit(() => { if (t.trim()) n.text = t.trim(); else delete n.text; selectNote(n); }, { light: true });
      });
      return;
    }
  }
}
// u = length in 16th notes (1 = 16th, 4 = quarter, 16 = whole)
function setDur(u) {
  S.curDur = u;
  $$('.edit-bar [data-dur]').forEach(b => b.classList.toggle('on', +b.dataset.dur === u));
  if (selNote()) setLen(u / 4 / Theory.meter(S.song).q);
}
function setLen(beats) {
  const p = curPart(), n = selNote();
  if (!n) return;
  edit(() => {
    n.d = +beats.toFixed(4);
    const end = n.b + n.d;
    for (let j = p.notes.indexOf(n) + 1; j < p.notes.length; j++) {
      const m = p.notes[j];
      if (m.b >= end) break;
      if (m.b + m.d <= end) { m.d = 0; continue; }
      m.d = +(m.b + m.d - end).toFixed(4); m.b = end;
    }
    p.notes = p.notes.filter(x => x.d > 0);
    selectNote(n);
  }, { light: true });
}

let previewCtx = null;
function previewNote(midi) {
  try {
    previewCtx = previewCtx || new (window.AudioContext || window.webkitAudioContext)();
    const c = previewCtx, t = c.currentTime;
    const o = c.createOscillator(), g = c.createGain();
    o.type = 'triangle'; o.frequency.value = 440 * Math.pow(2, (midi - 69) / 12);
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.25, t + 0.02); g.gain.linearRampToValueAtTime(0, t + 0.45);
    o.connect(g); g.connect(c.destination); o.start(t); o.stop(t + 0.5);
  } catch (e) { }
}

function setEditing(on) {
  S.editing = on;
  document.body.classList.toggle('editing', on);
  $('#editBar').classList.toggle('hidden', !on);
  $('#editBtn').classList.toggle('on', on);
  $('#editBtn').textContent = on ? '✓ Done' : '✎ Edit';
  if (!on) S.sel = null;
  $$('.edit-bar [data-dur]').forEach(b => b.classList.toggle('on', +b.dataset.dur === S.curDur));
  if (S.song) renderScore();
}

// ---------------------------------------------------------------- drag notes up and down
// Edit mode: drag a note to change its pitch, one step of the key at a time (▲▼ for sharps/flats).
// With a mouse any note in your parts can be dragged; on a touch screen, tap a note first, then drag it.
function stepInKey(midi, steps, key) {
  const sc = Arrange.scalePcs(key), dir = Math.sign(steps);
  let m = midi;
  for (let i = 0; i < Math.abs(steps); i++) { m += dir; let g = 0; while (!sc.includes(Theory.mod(m, 12)) && g++ < 3) m += dir; }
  return m;
}
function bindDrag() {
  const box = $('#score');
  const pt = e => e.touches ? e.touches[0] || e.changedTouches[0] : e;
  const begin = (e, touch) => {
    if (!S.editing || !S.layout || ((typeof Stage !== 'undefined' && Stage.on))) return;
    if (!touch && e.button !== 0) return;
    const sysDiv = e.target.closest && e.target.closest('.system');
    if (!sysDiv) return;
    const P = pt(e), rect = sysDiv.querySelector('svg').getBoundingClientRect(), z = S.layout.zoom;
    const r = Score.hitTest(S.layout, +sysDiv.dataset.sys, (P.clientX - rect.left) / z, (P.clientY - rect.top) / z);
    const hit = r && r.hit;
    if (!hit || hit.idx == null) return;
    const part = S.song.parts.find(x => x.id === hit.partId);
    if (!part || !part.editable) return;
    if (touch && !(S.sel && S.sel.partId === part.id && S.sel.idx === hit.idx)) return;   // touch: only the selected note
    S.drag = { part, note: part.notes[hit.idx], y0: P.clientY, p0: part.notes[hit.idx].p, started: false, touch };
  };
  const move = e => {
    const d = S.drag; if (!d) return;
    if (d.touch) e.preventDefault();
    const P = pt(e), dy = P.clientY - d.y0;
    if (!d.started) {
      if (Math.abs(dy) < 6) return;
      d.started = true;
      S.undo.push(snapshot()); if (S.undo.length > 100) S.undo.shift(); S.redo = [];
      selectNote(d.note);
      document.body.classList.add('dragging');
    }
    const ins = Theory.inst(d.part), tr = ins.tr || 0, wkey = Theory.writtenKey(S.song.key, ins);
    const steps = Math.round(-dy / (5 * S.layout.zoom));
    let np = stepInKey(d.p0 + tr, steps, wkey) - tr;
    np = Math.max(ins.lo, Math.min(ins.hi, np));
    if (np !== d.note.p) { d.note.p = np; selectNote(d.note); renderScore(); previewNote(np); }
  };
  const end = () => {
    const d = S.drag; S.drag = null;
    document.body.classList.remove('dragging');
    if (d && d.started) { S.suppressClick = true; setTimeout(() => { S.suppressClick = false; }, 400); scheduleSave(); }
  };
  box.addEventListener('mousedown', e => begin(e, false));
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', end);
  box.addEventListener('touchstart', e => begin(e, true), { passive: true });
  box.addEventListener('touchmove', move, { passive: false });
  box.addEventListener('touchend', end);
  box.addEventListener('touchcancel', end);
}

function shortcutsHelp() {
  const rows = [
    ['Playing', [['Space', 'Play / pause'], ['← →', 'Back / forward one bar'], ['L', 'Loop some bars'], ['Ctrl + Z / Ctrl + Y', 'Undo / redo any change'], ['E', 'Start editing'], ['?', 'This list']]],
    ['Editing', [['Click on the staff', 'Put a note there'], ['A – G', 'Type notes one after another'], ['Click a note', 'Select it'], ['Drag a note', 'Move it up or down in the key'], ['↑ ↓', 'Up / down a semitone'], ['Shift + ↑ ↓', 'Up / down an octave'],
      ['← →', 'Previous / next note'], ['1 2 3 4 5', '16th, 8th, quarter, half, whole'], ['.', 'Dotted'], ['T', 'Triplet'], ['N', 'Put a note on the selected rest'],
      ['Delete', 'Make it a rest'], ['S', 'Slur to the next note'], ['Esc', 'Deselect, then stop editing']]],
    ['Stage mode', [['Space', 'Play / pause'], ['→  Page Down', 'Next page (most page-turn pedals send these)'], ['←  Page Up', 'Previous page'], ['D', 'Dark theme'], ['F', 'Full screen'], ['Esc', 'Leave stage mode']]],
  ];
  modal(h('div', { class: 'keys-help' }, h('h3', {}, 'Keyboard shortcuts'),
    rows.map(([t, list]) => h('div', {}, h('div', { class: 'mini-label' }, t),
      h('table', {}, list.map(([k, d]) => h('tr', {}, h('td', {}, h('kbd', {}, k)), h('td', {}, d))))))), [['Close', true, 'primary']]);
}

// ---------------------------------------------------------------- score clicks
async function onScoreClick(e) {
  if (S.suppressClick) { S.suppressClick = false; return; }
  if ((typeof Stage !== 'undefined' && Stage.on)) return Stage.tap(e);
  const sysDiv = e.target.closest('.system');
  if (!sysDiv || !S.layout) return;
  const sysIdx = +sysDiv.dataset.sys;
  const rect = sysDiv.querySelector('svg').getBoundingClientRect();
  const z = S.layout.zoom;
  const x = (e.clientX - rect.left) / z, y = (e.clientY - rect.top) / z;

  const lyr = e.target.closest('.lyric'), chd = e.target.closest('.chord'), sec = e.target.closest('[data-sec]');
  if (sec) {
    const sc = S.song.sections[+sec.dataset.sec];
    if (S.editing) return editSection(sc, sc.b);
    S.player.seekBeat(sc.b); updateCursor(true); return;
  }
  if (S.editing && lyr) return editLyric(+lyr.dataset.i);
  if (S.editing && chd) return editChord(+chd.dataset.i);

  const r = Score.hitTest(S.layout, sysIdx, x, y);
  if (!r) return;
  const bpb = S.song.beatsPerBar;

  if (S.loopMode) {
    if (r.measure == null) return;
    if (S.loopPick == null) { S.loopPick = r.measure; drawOverlays(); toast('Now tap the last bar of the loop'); return; }
    const a = Math.min(S.loopPick, r.measure), b = Math.max(S.loopPick, r.measure);
    S.player.loop = { from: a * bpb, to: (b + 1) * bpb };
    S.loopPick = null; S.loopMode = false;
    $('#tLoop').classList.add('on'); $('#tLoop').textContent = `⟲ Bars ${a - S.layout.m0 + 1}–${b - S.layout.m0 + 1} ✕`;
    S.player.seekBeat(a * bpb);
    drawOverlays();
    return;
  }

  if (S.editing) {
    const hit = r.hit;
    const p = hit && S.song.parts.find(x => x.id === hit.partId);
    // close to a note head: select it; anywhere else on your staff: put a note there
    const onNote = hit && hit.idx != null && Math.abs(x - (hit.sn.getAbsoluteX() + 6)) < 14;
    if (onNote && p && p.editable) {
      S.sel = { partId: p.id, idx: hit.idx }; previewNote(p.notes[hit.idx].p);
      renderScore();
    } else if (r.block >= 0 && r.measure != null && placeNote(sysIdx, r.block, r.measure, x, y)) {
      /* placed */
    } else if (hit && p && p.editable && hit.rest) {
      S.sel = { partId: p.id, rest: hit.rest }; renderScore();
    } else if (hit && p && !p.editable) toast('That\'s a reference part and can\'t be edited.');
    else if (lyr || chd) { /* ignore */ }
    return;
  }
  // practice mode: jump to tapped spot
  if (r.hit) S.player.seekBeat(r.hit.s);
  else if (r.measure != null) S.player.seekBeat(r.measure * bpb);
  updateCursor(true);
}

// ---- note entry
// Put a note where the staff was tapped: pitch from the height (in the key), beat from
// the position (snapped to the chosen note length). Replaces whatever was there.
function placeNote(sysIdx, blockIdx, m, x, y) {
  const sys = S.layout.systems[sysIdx], bl = sys.blocks[blockIdx];
  const part = bl && bl.part;
  if (!part || !part.editable) return false;
  const meas = S.layout.measures[m], bpb = S.song.beatsPerBar, M = Theory.meter(S.song);
  const [[b0, x0], [, x1]] = meas.points;
  let beat = b0 + Math.max(0, Math.min(0.999, (x - x0) / (x1 - x0))) * bpb;
  const len = S.curDur / 4 / M.q;                       // chosen length, in beats
  const g = Math.min(len, M.compound ? 1 / 3 : 1, 1);     // snap grid
  beat = Math.max(b0, Math.min(b0 + bpb - g, b0 + Math.floor((beat - b0) / g + 0.35) * g));
  const step = bl.cl.top + Math.round((bl.topLine - y) / 5);
  const ins = Theory.inst(part);
  let midi = Theory.stepToMidi(step, bl.wkey) - (ins.tr || 0);
  if (midi < ins.lo - 12 || midi > ins.hi + 12) return false;   // tapped far off the staff
  midi = Math.max(ins.lo, Math.min(ins.hi, midi));
  putNote(part, +beat.toFixed(4), len, midi);
  return true;
}
function putNote(part, b, len, midi) {
  const e = b + len;
  let nn;
  edit(() => {
    const keep = [];
    for (const n of part.notes) {
      const ne = n.b + n.d;
      if (ne <= b + 1e-6 || n.b >= e - 1e-6) { keep.push(n); continue; }
      if (n.b < b) { keep.push(Object.assign(n, { d: +(b - n.b).toFixed(4) })); if (ne > e) keep.push({ ...n, b: +e.toFixed(4), d: +(ne - e).toFixed(4), slur: undefined }); continue; }
      if (ne > e) { n.d = +(ne - e).toFixed(4); n.b = +e.toFixed(4); keep.push(n); }
    }
    nn = { b, d: +len.toFixed(4), p: midi };
    keep.push(nn);
    part.notes = keep.filter(n => n.d > 1e-4).sort((a1, b1) => a1.b - b1.b);
    selectNote(nn);
  }, { light: true });
  previewNote(midi);
  return nn;
}
// PC: type A-G to add notes one after another (or change the selected note's letter).
function typeLetter(letter) {
  const part = curPart(), key = Theory.writtenKey(S.song.key, Theory.inst(part)), tr = Theory.inst(part).tr || 0;
  const n = selNote();
  if (n) {
    const p = Theory.letterToMidi(letter, key, n.p + tr) - tr;
    edit(() => { n.p = p; selectNote(n); }, { light: true });
    previewNote(p);
    return;
  }
  const at = S.sel && S.sel.rest ? S.sel.rest.s : Math.max(0, Math.floor(S.player.beat));
  const prev = [...part.notes].reverse().find(x => x.b < at);
  const near = prev ? prev.p + tr : Theory.inst(part).center + tr;
  const len = S.curDur / 4 / Theory.meter(S.song).q;
  putNote(part, +at.toFixed(4), len, Theory.letterToMidi(letter, key, near) - tr);
  // move on: select the space straight after the new note
  S.sel = { partId: part.id, rest: { s: +(at + len).toFixed(4), e: +(at + 2 * len).toFixed(4) } };
  renderScore();
}

// Write a line for some bars from the chords (for empty bars, or to try an idea).
async function suggestDialog() {
  const s = S.song, bpb = s.beatsPerBar, full = Score.songRange(s), part = curPart();
  const n = selNote();
  const start = n ? Math.floor(n.b / bpb) : S.sel && S.sel.rest ? Math.floor(S.sel.rest.s / bpb) : Math.max(full.m0, Math.floor(S.player.beat / bpb));
  const num = (v) => h('input', { type: 'number', min: 1, max: full.m1 - full.m0, value: v, inputmode: 'numeric' });
  const a = num(start - full.m0 + 1), b = num(Math.min(full.m1 - full.m0, start - full.m0 + 4));
  const style = h('select', {},
    h('option', { value: 'line' }, 'A moving line (like a countermelody)'),
    h('option', { value: 'long' }, 'Long notes (one or two per bar, good for pads)'),
    h('option', { value: 'arp' }, 'Broken chords (eighth notes)'));
  if (!await modal(h('div', { class: 'add-part' }, h('h3', {}, '✨ Suggest notes'),
    h('p', { class: 'muted' }, `Writes notes for "${partLabel(part)}" from the chords. It replaces any notes already in those bars. You can undo it.`),
    h('div', { class: 'row' }, h('label', {}, 'From bar', a), h('label', {}, 'To bar', b)), h('div', { class: 'row' }, h('label', {}, 'Style', style))),
    [['Cancel', false], ['Write notes', true, 'primary']])) return;
  const m0 = full.m0 + Math.max(1, +a.value || 1) - 1, m1 = full.m0 + Math.max(+a.value || 1, +b.value || 1);
  const b0 = m0 * bpb, b1 = m1 * bpb;
  const chords = [...s.chords].sort((x, y) => x.beat - y.beat).filter(c => c.beat < b1 && c.beat + c.dur > b0)
    .map(c => ({ ...c, beat: Math.max(c.beat, b0), dur: Math.min(c.beat + c.dur, b1) - Math.max(c.beat, b0) }));
  if (!chords.length) return toast('There are no chords in those bars to work from. Add chords first (Edit, tap above the staff).', 5000);
  const ins = Theory.inst(part);
  const near = part.notes.filter(x => x.b < b0).slice(-6).map(x => x.p);
  const center = near.length ? near.sort((x, y) => x - y)[Math.floor(near.length / 2)] : ins.center;
  let notes = [];
  if (style.value === 'line') notes = Arrange.fill(s, ins, b0, b1, chords, center);
  else {
    for (const c of chords) {
      const tones = Theory.chordTones(c);
      const pick = target => { let best = null, bd = 1e9; for (let m = ins.lo; m <= ins.hi; m++) if (tones.includes(Theory.mod(m, 12)) && Math.abs(m - target) < bd) { bd = Math.abs(m - target); best = m; } return best; };
      if (style.value === 'long') {
        const p0 = pick(notes.length ? notes[notes.length - 1].p : center);
        notes.push({ b: c.beat, d: c.dur, p: p0 });
      } else {
        const root = pick(center - 4), ch = [root, ...[1, 2].map(i => pick(root + [4, 7][i - 1] + (i === 2 ? 0 : 0)))].filter(x => x != null).sort((x, y) => x - y);
        const seq = [ch[0], ch[1], ch[2], ch[1]];
        for (let t = 0, k = 0; t < c.dur - 1e-6; t += 0.5, k++) notes.push({ b: c.beat + t, d: Math.min(0.5, c.dur - t), p: seq[k % 4] });
      }
    }
  }
  edit(() => {
    part.notes = part.notes.filter(x => x.b + x.d <= b0 + 1e-6 || x.b >= b1 - 1e-6).concat(notes.map(x => ({ b: +x.b.toFixed(4), d: +x.d.toFixed(4), p: x.p })));
    S.sel = null;
  });
  toast(`Wrote ${notes.length} notes in bars ${+a.value}–${+b.value}`, 6000, { label: 'Undo', fn: undo });
}

async function editLyric(i) {
  const w = S.song.lyrics[i];
  const inp = h('input', { type: 'text', value: w.text });
  const r = await modal(h('div', {}, h('h3', {}, 'Fix word'), inp,
    h('p', { class: 'muted' }, 'Tip: type several words with spaces to split one into more.')),
    [['Delete word', 'del', 'danger'], ['Cancel', null], ['Save', 'ok', 'primary']]);
  if (r === 'del') edit(() => S.song.lyrics.splice(i, 1), { light: true });
  else if (r === 'ok') edit(() => {
    const parts = inp.value.trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return;
    const next = S.song.lyrics[i + 1];
    const span = next ? Math.max(0.25, next.b - w.b) : 1;
    const step = Math.max(0.25, Math.floor(span / parts.length * 4) / 4);
    const words = parts.map((t, k) => ({ ...w, text: t, b: w.b + k * step }));
    S.song.lyrics.splice(i, 1, ...words);
  }, { light: true });
}
async function editChord(i) {
  const c = S.song.chords[i];
  const inp = h('input', { type: 'text', value: Theory.chordName(c, S.song.key) });
  const r = await modal(h('div', {}, h('h3', {}, 'Change chord'), inp, h('p', { class: 'muted' }, 'For example: G, Em, D/F#, Csus4')),
    [['Delete', 'del', 'danger'], ['Cancel', null], ['Save', 'ok', 'primary']]);
  if (r === 'del') edit(() => S.song.chords.splice(i, 1));
  else if (r === 'ok') {
    const pc = Theory.parseChord(inp.value);
    if (!pc) return toast('I didn\'t understand that chord');
    edit(() => Object.assign(c, pc));
  }
}

// ---------------------------------------------------------------- bindings
function bindSong() {
  $('#backBtn').addEventListener('click', showLibrary);
  $('#songTitle').addEventListener('click', async () => {
    const t = await ask('Rename song', '', S.song.title);
    if (t && t.trim()) edit(() => { S.song.title = t.trim(); $('#songTitle').textContent = S.song.title; }, { light: true });
  });
  $('#editBtn').addEventListener('click', () => setEditing(!S.editing));
  $('#shareBtn').addEventListener('click', async () => {
    const choice = await modal(h('div', {}, h('h3', {}, 'Share or export'),
      h('p', {}, h('b', {}, 'Song file: '), S.isPC
        ? 'send it to your phone with WhatsApp or email and open it in Violin Play-Along there.'
        : 'send the song (with your changes) to your PC or a bandmate.'),
      h('p', {}, h('b', {}, 'Play-along video: '), 'an MP4 of the sheet music with a moving cursor and the sound you choose. Plays anywhere, no app needed.'),
      h('p', {}, h('b', {}, 'PDF: '), 'printable sheet music. ', h('b', {}, 'MusicXML: '), 'opens in MuseScore and other notation programs.')),
      [['Cancel', null], ['PDF', 'pdf'], ['MusicXML', 'xml'], ['Video', 'video'], ['Song file', 'file', 'primary']]);
    if (choice === 'pdf') exportPdfDialog();
    if (choice === 'xml') {
      const xml = Exports.musicxml(S.song);
      const r = await shareOrDownload(new Blob([xml], { type: 'application/vnd.recordare.musicxml+xml' }), safeName(S.song.title) + '.musicxml', S.song.title);
      if (r === 'downloaded' || r === 'saved') toast('MusicXML saved. Open it in MuseScore (free) to print or edit further.', 4500);
      if (r === 'failed') toast('Saving isn\'t available here.', 4000);
    }
    if (choice === 'file') { clearTimeout(S.saveTimer); await (S.where === 'server' ? Store.server : Store.local).save(S.song); shareSong(S.song.id, S.where, S.song.title); }
    if (choice === 'video') exportVideoDialog();
  });
  $('#score').addEventListener('click', onScoreClick);
  $$('.edit-bar [data-act]').forEach(b => {
    if (b.tagName === 'SELECT') b.addEventListener('change', () => {
      const n = selNote(); const v = b.value; b.value = '';
      if (!n) return toast('Tap a note in your part first');
      const field = b.dataset.act === 'fing' ? 'fing' : 'dyn';
      edit(() => { if (v === '-') delete n[field]; else n[field] = v; selectNote(n); }, { light: true });
    });
    else b.addEventListener('click', () => act(b.dataset.act));
  });
  $$('.edit-bar [data-dur]').forEach(b => b.addEventListener('click', () => setDur(+b.dataset.dur)));

  // transport
  $('#tPlay').addEventListener('click', () => { if (S.player.synthOn) S.player.setSynth(true); const was = S.player.playing; S.player.toggle(); if (was) Practice.onPause(); });
  $('#tStart').addEventListener('click', () => { S.player.seekBeat(S.player.loop ? S.player.loop.from : (S.layout ? S.layout.m0 * S.song.beatsPerBar : 0)); updateCursor(true); });
  const barJump = d => { const bpb = S.song.beatsPerBar; const m = Math.floor(S.player.beat / bpb) + d; S.player.seekBeat(Math.max(0, m) * bpb); updateCursor(true); };
  $('#tBack').addEventListener('click', () => barJump(-1));
  $('#tFwd').addEventListener('click', () => barJump(1));
  $('#tSpeed').addEventListener('input', e => { const v = +e.target.value; $('#tSpeedVal').textContent = v + '%'; S.player.setRate(v / 100); });
  $('#tTrack').addEventListener('change', e => S.player.setTrack(e.target.value));
  $('#tSynth').addEventListener('click', () => {
    const on = !S.player.synthOn;
    S.player.setSynth(on, 0.5, synthPartId());
    $('#tSynth').classList.toggle('on', on);
    toast(on ? `You'll hear "${S.song.parts.find(p => p.id === synthPartId()).name}" played along` : 'Part playback off');
  });
  $('#tLoop').addEventListener('click', () => {
    if (S.player.loop || S.loopMode) {
      S.player.loop = null; S.loopMode = false; S.loopPick = null;
      $('#tLoop').classList.remove('on'); $('#tLoop').textContent = '⟲ Loop';
      drawOverlays();
      return;
    }
    S.loopMode = true; S.loopPick = null;
    $('#tLoop').classList.add('on'); $('#tLoop').textContent = '⟲ Pick bars… ✕';
    toast('Tap the first bar of the loop');
  });
  $('#tPractice').addEventListener('click', () => Practice.open());
  $('#keysBtn').addEventListener('click', shortcutsHelp);
  $('#undoBtn').addEventListener('click', undo);
  $('#redoBtn').addEventListener('click', redo);
  bindDrag();
  Samples.on = S.view.realSounds !== false;
  S.player.onRate = r => { $('#tSpeed').value = Math.round(r * 100); $('#tSpeedVal').textContent = Math.round(r * 100) + '%'; toast(`Speed ${Math.round(r * 100)}%`, 1200); };
  $('#tFollow').classList.toggle('on', S.view.follow);
  $('#tFollow').addEventListener('click', () => { S.view.follow = !S.view.follow; saveView(); $('#tFollow').classList.toggle('on', S.view.follow); });
  $('#zIn').addEventListener('click', () => { S.view.zoom = Math.min(1.8, +(S.view.zoom + 0.1).toFixed(2)); saveView(); renderScore(); });
  $('#zOut').addEventListener('click', () => { S.view.zoom = Math.max(0.6, +(S.view.zoom - 0.1).toFixed(2)); saveView(); renderScore(); });

  let rt;
  window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => S.song && renderScore(), 250); });

  document.addEventListener('keydown', e => {
    if (!$('#modal').classList.contains('hidden')) return;
    if (['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return;
    const k = e.key;
    if (k === '?' ) { e.preventDefault(); return shortcutsHelp(); }
    if (!S.song || ((typeof Stage !== 'undefined' && Stage.on))) return;
    if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 'z') { e.preventDefault(); return e.shiftKey ? redo() : undo(); }
    if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 'y') { e.preventDefault(); return redo(); }
    if (!S.editing && k.toLowerCase() === 'e' && !e.ctrlKey && !e.metaKey) return setEditing(true);
    if (k === 'Escape' && S.editing && !S.sel) return setEditing(false);
    if (!S.editing && k.toLowerCase() === 'l') return $('#tLoop').click();
    if (!S.editing && (k === 'ArrowLeft' || k === 'ArrowRight')) { e.preventDefault(); return (k === 'ArrowLeft' ? $('#tBack') : $('#tFwd')).click(); }
    if (k === ' ') { e.preventDefault(); S.player.toggle(); return; }
    if (!S.editing) return;
    if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 'z') { e.preventDefault(); return e.shiftKey ? redo() : undo(); }
    if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 'y') { e.preventDefault(); return redo(); }
    if (k === 'ArrowUp') { e.preventDefault(); return act(e.shiftKey ? 'octUp' : 'up'); }
    if (k === 'ArrowDown') { e.preventDefault(); return act(e.shiftKey ? 'octDown' : 'down'); }
    if (k === 'ArrowLeft' || k === 'ArrowRight') {
      e.preventDefault();
      const p = curPart(); if (!p.notes.length) return;
      let i = S.sel && S.sel.idx != null ? S.sel.idx + (k === 'ArrowLeft' ? -1 : 1) : 0;
      i = Math.max(0, Math.min(p.notes.length - 1, i));
      S.sel = { partId: p.id, idx: i }; previewNote(p.notes[i].p); renderScore();
      return;
    }
    const durKeys = { 1: 1, 2: 2, 3: 4, 4: 8, 5: 16 };
    if (durKeys[k]) return setDur(durKeys[k]);
    if (k === '.') return act('dot');
    if (k.toLowerCase() === 't') return act('trip');
    if (k === 'Delete' || k === 'Backspace') { e.preventDefault(); return act('del'); }
    if (/^[a-gA-G]$/.test(k) && !e.ctrlKey && !e.metaKey && !e.altKey) return typeLetter(k);
    if (k.toLowerCase() === 'n') return act('add');
    if (k.toLowerCase() === 's') return act('slur');
    if (k === 'Escape') { S.sel = null; renderScore(); }
  });
}

start();
