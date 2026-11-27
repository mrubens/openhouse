import { weather, weatherProblem, setLocation } from '/kit/openhouse.js';
import { tab, esc } from '/kit/weather-look.js';

// The forecast on a sky that follows the time and the weather (/kit/weather-look.js), with the lines that tie it to
// the household's plans (GET /weather's sense). A dark home dims the sky; at night it's dark and still.
const app = document.getElementById('app');
const dim = new URLSearchParams(location.search).get('dark') === '1';

async function draw(w) {
  if (!w) {
    app.className = '';
    if (await weatherProblem() === 'no location') return ask();
    app.innerHTML = '<div class="none"><h2>No weather right now</h2><p>It will show here once the forecast can be reached.</p></div>';
    return;
  }
  const narrow = matchMedia('(max-width: 760px)').matches; // (matchMedia: the kit keeps a phone's layout on its side)
  const t = tab(w, { now: new Date(), nh: narrow ? 6 : 12 });
  app.className = t.cls + (narrow ? ' narrow' : '') + (dim ? ' dim' : '') + (document.hidden ? ' paused' : '');
  app.innerHTML = t.html;
}

// Nobody has said where home is yet: ask here, once (a ZIP code or a town).
function ask(note = '') {
  app.className = '';
  app.innerHTML = `<form class="none ask"><h2>Where's home?</h2><p>A ZIP code or town, for the forecast.</p>
    <div class="row"><input name="place" autocomplete="off" placeholder="ZIP code or town"><button>Show the weather</button></div>
    <p class="note">${esc(note)}</p></form>`;
  const f = app.querySelector('form');
  f.onsubmit = async (e) => {
    e.preventDefault();
    const place = f.place.value.trim(); if (!place) return;
    f.querySelector('button').disabled = true;
    try { await setLocation(place); } catch { return ask("That didn't save. Try again."); }
    const w = await weather();
    w ? draw(w) : ask(`Couldn't find ${place}. Try a ZIP code.`);
  };
}

let timer = 0, last = null;
async function refresh() {
  clearTimeout(timer);
  last = await weather();
  draw(last);
  if (!document.hidden) timer = setTimeout(refresh, 10 * 60e3);
}
// Hidden: nothing moves and nothing is fetched; back: fresh at once.
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); else { clearTimeout(timer); app.classList.add('paused'); } });
matchMedia('(max-width: 760px)').addEventListener('change', () => { if (last) draw(last); });
refresh();
