const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(body: unknown, status = 200, cache = "no-store") {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json; charset=utf-8", "Cache-Control": cache },
  });
}

async function upstream(url: string, init: RequestInit = {}) {
  const r = await fetch(url, {
    ...init,
    headers: { Accept: "application/json", ...(init.headers || {}) },
  });
  const text = await r.text();
  let data: any = null;
  try { data = JSON.parse(text); } catch (_) {}
  if (!r.ok) {
    return { ok: false, status: r.status, data, text: text.slice(0, 300) };
  }
  return { ok: true, status: r.status, data };
}

function aircraftArray(data: any): any[] {
  if (Array.isArray(data?.ac)) return data.ac;
  if (Array.isArray(data?.aircraft)) return data.aircraft;
  return [];
}

export default async function (req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "GET") return json({ error: "Method not allowed", ft_relay_version: "3.2-relay" }, 405);

  const u = new URL(req.url);

  try {
    // Explicit global searches on the already-working Val root URL.
    const reg = (u.searchParams.get("reg") || "").trim().toUpperCase();
    const callsign = (u.searchParams.get("callsign") || "").trim().toUpperCase();
    const icao = (u.searchParams.get("icao") || "").trim().toLowerCase();

    if (reg || callsign || icao) {
      let kind = "";
      let query = "";
      let url = "";

      if (reg) {
        kind = "registration";
        query = reg;
        url = `https://api.adsb.lol/v2/reg/${encodeURIComponent(reg)}`;
      } else if (icao) {
        kind = "icao";
        query = icao;
        url = `https://api.adsb.lol/v2/icao/${encodeURIComponent(icao)}`;
      } else {
        kind = "callsign";
        query = callsign;
        url = `https://api.adsb.lol/v2/callsign/${encodeURIComponent(callsign)}`;
      }

      const r = await upstream(url);
      if (!r.ok) {
        return json({
          ac: [],
          ft_relay_version: "3.2-relay",
          ft_mode: "search",
          ft_match: kind,
          ft_query: query,
          ft_upstream_status: r.status,
          ft_upstream_error: r.text || r.data || "upstream error",
        }, 502);
      }

      const ac = aircraftArray(r.data);
      return json({
        ac,
        total: ac.length,
        ft_relay_version: "3.2-relay",
        ft_mode: "search",
        ft_match: kind,
        ft_query: query,
        ft_upstream_status: r.status,
      });
    }

    // Positionsbezogene Routensuche: ?route=CALLSIGN&lat=...&lon=...
    // Die Route wird serverseitig per POST bei adsb.lol abgefragt, damit die PWA
    // keinen zweiten direkten Datenpfad benoetigt.
    const route = (u.searchParams.get("route") || "").trim().toUpperCase();
    if (route) {
      const lat = Number(u.searchParams.get("lat"));
      const lon = Number(u.searchParams.get("lon"));
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        return json({ error: "route requires lat and lon", ft_relay_version: "3.2-relay" }, 400);
      }
      const r = await upstream("https://api.adsb.lol/api/0/routeset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planes: [{ callsign: route, lat, lng: lon }] }),
      });
      if (!r.ok) {
        return json({ error: "route upstream failed", ft_relay_version: "3.2-relay", ft_mode: "route", ft_upstream_status: r.status }, 502);
      }
      const rows = Array.isArray(r.data) ? r.data : [];
      const row = rows[0] || null;
      return json({ route: row, routes: rows, ft_relay_version: "3.2-relay", ft_mode: "route", ft_upstream_status: r.status });
    }

    // Existing map query: ?lat=...&lon=...&radius=...
    const lat = Number(u.searchParams.get("lat"));
    const lon = Number(u.searchParams.get("lon"));
    const radius = Math.min(Math.max(Number(u.searchParams.get("radius")) || 100, 1), 250);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      return json({
        error: "Bitte lat und lon angeben oder reg/callsign/icao verwenden.",
        ft_relay_version: "3.2-relay",
      }, 400);
    }

    const r = await upstream(`https://api.adsb.lol/v2/point/${lat}/${lon}/${radius}`);
    if (!r.ok) {
      return json({
        error: "ADS-B upstream failed",
        ft_relay_version: "3.2-relay",
        ft_mode: "point",
        ft_upstream_status: r.status,
      }, 502);
    }

    const data = r.data || {};
    data.ft_relay_version = "3.2-relay";
    data.ft_mode = "point";
    return json(data, 200, "public, max-age=10");
  } catch (err) {
    return json({
      error: "Flight-Tracker-Relayfehler",
      detail: String(err),
      ft_relay_version: "3.2-relay",
    }, 502);
  }
}
