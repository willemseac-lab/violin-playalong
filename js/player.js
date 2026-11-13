// Timeline (beats <-> seconds, with inserted bars), instrument synth, and the player.
//
// song.beats   = audio time of each ORIGINAL beat of the recording.
// song.inserts = [{at, len, fill}] bars added by the user: `len` beats inserted before
//                original beat `at`. During them the recording is silent, or `fill`
//                {from: original beat, track} repeats music from elsewhere.
// Score positions ("beats" everywhere else) include the inserted beats.
const Timeline = (() => {
  function oTime(song, beat) {
    const b = song.beats;
    if (!b || b.length < 2) return beat * 60 / (song.tempo || 90);
    const n = b.length;
    if (beat <= 0) return b[0] + beat * (b[1] - b[0]);
    if (beat >= n - 1) return b[n - 1] + (beat - n + 1) * (b[n - 1] - b[n - 2]);
    const i = Math.floor(beat);
    return b[i] + (beat - i) * (b[i + 1] - b[i]);
  }
  function oBeat(song, t) {
    const b = song.beats;
    if (!b || b.length < 2) return t * (song.tempo || 90) / 60;
    if (t <= b[0]) return (t - b[0]) / (b[1] - b[0]);
    const n = b.length;
    if (t >= b[n - 1]) return n - 1 + (t - b[n - 1]) / (b[n - 1] - b[n - 2]);
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (b[mid] <= t) lo = mid; else hi = mid; }
    return lo + (t - b[lo]) / (b[hi] - b[lo]);
  }
  // Gaps with their place on the timeline (T = seconds including gaps).
  function gaps(song) {
    const list = (song.inserts || []).slice().sort((x, y) => x.at - y.at);
    let accT = 0, accB = 0;
    return list.map(ins => {
      const a = Math.max(0, oTime(song, ins.at));
      const step = Math.max(0.05, oTime(song, ins.at) - oTime(song, ins.at - 1));
      const g = { ins, a, step, dur: ins.len * step, T0: a + accT, nb0: ins.at + accB, accT, accB };
      accT += g.dur; accB += ins.len;
      return g;
    });
  }
  function beatToT(song, nb) {
    let accT = 0, accB = 0;
    for (const g of gaps(song)) {
      if (nb < g.nb0) break;
      if (nb < g.nb0 + g.ins.len) return g.T0 + (nb - g.nb0) * g.step;
      accT += g.dur; accB += g.ins.len;
    }
    return oTime(song, nb - accB) + accT;
  }
  function TtoBeat(song, T) {
    let accT = 0, accB = 0;
    for (const g of gaps(song)) {
      if (T < g.T0) break;
      if (T < g.T0 + g.dur) return g.nb0 + (T - g.T0) / g.step;
      accT += g.dur; accB += g.ins.len;
    }
    return oBeat(song, T - accT) + accB;
  }
  // score beat -> original beat (or the gap it falls in)
  function locate(song, nb) {
    let accB = 0;
    for (const g of gaps(song)) {
      if (nb < g.nb0) break;
      if (nb < g.nb0 + g.ins.len) return { gap: g, orig: g.ins.at };
      accB += g.ins.len;
    }
    return { gap: null, orig: nb - accB };
  }
  function total(song) { return (song.duration || 0) + gaps(song).reduce((s, g) => s + g.dur, 0); }
  // Pieces of audio to play, in timeline order (used for exporting).
  function segments(song) {
    const out = [];
    let a = 0, T = 0;
    for (const g of gaps(song)) {
      if (g.a > a) { out.push({ kind: 'audio', T0: T, a0: a, a1: g.a }); T += g.a - a; a = g.a; }
      out.push({ kind: 'gap', T0: T, dur: g.dur, fill: g.ins.fill ? { track: g.ins.fill.track, a0: Math.max(0, oTime(song, g.ins.fill.from)) } : null });
      T += g.dur;
    }
    out.push({ kind: 'audio', T0: T, a0: a, a1: song.duration || a });
    return out;
  }
  return { oTime, oBeat, gaps, beatToT, TtoBeat, locate, total, segments };
})();

