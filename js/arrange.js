// Part generators: duet/harmony, countermelody, easier versions, range fitting.
// All work from the song's key, chords and a source part (usually the melody).
const Arrange = (() => {
  const mod = Theory.mod;
  const DISSONANT = new Set([1, 2, 6, 10, 11]);
  const median = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

  function scalePcs(key) {
    const ints = key.mode === 'minor' ? [0, 2, 3, 5, 7, 8, 10] : [0, 2, 4, 5, 7, 9, 11];
    return ints.map(i => mod(key.tonic + i, 12));
  }
  function chordAt(chords, b) {
    let best = null;
    for (const c of chords) { if (c.beat <= b + 1e-6) best = c; else break; }
    return best;
  }
  const sounding = (notes, t) => notes.find(n => n.b <= t + 1e-6 && n.b + n.d > t + 1e-6);
  const sortedChords = song => [...(song.chords || [])].filter(c => c.root != null).sort((a, b) => a.beat - b.beat);

  // Move a line into an instrument's range: whole-line octave shift, then fold stragglers.
  function fitRange(notes, ins, stay = 0) {
    if (!notes.length) return [];
    const med = median(notes.map(n => n.p));
    let best = 0, bs = 1e9;
    for (const sft of [-36, -24, -12, 0, 12, 24, 36]) {
      const out = notes.filter(n => n.p + sft < ins.lo || n.p + sft > ins.hi).length;
      const sc = out * 10 + Math.abs(med + sft - ins.center) + Math.abs(sft) / 12 * stay;
      if (sc < bs) { bs = sc; best = sft; }
    }
    return notes.map(n => {
      let p = n.p + best;
      while (p < ins.lo) p += 12;
      while (p > ins.hi) p -= 12;
      return { b: n.b, d: n.d, p };
    });
  }

  // Duet / harmony: same rhythm, a 3rd or 6th below (or above), kept to chord tones.
  function harmony(song, src, opts = {}) {
    const above = opts.above;
    const sc = scalePcs(song.key);
    const chords = sortedChords(song);
    const out = [];
    let prev = null;
    const COST = { 3: 0, 4: 0, 8: 1.5, 9: 1.5, 5: 3, 7: 2.5 };
    for (const n of src.notes) {
      const c = chordAt(chords, n.b);
      const ct = c ? Theory.chordTones(c) : [];
      let best = null, bs = 1e9;
      for (let iv = 3; iv <= 9; iv++) {
        if (iv === 6) continue;
        const q = above ? n.p + iv : n.p - iv;
        const pc = mod(q, 12);
        if (!sc.includes(pc) && !ct.includes(pc)) continue;
        let s = COST[iv] ?? 5;
        if (ct.length && !ct.includes(pc)) s += n.d >= 1 ? 2.5 : 0.8; // short notes may pass
        if (prev != null) s += Math.abs(q - prev) * 0.25;
        if (s < bs) { bs = s; best = q; }
      }
      if (best == null) best = above ? n.p + 4 : n.p - 3;
      out.push({ b: n.b, d: n.d, p: best });
      prev = best;
    }
    return out;
  }

  // Countermelody: moves when the melody holds or rests, holds when the melody is busy.
  function countermelody(song, src, opts = {}) {
    const above = opts.above;
    const notes = src.notes;
    const chords = sortedChords(song);
    if (!chords.length) return [];
    const bpb = song.beatsPerBar || 4;
    const sc = scalePcs(song.key);
    const first = Math.floor(Math.min(chords[0].beat, notes.length ? notes[0].b : 1e9));
    const last = chords[chords.length - 1];
    const end = Math.ceil(Math.max(last.beat + last.dur, notes.length ? notes[notes.length - 1].b + notes[notes.length - 1].d : 0));
    const melMed = median(notes.map(n => n.p)) || 72;
    const center = opts.center != null ? opts.center : melMed + (above ? 7 : -8);
    const out = [];
    let prev = Math.round(center), prev2 = null;

    function pick(t, pool, mustMove) {
      const mn = sounding(notes, t);
      let best = null, bs = 1e9;
      for (let q = Math.round(center) - 9; q <= Math.round(center) + 9; q++) {
        if (!pool.includes(mod(q, 12))) continue;
        let s = Math.abs(q - prev);
        if (q === prev) s += mustMove ? 7 : 0.5;
        if (Math.abs(q - prev) > 7) s += 4;
        if (q === prev2) s += 2.5; // don't just rock between two notes
        s += Math.abs(q - center) * 0.35;
        if (mn) {
          const iv = Math.abs(q - mn.p) % 12;
          if (iv === 0) s += 6;
          if (DISSONANT.has(iv)) s += 5;
          if (!above && q >= mn.p) s += 5;
          if (above && q <= mn.p) s += 5;
        }
        if (s < bs) { bs = s; best = q; }
      }
      best = best ?? prev;
      prev2 = prev;
      return best;
    }

    for (let t = first; t < end; t++) {
      const c = chordAt(chords, t);
      if (!c || t < chords[0].beat) continue;
      const ct = Theory.chordTones(c);
      const onsets = notes.filter(n => n.b >= t - 1e-6 && n.b < t + 1 - 1e-6).length;
      const melHere = sounding(notes, t) || sounding(notes, t + 0.5);
      const barStart = mod(t, bpb) === 0;
      const chordChange = Math.abs(c.beat - t) < 1e-6;
      const lastOut = out[out.length - 1];
      const canHold = lastOut && Math.abs(lastOut.b + lastOut.d - t) < 1e-6 && ct.includes(mod(lastOut.p, 12));

      const halfBar = mod(t, bpb) === Math.floor(bpb / 2) && bpb >= 4;
      if (!melHere) {
        // melody resting: fill with two eighths (chord tone, then passing tone)
        const a = pick(t, ct, true); out.push({ b: t, d: 0.5, p: a }); prev = a;
        const b = pick(t + 0.5, sc, true); out.push({ b: t + 0.5, d: 0.5, p: b }); prev = b;
      } else if (onsets === 0) {
        // melody holding a long note: move in quarters
        const a = pick(t, ct, true); out.push({ b: t, d: 1, p: a }); prev = a;
      } else if (canHold && !chordChange && !barStart && !halfBar) {
        lastOut.d += 1; // melody busy: sustain
      } else {
        // new chord, new bar or half-bar: move to a fresh chord tone
        const a = pick(t, ct, true); out.push({ b: t, d: 1, p: a }); prev = a;
      }
    }
    // join repeated sustained notes
    const res = [];
    for (const n of out) {
      const p = res[res.length - 1];
      if (p && p.p === n.p && Math.abs(p.b + p.d - n.b) < 1e-6 && n.d >= 1 && p.d >= 1 && mod(n.b, bpb) !== 0 && mod(n.b, bpb) !== Math.floor(bpb / 2)) p.d += n.d;
      else res.push({ ...n });
    }
    return res;
  }

  // Easier version. level 1: no 16ths, 1st position; 2: one note per beat; 3: long notes.
  function simplify(notes, level, ins) {
    if (!notes.length) return [];
    const g = { 1: 0.5, 2: 1, 3: 2 }[level] || 0.5;
    const start = Math.floor(notes[0].b / g) * g;
    const last = notes[notes.length - 1];
    const end = last.b + last.d;
    const out = [];
    for (let t = start; t < end - 1e-6; t += g) {
      let best = null, bo = 0;
      for (const n of notes) {
        if (n.b >= t + g || n.b + n.d <= t) continue;
        let o = Math.min(n.b + n.d, t + g) - Math.max(n.b, t);
        if (Math.abs(n.b - t) < 1e-6) o += g * 0.3; // prefer notes that start on the beat
        if (o > bo + 1e-6) { bo = o; best = n; }
      }
      if (!best || bo < g * 0.3) continue;
      const prev = out[out.length - 1];
      const adjacent = prev && Math.abs(prev.b + prev.d - t) < 1e-6;
      if (adjacent && prev.p === best.p && (level >= 2 || prev._src === best)) { prev.d += g; continue; }
      out.push({ b: t, d: g, p: best.p, _src: best });
    }
    const top = ins.first || ins.hi;
    return out.map(n => {
      let p = n.p;
      while (p > top && p - 12 >= ins.lo) p -= 12;
      return { b: +n.b.toFixed(4), d: +n.d.toFixed(4), p };
    });
  }

  // A short fill for empty bars [b0, b1): moving line over the chords given.
  function fill(song, ins, b0, b1, chords, center) {
    const bpb = song.beatsPerBar || 4;
    const tmp = { key: song.key, beatsPerBar: bpb, chords: chords.map(c => ({ ...c })) };
    let notes = countermelody(tmp, { notes: [] }, { center: center || ins.center }).filter(n => n.b >= b0 && n.b < b1);
    const out = [];
    for (const n of notes) {
      const pos = mod(n.b - b0, bpb), prev = out[out.length - 1];
      const lastBeat = n.b >= b1 - 1;
      // start each bar with a quarter note, and land on a long note at the end
      if (prev && (mod(prev.b - b0, bpb) === 0 || prev.b >= b1 - 1) && Math.abs(prev.b + prev.d - n.b) < 1e-6 && prev.d < 1 && (pos === 0.5 || lastBeat)) { prev.d += n.d; continue; }
      out.push({ b: n.b, d: n.d, p: n.p });
    }
    return fitRange(out, ins, 30);
  }

  return { fitRange, harmony, countermelody, simplify, scalePcs, fill, chordAt };
})();
