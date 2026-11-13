// Music theory helpers: spelling, keys, scales, chords, Nashville numbers.
const Theory = (() => {
  const SHARPS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const FLATS = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
  // sharps (+) / flats (-) in the major key on each pitch class
  const MAJOR_SIG = { 0: 0, 7: 1, 2: 2, 9: 3, 4: 4, 11: 5, 6: 6, 5: -1, 10: -2, 3: -3, 8: -4, 1: -5 };
  const MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11];
  const MINOR_SCALE = [0, 2, 3, 5, 7, 8, 10];
  const LETTERS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];

  const mod = (n, m) => ((n % m) + m) % m;

  function sig(key) {
    const relMajor = key.mode === 'minor' ? mod(key.tonic + 3, 12) : key.tonic;
    return MAJOR_SIG[relMajor];
  }
  function names(key) { return sig(key) >= 0 ? SHARPS : FLATS; }
  function pcName(pc, key) { return names(key)[mod(pc, 12)]; }
  function keyName(key) { return pcName(key.tonic, key) + (key.mode === 'minor' ? ' minor' : ' major'); }
  function vexKey(key) {
    const relMajor = key.mode === 'minor' ? mod(key.tonic + 3, 12) : key.tonic;
    const s = MAJOR_SIG[relMajor];
    return (s >= 0 ? SHARPS : FLATS)[relMajor];
  }

  // Spell a MIDI note for VexFlow ("f#/5") within the key.
  function vexNote(midi, key) {
    const n = pcName(midi, key);
    const oct = Math.floor(midi / 12) - 1;
    return n.toLowerCase() + '/' + oct;
  }
  function noteName(midi, key) {
    return pcName(midi, key) + (Math.floor(midi / 12) - 1);
  }
  // Diatonic staff step (C4 = 28) used for layout heights.
  function staffStep(midi, key) {
    const n = pcName(midi, key);
    const oct = Math.floor(midi / 12) - 1;
    return oct * 7 + LETTERS.indexOf(n[0]);
  }

  function scale(key) {
    const ints = key.mode === 'minor' ? MINOR_SCALE : MAJOR_SCALE;
    return ints.map(i => pcName(key.tonic + i, key));
  }

  // Chord qualities: symbol and intervals above the root.
  const QUAL = {
    maj: { s: '', n: '', i: [0, 4, 7] }, min: { s: 'm', n: 'm', i: [0, 3, 7] }, dim: { s: 'dim', n: '°', i: [0, 3, 6] },
    sus2: { s: 'sus2', n: 'sus2', i: [0, 2, 7] }, sus4: { s: 'sus4', n: 'sus4', i: [0, 5, 7] },
    7: { s: '7', n: '⁷', i: [0, 4, 7, 10] }, maj7: { s: 'maj7', n: 'maj⁷', i: [0, 4, 7, 11] }, m7: { s: 'm7', n: 'm⁷', i: [0, 3, 7, 10] },
  };
  const isMinor = c => ['min', 'm7', 'dim'].includes(c.quality);
  function chordName(c, key) {
    if (c.root == null) return 'N.C.';
    const q = QUAL[c.quality] || QUAL.maj;
    return pcName(c.root, key) + q.s + (c.ext || '') + (c.bass != null && c.bass !== c.root ? '/' + pcName(c.bass, key) : '');
  }

  const DEGREE = { 0: '1', 1: 'b2', 2: '2', 3: 'b3', 4: '3', 5: '4', 6: 'b5', 7: '5', 8: 'b6', 9: '6', 10: 'b7', 11: '7' };
  function number(c, key) {
    if (c.root == null) return '';
    const q = QUAL[c.quality] || QUAL.maj;
    return DEGREE[mod(c.root - key.tonic, 12)] + q.n + (c.bass != null && c.bass !== c.root ? '/' + DEGREE[mod(c.bass - key.tonic, 12)] : '');
  }

  // Parse a chord typed by the user: "F#m", "Bb", "Gsus4", "D/F#"
  const notePc = (l, acc) => mod({ C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[l.toUpperCase()] + (acc === '#' ? 1 : acc === 'b' ? -1 : 0), 12);
  function parseChord(text) {
    const m = /^\s*([A-Ga-g])([#b]?)([^/\s]*)(?:\/([A-Ga-g])([#b]?))?\s*$/.exec(text || '');
    if (!m) return null;
    const t = m[3];
    let quality = 'maj', ext = '';
    const table = [['maj7', 'maj7'], ['M7', 'maj7'], ['m7', 'm7'], ['min7', 'm7'], ['dim', 'dim'], ['°', 'dim'], ['sus2', 'sus2'],
      ['sus4', 'sus4'], ['sus', 'sus4'], ['min', 'min'], ['m', 'min'], ['7', '7']];
    const hit = table.find(([k]) => t.startsWith(k));
    if (hit) { quality = hit[1]; ext = t.slice(hit[0].length); } else ext = t;
    const c = { root: notePc(m[1], m[2]), quality };
    if (ext) c.ext = ext;
    if (m[4]) c.bass = notePc(m[4], m[5]);
    return c;
  }

  // How comfortable a key is for an instrument (key = concert key).
  function comfort(key, insKey) {
    const ins = INSTRUMENTS[insKey] || INSTRUMENTS.violin;
    const wk = writtenKey(key, ins), s = sig(wk), nm = ins.name.toLowerCase().replace(/ \(.*\)| in .*/, '');
    const out = { written: ins.tr ? wk : null };
    if (ins.open) {
      const open = ins.open.map(m => pcName(m, key)[0] === pcName(m, key) ? pcName(m, key) : pcName(m, key));
      const sc = scale(key);
      const ring = ins.open.map(m => SHARPS[mod(m, 12)]).filter((n, i) => sc.includes(pcName(ins.open[i], key)));
      const r = ring.length;
      if (r >= 3) { out.level = 'easy'; out.text = `Very comfortable on ${nm}. Lots of open strings ring, and the scale sits naturally under the fingers.`; }
      else if (r === 2) { out.level = 'ok'; out.text = `Comfortable on ${nm}. A few open strings fit; watch the finger pattern on the others.`; }
      else if (r === 1) { out.level = 'harder'; out.text = `A bit harder on ${nm}. Only one open string fits. Practise the scale first.`; }
      else { out.level = 'hard'; out.text = `Hard key for ${nm}. No open strings fit. Practise the scale slowly, or ask the band to change key.`; }
      out.ringText = r ? `Open strings in this key: ${ins.open.filter(m => sc.includes(pcName(m, key))).map(m => pcName(m, key)).join(', ')}.` : 'Avoid open strings in this key.';
    } else {
      const a = Math.abs(s);
      out.level = a <= 2 ? 'easy' : a <= 3 ? 'ok' : a <= 4 ? 'harder' : 'hard';
      out.text = { easy: `An easy key to read on ${nm}.`, ok: `A common key on ${nm}.`, harder: `A bit harder on ${nm}: lots of sharps or flats to remember.`, hard: `A hard key on ${nm}: many sharps or flats.` }[out.level];
      out.ringText = '';
    }
    if (ins.tr) out.text = `${ins.name} reads in ${keyName(wk)} (${accidentalText(wk).replace(/^\d+ \w+/, m => m.toLowerCase())}). ` + out.text;
    return out;
  }
  const violinComfort = key => comfort(key, 'violin');

  // Suggested 1st-position fingering for string instruments: "0".."4", or '' when out of reach.
  const FINGER = {
    violin: { 0: 0, 1: 1, 2: 1, 3: 2, 4: 2, 5: 3, 6: 3, 7: 4 },
    viola: { 0: 0, 1: 1, 2: 1, 3: 2, 4: 2, 5: 3, 6: 3, 7: 4 },
    cello: { 0: 0, 1: 1, 2: 1, 3: 2, 4: 3, 5: 4, 6: 4 },
    bass: { 0: 0, 1: 1, 2: 1, 3: 2, 4: 4 },
  };
  function fingering(midi, insKey, preferFourth) {
    const ins = INSTRUMENTS[insKey], tab = FINGER[insKey];
    if (!ins || !ins.open || !tab) return '';
    const opts = [];
    ins.open.forEach((o, si) => { const d = midi - o; if (tab[d] != null) opts.push({ f: tab[d], d, si }); });
    if (!opts.length) return '';
    // open strings beat 4th finger unless asked; otherwise prefer the lower string (fewer string crossings up high)
    opts.sort((a, b) => (preferFourth ? (a.f === 0) - (b.f === 0) : (a.f === 4) - (b.f === 4)) || a.si - b.si);
    return String(opts[0].f);
  }

  // Time signature: beatsPerBar counts detected beats; in 6/8, 9/8, 12/8 a beat is a dotted quarter.
  function meter(song) {
    const bpb = song.beatsPerBar || 4;
    const ts = song.timeSig || `${bpb}/4`;
    const [num, den] = ts.split('/').map(Number);
    const compound = den === 8 && num % 3 === 0;
    const q = compound ? 1.5 : den === 8 ? 0.5 : 1;   // quarter notes per beat
    return { num, den, bpb, q, compound, text: ts, TPB: Math.round(12 * q) };
  }

  function accidentalText(key) {
    const s = sig(key);
    if (s === 0) return 'No sharps or flats';
    const sharpOrder = ['F#', 'C#', 'G#', 'D#', 'A#', 'E#'];
    const flatOrder = ['Bb', 'Eb', 'Ab', 'Db', 'Gb', 'Cb'];
    const list = s > 0 ? sharpOrder.slice(0, s) : flatOrder.slice(0, -s);
    return `${Math.abs(s)} ${s > 0 ? 'sharp' : 'flat'}${Math.abs(s) > 1 ? 's' : ''}: ${list.join(', ')}`;
  }

  // Most frequent 4-chord pattern (by bar) → "main progression"
  function mainProgression(chords, key, bpb) {
    if (!chords || chords.length < 4) return null;
    const seq = [];
    for (const c of chords) {
      const name = chordName(c, key);
      if (!seq.length || seq[seq.length - 1].name !== name) seq.push({ name, num: number(c, key) });
    }
    const counts = new Map();
    for (let i = 0; i + 4 <= seq.length; i++) {
      const k = seq.slice(i, i + 4).map(x => x.name).join(' ');
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    let best = null, bestN = 0;
    for (const [k, n] of counts) if (n > bestN) { best = k; bestN = n; }
    if (!best || bestN < 2) return null;
    const ns = best.split(' ');
    const nums = ns.map(n => seq.find(x => x.name === n).num);
    return { names: ns, numbers: nums, times: bestN };
  }

  function chordSummary(chords, key) {
    const m = new Map();
    for (const c of chords || []) {
      const name = chordName(c, key);
      const e = m.get(name) || { name, num: number(c, key), beats: 0 };
      e.beats += c.dur;
      m.set(name, e);
    }
    return [...m.values()].sort((a, b) => b.beats - a.beats);
  }

  function chordTones(c) {
    if (c.root == null) return [];
    return (QUAL[c.quality] || QUAL.maj).i.map(i => mod(c.root + i, 12));
  }

  // Instruments. Notes are stored at concert pitch; tr = how much higher it's written.
  // lo/hi = playable concert range, center = comfortable middle, first = top of 1st position.
  const INSTRUMENTS = {
    violin:    { open: [55, 62, 69, 76], name: 'Violin', group: 'Strings', clef: 'treble', tr: 0, lo: 55, hi: 100, center: 74, first: 83, tone: 'strings' },
    viola:     { open: [48, 55, 62, 69], name: 'Viola', group: 'Strings', clef: 'alto', tr: 0, lo: 48, hi: 88, center: 64, first: 76, tone: 'strings' },
    cello:     { open: [36, 43, 50, 57], name: 'Cello', group: 'Strings', clef: 'bass', tr: 0, lo: 36, hi: 76, center: 52, first: 62, tone: 'low' },
    bass:      { open: [28, 33, 38, 43], name: 'Double bass', group: 'Strings', clef: 'bass', tr: 12, lo: 28, hi: 60, center: 40, tone: 'low' },
    harp:      { name: 'Harp', group: 'Strings', clef: 'treble', tr: 0, lo: 48, hi: 96, center: 72, tone: 'pluck' },
    piccolo:   { name: 'Piccolo', group: 'Woodwind', clef: 'treble', tr: -12, lo: 74, hi: 105, center: 88, tone: 'flute' },
    flute:     { name: 'Flute', group: 'Woodwind', clef: 'treble', tr: 0, lo: 60, hi: 96, center: 79, tone: 'flute' },
    oboe:      { name: 'Oboe', group: 'Woodwind', clef: 'treble', tr: 0, lo: 58, hi: 91, center: 74, tone: 'oboe' },
    coranglais:{ name: 'Cor anglais (F)', group: 'Woodwind', clef: 'treble', tr: 7, lo: 52, hi: 81, center: 65, tone: 'oboe' },
    clarinet:  { name: 'Clarinet in B\u266d', group: 'Woodwind', clef: 'treble', tr: 2, lo: 50, hi: 91, center: 67, tone: 'clarinet' },
    bassclar:  { name: 'Bass clarinet (B\u266d)', group: 'Woodwind', clef: 'treble', tr: 14, lo: 38, hi: 72, center: 53, tone: 'clarinet' },
    bassoon:   { name: 'Bassoon', group: 'Woodwind', clef: 'bass', tr: 0, lo: 34, hi: 72, center: 50, tone: 'bassoon' },
    horn:      { name: 'French horn (F)', group: 'Brass', clef: 'treble', tr: 7, lo: 41, hi: 77, center: 60, tone: 'horn' },
    trumpet:   { name: 'Trumpet in B\u266d', group: 'Brass', clef: 'treble', tr: 2, lo: 54, hi: 82, center: 67, tone: 'brass' },
    trombone:  { name: 'Trombone', group: 'Brass', clef: 'bass', tr: 0, lo: 40, hi: 72, center: 55, tone: 'brass' },
    tuba:      { name: 'Tuba', group: 'Brass', clef: 'bass', tr: 0, lo: 28, hi: 58, center: 41, tone: 'horn' },
    altosax:   { name: 'Alto sax (E\u266d)', group: 'Other', clef: 'treble', tr: 9, lo: 49, hi: 81, center: 63, tone: 'sax' },
    tenorsax:  { name: 'Tenor sax (B\u266d)', group: 'Other', clef: 'treble', tr: 14, lo: 44, hi: 76, center: 58, tone: 'sax' },
    guitar:    { name: 'Guitar (melody)', group: 'Other', clef: 'treble', tr: 12, lo: 40, hi: 76, center: 60, tone: 'pluck' },
    piano:     { name: 'Piano / keys', group: 'Other', clef: 'treble', tr: 0, lo: 48, hi: 96, center: 72, tone: 'pluck' },
  };
  const CLEF = { // staff steps of top and bottom line, rest positions
    treble: { top: 38, bottom: 30, rest: 'b/4', wrest: 'd/5' },
    alto:   { top: 32, bottom: 24, rest: 'c/4', wrest: 'e/4' },
    bass:   { top: 26, bottom: 18, rest: 'd/3', wrest: 'f/3' },
  };
  const inst = p => INSTRUMENTS[(p && p.instrument) || 'violin'] || INSTRUMENTS.violin;
  const writtenKey = (key, i) => ({ tonic: mod(key.tonic + (i.tr || 0), 12), mode: key.mode });

  // Staff position (as staffStep counts it) -> MIDI note, with the key signature's sharps/flats.
  function stepToMidi(step, key) {
    const oct = Math.floor(step / 7), letter = mod(step, 7);
    let m = (oct + 1) * 12 + MAJOR_SCALE[letter];
    const sg = sig(key), L = LETTERS[letter];
    if (sg > 0 && 'FCGDAEB'.slice(0, sg).includes(L)) m += 1;
    if (sg < 0 && 'BEADGCF'.slice(0, -sg).includes(L)) m -= 1;
    return m;
  }
  // The note called `letter` (A-G) in the key, in the octave closest to `near`.
  function letterToMidi(letter, key, near) {
    const base = stepToMidi(4 * 7 + LETTERS.indexOf(letter.toUpperCase()), key);
    let best = base, bd = 1e9;
    for (let o = -4; o <= 4; o++) { const m = base + 12 * o, d = Math.abs(m - near); if (d < bd) { bd = d; best = m; } }
    return best;
  }
  return { stepToMidi, letterToMidi, QUAL, isMinor, comfort, fingering, meter, INSTRUMENTS, CLEF, inst, writtenKey, mod, sig, pcName, keyName, vexKey, vexNote, noteName, staffStep, scale, chordName, number, parseChord,
    violinComfort, accidentalText, mainProgression, chordSummary, chordTones, SHARPS, FLATS };
})();
