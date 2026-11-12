// Stage mode: the music big and clear for a tablet on a music stand. Shows as many lines
// as fit; when the cursor reaches the last line on screen, that line moves to the top so
// you can always read ahead. Page-turn pedals, arrow keys or tapping the edges turn pages.
const Stage = (() => {
  const G = { on: false, start: 0, last: 0, wake: null };
  const avail = () => window.innerHeight - ($('#stageBar').offsetHeight || 60) - 10;

  G.zoom = () => S.view.stageZoom || (window.innerWidth >= 900 ? 1.35 : 1.15);

  // show the lines from `start` that fit on screen
  G.layout = () => {
    if (!G.on || !S.layout) return;
    const sys = S.layout.systems;
    G.start = Math.max(0, Math.min(G.start, sys.length - 1));
    let used = 0;
    G.last = G.start;
    sys.forEach((sy, i) => {
      const hgt = sy.H * S.layout.zoom + 6;
      const show = i >= G.start && (i === G.start || used + hgt <= avail());
      if (show) { used += hgt; G.last = i; }
      sy.div.style.display = show ? '' : 'none';
    });
    info();
  };
  function info() {
    const beat = S.player.beat, bpb = S.song.beatsPerBar;
    const sec = sectionAt(beat), secs = [...(S.song.sections || [])].sort((a, b) => a.b - b.b);
    const next = secs.find(x => x.b > beat + 1e-6);
    $('#sgSec').textContent = sec ? sec.name : S.song.title;
    $('#sgBar').textContent = ` · bar ${Math.max(1, Math.floor(beat / bpb) - S.layout.m0 + 1)} of ${S.layout.m1 - S.layout.m0}` + (next ? ` · next: ${next.name}` : '');
    $('#sgPlay').textContent = S.player.playing ? '❚❚' : '▶';
  }
  function show(start) {
    if (start === G.start) return;
    G.start = start;
    $('#score').classList.remove('turn'); void $('#score').offsetWidth; $('#score').classList.add('turn');
    G.layout();
    window.scrollTo(0, 0);
  }
  // called on every cursor update
  G.follow = sysIdx => {
    if (!G.on) return;
    info();
    if (sysIdx < 0) return;
    if (sysIdx < G.start || sysIdx > G.last) show(sysIdx);
    else if (S.player.playing && sysIdx === G.last && G.last > G.start) show(sysIdx);   // read ahead: current line to the top
  };
  G.next = () => { if (S.layout && G.last < S.layout.systems.length - 1) show(G.last + 1); };
  G.prev = () => {
    if (!S.layout || G.start === 0) return;
    let used = 0, i = G.start - 1;
    while (i > 0 && used + S.layout.systems[i - 1].H * S.layout.zoom + 6 + S.layout.systems[i].H * S.layout.zoom <= avail()) { used += S.layout.systems[i].H * S.layout.zoom + 6; i--; }
    show(Math.max(0, i));
  };
  // tap the left or right edge to turn back or forward; the middle plays and pauses
  G.tap = e => {
    const x = e.clientX / window.innerWidth;
    if (x < 0.25) return G.prev();
    if (x > 0.75) return G.next();
    S.player.toggle();
  };

  async function wake() {
    try { if ('wakeLock' in navigator && G.on && document.visibilityState === 'visible') G.wake = await navigator.wakeLock.request('screen'); } catch (e) { }
  }
  async function fullscreen(on) {
    try {
      if (on && !document.fullscreenElement) await document.documentElement.requestFullscreen();
      if (!on && document.fullscreenElement) await document.exitFullscreen();
    } catch (e) { if (on) toast('Full screen isn\'t available here', 2500); }
  }
  G.enter = () => {
    if (!S.song || !S.layout) return toast('Open a song with sheet music first');
    if (S.editing) setEditing(false);
    G.on = true;
    document.body.classList.add('stage');
    document.body.classList.toggle('stage-dark', !!S.view.stageDark);
    $('#sgDark').classList.toggle('on', !!S.view.stageDark);
    $('#stageBar').classList.remove('hidden');
    const pos = Score.beatToX(S.layout, S.player.beat);
    G.start = pos.sys > 0 ? pos.sys : 0;
    renderScore();
    fullscreen(true);
    wake();
  };
  G.exit = () => {
    G.on = false;
    document.body.classList.remove('stage', 'stage-dark');
    $('#stageBar').classList.add('hidden');
    try { G.wake && G.wake.release(); } catch (e) { }
    G.wake = null;
    fullscreen(false);
    renderScore();
  };

  function bind() {
    $('#stageBtn').addEventListener('click', () => G.enter());
    $('#sgExit').addEventListener('click', () => G.exit());
    $('#sgPlay').addEventListener('click', () => { S.player.toggle(); info(); });
    $('#sgNext').addEventListener('click', () => G.next());
    $('#sgPrev').addEventListener('click', () => G.prev());
    $('#sgFull').addEventListener('click', () => fullscreen(!document.fullscreenElement));
    const zoomBy = d => { S.view.stageZoom = Math.max(0.8, Math.min(2.4, +(G.zoom() + d).toFixed(2))); saveView(); renderScore(); };
    $('#sgIn').addEventListener('click', () => zoomBy(0.15));
    $('#sgOut').addEventListener('click', () => zoomBy(-0.15));
    $('#sgDark').addEventListener('click', () => {
      S.view.stageDark = !S.view.stageDark; saveView();
      document.body.classList.toggle('stage-dark', S.view.stageDark); $('#sgDark').classList.toggle('on', S.view.stageDark);
    });
    document.addEventListener('keydown', e => {
      if (!G.on || !$('#modal').classList.contains('hidden')) return;
      const k = e.key;
      if (k === ' ') { e.preventDefault(); S.player.toggle(); info(); }
      else if (['ArrowRight', 'PageDown', 'ArrowDown'].includes(k)) { e.preventDefault(); G.next(); }
      else if (['ArrowLeft', 'PageUp', 'ArrowUp'].includes(k)) { e.preventDefault(); G.prev(); }
      else if (k === 'Escape') G.exit();
      else if (k.toLowerCase() === 'd') $('#sgDark').click();
      else if (k.toLowerCase() === 'f') fullscreen(!document.fullscreenElement);
    });
    document.addEventListener('visibilitychange', () => { if (G.on && document.visibilityState === 'visible') wake(); });
    let rt;
    window.addEventListener('resize', () => { if (G.on) { clearTimeout(rt); rt = setTimeout(() => renderScore(), 200); } });
  }
  bind();
  return G;
})();
