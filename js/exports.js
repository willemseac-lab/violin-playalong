// Exports: printable PDF sheet music and MusicXML (opens in MuseScore, Sibelius, Finale…).
const Exports = (() => {
  const SVG_CSS = `.lyric{font:14px system-ui,sans-serif;fill:#222}.chord{font:700 14.5px system-ui,sans-serif;fill:#222}
.chord.cont{fill:#999}.chord-num{font-size:11px;fill:#666}.bar-num{font:10px system-ui,sans-serif;fill:#777}
.part-label{font:600 10.5px system-ui,sans-serif;fill:#555}.section-mark{font:700 13px Georgia,serif;fill:#111}
.section-box{fill:#fff;stroke:#111;stroke-width:1}.tempo-mark{font:700 13px Georgia,serif;fill:#111}`;

  async function svgImage(svg, w, h, extraCss) {
    const c = svg.cloneNode(true);
    c.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    c.setAttribute('width', w); c.setAttribute('height', h);
    const st = document.createElementNS('http://www.w3.org/2000/svg', 'style');
    st.textContent = SVG_CSS + (extraCss || '');
    c.insertBefore(st, c.firstChild);
    const img = new Image();
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(new XMLSerializer().serializeToString(c));
    await img.decode();
    return img;
  }

  // ---------------------------------------------------------------- PDF
  async function pdf(song, o, onProgress) {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
    const PW = 210, PH = 297, M = 14, usable = PW - 2 * M;
    const LW = o.perLine * 230 + 40;
    const host = document.createElement('div');
    host.style.cssText = `position:fixed;left:-20000px;top:0;width:${LW + 16}px;background:#fff`;
    document.body.appendChild(host);
    try {
      const layout = Score.render(host, song, { width: LW + 4, zoom: 1, perLine: o.perLine, parts: o.parts,
        showLyrics: o.showLyrics, showChords: o.showChords, chordMode: o.chordMode, showFing: o.showFing, showTempo: true, range: o.range, print: true });
      const mmPer = usable / LW, k = 2.4;   // render at ~200 dpi
      const header = () => {
        doc.setFont('helvetica', 'bold'); doc.setFontSize(18);
        doc.text(song.title || 'Song', PW / 2, M + 6, { align: 'center' });
        doc.setFont('helvetica', 'normal'); doc.setFontSize(10);
        const ins = o.parts.length === 1 ? Theory.inst(o.parts[0]) : null;
        const keyTxt = ins && ins.tr ? `${Theory.keyName(Theory.writtenKey(song.key, ins))} (written for ${ins.name})` : Theory.keyName(song.key);
        doc.text(o.subtitle || '', M, M + 13);
        doc.text(`${keyTxt} · ${Theory.meter(song).text}`, PW - M, M + 13, { align: 'right' });
        return M + 18;
      };
      let page = 1, y = header();
      for (let i = 0; i < layout.systems.length; i++) {
        const sys = layout.systems[i];
        const hmm = sys.H * mmPer;
        if (y + hmm > PH - M - 6) {
          doc.setFontSize(9); doc.text(`${page}`, PW / 2, PH - 7, { align: 'center' });
          doc.addPage(); page++; y = M;
        }
        const img = await svgImage(sys.svg, Math.round(sys.W * k), Math.round(sys.H * k));
        const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
        const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.drawImage(img, 0, 0);
        doc.addImage(c.toDataURL('image/png'), 'PNG', M, y, sys.W * mmPer, hmm, undefined, 'FAST');
        y += hmm + 2;
        onProgress && onProgress((i + 1) / layout.systems.length);
        await new Promise(r => setTimeout(r, 0));
      }
      doc.setFontSize(9); doc.text(`${page}`, PW / 2, PH - 7, { align: 'center' });
      return doc.output('blob');
    } finally { host.remove(); }
  }

  // ---------------------------------------------------------------- MusicXML
  const esc = t => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const TYPE = { 48: ['whole', 0], 36: ['half', 1], 24: ['half', 0], 18: ['quarter', 1], 12: ['quarter', 0], 9: ['eighth', 1], 6: ['eighth', 0], 3: ['16th', 0] };
  const TTYPE = { 8: 'quarter', 4: 'eighth', 2: '16th' };
  const KIND = { maj: 'major', min: 'minor', dim: 'diminished', sus2: 'suspended-second', sus4: 'suspended-fourth', 7: 'dominant', maj7: 'major-seventh', m7: 'minor-seventh' };
  const CLEF = { treble: ['G', 2], alto: ['C', 3], bass: ['F', 4] };
  function pitchXml(midi, key) {
    const n = Theory.pcName(midi, key);
    const alter = n.length > 1 ? (n[1] === '#' ? 1 : -1) : 0;
    return `<pitch><step>${n[0]}</step>${alter ? `<alter>${alter}</alter>` : ''}<octave>${Math.floor(midi / 12) - 1}</octave></pitch>`;
  }
  function transposeXml(tr) {
    if (!tr) return '';
    const oct = Math.trunc(tr / 12), r = tr - oct * 12;
    const dia = { 0: 0, 2: 1, 5: 3, 7: 4, 9: 5, [-2]: -1 }[r] ?? Math.round(r * 7 / 12);
    return `<transpose><diatonic>${-dia}</diatonic><chromatic>${-r}</chromatic>${oct ? `<octave-change>${-oct}</octave-change>` : ''}</transpose>`;
  }

  function musicxml(song) {
    const M = Theory.meter(song), TPB = M.TPB, BAR = M.bpb * TPB;
    const { m0, m1 } = Score.songRange(song);
    const parts = song.parts;
    const chords = [...(song.chords || [])].sort((a, b) => a.beat - b.beat);
    const lyrics = song.lyrics || [];
    const sections = song.sections || [];
    let xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">
<score-partwise version="4.0">
<work><work-title>${esc(song.title || 'Song')}</work-title></work>
<identification><encoding><software>Violin Play-Along</software></encoding></identification>
<part-list>${parts.map((p, i) => `<score-part id="P${i + 1}"><part-name>${esc(p.name || 'Part')}</part-name><score-instrument id="P${i + 1}-I1"><instrument-name>${esc(Theory.inst(p).name)}</instrument-name></score-instrument></score-part>`).join('')}</part-list>
`;
    parts.forEach((p, pi) => {
      const ins = Theory.inst(p), wkey = Theory.writtenKey(song.key, ins), tr = ins.tr || 0;
      const first = pi === 0;
      xml += `<part id="P${pi + 1}">\n`;
      let tieOpen = false;
      const slurEnds = new Map(), wedgeEnds = new Map();
      for (let m = m0; m < m1; m++) {
        const startT = m * BAR, endT = startT + BAR;
        xml += `<measure number="${m - m0 + 1}">`;
        if (m === m0) {
          const [sign, line] = CLEF[ins.clef];
          xml += `<attributes><divisions>12</divisions><key><fifths>${Theory.sig(wkey)}</fifths><mode>${song.key.mode}</mode></key>` +
            `<time><beats>${M.num}</beats><beat-type>${M.den}</beat-type></time><clef><sign>${sign}</sign><line>${line}</line></clef>${transposeXml(tr)}</attributes>`;
          if (first && song.tempo) xml += `<direction placement="above"><direction-type>${song.tempoText ? `<words font-weight="bold">${esc(song.tempoText)}</words>` : ''}` +
            `<metronome><beat-unit>${M.compound ? 'quarter' : M.den === 8 ? 'eighth' : 'quarter'}</beat-unit>${M.compound ? '<beat-unit-dot/>' : ''}<per-minute>${Math.round(song.tempo)}</per-minute></metronome></direction-type><sound tempo="${Math.round(song.tempo * (M.compound ? 1.5 : 1))}"/></direction>`;
        }
        if (first) for (const s of sections) if (Math.round(s.b * TPB) >= startT && Math.round(s.b * TPB) < endT && Math.round(s.b * TPB) === startT)
          xml += `<direction placement="above"><direction-type><rehearsal>${esc(s.name)}</rehearsal></direction-type></direction>`;
        // events in this bar
        const evs = [];
        let cur = startT;
        p.notes.forEach((n, i) => {
          const ns = Math.round(n.b * TPB), ne = Math.round((n.b + n.d) * TPB);
          if (ne <= startT || ns >= endT || ne <= ns) return;
          const s = Math.max(ns, startT), e = Math.min(ne, endT);
          if (s < cur) return;
          if (s > cur) evs.push({ rest: true, s: cur, e: s });
          evs.push({ i, n, s, e, tieIn: ns < startT, tieOut: ne > endT });
          cur = e;
        });
        if (cur < endT) evs.push({ rest: true, s: cur, e: endT });
        // pieces with triplet groups
        const pieces = [];
        for (const ev of evs) {
          if (ev.rest && ev.e - ev.s === BAR) { pieces.push({ ev, d: BAR, whole: true, s: ev.s }); continue; }
          const ps = Score.splitDur(ev.s - startT, ev.e - ev.s, M);
          ps.forEach((pc, k) => pieces.push({ ev, d: pc.d, trip: pc.trip, s: startT + pc.pos, first: k === 0, last: k === ps.length - 1 }));
        }
        let grp = 0, unit = 0;
        for (const pc of pieces) {
          if (!pc.trip) { grp = 0; continue; }
          const u = pc.d === 2 ? 6 : 12;
          if (grp === 0 || u !== unit) { pc.tupStart = true; grp = 0; unit = u; }
          grp += pc.d;
          if (grp >= unit) { pc.tupStop = true; grp = 0; }
        }
        let lastTripOpen = null;
        for (const pc of pieces) {
          const { ev } = pc;
          // chord symbols and words that start inside this piece
          if (first) for (const c of chords) {
            const ct = Math.round(c.beat * TPB);
            if (ct >= pc.s && ct < pc.s + pc.d && c.root != null) {
              const rn = Theory.pcName(c.root, song.key), bn = c.bass != null && c.bass !== c.root ? Theory.pcName(c.bass, song.key) : null;
              const alt = n => n.length > 1 ? `<root-alter>${n[1] === '#' ? 1 : -1}</root-alter>` : '';
              xml += `<harmony><root><root-step>${rn[0]}</root-step>${alt(rn)}</root><kind>${KIND[c.quality] || 'major'}</kind>` +
                (bn ? `<bass><bass-step>${bn[0]}</bass-step>${bn.length > 1 ? `<bass-alter>${bn[1] === '#' ? 1 : -1}</bass-alter>` : ''}</bass>` : '') +
                (ct > pc.s ? `<offset>${ct - pc.s}</offset>` : '') + `</harmony>`;
            }
          }
          const n = ev.n;
          if (n && pc.first && !ev.tieIn) {
            if (n.dyn && /^(ppp|pp|p|mp|mf|f|ff|fff)$/.test(n.dyn)) xml += `<direction placement="below"><direction-type><dynamics><${n.dyn}/></dynamics></direction-type></direction>`;
            else if (n.dyn) xml += `<direction placement="below"><direction-type><words font-style="italic">${esc(n.dyn)}</words></direction-type></direction>`;
            if (n.text) xml += `<direction placement="above"><direction-type><words font-weight="bold">${esc(n.text)}</words></direction-type></direction>`;
            if (n.hp) { xml += `<direction placement="below"><direction-type><wedge type="${n.hp.type === 'dim' ? 'diminuendo' : 'crescendo'}" number="1"/></direction-type></direction>`; wedgeEnds.set(ev.i + (n.hp.n || 1), true); }
          }
          xml += '<note>';
          if (ev.rest) xml += pc.whole ? '<rest measure="yes"/>' : '<rest/>';
          else xml += pitchXml(n.p + tr, wkey);
          xml += `<duration>${pc.d}</duration>`;
          const tieStart = n && (!pc.last || ev.tieOut), tieStop = n && (!pc.first || ev.tieIn);
          if (tieStop) xml += '<tie type="stop"/>';
          if (tieStart) xml += '<tie type="start"/>';
          if (!pc.whole) {
            if (pc.trip) xml += `<type>${TTYPE[pc.d] || '16th'}</type>`;
            else { const t = TYPE[pc.d] || ['16th', 0]; xml += `<type>${t[0]}</type>${t[1] ? '<dot/>' : ''}`; }
          }
          if (pc.trip) xml += '<time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification>';
          let nota = '';
          if (tieStop) nota += '<tied type="stop"/>';
          if (tieStart) nota += '<tied type="start"/>';
          if (pc.tupStart) nota += '<tuplet type="start" bracket="yes"/>';
          if (pc.tupStop) nota += '<tuplet type="stop"/>';
          if (n && pc.first && !ev.tieIn) {
            if (n.slur) { nota += '<slur type="start" number="1"/>'; slurEnds.set(ev.i + n.slur, true); }
            const tech = (n.bow === 'down' ? '<down-bow/>' : n.bow === 'up' ? '<up-bow/>' : '') + (n.fing != null && n.fing !== '' ? `<fingering>${esc(n.fing)}</fingering>` : '');
            if (tech) nota += `<technical>${tech}</technical>`;
          }
          if (n && pc.last && !ev.tieOut) {
            if (slurEnds.has(ev.i)) { nota += '<slur type="stop" number="1"/>'; slurEnds.delete(ev.i); }
            if (n.ferm) nota += '<fermata type="upright"/>';
          }
          if (nota) xml += `<notations>${nota}</notations>`;
          if (first && n && pc.first && !ev.tieIn) {
            const w = lyrics.find(w => Math.abs(Math.round(w.b * TPB) - pc.s) < 2);
            if (w) xml += `<lyric number="1"><syllabic>${/-$/.test(w.text) ? 'begin' : 'single'}</syllabic><text>${esc(w.text.replace(/-$/, ''))}</text></lyric>`;
          }
          xml += '</note>';
          if (n && pc.last && !ev.tieOut && wedgeEnds.has(ev.i)) { xml += '<direction><direction-type><wedge type="stop" number="1"/></direction-type></direction>'; wedgeEnds.delete(ev.i); }
        }
        if (m === m1 - 1) xml += '<barline location="right"><bar-style>light-heavy</bar-style></barline>';
        xml += '</measure>\n';
      }
      xml += '</part>\n';
    });
    return xml + '</score-partwise>\n';
  }

  return { pdf, musicxml, svgImage, SVG_CSS };
})();
