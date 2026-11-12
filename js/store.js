// Where songs live: on the PC (server) or on this device (IndexedDB).
const TRACK_KEYS = ['audio', 'band', 'vocals', 'bass', 'drums', 'other'];
const TRACK_NAMES = { audio: 'Full song', band: 'No vocals', vocals: 'Vocals only', bass: 'Bass only', drums: 'Drums only', other: 'Other instruments' };
const Store = (() => {
  // ---------------- PC server
  const server = {
    available: false,
    info: null,
    async ping() {
      try {
        const r = await fetch('/api/ping', { cache: 'no-store' });
        if (!r.ok) throw 0;
        const j = await r.json();
        this.available = j.app === 'violin-playalong';
        this.info = j;
      } catch (e) { this.available = false; }
      return this.available;
    },
    async list() { return (await fetch('/api/songs', { cache: 'no-store' })).json(); },
    async load(id) {
      const song = await (await fetch(`/api/songs/${id}/files/song.json`, { cache: 'no-store' })).json();
      const f = song.files || {};
      const u = n => `/api/songs/${id}/files/${n}`;
      const urls = {};
      for (const k of TRACK_KEYS.concat('video')) if (f[k]) urls[k] = u(f[k]);
      return { song, urls };
    },
    async save(song) {
      const r = await fetch(`/api/songs/${song.id}/song.json`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(song) });
      if (!r.ok) throw new Error('Save failed');
      return r.json();
    },
    async status(id) { return (await fetch(`/api/songs/${id}/status`, { cache: 'no-store' })).json(); },
    upload(file, fields, onProgress) {
      return new Promise((resolve, reject) => {
        const fd = new FormData();
        fd.append('file', file, file.name || 'recording');
        for (const k in fields) fd.append(k, fields[k]);
        const xhr = new XMLHttpRequest();
        xhr.open('POST', '/api/upload');
        xhr.upload.onprogress = e => e.lengthComputable && onProgress && onProgress(e.loaded / e.total);
        xhr.onload = () => xhr.status < 300 ? resolve(JSON.parse(xhr.responseText)) : reject(new Error(xhr.responseText));
        xhr.onerror = () => reject(new Error('Upload failed'));
        xhr.send(fd);
      });
    },
    async reprocess(id, fields) {
      const fd = new FormData();
      for (const k in fields) fd.append(k, fields[k]);
      const r = await fetch(`/api/songs/${id}/process`, { method: 'POST', body: fd });
      if (!r.ok) throw new Error(await r.text());
    },
    async remove(id) { const r = await fetch(`/api/songs/${id}`, { method: 'DELETE' }); if (!r.ok) throw new Error(await r.text()); },
    exportUrl(id, video) { return `/api/songs/${id}/export?video=${video ? 1 : 0}`; },
    async exportBlob(id) { return (await fetch(this.exportUrl(id, false))).blob(); },
    async importFile(blob, mode) {
      const fd = new FormData();
      fd.append('file', blob, 'song.vsong');
      if (mode) fd.append('mode', mode);
      const r = await fetch('/api/import', { method: 'POST', body: fd });
      if (r.status === 409) return { conflict: true, ...(await r.json()) };
      if (!r.ok) throw new Error((await r.json()).detail || 'Import failed');
      return r.json();
    },
  };

  // ---------------- this device (IndexedDB)
  let dbp = null;
  function db() {
    if (!dbp) dbp = new Promise((res, rej) => {
      const rq = indexedDB.open('violin-playalong', 1);
      rq.onupgradeneeded = () => {
        rq.result.createObjectStore('songs', { keyPath: 'id' });
        rq.result.createObjectStore('files');
      };
      rq.onsuccess = () => res(rq.result);
      rq.onerror = () => rej(rq.error);
    });
    return dbp;
  }
  async function tx(store, mode, fn) {
    const d = await db();
    return new Promise((res, rej) => {
      const t = d.transaction(store, mode);
      const out = fn(t.objectStore(store));
      t.oncomplete = () => res(out instanceof IDBRequest ? out.result : out);
      t.onerror = () => rej(t.error);
    });
  }
  const objectUrls = [];

  const local = {
    async list() {
      const all = await tx('songs', 'readonly', s => s.getAll());
      return all.map(r => ({ id: r.id, title: r.song.title, modified: r.song.modified, analysed: r.song.analysed,
        files: r.song.files || {}, state: 'done' })).sort((a, b) => (b.modified || '').localeCompare(a.modified || ''));
    },
    async has(id) { return !!(await tx('songs', 'readonly', s => s.get(id))); },
    async load(id) {
      const rec = await tx('songs', 'readonly', s => s.get(id));
      if (!rec) throw new Error('Song not found');
      objectUrls.splice(0).forEach(u => URL.revokeObjectURL(u));
      const urls = {};
      for (const name of TRACK_KEYS.concat('video')) {
        const fn = (rec.song.files || {})[name];
        if (!fn) continue;
        const blob = await tx('files', 'readonly', s => s.get(id + '/' + fn));
        if (blob) { urls[name] = URL.createObjectURL(blob); objectUrls.push(urls[name]); }
      }
      return { song: rec.song, urls };
    },
    async save(song) {
      const d = new Date(), p = n => String(n).padStart(2, '0');
      song.modified = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
      await tx('songs', 'readwrite', s => s.put({ id: song.id, song }));
      return { modified: song.modified };
    },
    async remove(id) {
      const rec = await tx('songs', 'readonly', s => s.get(id));
      await tx('songs', 'readwrite', s => s.delete(id));
      if (rec) for (const fn of Object.values(rec.song.files || {})) await tx('files', 'readwrite', s => s.delete(id + '/' + fn));
    },
    async importFile(blob, mode) {
      const zip = await JSZip.loadAsync(blob);
      const sj = zip.file('song.json');
      if (!sj) throw new Error("That isn't a song file (.vsong)");
      const song = JSON.parse(await sj.async('string'));
      if (!song.id) song.id = 'song-' + Math.random().toString(36).slice(2, 8);
      if (await this.has(song.id)) {
        if (!mode) {
          const cur = (await tx('songs', 'readonly', s => s.get(song.id))).song;
          return { conflict: true, title: cur.title, deviceModified: cur.modified, fileModified: song.modified };
        }
        if (mode === 'copy') { song.id = song.id + '-' + Math.random().toString(36).slice(2, 5); song.title += ' (copy)'; }
      }
      const files = {};
      for (const [name, fn] of TRACK_KEYS.map(k => [k, k + '.mp3']).concat([['video', 'video.mp4']])) {
        const f = zip.file(fn);
        if (!f) continue;
        const b = new Blob([await f.async('arraybuffer')], { type: fn.endsWith('mp4') ? 'video/mp4' : 'audio/mpeg' });
        await tx('files', 'readwrite', s => s.put(b, song.id + '/' + fn));
        files[name] = fn;
      }
      song.files = files;
      await tx('songs', 'readwrite', s => s.put({ id: song.id, song }));
      return { id: song.id };
    },
    async exportBlob(id) {
      const rec = await tx('songs', 'readonly', s => s.get(id));
      const zip = new JSZip();
      zip.file('song.json', JSON.stringify(rec.song));
      for (const fn of Object.values(rec.song.files || {})) {
        if (fn === 'video.mp4') continue;
        const b = await tx('files', 'readonly', s => s.get(id + '/' + fn));
        if (b) zip.file(fn, b);
      }
      return zip.generateAsync({ type: 'blob', compression: 'STORE' });
    },
  };

  return { server, local };
})();

// Share a file (Android share sheet → WhatsApp/email) or fall back to saving it.
async function shareOrDownload(blob, filename, text) {
  const file = new File([blob], filename, { type: blob.type || 'application/octet-stream' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: filename, text: text || '' }); return 'shared'; }
    catch (e) { if (e.name === 'AbortError') return 'cancelled'; }
  }
  // Inside a Claude artifact: use the platform's download prompt (zip is allowed, .vsong/.mp3 are not).
  if (window.claude && window.claude.use) {
    let dl = null;
    try { dl = await window.claude.use('downloads'); } catch (e) { }
    if (dl) {
      let name = filename, data = blob;
      if (/\.vsong$/i.test(name)) name = name + '.zip';
      else if (!/\.(zip|mp4|webm|json|txt|pdf)$/i.test(name)) {
        const z = new JSZip(); z.file(name, blob);
        data = await z.generateAsync({ type: 'blob', compression: 'STORE' });
        name = name + '.zip';
      }
      try { await dl.save({ filename: name, data }); return 'saved'; }
      catch (e) { return e && e.code === 'declined' ? 'cancelled' : 'failed'; }
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
  return 'downloaded';
}