// ---------------------------------------------------------------- synth
const Synth = (() => {
  const T = {
    strings:  { h: [1, .55, .42, .3, .2, .14, .1, .07, .05], att: .07, rel: .1, vib: .006 },
    low:      { h: [1, .7, .5, .32, .2, .12, .08], att: .09, rel: .12, vib: .004 },
    flute:    { h: [1, .32, .08, .04, .02], att: .05, rel: .08, vib: .004 },
    oboe:     { h: [.45, 1, .85, .7, .5, .32, .2, .14, .1], att: .03, rel: .06, vib: .003 },
    clarinet: { h: [1, .04, .6, .03, .38, .02, .2, .01, .1], att: .04, rel: .07, vib: 0 },
    bassoon:  { h: [.6, 1, .7, .5, .3, .2, .12], att: .04, rel: .08, vib: .002 },
    brass:    { h: [1, .85, .7, .55, .42, .3, .22, .15, .1, .07], att: .05, rel: .08, vib: .002 },
    horn:     { h: [1, .6, .36, .2, .1, .05], att: .07, rel: .1, vib: 0 },
    sax:      { h: [1, .8, .5, .6, .3, .25, .15, .1], att: .04, rel: .08, vib: .004 },
    pluck:    { h: [1, .5, .32, .2, .12, .07, .04], att: .004, rel: .1, vib: 0, decay: 1.1 },
  };
  const waves = new WeakMap();
  function wave(ctx, name) {
    let m = waves.get(ctx);
    if (!m) { m = {}; waves.set(ctx, m); }
    if (!m[name]) {
      const hs = T[name].h;
      const re = new Float32Array(hs.length + 1), im = new Float32Array(hs.length + 1);
      hs.forEach((v, i) => im[i + 1] = v);
      m[name] = ctx.createPeriodicWave(re, im);
    }
    return m[name];
  }
  // Play one note: a recorded sample when the instrument's sounds are loaded, else a
  // synthesised tone. Returns the sources so a live player can stop them.
  function voice(ctx, dest, insKey, midi, when, dur, vol = 0.2, extra) {
    if (insKey === 'drums') return [midi, ...(extra || [])].flatMap(d => drum(ctx, dest, d, when, vol));
    if (Samples.on && Samples.ready(insKey)) return Samples.voice(ctx, dest, insKey, midi, when, dur, vol);
    const tn = (Theory.INSTRUMENTS[insKey] || Theory.INSTRUMENTS.violin).tone || 'strings';
    const t = T[tn];
    const f = 440 * Math.pow(2, (midi - 69) / 12);
    const osc = ctx.createOscillator();
    osc.setPeriodicWave(wave(ctx, tn));
    osc.frequency.value = f;
    const g = ctx.createGain();
    const peak = vol * (f < 130 ? 1.5 : f < 260 ? 1.2 : 1);
    const end = when + dur;
    // start the bow/breath a touch early so the note is heard ON the beat, not after it
    const att = Math.min(t.att, dur * 0.4), start = Math.max(ctx.currentTime || 0, when - att * 0.7);
    g.gain.setValueAtTime(0, start);
    g.gain.linearRampToValueAtTime(peak, start + att);
    if (t.decay) g.gain.setTargetAtTime(peak * 0.08, start + att, t.decay / 3);
    else g.gain.setValueAtTime(peak * 0.92, Math.max(start + att, end - 0.03));
    g.gain.setTargetAtTime(0, end, t.rel / 3);
    osc.connect(g); g.connect(dest);
    const nodes = [osc];
    if (t.vib && dur > 0.35) {
      const lfo = ctx.createOscillator(); lfo.frequency.value = 5.6;
      const lg = ctx.createGain();
      lg.gain.setValueAtTime(0, when); lg.gain.linearRampToValueAtTime(f * t.vib, when + 0.3);
      lfo.connect(lg); lg.connect(osc.frequency);
      nodes.push(lfo);
    }
    const stop = end + t.rel * 2 + 0.05;
    nodes.forEach(o => { o.start(start); o.stop(stop); });
    return nodes;
  }
  // Drum kit, made from noise and tones: kick, snare, toms, hi-hat and cymbals.
  let noiseBuf = null;
  function noise(ctx) {
    if (!noiseBuf || noiseBuf.sampleRate !== ctx.sampleRate) {
      noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const d = noiseBuf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    const s = ctx.createBufferSource(); s.buffer = noiseBuf; return s;
  }
  function drum(ctx, dest, d, when, vol) {
    const nodes = [], g = ctx.createGain(); g.connect(dest);
    const amp = vol * 3;
    if (d === 36 || d === 41 || d === 45) {           // kick and toms: falling sine
      const o = ctx.createOscillator(), f0 = d === 36 ? 55 : d === 41 ? 90 : 130;
      o.frequency.setValueAtTime(f0 * 2.6, when); o.frequency.exponentialRampToValueAtTime(f0, when + 0.08);
      g.gain.setValueAtTime(amp * 1.4, when); g.gain.exponentialRampToValueAtTime(0.001, when + (d === 36 ? 0.35 : 0.3));
      o.connect(g); o.start(when); o.stop(when + 0.4); nodes.push(o);
    } else {
      const n = noise(ctx), f = ctx.createBiquadFilter();
      const hat = d === 42 || d === 46, cym = d === 49 || d === 51;
      f.type = hat || cym ? 'highpass' : 'bandpass'; f.frequency.value = hat ? 7000 : cym ? 5000 : 1800;
      const len = d === 42 ? 0.06 : d === 46 ? 0.3 : cym ? 1.2 : 0.18;
      g.gain.setValueAtTime(amp * (hat ? 0.5 : cym ? 0.45 : 1), when); g.gain.exponentialRampToValueAtTime(0.001, when + len);
      n.connect(f); f.connect(g); n.start(when); n.stop(when + len + 0.05); nodes.push(n);
      if (d === 38) {                                   // snare body
        const o = ctx.createOscillator(), og = ctx.createGain(); o.frequency.value = 190;
        og.gain.setValueAtTime(amp * 0.6, when); og.gain.exponentialRampToValueAtTime(0.001, when + 0.1);
        o.connect(og); og.connect(dest); o.start(when); o.stop(when + 0.12); nodes.push(o);
      }
    }
    return nodes;
  }
  // Metronome click: short woodblock-like tick, accented on the first beat of the bar.
  function click(ctx, dest, when, accent) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'triangle'; o.frequency.value = accent ? 1760 : 1175;
    g.gain.setValueAtTime(0, when); g.gain.linearRampToValueAtTime(accent ? 0.5 : 0.32, when + 0.002);
    g.gain.exponentialRampToValueAtTime(0.001, when + 0.06);
    o.connect(g); g.connect(dest); o.start(when); o.stop(when + 0.08);
    return [o];
  }
  return { voice, click };
})();

