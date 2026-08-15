# Route Management with OpenStreetMap — Frontend Spec

For School Admin Console (and reusable in Super Admin). Uses free **OSM tiles**
+ **OSRM public routing** for the map & path. Backend stores what OSRM returns.

---

## The UX flow

```
Admin clicks "Add Route"
  ▸ Types a route name
  ▸ Map opens (Leaflet + OSM tiles)
  ▸ Clicks/searches to add stops in order
  ▸ Drag markers to reorder
  ▸ Client calls OSRM → gets polyline + distance + duration
  ▸ Clicks Save
  ▸ ONE POST /routes call → route + all stops committed atomically
```

---

## 1. Recommended libraries (all free, MIT/BSD)

```bash
npm install leaflet react-leaflet   # map + tiles
npm install @mapbox/polyline        # encode/decode OSRM polylines
```

No API key needed — OSM tiles + OSRM are open & free (rate-limited to ~1 req/sec
on the public demo server; enough for a pilot).

---

## 2. Map + tiles (Leaflet)

```tsx
"use client";
import { MapContainer, TileLayer, Marker, Polyline, useMapEvents } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';

<MapContainer center={[28.7041, 77.1025]} zoom={12} style={{ height: 500 }}>
  <TileLayer
    attribution='&copy; <a href="https://osm.org/copyright">OpenStreetMap</a>'
    url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
  />
  {stops.map((s, i) => <Marker key={i} position={[s.lat, s.lng]} draggable />)}
  {polylineLatLngs.length > 0 && <Polyline positions={polylineLatLngs} />}
</MapContainer>
```

## 3. Adding stops (click-to-add)

```tsx
function ClickToAddStop({ onAdd }) {
  useMapEvents({
    click(e) {
      onAdd({ lat: e.latlng.lat, lng: e.latlng.lng, orderIdx: stops.length });
    },
  });
  return null;
}
```

## 4. Reverse-geocoding a click → address (Nominatim, free)

```ts
async function reverseGeocode(lat: number, lng: number) {
  const res = await fetch(
    `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}`,
    { headers: { 'User-Agent': 'Voltava-Fleet/1.0 (ops@voltava.in)' } }
  );
  const data = await res.json();
  return data.display_name as string;
}
```
⚠️ Nominatim asks for max **1 req/sec** and a real User-Agent. Debounce clicks.

## 5. Compute path + distance + duration (OSRM)

```ts
// Given ordered stops, ask OSRM for the driving path.
async function fetchOsrmRoute(stops: {lat:number,lng:number}[]) {
  const coords = stops.map(s => `${s.lng},${s.lat}`).join(';');
  const url = `https://router.project-osrm.org/route/v1/driving/${coords}?overview=full&geometries=polyline`;
  const res = await fetch(url);
  const data = await res.json();
  const route = data.routes?.[0];
  if (!route) return null;
  return {
    geometry: route.geometry as string,          // encoded polyline (send to backend)
    distanceKm: route.distance / 1000,
    durationMin: Math.round(route.duration / 60),
    // Per-stop arrival offsets (in minutes from origin)
    legs: route.legs.reduce<number[]>((acc, leg, i) => {
      const prev = acc[i] ?? 0;
      acc.push(prev + Math.round(leg.duration / 60));
      return acc;
    }, [0]),
  };
}
```

For rendering the polyline on the map:
```ts
import polyline from '@mapbox/polyline';
const latLngs = polyline.decode(route.geometry); // → [[lat,lng], ...]
```

## 6. Save the route — atomic POST

```ts
async function saveRoute(schoolId: string, name: string, stops: Stop[]) {
  const osrm = await fetchOsrmRoute(stops);
  const payload = {
    name,
    estimatedDuration: osrm?.durationMin ?? null,
    distanceKm: osrm?.distanceKm ?? null,
    geometry: osrm?.geometry ?? null,
    stops: stops.map((s, i) => ({
      name: s.name,
      address: s.address ?? null,
      lat: s.lat,
      lng: s.lng,
      orderIdx: i,
      expectedArrivalMinutes: osrm?.legs[i] ?? null,
    })),
  };

  // ONE call — route + all stops in a DB transaction.
  return request(`/schools/${schoolId}/routes`, { method: 'POST', body: JSON.stringify(payload) });
}
```

Backend enforces:
- min 2 stops
- unique orderIdx
- atomic: if anything fails, nothing is written

---

## 7. Backend endpoints — full reference

| Method | Path | Body / Notes |
|--------|------|--------------|
| `POST` | `/api/schools/:schoolId/routes` | `{ name, estimatedDuration?, distanceKm?, geometry?, stops:[{name,address?,lat,lng,orderIdx,expectedArrivalMinutes?}] }` — atomic, min 2 stops |
| `PUT` | `/api/routes/:id` | `{ name?, estimatedDuration?, distanceKm?, geometry? }` — route metadata only, does not touch stops |
| `DELETE` | `/api/routes/:id` | 400 if the route has any active trip (`PLANNED`/`ON_SCHEDULE`/`DELAYED`) |
| `POST` | `/api/routes/:routeId/stops` | `{ name, address?, lat, lng, orderIdx, expectedArrivalMinutes? }` — single stop |
| `PUT` | `/api/routes/:routeId/stops/:id` | any of the above fields, partial |
| `DELETE` | `/api/routes/:routeId/stops/:id` | Cascade: also removes any StudentRouteMapping on that stop |
| `PUT` | `/api/routes/:routeId/stops/reorder` | `[{ id, orderIdx }, ...]` — bulk reorder, transactional |

Tenant scoping: SCHOOL_ADMIN only operates on their own school's routes.
SUPER_ADMIN bypasses. All others → 403.

---

## 8. UX edge cases to handle

1. **OSRM rate limit hit** (rare with 1/sec): fall back to straight-line polyline
   built from stop coords and estimate distance as sum of Haversine legs.
2. **User reorders stops after saving** → call `PUT /reorder`, then re-fetch OSRM
   for updated `estimatedDuration`/`geometry`, then `PUT /routes/:id` with new
   fields. Show a "recalculating…" spinner during this ~1s round-trip.
3. **Editing an existing route** → load `GET /schools/:id/routes` (includes
   `stops` + `geometry`), decode the polyline, seed the map state.
4. **Delete disabled state**: before allowing delete, show "N active trips —
   complete them first" if `route.trips.some(t => t.status !== 'COMPLETED')`.

---

## 9. Testing checklist

- [ ] Add route with 2 stops → saved with geometry + distance + duration
- [ ] Add route with 1 stop → backend returns 400 ("A route needs at least 2 stops")
- [ ] Add route with duplicate `orderIdx` in the array → backend returns 400
- [ ] Reorder stops → order persists on refresh
- [ ] Delete stop mid-route → other stops stay, mappings on that stop are gone
- [ ] Delete route with active trip → 400 with clear message
- [ ] Delete route without trips → cascades to stops + mappings, no orphans
- [ ] Cross-tenant (SCHOOL_ADMIN B tries to touch School A's route) → 403
- [ ] OSRM downtime → app degrades gracefully, still saves stops (no geometry)
