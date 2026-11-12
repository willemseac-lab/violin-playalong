// Practice panel: count-in, metronome click, speed trainer, looping sections and an
// intonation check that listens through the microphone while you play your part.
const Practice = (() => {
  const P = { results: {} };          // results[partId][noteIdx] = [cents, ...]
  let mic = null, raf = null, lastRender = 0;

  const pct = v => Math.round(v * 100) + '%';
  function fillSelect(sel, values, cur) {
    sel.innerHTML = '';
    for (const v of values) sel.append(h('option', { value: v, selected: Math.abs(v - cur) < 1e-6 }, pct(v)));
  }
  function loopLabel() {
    const lp = S.player.loop, bpb = S.song.beatsPerBar;
    if (!lp) return 'Loop: none yet. Use ⟲ Loop or a section below, or the whole song is used.';
    const sec = (S.song.sections || []).find(x => Math.abs(x.b - lp.from) < 1e-6);
    return `Loop: ${sec ? sec.name + ', ' : ''}bars ${barNo(lp.from / bpb)}–${barNo(lp.to / bpb) - 1}`;
  }
  function setLoop(from, to, label) {
    S.player.loop = { from, to };
    S.loopMode = false; S.loopPick = null;
    $('#tLoop').classList.add('on');
    $('#tLoop').textContent = `⟲ ${label || `Bars ${barNo(from / S.song.beatsPerBar)}–${barNo(to / S.song.beatsPerBar) - 1}`} ✕`;
    S.player.seekBeat(from);
    drawOverlays(); updateCursor(true);
    $('#pRange').textContent = loopLabel();
  }

  P.open = () => {
    const box = $('#practice');
    box.classList.remove('hidden');
    $('#pCount').value = String(S.player.countIn || 0);
    $('#pClick').checked = S.player.clickOn;
    const steps = []; for (let v = 0.5; v <= 1.101; v += 0.05) steps.push(+v.toFixed(2));
    fillSelect($('#pFrom'), steps.filter(v => v <= 1), 0.7);
    fillSelect($('#pTo'), steps.filter(v => v >= 0.6), 1);
    $('#pRange').textContent = loopLabel();
    $('#pTrain').textContent = S.player.trainer ? 'Stop speed trainer' : 'Start speed trainer';
    const secs = $('#pSecs'); secs.innerHTML = '';
    const list = [...(S.song.sections || [])].sort((a, b) => a.b - b.b);
    if (!list.length) secs.append(h('span', { class: 'muted small' }, 'No sections yet. In Edit, tap a note and use "§ Section" to mark Intro, Verse, Chorus…'));
    for (const sc of list) secs.append(h('button', { class: 'chip', onclick: () => { const r = sectionRange(sc); setLoop(r.from, r.to, sc.name); } }, sc.name));
    $('#pMic').textContent = mic ? '■ Stop listening' : '🎙 Start listening';
    summary();
  };
  function bind() {
    $('#pClose').addEventListener('click', () => $('#practice').classList.add('hidden'));
    $('#pCount').addEventListener('change', e => { S.player.countIn = +e.target.value; });
    $('#pClick').addEventListener('change', e => S.player.setClick(e.target.checked));
    $('#pTrain').addEventListener('click', () => {
      if (S.player.trainer) {
        S.player.trainer = null;
        $('#pTrain').textContent = 'Start speed trainer';
        return toast('Speed trainer off');
      }
      if (!S.player.loop) {
        const sec = sectionAt(S.player.beat);
        if (sec) { const r = sectionRange(sec); setLoop(r.from, r.to, sec.name); }
        else setLoop(S.layout.m0 * S.song.beatsPerBar, S.layout.m1 * S.song.beatsPerBar, 'Whole song');
      }
      const from = +$('#pFrom').value, to = +$('#pTo').value, step = +$('#pStep').value;
      S.player.trainer = { step, to: Math.max(from, to) };
      S.player.setRate(from); S.player.onRate(from);
      $('#pTrain').textContent = 'Stop speed trainer';
      S.player.seekBeat(S.player.loop.from);
      if (!S.player.playing) S.player.play();
    });
    $('#pMic').addEventListener('click', () => mic ? stopMic() : startMic());
    $('#pMicClear').addEventListener('click', () => { P.results = {}; summary(); renderScore(); });
  }

  // ---- intonation
  function partForCheck() {
    const id = shownPartId(), p = S.song.parts.find(x => x.id === id);
    return p && p.editable ? p : myPart();
  }
  async function startMic() {
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    } catch (e) {
      return toast('The microphone isn\'t available here. It works in the app opened from your PC or installed on your phone.', 6000);
    }
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const src = ctx.createMediaStreamSource(stream);
    const an = ctx.createAnalyser(); an.fftSize = 4096;
    src.connect(an);
    mic = { stream, ctx, an, buf: new Float32Array(an.fftSize) };
    $('#tuner').classList.remove('hidden');
    $('#pMic').textContent = '■ Stop listening';
    toast(S.player.playing ? 'Listening…' : 'Listening. Press play and play your part.', 3000);
    loop();
  }
  function stopMic() {
    if (!mic) return;
    cancelAnimationFrame(raf);
    mic.stream.getTracks().forEach(t => t.stop());
    mic.ctx.close();
    mic = null;
    $('#tuner').classList.add('hidden');
    $('#pMic').textContent = '🎙 Start listening';
    summary(); renderScore();
  }
  // Pitch by autocorrelation (works well for a single bowed or sung note).
  function detect(buf, sr) {
    let rms = 0; for (const v of buf) rms += v * v;
    rms = Math.sqrt(rms / buf.length);
    if (rms < 0.01) return null;
    const N = buf.length, minLag = Math.floor(sr / 2000), maxLag = Math.floor(sr / 150);
    const c = new Float32Array(maxLag + 2);
    for (let lag = minLag; lag <= maxLag + 1; lag++) {
      let s = 0, e1 = 0, e2 = 0;
      for (let i = 0; i < N - lag; i += 2) { s += buf[i] * buf[i + lag]; e1 += buf[i] * buf[i]; e2 += buf[i + lag] * buf[i + lag]; }
      c[lag] = s / Math.sqrt(e1 * e2 + 1e-12);
    }
    let best = -1, bl = 0;
    const peakMax = Math.max(...c.slice(minLag));
    for (let lag = minLag + 1; lag <= maxLag; lag++) {   // first peak close to the best (avoids octave errors)
      if (c[lag] > c[lag - 1] && c[lag] >= c[lag + 1] && c[lag] > 0.9 * peakMax) { best = c[lag]; bl = lag; break; }
    }
    if (!bl || best < 0.8) return null;
    const a = c[bl - 1], b = c[bl], d = c[bl + 1];
    const shift = (a - d) / (2 * (a - 2 * b + d) || 1);
    return sr / (bl + shift);
  }
  const NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
  const nm = m => NAMES[((Math.round(m) % 12) + 12) % 12] + (Math.floor(Math.round(m) / 12) - 1);
  function loop() {
    raf = requestAnimationFrame(loop);
    if (!mic) return;
    mic.an.getFloatTimeDomainData(mic.buf);
    const f = detect(mic.buf, mic.ctx.sampleRate);
    const part = partForCheck();
    // what you were meant to be playing a moment ago (the microphone hears a little late)
    const beat = S.player.playing ? Timeline.TtoBeat(S.song, S.player.T - 0.09 * S.player.rate) : null;
    let want = null, wi = -1;
    if (beat != null) {
      wi = part.notes.findIndex(n => beat >= n.b + n.d * 0.2 && beat < n.b + n.d * 0.85);
      want = wi >= 0 ? part.notes[wi] : null;
    }
    if (!f) { $('#tnHeard').textContent = '–'; $('#tnWant').textContent = want ? ' want ' + nm(want.p) : ''; $('#tnNeedle').style.left = '50%'; $('#tnCents').textContent = ''; return; }
    const m = 69 + 12 * Math.log2(f / 440);
    let cents = want ? (m - want.p) * 100 : (m - Math.round(m)) * 100;
    if (want && Math.abs(cents) > 600) { const oct = Math.round(cents / 1200) * 1200; cents -= oct; }   // played an octave off: judge the tuning anyway
    $('#tnHeard').textContent = nm(m);
    $('#tnWant').textContent = want ? (Math.abs(cents) > 60 ? ` · wrong note, want ${nm(want.p)}` : ` · ${nm(want.p)}`) : '';
    const c = Math.max(-50, Math.min(50, cents));
    $('#tnNeedle').style.left = (50 + c) + '%';
    $('#tnNeedle').style.background = Math.abs(cents) <= 15 ? '#2e7d32' : Math.abs(cents) <= 35 ? '#ef6c00' : '#c62828';
    $('#tnCents').textContent = `${cents > 0 ? '+' : ''}${Math.round(cents)} cents ${Math.abs(cents) <= 5 ? '' : cents > 0 ? '(sharp)' : '(flat)'}`;
    if (want && Math.abs(cents) <= 250) {
      const r = (P.results[part.id] = P.results[part.id] || {});
      (r[wi] = r[wi] || []).push(cents);
      if (performance.now() - lastRender > 1500 && !S.player.playing) { lastRender = performance.now(); renderScore(); }
    }
  }
  const median = a => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  P.colorOf = (partId, idx) => {
    const r = P.results[partId];
    if (!r || !r[idx] || r[idx].length < 3) return null;
    const c = Math.abs(median(r[idx]));
    return c <= 15 ? '#2e7d32' : c <= 35 ? '#ef6c00' : '#c62828';
  };
  function summary() {
    const box = $('#pSummary'); if (!box) return;
    const part = S.song && partForCheck(), r = part && P.results[part.id];
    if (!r || !Object.keys(r).length) { box.textContent = ''; return; }
    const meds = Object.values(r).filter(a => a.length >= 3).map(median);
    const good = meds.filter(c => Math.abs(c) <= 15).length, off = meds.filter(c => Math.abs(c) > 15 && Math.abs(c) <= 35).length;
    const bad = meds.length - good - off, avg = meds.reduce((s, c) => s + c, 0) / (meds.length || 1);
    box.textContent = `${meds.length} notes checked: ${good} in tune, ${off} a bit off, ${bad} out of tune.` +
      (Math.abs(avg) > 8 ? ` On average you're a little ${avg > 0 ? 'sharp' : 'flat'} (${Math.round(avg)} cents).` : '');
  }
  P._detect = detect;
  P.onPause = () => { if (mic) { summary(); renderScore(); } };
  document.addEventListener('DOMContentLoaded', bind);
  if (document.readyState !== 'loading') setTimeout(bind, 0);
  return P;
})();
