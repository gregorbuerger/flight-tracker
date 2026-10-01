const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function out(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

async function fetchJson(url: string, init: RequestInit = {}) {
  const r = await fetch(url, { ...init, headers: { Accept: "application/json", ...(init.headers || {}) } });
  if (!r.ok) throw new Error(`${r.status}`);
  return await r.json();
}

export default async function (req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "GET") return out({ error: "Method not allowed" }, 405);
  try {
    const u = new URL(req.url);
    const mode = (u.searchParams.get("mode") || "point").toLowerCase();

    if (mode === "search") {
      const q = (u.searchParams.get("q") || "").trim().toUpperCase();
      if (!q || q.length > 24) return out({ error: "Invalid search" }, 400);
      const e = encodeURIComponent(q);
      const urls: string[] = [];
      if (/^[0-9A-F]{6}$/.test(q)) urls.push(`https://api.adsb.lol/v2/icao/${e}`);
      if (/^[A-Z0-9]{1,3}-[A-Z0-9-]{1,10}$/.test(q)) urls.push(`https://api.adsb.lol/v2/reg/${e}`);
      urls.push(`https://api.adsb.lol/v2/callsign/${e}`);
      if (!urls.some(x => x.includes('/reg/'))) urls.push(`https://api.adsb.lol/v2/reg/${e}`);
      if (!urls.some(x => x.includes('/icao/')) && /^[0-9A-F]+$/.test(q)) urls.push(`https://api.adsb.lol/v2/icao/${e}`);
      for (const url of urls) {
        try {
          const d: any = await fetchJson(url);
          const ac = d?.ac || d?.aircraft || [];
          if (Array.isArray(ac) && ac.length) return out({ ...d, ac, ft_search: q });
        } catch (_) {}
      }
      return out({ ac: [], ft_search: q });
    }

    if (mode === "route") {
      const callsign = (u.searchParams.get("callsign") || "").trim().toUpperCase();
      const lat = Number(u.searchParams.get("lat")), lon = Number(u.searchParams.get("lon"));
      if (!callsign || !Number.isFinite(lat) || !Number.isFinite(lon)) return out({ error: "Invalid route query" }, 400);
      const d = await fetchJson("https://adsb.im/api/0/routeset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planes: [{ callsign, lat, lng: lon }] }),
      });
      return out(d);
    }

    const lat = Number(u.searchParams.get("lat")), lon = Number(u.searchParams.get("lon"));
    const radius = Math.min(Math.max(Number(u.searchParams.get("radius")) || 100, 1), 250);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) return out({ error: "Bitte lat und lon angeben." }, 400);
    const d = await fetchJson(`https://api.adsb.lol/v2/point/${lat}/${lon}/${radius}`);
    return new Response(JSON.stringify(d), { status: 200, headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "public, max-age=10" } });
  } catch (e) {
    return out({ error: "Flight-Tracker-Relayfehler" }, 502);
  }
}
