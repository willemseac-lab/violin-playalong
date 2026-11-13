// Sheet music rendering with VexFlow: staves per part, sections, chords + lyrics on top,
// time-proportional spacing, triplets and compound time, hit-testing, beat <-> x mapping.
//
// Internally everything is counted in ticks: 12 ticks = one quarter note, so 16ths (3),
// 8th-note triplets (4) and 6/8 eighths (6) all land on whole numbers.
const Score = (() => {
  const VF = Vex.Flow;
  const STD = { 48: 'w', 36: 'hd', 24: 'h', 18: 'qd', 12: 'q', 9: '8d', 6: '8', 3: '16' };
  const TRIP = { 8: 'q', 4: '8', 2: '16' };
  const SVGNS = 'http://www.w3.org/2000/svg';
  const COLORS = { sel: '#1e6fd9', ref: '#7a7a7a', bad: '#c62828' };

  // Split a stretch of `len` ticks starting `pos` ticks into the bar into notatable pieces.
  function splitDur(pos, len, M) {
    const B = M.TPB, out = [];
    const sameBeat = (p, d) => Math.floor(p / B) === Math.floor((p + d - 1) / B);
    const fitsStd = (p, d) => {
      if (p % 3 || d % 3) return false;
      if (d >= B) return p % B === 0 && (d % B === 0 || (!M.compound && d === 18 && p % 12 === 0));
      if (M.compound) return d === 12 ? (p % B === 0 || p % B === 6) && sameBeat(p, d) : sameBeat(p, d) && (d !== 9 || p % 6 === 0);
      if (d === 9) return p % 6 === 0 && sameBeat(p, d);
      return sameBeat(p, d);
    };
    const fitsTrip = (p, d) => !M.compound && p % (d === 8 ? 4 : d) === 0 && sameBeat(p, d);
    while (len > 0) {
      let pick = null, trip = false;
      const tripFirst = pos % 3 !== 0 || len % 3 !== 0;   // off the 16th grid: it's a triplet
      if (tripFirst) for (const d of [8, 4, 2]) if (d <= len && fitsTrip(pos, d)) { pick = d; trip = true; break; }
      if (!pick) for (const d of [48, 36, 24, 18, 12, 9, 6, 3]) if (d <= len && fitsStd(pos, d)) { pick = d; break; }
      if (!pick && !tripFirst) for (const d of [8, 4, 2]) if (d <= len && fitsTrip(pos, d)) { pick = d; trip = true; break; }
      if (!pick) { pick = len >= 3 && pos % 3 === 0 ? 3 : len >= 2 ? 2 : len; trip = pick === 2; }
      out.push({ d: pick, trip, pos });
      pos += pick; len -= pick;
    }
    return out;
  }

  function measureEvents(notes, startT, endT, TPB) {
    const ev = [];
    let cur = startT;
    for (let i = 0; i < notes.length; i++) {
      const n = notes[i];
      const ns = Math.round(n.b * TPB), ne = Math.round((n.b + n.d) * TPB);
      if (ne <= startT || ns >= endT || ne <= ns) continue;
      const s = Math.max(ns, startT), e = Math.min(ne, endT);
      if (s < cur) continue;
      if (s > cur) ev.push({ rest: true, s: cur, e: s });
      ev.push({ idx: i, s, e, tieIn: ns < startT, tieOut: ne > endT });
      cur = e;
    }
    if (cur < endT) ev.push({ rest: true, s: cur, e: endT });
    return ev;
  }

  function songRange(song) {
    const bpb = song.beatsPerBar || 4;
    let first = Infinity, last = 0;
    for (const p of song.parts || []) for (const n of p.notes) { first = Math.min(first, n.b); last = Math.max(last, n.b + n.d); }
    for (const w of song.lyrics || []) { first = Math.min(first, w.b); last = Math.max(last, w.b + 1); }
    for (const c of song.chords || []) { first = Math.min(first, c.beat); last = Math.max(last, c.beat + c.dur); }
    if (song.beats && song.duration) last = Math.max(last, Timeline.TtoBeat(song, Timeline.total(song)));
    if (!isFinite(first)) first = 0;
    return { m0: Math.max(0, Math.floor(first / bpb)), m1: Math.max(1, Math.ceil(last / bpb - 1e-6)) };
  }

  function el(tag, attrs, text) {
    const e = document.createElementNS(SVGNS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (text != null) e.textContent = text;
    return e;
  }

  function tempoLabel(song, M) {
    if (!song.tempo && !song.tempoText) return '';
    const bpm = song.tempo ? Math.round(song.tempo) : null;
    const unit = M.compound ? '♩.' : M.den === 8 ? '♪' : '♩';
    return (song.tempoText ? song.tempoText + ' ' : '') + (bpm ? (song.tempoText ? `(${unit} = ${bpm})` : `${unit} = ${bpm}`) : '');
  }

  function render(container, song, opts) {
    const key = song.key || { tonic: 0, mode: 'major' };
    const M = Theory.meter(song);
    const bpb = M.bpb, TPB = M.TPB, BAR = bpb * TPB;
    const zoom = opts.zoom || 1;
    const W = Math.max(280, (opts.width - 4) / zoom);
    const parts = opts.parts;
    const full = songRange(song);
    const m0 = opts.range ? Math.max(full.m0, opts.range.m0) : full.m0;
    const m1 = opts.range ? Math.min(full.m1, opts.range.m1) : full.m1;
    // fast notes need wider bars: aim for ~17px per shortest note
    let smallest = 1;
    for (const p of parts) for (const n of p.notes) if (n.d > 0 && n.d < smallest) smallest = Math.max(1 / 6, n.d);
    const barMin = Math.max(230, bpb / smallest * 17 + 50);
    const auto = Math.max(1, Math.floor((W - 30) / barMin));
    const perLine = opts.perLine ? Math.max(1, Math.min(opts.perLine, auto)) : auto;
    const layout = { systems: [], hits: [], measures: {}, zoom, bpb, m0, m1, TPB };
    container.innerHTML = '';

    const lyrics = (song.lyrics || []).map((w, i) => ({ ...w, i }));
    const chords = (song.chords || []).map((c, i) => ({ ...c, i }));
    const sections = (song.sections || []).map((s, i) => ({ ...s, i })).sort((a, b) => a.b - b.b);
    const tempoTxt = opts.showTempo === false ? '' : tempoLabel(song, M);
    const pendingTie = {};

    for (let sm = m0; sm < m1; sm += perLine) {
      const sysIdx = layout.systems.length;
      const me = Math.min(m1, sm + perLine);
      const b0 = sm * bpb, b1 = me * bpb;

      // vertical layout
      const secs = sections.filter(s => s.b >= b0 && s.b < b1);
      const showMarks = secs.length > 0 || (sm === m0 && tempoTxt);
      const showChords = opts.showChords && chords.some(c => c.beat < b1 && c.beat + c.dur > b0);
      const showLyrics = opts.showLyrics && lyrics.some(w => w.b >= b0 && w.b < b1);
      let y = 14;
      const markY = showMarks ? y + 16 : null; if (showMarks) y += 26;
      const chordY = showChords ? y + 14 : null; if (showChords) y += 22;
      const lyricY = showLyrics ? y + 14 : null; if (showLyrics) y += 22;
      const blocks = [];
      for (const p of parts) {
        const ins = Theory.inst(p), cl = Theory.CLEF[ins.clef], wkey = ins.drums ? { tonic: 0, mode: 'major' } : Theory.writtenKey(key, ins), tr = ins.tr || 0;
        let hi = cl.top, lo = cl.bottom, marks = false;
        for (const n of p.notes) {
          if (n.b + n.d <= b0 || n.b >= b1) continue;
          const st = ins.drums ? (Theory.DRUMS[n.p] || Theory.DRUMS[38]).step : Theory.staffStep(n.p + tr, wkey);
          hi = Math.max(hi, st); lo = Math.min(lo, st);
          if (n.fing != null && opts.showFing !== false || n.bow || n.ferm || n.text) marks = true;
        }
        const above = Math.max(0, hi - cl.top) * 5 + (parts.length > 1 ? 30 : 18) + (marks ? 14 : 0);
        const below = Math.max(0, cl.bottom - lo) * 5 + 34;
        const topLine = y + above;
        blocks.push({ part: p, ins, cl, wkey, tr, vexKey: Theory.vexKey(wkey), top: y, topLine, staveY: topLine - 40, bottom: topLine + 40 + below });
        y = topLine + 40 + below;
      }
      const H = y + 4;

      const div = document.createElement('div');
      div.className = 'system';
      div.dataset.sys = sysIdx;
      container.appendChild(div);
      const renderer = new VF.Renderer(div, VF.Renderer.Backends.SVG);
      renderer.resize(W, H);
      const ctx = renderer.getContext();
      const svg = div.querySelector('svg');
      svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
      svg.setAttribute('width', W * zoom);
      svg.setAttribute('height', H * zoom);

      const left = 8;
      // Time-proportional spacing: every bar gets the same width for its notes, and each
      // note sits where its beat falls, so the cursor moves at a constant speed.
      const probe = (first, time) => Math.max(...blocks.map(bl => {
        const st = new VF.Stave(0, 0, 300);
        if (first) { st.addClef(bl.ins.clef).addKeySignature(bl.vexKey); if (time) st.addTimeSignature(M.text); }
        return st.getNoteStartX();
      }));
      const offFirst = probe(true, sm === m0), offPlain = probe(false), LEAD = 5;
      const area = (W - left - 6 - probe(true, true) - (perLine - 1) * offPlain) / perLine;
      const span = area + offPlain;   // pixels per bar, the same for every bar on the line
      let x = left;
      const sys = { div, svg, idx: sysIdx, m0: sm, m1: me, H, W, zoom, blocks, measures: [] };
      layout.systems.push(sys);
      const sysNotes = {}; // partId -> [{idx, first, last}]

      for (let m = sm; m < me; m++) {
        const w = area + (m === sm ? offFirst : offPlain);
        const staves = blocks.map(bl => {
          const st = new VF.Stave(x, bl.staveY, w);
          if (m === sm) st.addClef(bl.ins.clef).addKeySignature(bl.vexKey);
          if (m === m0) st.addTimeSignature(M.text);
          if (m === full.m1 - 1) st.setEndBarType(VF.Barline.type.END);
          return st;
        });
        const startX = Math.max(...staves.map(s => s.getNoteStartX()));
        staves.forEach(s => { s.setNoteStartX(startX); s.setContext(ctx).draw(); });

        const voices = [], allBeams = [], allTies = [], allTuplets = [], pts = [];
        const mStart = m * bpb, startT = m * BAR, endT = startT + BAR;
        blocks.forEach((bl, bi) => {
          const p = bl.part;
          const ref = !p.editable && parts.length > 1 && !opts.print;
          const evs = measureEvents(p.notes, startT, endT, TPB);
          const tick = [], tripRun = [];
          const flushTrip = () => {
            // group triplet pieces into brackets of one beat (or half a beat for 16ths)
            let grp = [], acc = 0, unit = 0;
            const close = () => { if (grp.length > 1 || (grp.length === 1 && acc < unit)) allTuplets.push(new VF.Tuplet(grp.map(g => g.sn), { num_notes: 3, notes_occupied: 2, ratioed: false })); grp = []; acc = 0; };
            for (const t of tripRun) {
              const u = t.d === 2 ? 6 : 12;
              if (grp.length && (u !== unit || Math.floor(t.pos / u) !== Math.floor(grp[0].pos / u))) close();
              unit = u; grp.push(t); acc += t.d;
              if (acc >= unit) close();
            }
            if (grp.length) close();
            tripRun.length = 0;
          };
          for (const ev of evs) {
            const made = [];
            if (ev.rest && ev.e - ev.s === BAR) {
              const sn = new VF.StaveNote({ keys: [bl.cl.wrest], clef: bl.ins.clef, duration: 'wr', align_center: true });
              made.push({ sn, s: ev.s, d: BAR });
            } else {
              for (const pc of splitDur(ev.s - startT, ev.e - ev.s, M)) {
                const code = pc.trip ? TRIP[pc.d] || '16' : STD[pc.d] || '16';
                let sn;
                if (ev.rest) sn = new VF.StaveNote({ keys: [bl.cl.rest], clef: bl.ins.clef, duration: code + 'r' });
                else {
                  const note = p.notes[ev.idx];
                  const keys = bl.ins.drums
                    ? [...new Set([note.p, ...(note.extra || [])])].map(d => Theory.DRUMS[d] || Theory.DRUMS[38])
                        .sort((a, b) => a.step - b.step).map(d => d.key)
                    : [Theory.vexNote(note.p + bl.tr, bl.wkey)];
                  sn = bl.ins.drums
                    ? new VF.StaveNote({ keys, clef: 'percussion', duration: code, stem_direction: VF.Stem.UP })
                    : new VF.StaveNote({ keys, clef: bl.ins.clef, duration: code, auto_stem: true });
                }
                if (code.endsWith('d')) VF.Dot.buildAndAttach([sn], { all: true });
                const mk = { sn, s: startT + pc.pos, d: pc.d, pos: pc.pos, trip: pc.trip };
                made.push(mk);
                if (pc.trip) tripRun.push(mk); else flushTrip();
              }
            }
            const isSel = opts.sel && opts.sel.partId === p.id &&
              (ev.rest ? (opts.sel.rest && Math.abs(opts.sel.rest.s - ev.s / TPB) < 1e-6) : opts.sel.idx === ev.idx);
            const note = ev.rest ? null : p.notes[ev.idx];
            const outOfRange = note && (note.p < bl.ins.lo || note.p > bl.ins.hi);
            for (const mk of made) {
              if (isSel) mk.sn.setStyle({ fillStyle: COLORS.sel, strokeStyle: COLORS.sel });
              else if (outOfRange) mk.sn.setStyle({ fillStyle: COLORS.bad, strokeStyle: COLORS.bad });
              else if (note && opts.colorOf && opts.colorOf(p.id, ev.idx)) { const c = opts.colorOf(p.id, ev.idx); mk.sn.setStyle({ fillStyle: c, strokeStyle: c }); }
              else if (ref) mk.sn.setStyle({ fillStyle: COLORS.ref, strokeStyle: COLORS.ref });
              tick.push(mk.sn);
              layout.hits.push({ sys: sysIdx, block: bi, partId: p.id, idx: ev.rest ? null : ev.idx,
                rest: ev.rest ? { s: ev.s / TPB, e: ev.e / TPB } : null, sn: mk.sn, s: mk.s / TPB });
            }
            if (note) {
              const first = made[0].sn, last = made[made.length - 1].sn;
              if (!ev.tieIn) {
                const above = VF.Modifier.Position.ABOVE;
                if (note.fing != null && note.fing !== '' && opts.showFing !== false) first.addModifier(new VF.Annotation(String(note.fing))
                  .setFont('Arial', 10, 'bold').setVerticalJustification(VF.Annotation.VerticalJustify.TOP), 0);
                if (note.bow === 'down') first.addModifier(new VF.Articulation('am').setPosition(above), 0);
                if (note.bow === 'up') first.addModifier(new VF.Articulation('a|').setPosition(above), 0);
                if (note.dyn) first.addModifier(new VF.Annotation(note.dyn)
                  .setFont('Times New Roman', 14, 'bold', 'italic')
                  .setVerticalJustification(VF.Annotation.VerticalJustify.BOTTOM), 0);
                if (note.text) first.addModifier(new VF.Annotation(note.text)
                  .setFont('Arial', 11, 'bold')
                  .setVerticalJustification(VF.Annotation.VerticalJustify.TOP), 0);
              }
              if (note.ferm && !ev.tieOut) last.addModifier(new VF.Articulation('a@a').setPosition(VF.Modifier.Position.ABOVE), 0);
              for (let k = 1; k < made.length; k++) allTies.push([made[k - 1].sn, made[k].sn]);
              if (ev.tieIn && pendingTie[p.id]) {
                const prev = pendingTie[p.id];
                allTies.push(prev.sys === sysIdx ? [prev.sn, first] : [null, first]);
              }
              pendingTie[p.id] = ev.tieOut ? { sn: last, sys: sysIdx } : null;
              if (ev.tieOut && m === me - 1) allTies.push([last, null]);
              (sysNotes[p.id] = sysNotes[p.id] || []).push({ idx: ev.idx, first, last });
            }
            for (const mk of made) pts.push([mk.s / TPB, mk.sn]);
          }
          flushTrip();
          const voice = new VF.Voice({ num_beats: M.num, beat_value: M.den }).setMode(VF.Voice.Mode.SOFT);
          voice.addTickables(tick);
          VF.Accidental.applyAccidentals([voice], bl.vexKey);
          const beams = VF.Beam.generateBeams(tick.filter(t => !t.isRest()),
            { groups: [M.compound ? new VF.Fraction(3, 8) : new VF.Fraction(1, 4)] });
          voices.push({ voice, stave: staves[bi] });
          allBeams.push(...beams);
        });
        const fmt = new VF.Formatter();
        voices.forEach(v => fmt.joinVoices([v.voice]));
        fmt.format(voices.map(v => v.voice), Math.max(20, staves[0].getNoteEndX() - startX - 10));
        const X0 = startX + LEAD;
        const moved = new Set();
        voices.forEach(v => v.voice.getTickables().forEach(t => t.setStave(v.stave)));
        for (const [b, sn] of pts) {
          if (sn.isCenterAligned && sn.isCenterAligned()) continue;
          const tc = sn.getTickContext();
          if (moved.has(tc)) continue;
          moved.add(tc);
          tc.setX(tc.getX() + (X0 + (b - mStart) / bpb * span) - sn.getAbsoluteX());
        }
        voices.forEach(v => v.voice.draw(ctx, v.stave));
        allBeams.forEach(b => b.setContext(ctx).draw());
        allTuplets.forEach(t => { try { t.setContext(ctx).draw(); } catch (e) { } });
        allTies.forEach(([a, b]) => {
          new VF.StaveTie({ first_note: a, last_note: b, first_indices: [0], last_indices: [0] }).setContext(ctx).draw();
        });

        const points = [[mStart, X0], [mStart + bpb, X0 + span]];
        const meas = { m, sys: sysIdx, x0: x, x1: x + w, startX, points };
        sys.measures.push(meas);
        layout.measures[m] = meas;
        x += w;
      }

      // slurs and hairpins (both span note `i` to note `i + n`)
      for (const bl of blocks) {
        const p = bl.part;
        const list = sysNotes[p.id] || [];
        if (!list.length) continue;
        const byIdx = new Map(list.map(o => [o.idx, o]));
        const lo = list[0].idx, hiIdx = list[list.length - 1].idx;
        const span2 = (i, n) => {
          const j = Math.min(p.notes.length - 1, i + n);
          if (j < lo || i > hiIdx) return null;
          const a = byIdx.get(i), b = byIdx.get(j);
          const from = a ? a.first : list[0].first, to = b ? b.last : list[list.length - 1].last;
          return from === to ? null : [from, to];
        };
        p.notes.forEach((nt, i) => {
          if (nt.slur) {
            const sp = span2(i, nt.slur);
            if (sp) try { new VF.Curve(sp[0], sp[1], { cps: [{ x: 0, y: 12 }, { x: 0, y: 12 }] }).setContext(ctx).draw(); } catch (e) { }
          }
          if (nt.hp) {
            const sp = span2(i, nt.hp.n || 1);
            if (sp) try {
              const hp = new VF.StaveHairpin({ first_note: sp[0], last_note: sp[1] },
                nt.hp.type === 'dim' ? VF.StaveHairpin.type.DECRESC : VF.StaveHairpin.type.CRESC);
              hp.setPosition(VF.Modifier.Position.BELOW);
              hp.setRenderOptions({ height: 9, y_shift: 6, left_shift_px: 0, right_shift_px: 0 });
              hp.setContext(ctx).draw();
            } catch (e) { }
          }
        });
      }

      if (blocks.length > 1) {
        blocks.forEach(bl => svg.appendChild(el('text', { x: left + 2, y: bl.top + 11, class: 'part-label' }, bl.part.name)));
      }
      svg.appendChild(el('text', { x: left, y: 10, class: 'bar-num' }, String(sm - full.m0 + 1)));

      // sections (boxed) and the tempo marking
      if (showMarks) {
        let lastEnd = -1;
        if (sm === m0 && tempoTxt) {
          const t = el('text', { x: left + 2, y: markY, class: 'tempo-mark' }, tempoTxt);
          svg.appendChild(t);
          lastEnd = left + 2 + t.getComputedTextLength();
        }
        for (const s of secs) {
          const sx = Math.max(beatToX(layout, s.b).x - 4, lastEnd + 8);
          const t = el('text', { x: sx + 5, y: markY, class: 'section-mark', 'data-sec': s.i }, s.name);
          svg.appendChild(t);
          const tw = t.getComputedTextLength();
          svg.insertBefore(el('rect', { x: sx, y: markY - 14, width: tw + 10, height: 19, rx: 2, class: 'section-box', 'data-sec': s.i }), t);
          lastEnd = sx + tw + 10;
        }
      }
      if (showChords) {
        let lastEnd = -1;
        for (const c of chords) {
          if (c.beat >= b1 || c.beat + c.dur <= b0) continue;
          const cb = Math.max(c.beat, b0);
          let cx = Math.max(beatToX(layout, cb).x, lastEnd + 6);
          const g = el('text', { x: cx, y: chordY, class: 'chord', 'data-i': c.i });
          const name = Theory.chordName(c, key), num = Theory.number(c, key);
          if (opts.chordMode === 'numbers') g.textContent = num;
          else {
            g.textContent = name;
            if (opts.chordMode === 'both') g.appendChild(el('tspan', { class: 'chord-num', dx: 3 }, num));
          }
          if (c.beat < b0) g.setAttribute('class', 'chord cont');
          svg.appendChild(g);
          lastEnd = cx + g.getComputedTextLength();
        }
      }
      if (showLyrics) {
        let lastEnd = -1;
        for (const wd of lyrics) {
          if (wd.b < b0 || wd.b >= b1) continue;
          const lx = Math.max(beatToX(layout, wd.b).x, lastEnd + 4);
          const t = el('text', { x: lx, y: lyricY, class: 'lyric', 'data-i': wd.i }, wd.text);
          svg.appendChild(t);
          lastEnd = lx + t.getComputedTextLength();
        }
      }
      const ov = document.createElement('div');
      ov.className = 'overlay';
      div.appendChild(ov);
      sys.overlay = ov;
    }
    return layout;
  }

  function beatToX(layout, beat) {
    const m = Math.floor(beat / layout.bpb + 1e-9);
    const meas = layout.measures[m];
    if (!meas) return { sys: -1, x: 0 };
    const pts = meas.points;
    let x = pts[0][1];
    for (let i = 0; i < pts.length - 1; i++) {
      const [ba, xa] = pts[i], [bb, xb] = pts[i + 1];
      if (beat >= ba && beat <= bb) { x = xa + (xb - xa) * (beat - ba) / Math.max(1e-6, bb - ba); break; }
      if (beat > bb) x = xb;
    }
    return { sys: meas.sys, x, meas };
  }

  function hitTest(layout, sysIdx, x, y) {
    const sys = layout.systems[sysIdx];
    if (!sys) return null;
    const meas = sys.measures.find(m => x >= m.x0 && x < m.x1);
    const block = sys.blocks.findIndex(b => y >= b.top && y < b.bottom);
    let best = null, bestD = 1e9;
    if (block >= 0) {
      for (const h of layout.hits) {
        if (h.sys !== sysIdx || h.block !== block) continue;
        const d = Math.abs(x - (h.sn.getAbsoluteX() + 6));
        if (d < bestD) { bestD = d; best = h; }
      }
    }
    return { hit: bestD < 28 ? best : null, measure: meas ? meas.m : null, block };
  }

  // half the width of a note head: the cursor is drawn this far right, so it crosses the
  // middle of a note exactly when the note should sound
  const HEAD = 6;
  return { render, beatToX, hitTest, songRange, splitDur, tempoLabel, HEAD };
})();
