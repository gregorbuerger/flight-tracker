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
    const parts = u.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const pathMode = (parts[0] || "").toLowerCase();
    const mode = pathMode === "search" || pathMode === "route" ? pathMode : (u.searchParams.get("mode") || "point").toLowerCase();

    if (mode === "search") {
      const q = ((parts[1] || u.searchParams.get("q") || "")).trim().toUpperCase();
      if (!q || q.length > 24) return out({ error: "Invalid search" }, 400);
      const compact = q.replace(/\s+/g, "");
      const e = encodeURIComponent(compact);
      const attempts: { kind: string; url: string }[] = [];
      if (/^[0-9A-F]{6}$/.test(compact)) attempts.push({ kind: "icao", url: `https://api.adsb.lol/v2/icao/${e}` });
      if (/^[A-Z0-9]{1,3}-[A-Z0-9-]{1,10}$/.test(compact)) attempts.push({ kind: "registration", url: `https://api.adsb.lol/v2/reg/${e}` });
      attempts.push({ kind: "callsign", url: `https://api.adsb.lol/v2/callsign/${e}` });
      if (!attempts.some(x => x.kind === "registration")) attempts.push({ kind: "registration", url: `https://api.adsb.lol/v2/reg/${e}` });
      const diagnostics: any[] = [];
      for (const a of attempts) {
        try {
          const r = await fetch(a.url, { headers: { Accept: "application/json" } });
          let d: any = null;
          try { d = await r.json(); } catch (_) {}
          const ac = d?.ac || d?.aircraft || [];
          diagnostics.push({ kind: a.kind, status: r.status, count: Array.isArray(ac) ? ac.length : 0 });
          if (r.ok && Array.isArray(ac) && ac.length) return out({ ac, ft_relay_version: "2.5", ft_mode: "search", ft_search: q, ft_match: a.kind, ft_diagnostics: diagnostics });
        } catch (err) {
          diagnostics.push({ kind: a.kind, status: 0, count: 0, error: String(err) });
        }
      }
      const upstreamFailed = diagnostics.length > 0 && diagnostics.every(x => x.status === 0 || x.status >= 400);
      return out({ ac: [], ft_relay_version: "2.5", ft_mode: "search", ft_search: q, ft_diagnostics: diagnostics, ft_upstream_failed: upstreamFailed });
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
      return out({ ...d, ft_relay_version: "2.5", ft_mode: "route" });
    }

    const lat = Number(u.searchParams.get("lat")), lon = Number(u.searchParams.get("lon"));
    const radius = Math.min(Math.max(Number(u.searchParams.get("radius")) || 100, 1), 250);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) return out({ error: "Bitte lat und lon angeben." }, 400);
    const d = await fetchJson(`https://api.adsb.lol/v2/point/${lat}/${lon}/${radius}`);
    d.ft_relay_version = "2.5"; d.ft_mode = "point";
    return new Response(JSON.stringify(d), { status: 200, headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "public, max-age=10" } });
  } catch (e) {
    return out({ error: "Flight-Tracker-Relayfehler" }, 502);
  }
}
