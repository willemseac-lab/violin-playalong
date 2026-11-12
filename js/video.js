// Export a play-along video (MP4): the chosen sheet(s) laid out as pages with a
// header, a highlighted bar and a moving cursor, plus the chosen audio mix.
const Video = (() => {
  const supported = () => 'VideoEncoder' in window && 'AudioEncoder' in window && 'OfflineAudioContext' in window && !!window.Mp4Muxer;
  const SVG_CSS = `.lyric{font:14px system-ui,sans-serif;fill:#2b2420}.chord{font:700 14.5px system-ui,sans-serif;fill:#7a2e1f}
.chord.cont{fill:#b9a49b}.chord-num{font-size:11px;fill:#b4532a}.bar-num{font:10px system-ui,sans-serif;fill:#8a7f73}
.part-label{font:600 10.5px system-ui,sans-serif;fill:#7b7068}.section-mark{font:700 13px Georgia,serif;fill:#111}
.section-box{fill:#fff;stroke:#111;stroke-width:1}.tempo-mark{font:700 13px Georgia,serif;fill:#111}`;
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  async function svgImage(svg, w, h) {
    const c = svg.cloneNode(true);
    c.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    c.setAttribute('width', w); c.setAttribute('height', h);
    const st = document.createElementNS('http://www.w3.org/2000/svg', 'style');
    st.textContent = SVG_CSS;
    c.insertBefore(st, c.firstChild);
    const img = new Image();
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(new XMLSerializer().serializeToString(c));
    await img.decode();
    return img;
  }

  async function pickVideoCodec(width, height, fps) {
    const tries = [['avc', 'avc1.640028'], ['avc', 'avc1.4d0028'], ['avc', 'avc1.420028'], ['avc', 'avc1.42001f'], ['vp9', 'vp09.00.40.08'], ['av1', 'av01.0.08M.08']];
    for (const [mux, codec] of tries) {
      const cfg = { codec, width, height, bitrate: height >= 1080 ? 3_000_000 : 1_800_000, framerate: fps };
      if (mux === 'avc') cfg.avc = { format: 'avc' };
      try { if ((await VideoEncoder.isConfigSupported(cfg)).supported) return { mux, cfg }; } catch (e) { }
    }
    return null;
  }
  async function pickAudioCodec(sampleRate) {
    for (const [mux, codec] of [['aac', 'mp4a.40.2'], ['opus', 'opus']]) {
      const cfg = { codec, sampleRate, numberOfChannels: 2, bitrate: 128000 };
      try { if ((await AudioEncoder.isConfigSupported(cfg)).supported) return { mux, cfg }; } catch (e) { }
    }
    return null;
  }

  // Mix the recording (with inserted bars) and the chosen synth parts.
  async function mixAudio(song, urls, o, sr, onProgress) {
    const total = Timeline.total(song) + 1;
    const off = new OfflineAudioContext(2, Math.ceil(total * sr), sr);
    const comp = off.createDynamicsCompressor();
    comp.threshold.value = -8; comp.ratio.value = 6; comp.connect(off.destination);
    const bufs = {};
    const load = async name => {
      if (!name || !urls[name]) return null;
      if (!bufs[name]) bufs[name] = await off.decodeAudioData(await (await fetch(urls[name])).arrayBuffer());
      return bufs[name];
    };
    const play = (buf, T0, a0, dur) => {
      if (!buf || dur <= 0.005 || a0 >= buf.duration) return;
      const s = off.createBufferSource(); s.buffer = buf; s.connect(comp);
      s.start(Math.max(0, T0), a0, Math.min(dur, buf.duration - a0));
    };
    onProgress('Mixing the sound…', 0.02);
    const main = o.track === 'none' ? null : await load(o.track);
    for (const seg of Timeline.segments(song)) {
      if (seg.kind === 'audio') play(main, seg.T0, seg.a0, seg.a1 - seg.a0);
      else if (seg.fill && o.track !== 'none') play(await load(seg.fill.track) || await load('audio'), seg.T0, seg.fill.a0, seg.dur);
    }
    const g = off.createGain(); g.gain.value = o.track === 'none' ? 0.9 : 0.6; g.connect(comp);
    if (Samples.on) await Samples.ensure(song.parts.filter(p => o.hearParts.includes(p.id)).map(p => p.instrument));
    for (const p of song.parts) {
      if (!o.hearParts.includes(p.id)) continue;
      for (const n of p.notes) {
        const t0 = Timeline.beatToT(song, n.b), t1 = Timeline.beatToT(song, n.b + n.d);
        if (t0 < 0 || t0 > total) continue;
        Synth.voice(off, g, p.instrument, n.p, t0, Math.max(0.08, t1 - t0 - 0.02));
      }
    }
    return off.startRendering();
  }

  // o: {parts, track, hearParts, width, height, perLine, fps, showLyrics, showChords, chordMode, partLabel}
  async function make(song, urls, o, onProgress, isCancelled) {
    const W = o.width, H = o.height, fps = o.fps || 24, k = H / 1080;
    const vc = await pickVideoCodec(W, H, fps);
    const sr = 48000;
    const ac = await pickAudioCodec(sr);
    if (!vc || !ac) throw new Error('This browser can\'t make MP4 videos. Try Chrome or Edge.');

    // ---- lay out the music off-screen
    const headerH = Math.round(104 * k), margin = Math.round(34 * k);
    let perLine = o.perLine, LW, scale;
    const host = document.createElement('div');
    document.body.appendChild(host);
    const draw = () => {
      LW = perLine * 230 + 40; scale = (W - 2 * margin) / LW;
      host.style.cssText = `position:fixed;left:-20000px;top:0;width:${LW + 16}px;background:#fff`;
      return Score.render(host, song, { width: LW + 4, zoom: 1, perLine, parts: o.parts,
        showLyrics: o.showLyrics, showChords: o.showChords, chordMode: o.chordMode, sel: null, showFing: o.showFing, range: o.range });
    };
    let layout, pages = [], pageOf = [], sysY = [];
    try {
      layout = draw();
      // Tall systems (many parts): if only one fits per page, use bigger notes to fill the page.
      const availPx = H - headerH - 2 * margin, maxH = Math.max(...layout.systems.map(sy => sy.H));
      if (2 * maxH * scale + 8 > availPx && perLine > 3) {
        const want = Math.min(0.92 * availPx / maxH, (W - 2 * margin) / (3 * 230 + 40));
        const pl = Math.max(3, Math.floor(((W - 2 * margin) / want - 40) / 230));
        if (pl < perLine) { perLine = pl; layout = draw(); }
      }
      const avail = (H - headerH - 2 * margin) / scale;
      let y = 0, cur = [];
      for (const sys of layout.systems) {
        if (cur.length && y + sys.H > avail) { pages.push(cur); cur = []; y = 0; }
        pageOf[sys.idx] = pages.length; sysY[sys.idx] = y;
        cur.push(sys); y += sys.H + 8;
      }
      if (cur.length) pages.push(cur);
      onProgress('Drawing the pages…', 0.01);
      for (let pi = 0; pi < pages.length; pi++) {
        const c = document.createElement('canvas'); c.width = W; c.height = H;
        const x = c.getContext('2d');
        x.fillStyle = '#fff'; x.fillRect(0, 0, W, H);
        for (const sys of pages[pi]) {
          const img = await svgImage(sys.svg, Math.round(sys.W * scale), Math.round(sys.H * scale));
          x.drawImage(img, margin, headerH + margin + sysY[sys.idx] * scale);
        }
        pages[pi] = c;
      }
    } finally { host.remove(); }

    // ---- sound
    const audio = await mixAudio(song, urls, o, sr, onProgress);
    if (isCancelled()) return null;
    // only part of the song: start one beat early so you see where you come in
    const bpb0 = song.beatsPerBar || 4;
    const T0 = o.range ? Math.max(0, Timeline.beatToT(song, o.range.m0 * bpb0 - 1)) : 0;
    const T1 = o.range ? Math.min(audio.length / sr, Timeline.beatToT(song, o.range.m1 * bpb0) + 0.6) : audio.length / sr;
    const s0 = Math.floor(T0 * sr), s1 = Math.floor(T1 * sr);

    // the original video, small in the corner
    let vid = null, vidCanvas = null;
    if (o.corner && urls.video) {
      vid = document.createElement('video');
      vid.muted = true; vid.playsInline = true; vid.preload = 'auto'; vid.src = urls.video;
      await new Promise((res, rej) => { vid.onloadeddata = res; vid.onerror = () => rej(new Error('Could not read the original video')); setTimeout(res, 8000); });
      vidCanvas = document.createElement('canvas');
      const cw = Math.round(W * 0.28), ch = Math.round(cw * (vid.videoHeight || 9) / (vid.videoWidth || 16));
      vidCanvas.width = cw; vidCanvas.height = ch;
    }
    const segs = Timeline.segments(song);
    const audioTimeAt = T => {   // where in the original recording we are (held still during added bars)
      for (const g of segs) {
        if (T < g.T0) break;
        if (g.kind === 'audio' && T < g.T0 + (g.a1 - g.a0)) return g.a0 + (T - g.T0);
        if (g.kind === 'gap' && T < g.T0 + g.dur) return segs[segs.indexOf(g) + 1] ? segs[segs.indexOf(g) + 1].a0 : null;
      }
      return null;
    };
    const seek = t => new Promise(res => { if (Math.abs(vid.currentTime - t) < 0.02) return res(); const done = () => res(); vid.addEventListener('seeked', done, { once: true }); vid.currentTime = t; setTimeout(done, 1500); });

    const muxer = new Mp4Muxer.Muxer({ target: new Mp4Muxer.ArrayBufferTarget(),
      video: { codec: vc.mux, width: W, height: H, frameRate: fps },
      audio: { codec: ac.mux, numberOfChannels: 2, sampleRate: sr },
      fastStart: 'in-memory', firstTimestampBehavior: 'offset' });
    let err = null;
    const aenc = new AudioEncoder({ output: (c, m) => muxer.addAudioChunk(c, m), error: e => err = e });
    aenc.configure(ac.cfg);
    const L = audio.getChannelData(0).subarray(s0, s1), R = (audio.numberOfChannels > 1 ? audio.getChannelData(1) : audio.getChannelData(0)).subarray(s0, s1);
    const total = L.length / sr;
    const CH = 9600;
    for (let i = 0; i < L.length; i += CH) {
      const n = Math.min(CH, L.length - i);
      const data = new Float32Array(n * 2);
      data.set(L.subarray(i, i + n), 0); data.set(R.subarray(i, i + n), n);
      if (i < sr * 0.02) for (let j = 0; j < n; j++) { const f = Math.min(1, (i + j) / (sr * 0.02)); data[j] *= f; data[n + j] *= f; }
      const ad = new AudioData({ format: 'f32-planar', sampleRate: sr, numberOfFrames: n, numberOfChannels: 2,
        timestamp: Math.round(i / sr * 1e6), data });
      aenc.encode(ad); ad.close();
      if (aenc.encodeQueueSize > 20) await sleep(2);
    }
    await aenc.flush(); aenc.close();
    if (err) throw err;

    // ---- pictures
    const venc = new VideoEncoder({ output: (c, m) => muxer.addVideoChunk(c, m), error: e => err = e });
    venc.configure(vc.cfg);
    const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
    const x = canvas.getContext('2d', { alpha: false });
    const bpb = song.beatsPerBar || 4;
    const fullR = Score.songRange(song), nBars = fullR.m1 - fullR.m0;
    const chords = [...(song.chords || [])].sort((a, b) => a.beat - b.beat);
    const secs = [...(song.sections || [])].sort((a, b) => a.b - b.b);
    const frames = Math.ceil(total * fps);
    let lastPage = 0;
    const font = (px, w = '') => `${w} ${Math.round(px * k)}px system-ui, "Segoe UI", Roboto, sans-serif`;
    for (let i = 0; i < frames; i++) {
      if (isCancelled()) { try { venc.close(); } catch (e) { } return null; }
      if (err) throw err;
      const Tn = T0 + i / fps;
      const beat = Timeline.TtoBeat(song, Tn);
      const pos = Score.beatToX(layout, Math.max(beat, layout.m0 * bpb));
      if (pos.sys >= 0) lastPage = pageOf[pos.sys];
      x.drawImage(pages[lastPage], 0, 0);
      if (pos.sys >= 0) {
        const sys = layout.systems[pos.sys];
        const top = headerH + margin + sysY[pos.sys] * scale, hgt = sys.H * scale;
        x.fillStyle = 'rgba(255, 205, 60, 0.38)';
        x.fillRect(margin + pos.meas.x0 * scale, top, (pos.meas.x1 - pos.meas.x0) * scale, hgt);
        if (beat >= layout.m0 * bpb) { const cw = Math.max(2, 4 * k); x.fillStyle = '#d93a2b'; x.fillRect(margin + (pos.x + Score.HEAD) * scale - cw / 2, top, cw, hgt); }
      }
      if (vid && (i % 2 === 0 || i === 0)) {
        const at = audioTimeAt(Tn);
        if (at != null) { await seek(Math.min(at, (vid.duration || at) - 0.05)); vidCanvas.getContext('2d').drawImage(vid, 0, 0, vidCanvas.width, vidCanvas.height); }
      }
      if (vid) {
        const vx = W - margin - vidCanvas.width, vy = H - margin - vidCanvas.height;
        x.fillStyle = 'rgba(0,0,0,0.25)'; x.fillRect(vx + 4 * k, vy + 4 * k, vidCanvas.width, vidCanvas.height);
        x.drawImage(vidCanvas, vx, vy);
        x.strokeStyle = '#1f3566'; x.lineWidth = Math.max(2, 3 * k); x.strokeRect(vx, vy, vidCanvas.width, vidCanvas.height);
      }
      // header: section (or title), bar, what's next, chord, tempo
      const si = secs.reduce((acc, sc, j) => sc.b <= beat + 1e-6 ? j : acc, -1);
      const sec = si >= 0 ? secs[si] : null, nextSec = secs[si + 1];
      x.fillStyle = '#1f3566'; x.fillRect(0, 0, W, headerH);
      x.fillStyle = '#fff'; x.textBaseline = 'middle';
      x.font = font(44, '700'); x.textAlign = 'left';
      let title = sec ? sec.name : (song.title || 'Song');
      const full = title;
      while (x.measureText(title).width > W * 0.4 && title.length > 6) title = title.slice(0, -2);
      x.fillText(title === full ? title : title + '…', margin, headerH / 2);
      const bar = Math.min(nBars, Math.max(1, Math.floor(beat / bpb) - fullR.m0 + 1));
      const ci = chords.findIndex(c => c.beat <= beat && beat < c.beat + c.dur);
      const bits = [o.partLabel, `bar ${bar} of ${nBars}`];
      if (nextSec) bits.push('next: ' + nextSec.name);
      if (ci >= 0) bits.push(Theory.chordName(chords[ci], song.key) + (chords[ci + 1] ? ' → ' + Theory.chordName(chords[ci + 1], song.key) : ''));
      bits.push(`${Math.round(song.tempo || 0)} bpm`);
      x.font = font(28); x.textAlign = 'right'; x.fillStyle = '#dbe4f7';
      x.fillText(bits.filter(Boolean).join('   ·   '), W - margin, headerH / 2);

      const frame = new VideoFrame(canvas, { timestamp: Math.round(i * 1e6 / fps), duration: Math.round(1e6 / fps) });
      venc.encode(frame, { keyFrame: i % (fps * 4) === 0 });
      frame.close();
      while (venc.encodeQueueSize > 6) await sleep(3);
      if (i % 8 === 0) { onProgress(`Making the video… ${Math.round(i / frames * 100)}%`, 0.08 + 0.9 * i / frames); await sleep(0); }
    }
    await venc.flush(); venc.close();
    if (err) throw err;
    muxer.finalize();
    onProgress('Done', 1);
    return new Blob([muxer.target.buffer], { type: 'video/mp4' });
  }

  return { supported, make };
})();
