const STYLE =
  process.env.MAP_STYLE_URL ??
  'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';
const SEAMARK = 'https://tiles.openseamap.org/seamark/8/140/80.png';

async function check(url) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);
    return { ok: res.ok, status: res.status };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

const style = await check(STYLE);
const seamark = await check(SEAMARK);
console.log(JSON.stringify({ style: { url: STYLE, ...style }, seamark: { url: SEAMARK, ...seamark } }, null, 2));
if (!style.ok) {
  console.log('Recommendation: use offline GeoJSON fallback (automatic in UI).');
  process.exitCode = 1;
} else {
  console.log('Online dark tiles reachable.');
}