// ---------------------------------------------------------------- recorded instrument sounds
// One sound file per instrument family (sounds/<bank>.mp3) holding a note every few
// semitones; notes in between are re-pitched from the nearest recording.
const Samples = (() => {
  const META = window.VPA_SOUNDS || {};
  const BANKS = {
    violin: ['violin'], viola: ['violin', 'cello'], cello: ['cello'], bass: ['contrabass'], harp: ['harp'],
    piccolo: ['flute'], flute: ['flute'], oboe: ['clarinet'], coranglais: ['clarinet'], clarinet: ['clarinet'],
    bassclar: ['clarinet', 'bassoon'], bassoon: ['bassoon'], horn: ['horn'], trumpet: ['trumpet'], trombone: ['trombone'],
    tuba: ['tuba'], altosax: ['sax'], tenorsax: ['sax'], guitar: ['guitar'], piano: ['piano'],
  };
  const bufs = {}, loading = {};
  let decoder = null;
  const S = { on: true };
  const banksFor = k => (BANKS[k] || ['violin']).filter(b => META[b]);
  S.available = () => Object.keys(META).length > 0;
  S.ready = k => { const b = banksFor(k); return b.length > 0 && b.every(x => bufs[x]); };
  function load(bank) {
    if (bufs[bank]) return Promise.resolve(bufs[bank]);
    if (!loading[bank]) loading[bank] = (async () => {
      const r = await fetch('sounds/' + bank + '.mp3');
      if (!r.ok) throw new Error('missing sound ' + bank);
      decoder = decoder || new OfflineAudioContext(1, 1, 44100);
      const buf = await decoder.decodeAudioData(await r.arrayBuffer());
      // find where each recorded note really starts in the decoded file (MP3 adds a small delay)
      const x = buf.getChannelData(0), sr = buf.sampleRate;
      const notes = META[bank].notes.map(([m, off, dur, lead]) => {
        const a = Math.floor(off * sr), b = Math.min(x.length, a + Math.floor(0.2 * sr));
        let pk = 0; for (let i = a; i < Math.min(x.length, a + Math.floor(0.6 * sr)); i++) pk = Math.max(pk, Math.abs(x[i]));
        let on = a; while (on < b && Math.abs(x[on]) < pk * 0.03) on++;
        return { m, off: Math.max(0, on / sr - 0.003), dur: dur - (on / sr - off), lead };
      });
      bufs[bank] = { buf, notes, sustain: META[bank].sustain, rms: META[bank].rms || 0.05 };
      return bufs[bank];
    })();
    return loading[bank];
  }
  S.ensure = async keys => {
    const want = [...new Set([].concat(keys).flatMap(banksFor))];
    await Promise.all(want.map(b => load(b).catch(e => console.warn(e))));
  };
  S.voice = (ctx, dest, insKey, midi, when, dur, vol) => {
    let best = null, bank = null, bd = 1e9;
    for (const b of banksFor(insKey)) for (const n of bufs[b].notes) {
      const d = Math.abs(midi - n.m) + (midi > n.m ? 0.1 : 0);
      if (d < bd) { bd = d; best = n; bank = bufs[b]; }
    }
    const rate = Math.pow(2, (midi - best.m) / 12);
    const lead = best.lead / rate;                     // start early so the note is heard on the beat
    const now = ctx.currentTime || 0;
    let start = when - lead, off = best.off;
    if (start < now) { off += (now - start) * rate; start = now; }
    const src = ctx.createBufferSource();
    src.buffer = bank.buf; src.playbackRate.value = rate;
    const g = ctx.createGain();
    const end = when + dur, level = vol * 0.42 / bank.rms;   // banks evened out to about the synth's loudness
    const need = (end - start) * rate + 0.1;
    if (bank.sustain && need > best.dur - 0.35) {       // long note: loop the steady middle of the recording
      src.loop = true;
      src.loopStart = best.off + Math.min(best.dur * 0.45, Math.max(0.35, best.lead + 0.3));
      src.loopEnd = best.off + best.dur - 0.3;
    }
    g.gain.setValueAtTime(level, start);
    g.gain.setTargetAtTime(0, end, bank.sustain ? 0.05 : 0.12);
    src.connect(g); g.connect(dest);
    src.start(start, off);
    src.stop(end + (bank.sustain ? 0.35 : 0.8));
    return [src];
  };
  return S;
})();

