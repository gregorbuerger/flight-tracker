const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};

const json = (body, status = 200, extra = {}) => new Response(JSON.stringify(body), {
  status,
  headers: { ...CORS, "Content-Type": "application/json; charset=utf-8", ...extra }
});

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);

    try {
      const url = new URL(request.url);
      const lat = Number(url.searchParams.get("lat"));
      const lon = Number(url.searchParams.get("lon"));
      const radius = Math.min(Math.max(Number(url.searchParams.get("radius")) || 100, 1), 250);

      if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
        return json({ error: "Bitte lat und lon angeben." }, 400);
      }

      // Nearby map movements share one cache entry. This keeps upstream traffic low.
      const qLat = Math.round(lat * 50) / 50;
      const qLon = Math.round(lon * 50) / 50;
      const qRadius = Math.ceil(radius / 10) * 10;
      const cacheKey = new Request(`${url.origin}/cache/${qLat}/${qLon}/${qRadius}`, { method: "GET" });
      const cache = caches.default;
      const cached = await cache.match(cacheKey);
      if (cached) {
        const h = new Headers(cached.headers);
        Object.entries(CORS).forEach(([k, v]) => h.set(k, v));
        h.set("X-Flight-Tracker-Cache", "HIT");
        return new Response(cached.body, { status: cached.status, headers: h });
      }

      const sources = [
        {
          name: "adsb.fi",
          url: `https://opendata.adsb.fi/api/v3/lat/${qLat}/lon/${qLon}/dist/${qRadius}`
        },
        {
          name: "ADSB One",
          url: `https://api.adsb.one/v2/point/${qLat}/${qLon}/${qRadius}`
        }
      ];

      const failures = [];
      for (const source of sources) {
        try {
          const response = await fetch(source.url, {
            headers: { "Accept": "application/json", "User-Agent": "Flight-Tracker/0.5" }
          });
          if (!response.ok) {
            failures.push({ source: source.name, status: response.status });
            continue;
          }

          const data = await response.json();
          // Both providers are ADSBexchange/readsb compatible; normalize v3 if needed.
          if (!data.ac && Array.isArray(data.aircraft)) data.ac = data.aircraft;
          data.ft_source = source.name;
          data.ft_fetched_at = Date.now();

          const out = json(data, 200, {
            "Cache-Control": "public, max-age=20",
            "X-Flight-Tracker-Source": source.name,
            "X-Flight-Tracker-Cache": "MISS"
          });
          await cache.put(cacheKey, out.clone());
          return out;
        } catch (e) {
          failures.push({ source: source.name, status: "network" });
        }
      }

      return json({ error: "Flugdatenquellen voruebergehend nicht erreichbar", failures }, 502, {
        "Cache-Control": "no-store"
      });
    } catch (e) {
      return json({ error: "Proxy-Fehler" }, 500, { "Cache-Control": "no-store" });
    }
  }
};
