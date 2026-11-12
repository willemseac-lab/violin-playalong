// Phone tools: convert a video to MP3 in the browser (no upload needed).
const Tools = (() => {
  function f2i(f) {
    const out = new Int16Array(f.length);
    for (let i = 0; i < f.length; i++) {
      const s = Math.max(-1, Math.min(1, f[i]));
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return out;
  }

  async function toMp3(file, onProgress) {
    const buf = await file.arrayBuffer();
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = new AC();
    let audio;
    try { audio = await ctx.decodeAudioData(buf); }
    catch (e) { throw new Error("This phone can't read the sound in that file."); }
    finally { try { ctx.close(); } catch (e) { } }
    const ch = Math.min(2, audio.numberOfChannels);
    const enc = new lamejs.Mp3Encoder(ch, audio.sampleRate, 160);
    const L = audio.getChannelData(0), R = ch > 1 ? audio.getChannelData(1) : null;
    const block = 1152 * 16, out = [];
    for (let i = 0, k = 0; i < L.length; i += block, k++) {
      const l = f2i(L.subarray(i, i + block));
      const mp3 = R ? enc.encodeBuffer(l, f2i(R.subarray(i, i + block))) : enc.encodeBuffer(l);
      if (mp3.length) out.push(new Uint8Array(mp3));
      if (k % 12 === 0) { onProgress && onProgress(i / L.length); await new Promise(r => setTimeout(r, 0)); }
    }
    const end = enc.flush();
    if (end.length) out.push(new Uint8Array(end));
    onProgress && onProgress(1);
    return new Blob(out, { type: 'audio/mpeg' });
  }

  function baseName(name) { return (name || 'recording').replace(/\.[^.]+$/, ''); }

  return { toMp3, baseName };
})();
