export default {
  async fetch(request) {
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors });
    }

    if (request.method !== "GET") {
      return Response.json({ error: "Method not allowed" }, {
        status: 405,
        headers: cors
      });
    }

    try {
      const url = new URL(request.url);
      const lat = Number(url.searchParams.get("lat"));
      const lon = Number(url.searchParams.get("lon"));
      const radius = Math.min(
        Math.max(Number(url.searchParams.get("radius")) || 100, 1),
        250
      );

      if (
        !Number.isFinite(lat) || !Number.isFinite(lon) ||
        lat < -90 || lat > 90 || lon < -180 || lon > 180
      ) {
        return Response.json(
          { error: "Bitte lat und lon angeben." },
          { status: 400, headers: cors }
        );
      }

      const upstream =
        `https://api.airplanes.live/v2/point/${lat}/${lon}/${radius}`;

      const response = await fetch(upstream, {
        headers: {
          "Accept": "application/json",
          "User-Agent": "Flight-Tracker/0.3"
        }
      });

      if (!response.ok) {
        return Response.json(
          { error: "Flugdatenquelle nicht erreichbar", status: response.status },
          { status: 502, headers: cors }
        );
      }

      const data = await response.json();

      return new Response(JSON.stringify(data), {
        status: 200,
        headers: {
          ...cors,
          "Content-Type": "application/json",
          "Cache-Control": "public, max-age=5"
        }
      });
    } catch {
      return Response.json(
        { error: "Proxy-Fehler" },
        { status: 500, headers: cors }
      );
    }
  }
};
