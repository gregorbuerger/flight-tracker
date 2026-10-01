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

    // Val Town's public web URL reliably forwards requests on the root URL.
    // Therefore all Flight Tracker actions use distinct ROOT query parameters;
    // no sub-path routing and no generic mode/q parameters are required.
    const reg = (u.searchParams.get("reg") || "").trim().toUpperCase();
    const callsign = (u.searchParams.get("callsign") || "").trim().toUpperCase();
    const icao = (u.searchParams.get("icao") || "").trim().toUpperCase();
    const searchValue = reg || callsign || icao;

    if (searchValue) {
      if (searchValue.length > 24) return out({ error: "Invalid search" }, 400);
      let kind = "registration";
      let endpoint = "reg";
      if (icao) { kind = "icao"; endpoint = "icao"; }
      else if (callsign) { kind = "callsign"; endpoint = "callsign"; }
      const upstream = `https://api.adsb.lol/v2/${endpoint}/${encodeURIComponent(searchValue)}`;
      try {
        const r = await fetch(upstream, { headers: { Accept: "application/json" } });
        let d: any = null;
        try { d = await r.json(); } catch (_) {}
        const ac = d?.ac || d?.aircraft || [];
        return out({
          ac: Array.isArray(ac) ? ac : [],
          ft_relay_version: "2.6",
          ft_mode: "search",
          ft_search: searchValue,
          ft_match: kind,
          ft_upstream_status: r.status,
          ft_upstream_count: Array.isArray(ac) ? ac.length : 0,
          ft_upstream_failed: !r.ok,
        }, r.ok ? 200 : 502);
      } catch (err) {
        return out({
          ac: [], ft_relay_version: "2.6", ft_mode: "search",
          ft_search: searchValue, ft_match: kind,
          ft_upstream_status: 0, ft_upstream_count: 0,
          ft_upstream_failed: true, error: String(err),
        }, 502);
      }
    }

    const routeCallsign = (u.searchParams.get("route_callsign") || "").trim().toUpperCase();
    if (routeCallsign) {
      const lat = Number(u.searchParams.get("lat")), lon = Number(u.searchParams.get("lon"));
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return out({ error: "Invalid route query" }, 400);
      const d = await fetchJson("https://adsb.im/api/0/routeset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planes: [{ callsign: routeCallsign, lat, lng: lon }] }),
      });
      return out({ ...d, ft_relay_version: "2.6", ft_mode: "route" });
    }

    const lat = Number(u.searchParams.get("lat")), lon = Number(u.searchParams.get("lon"));
    const radius = Math.min(Math.max(Number(u.searchParams.get("radius")) || 100, 1), 250);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      return out({ error: "Bitte lat und lon angeben.", ft_relay_version: "2.6" }, 400);
    }
    const d = await fetchJson(`https://api.adsb.lol/v2/point/${lat}/${lon}/${radius}`);
    d.ft_relay_version = "2.6"; d.ft_mode = "point";
    return new Response(JSON.stringify(d), { status: 200, headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "public, max-age=10" } });
  } catch (e) {
    return out({ error: "Flight-Tracker-Relayfehler", ft_relay_version: "2.6" }, 502);
  }
}
