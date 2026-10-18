(() => {
  const t = document.title.match(/(\d+)\s*-\s*(\d+)\s+on\s+(.+)$/);
  const d = document.querySelector('main').innerText.match(/(\d{1,2}:\d{2}\s?[AP]M),\s+([A-Z][a-z]{2})\s+(\d+)\w*,\s+(\d{4})/);
  const tr = [...document.querySelectorAll('main tbody tr')];
  if (!t || !d || tr.length < 2) { console.error('Open a Refrag match page (play.refrag.gg/matches/...) with a scoreboard first.'); return; }
  const players = tr.map(r => {
    const c = [...r.children], lines = c[0].innerText.split('\n').map(s => s.trim()).filter(Boolean);
    const name = lines[0];
    const [k, dd, a] = c[2].innerText.split('/').map(Number);
    return {name, roles: lines.slice(1),
      rating: +c[1].innerText, k, d: dd, a, hs: parseFloat(c[4].innerText), kpr: +c[5].innerText, adr: +c[6].innerText, kast: +c[7].innerText};
  });
  const mon = 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ').indexOf(d[2]) + 1;
  const half = players.length / 2;
  const date = `${d[4]}-${String(mon).padStart(2, '0')}-${String(d[3]).padStart(2, '0')}`;
  const match = {id: location.pathname.split('/').pop(), date, time: d[1], map: t[3].trim(), score: [+t[1], +t[2]], source: 'refrag',
    win: players.slice(0, half), lose: players.slice(half)};
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(match, null, 1)], {type: 'application/json'}));
  a.download = `${date}-${match.map.toLowerCase()}-${t[1]}-${t[2]}.json`;
  a.click();
  console.log('Downloaded', a.download, match);
})();