// ---------------------------------------------------------------- player
const Player = (() => {
  class P {
    constructor() {
      this.audio = new Audio(); this.audio.preload = 'auto'; this.audio.preservesPitch = true;
      this.fill = new Audio(); this.fill.preload = 'auto'; this.fill.preservesPitch = true;
      this.song = null; this.urls = {}; this.track = 'audio';
      this.loop = null; this.rate = 1;
      this.synthOn = false; this.synthVol = 0.5; this.synthParts = ['violin'];
      this.ctx = null; this.scheduled = new Set();
      this.onTick = null;
      this._playing = false; this._timer = null;
      this.gap = null;      // {g, off (sec into gap), perf}
      this.gapIdx = 0;      // gaps before index are already behind us
      this.clickOn = false; this.countIn = 0;   // count-in bars before playing
      this.trainer = null;  // {step, to}: speed up a little every time the loop comes round
      this.onRate = null; this.counting = null;
      this.audio.addEventListener('ended', () => { if (this._playing && !this.gap) this.pause(); });
    }
    load(song, urls) {
      this.pause();
      this.song = song; this.urls = urls; this.track = 'audio'; this.loop = null;
      this.gap = null; this.gapIdx = 0;
      this.audio.src = urls.audio || '';
      if (this.gaps().length && this.gaps()[0].a <= 0) this._enterGap(0, 0);
    }
    gaps() { return Timeline.gaps(this.song); }
    get playing() { return this._playing; }
    _gapPos() {
      if (!this.gap) return 0;
      return this.gap.off + (this._playing ? (performance.now() - this.gap.perf) / 1000 * this.rate : 0);
    }
    get T() {
      if (!this.song) return 0;
      if (this.gap) return this.gap.g.T0 + Math.min(this._gapPos(), this.gap.g.dur);
      const gs = this.gaps();
      let acc = 0;
      for (let i = 0; i < this.gapIdx && i < gs.length; i++) acc += gs[i].dur;
      return this.audio.currentTime + acc;
    }
    get beat() { return this.song ? Timeline.TtoBeat(this.song, this.T) : 0; }

    setTrack(name) {
      if (!this.urls[name] || name === this.track) return;
      const T = this.T, playing = this._playing;
      if (playing) this.pause();
      this.track = name;
      this.audio.src = this.urls[name];
      this.audio.addEventListener('loadedmetadata', () => { this.seekT(T); if (playing) this.play(); }, { once: true });
    }
    setRate(r) {
      if (this.gap) { this.gap.off = this._gapPos(); this.gap.perf = performance.now(); }
      this.rate = r;
      this.audio.playbackRate = r; this.fill.playbackRate = r;
      this._stopSynth();
    }
    async play() {
      if (!this.song || this.counting) return;
      if (this.synthOn) {
        const ins = (this.song.parts || []).filter(p => this.synthParts.includes(p.id)).map(p => p.instrument);
        if (Samples.on && !ins.every(k => Samples.ready(k))) await Samples.ensure(ins);
      }
      if (this.countIn > 0) {
        // one or two bars of clicks at the song's speed, then go
        this._ensureCtx();
        const bpb = this.song.beatsPerBar || 4, b = Math.max(0, this.beat);
        const spb = Math.max(0.2, (Timeline.beatToT(this.song, Math.floor(b) + 1) - Timeline.beatToT(this.song, Math.floor(b))) / this.rate);
        const n = this.countIn * bpb, t0 = this.ctx.currentTime + 0.08;
        const nodes = [];
        for (let i = 0; i < n; i++) nodes.push(...Synth.click(this.ctx, this.master, t0 + i * spb, i % bpb === 0));
        const lead = (b % 1) * spb;   // land exactly on the next beat if we're part-way through one
        this.counting = { nodes, timer: setTimeout(() => { this.counting = null; this._go(); }, (0.08 + n * spb - lead) * 1000) };
        this.onTick && this.onTick();
        return;
      }
      return this._go();
    }
    async _go() {
      if (this.loop) { const b = this.beat; if (b < this.loop.from || b >= this.loop.to - 0.01) this.seekBeat(this.loop.from); }
      this._playing = true;
      this.audio.playbackRate = this.rate;
      if (this.synthOn || this.clickOn) this._ensureCtx();
      if (this.gap) { this.gap.perf = performance.now(); this._startFill(); }
      else { try { await this.audio.play(); } catch (e) { console.warn(e); this._playing = false; } }
      clearInterval(this._timer);
      this._timer = setInterval(() => this._tick(), 16);
      this.onTick && this.onTick();
    }
    pause() {
      if (this.counting) { clearTimeout(this.counting.timer); this.counting.nodes.forEach(o => { try { o.stop(); } catch (e) { } }); this.counting = null; }
      if (this.gap && this._playing) this.gap.off = this._gapPos();
      this._playing = false;
      clearInterval(this._timer);
      this.audio.pause(); this.fill.pause();
      this._stopSynth();
      this.onTick && this.onTick();
    }
    toggle() { this._playing || this.counting ? this.pause() : this.play(); }
    seekBeat(b) { this.seekT(Timeline.beatToT(this.song, b)); }
    seekT(T) {
      const gs = this.gaps();
      this._stopSynth(); this.fill.pause();
      this.gap = null; this.gapIdx = 0;
      let acc = 0;
      T = Math.max(0, T);
      for (let i = 0; i < gs.length; i++) {
        const g = gs[i];
        if (T < g.T0) break;
        if (T < g.T0 + g.dur) {
          this.audio.pause();
          this._setTime(g.a);
          this._enterGap(i, T - g.T0);
          this.onTick && this.onTick();
          return;
        }
        acc += g.dur; this.gapIdx = i + 1;
      }
      this._setTime(T - acc);
      if (this._playing && this.audio.paused) this.audio.play().catch(() => { });
      this.onTick && this.onTick();
    }
    _setTime(t) { try { this.audio.currentTime = Math.max(0, t); } catch (e) { } }
    _enterGap(i, off) {
      this.gapIdx = i;
      this.gap = { g: this.gaps()[i], off, perf: performance.now() };
      if (this._playing) this._startFill();
    }
    _startFill() {
      const f = this.gap && this.gap.g.ins.fill;
      if (!f) return;
      const url = this.urls[f.track] || this.urls.audio;
      if (!url) return;
      const t = Math.max(0, Timeline.oTime(this.song, f.from)) + this.gap.off;
      const go = () => { try { this.fill.currentTime = t; } catch (e) { } this.fill.playbackRate = this.rate; if (this._playing && this.gap) this.fill.play().catch(() => { }); };
      if (this.fill.getAttribute('data-u') !== url) {
        this.fill.setAttribute('data-u', url); this.fill.src = url;
        this.fill.addEventListener('loadedmetadata', go, { once: true });
      } else go();
    }
    _tick() {
      if (!this._playing) return;
      const gs = this.gaps();
      if (this.gap) {
        if (this._gapPos() >= this.gap.g.dur) {
          const g = this.gap.g;
          this.fill.pause();
          this.gap = null; this.gapIdx++;
          this._setTime(g.a);
          this.audio.play().catch(() => { });
        }
      } else {
        const g = gs[this.gapIdx];
        if (g && this.audio.currentTime >= g.a - 0.012) { this.audio.pause(); this._enterGap(this.gapIdx, 0); }
        else if (this.audio.paused && !this.audio.ended && this.audio.readyState > 2) this.audio.play().catch(() => { });
      }
      if (this.loop && this.beat >= this.loop.to - 0.01) {
        this.seekBeat(this.loop.from);
        if (this.trainer && this.rate < this.trainer.to - 1e-6) {
          this.setRate(Math.min(this.trainer.to, +(this.rate + this.trainer.step).toFixed(3)));
          this.onRate && this.onRate(this.rate);
        }
      }
      if (this.synthOn || this.clickOn) this._schedule();
      this.onTick && this.onTick();
    }

    // ---- parts played by the synth
    _ensureCtx() {
      if (!this.ctx) {
        this.ctx = new (window.AudioContext || window.webkitAudioContext)();
        this.master = this.ctx.createGain();
        this.master.connect(this.ctx.destination);
      }
      if (this.ctx.state === 'suspended') this.ctx.resume();
      this.master.gain.value = this.synthVol;
    }
    setSynth(on, vol, partIds) {
      this.synthOn = on;
      if (vol != null) this.synthVol = vol;
      if (partIds) this.synthParts = [].concat(partIds);
      if (on) this._ensureCtx();
      if (this.master) this.master.gain.value = this.synthVol;
      this._stopSynth();
    }
    _stopSynth() {
      for (const v of this.scheduled) { try { v.stop(); } catch (e) { } }
      this.scheduled.clear();
      this._done = new Set();
    }
    setClick(on) { this.clickOn = on; if (on) this._ensureCtx(); this._stopSynth(); }
    _schedule() {
      if (!this.ctx) return;
      this._done = this._done || new Set();
      const now = this.T, ahead = 0.25 * this.rate;
      if (this.clickOn) {
        const bpb = this.song.beatsPerBar || 4;
        const b0 = Math.ceil(Timeline.TtoBeat(this.song, now - 0.03)), b1 = Timeline.TtoBeat(this.song, now + ahead);
        for (let b = b0; b <= b1; b++) {
          if (this._done.has('c' + b)) continue;
          this._done.add('c' + b);
          const when = this.ctx.currentTime + Math.max(0, (Timeline.beatToT(this.song, b) - now) / this.rate);
          for (const o of Synth.click(this.ctx, this.master, when, ((b % bpb) + bpb) % bpb === 0)) { this.scheduled.add(o); o.onended = () => this.scheduled.delete(o); }
        }
      }
      if (!this.synthOn) return;
      for (const part of this.song.parts || []) {
        if (!this.synthParts.includes(part.id)) continue;
        for (let i = 0; i < part.notes.length; i++) {
          const n = part.notes[i];
          const t0 = Timeline.beatToT(this.song, n.b);
          if (t0 < now - 0.03 || t0 > now + ahead) continue;
          const key = part.id + ':' + i;
          if (this._done.has(key)) continue;
          if (this.loop && n.b >= this.loop.to) continue;
          this._done.add(key);
          const t1 = Timeline.beatToT(this.song, n.b + n.d);
          const when = this.ctx.currentTime + Math.max(0, (t0 - now) / this.rate);
          const dur = Math.max(0.08, (t1 - t0) / this.rate - 0.02);
          for (const o of Synth.voice(this.ctx, this.master, part.instrument, n.p, when, dur, 0.2, n.extra)) {
            this.scheduled.add(o); o.onended = () => this.scheduled.delete(o);
          }
        }
      }
    }
  }
  return { P };
})();
