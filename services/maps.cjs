"use strict";

const crypto = require("node:crypto");

function unavailable(message, statusCode = 503) {
  return Object.assign(new Error(message), {
    statusCode,
    publicMessage: message,
  });
}

function bookingFingerprint(body) {
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify([
        body.pickup_lat,
        body.pickup_lng,
        body.pickup_address,
        body.dropoff_lat,
        body.dropoff_lng,
        body.dropoff_address,
        body.service_type || "taxi",
        body.passengers || 1,
        body.vehicle_type || null,
        body.scheduled_for || null,
      ]),
    )
    .digest("hex");
}

function haversineKm(a, b, c, d) {
  const rad = (n) => (n * Math.PI) / 180;
  const h =
    Math.sin(rad(c - a) / 2) ** 2 +
    Math.cos(rad(a)) * Math.cos(rad(c)) * Math.sin(rad(d - b) / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function createMaps({
  token,
  allowApproximate = false,
  fetch: request = globalThis.fetch,
}) {
  async function get(path, params) {
    if (!token)
      throw unavailable(
        "Address search and road routes are temporarily unavailable. Please try again later.",
      );
    const url = new URL(path, "https://api.mapbox.com");
    url.search = new URLSearchParams({ ...params, access_token: token });
    let response;
    try {
      response = await request(url, { signal: AbortSignal.timeout(8000) });
    } catch {
      throw unavailable("The map service did not respond. Please try again.");
    }
    if (!response.ok)
      throw unavailable(
        "The map service is temporarily unavailable. Please try again later.",
      );
    return response.json();
  }
  function places(data) {
    return (data.features || [])
      .slice(0, 5)
      .filter(
        (f) =>
          Array.isArray(f.geometry?.coordinates) &&
          f.geometry.coordinates.every(Number.isFinite),
      )
      .map((f) => ({
        id: f.id,
        address:
          f.properties.full_address ||
          [f.properties.name, f.properties.place_formatted]
            .filter(Boolean)
            .join(", "),
        lat: f.geometry.coordinates[1],
        lng: f.geometry.coordinates[0],
      }));
  }
  return {
    enabled: !!token,
    async search(q) {
      // Booking addresses are persisted, so request permanent geocodes.
      return places(
        await get("/search/geocode/v6/forward", {
          q,
          limit: "5",
          autocomplete: "false",
          permanent: "true",
        }),
      );
    },
    async reverse(lat, lng) {
      return (
        places(
          await get("/search/geocode/v6/reverse", {
            latitude: String(lat),
            longitude: String(lng),
            permanent: "true",
          }),
        )[0] || null
      );
    },
    async route(body) {
      if (!token && allowApproximate) {
        const distance = Math.max(
          0.5,
          haversineKm(
            body.pickup_lat,
            body.pickup_lng,
            body.dropoff_lat,
            body.dropoff_lng,
          ) * 1.3,
        );
        return {
          distance_km: distance,
          duration_minutes: distance * 2,
          geometry: null,
          source: "approximate",
          traffic: false,
        };
      }
      const coords = `${body.pickup_lng},${body.pickup_lat};${body.dropoff_lng},${body.dropoff_lat}`;
      const data = await get(
        `/directions/v5/mapbox/driving-traffic/${coords}`,
        { geometries: "geojson", overview: "simplified", steps: "false" },
      );
      const route = data.routes?.[0];
      if (
        data.code !== "Ok" ||
        !route ||
        !Number.isFinite(route.distance) ||
        !Number.isFinite(route.duration)
      ) {
        throw unavailable(
          "No drivable route was found between these locations.",
          422,
        );
      }
      return {
        distance_km: route.distance / 1000,
        duration_minutes: route.duration / 60,
        geometry: route.geometry,
        source: "mapbox",
        traffic: true,
      };
    },
  };
}

module.exports = { createMaps, bookingFingerprint, unavailable };
