// Street → map pin, for buyers typing where to deliver and sellers placing
// their store. OpenStreetMap's Nominatim, limited to Rwanda. Its usage policy
// allows one request a second with an identifying User-Agent, so requests are
// queued one second apart and answers are cached for a day.
const { inRwanda } = require("../config/delivery");

const URL = process.env.GEOCODER_URL || "https://nominatim.openstreetmap.org/search";
const USER_AGENT = process.env.GEOCODER_USER_AGENT || "Ikiguzi-marketplace/1.0";
const CACHE_MS = 24 * 60 * 60 * 1000;
const GAP_MS = 1100;

const cache = new Map(); // query -> { at, results }
let queue = Promise.resolve();
let lastAt = 0;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** One request at a time, a second apart. */
function throttled(fn) {
  const run = queue.then(async () => {
    const gap = lastAt + GAP_MS - Date.now();
    if (gap > 0) await wait(gap);
    lastAt = Date.now();
    return fn();
  });
  queue = run.catch(() => {});
  return run;
}

/**
 * Places matching `q` (street, sector, district...) in Rwanda:
 * [{ label, lat, lng }], best first. An empty list when nothing matches.
 */
async function search(q) {
  const query = String(q || "").replace(/\s+/g, " ").trim().slice(0, 200);
  if (query.length < 3) return [];
  const key = query.toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.results;

  const params = new URLSearchParams({ q: query, format: "jsonv2", countrycodes: "rw", limit: "5", addressdetails: "0" });
  const rows = await throttled(async () => {
    const res = await fetch(`${URL}?${params}`, { headers: { "User-Agent": USER_AGENT, "Accept-Language": "en" }, signal: AbortSignal.timeout(6000) });
    if (!res.ok) throw Object.assign(new Error("The map search isn't answering right now. Place the pin by hand."), { statusCode: 503 });
    return res.json();
  });
  const results = (Array.isArray(rows) ? rows : [])
    .map((r) => ({ label: String(r.display_name || "").replace(/, Rwanda$/, ""), lat: Number(r.lat), lng: Number(r.lon) }))
    .filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lng) && inRwanda(r.lat, r.lng));
  if (cache.size > 2000) cache.clear();
  cache.set(key, { at: Date.now(), results });
  return results;
}

module.exports = { search, _cache: cache };
