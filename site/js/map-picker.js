// Leaflet map for choosing locations A and B. Tap the map (or drag a pin) to
// place whichever location is being set; search and "my location" live in
// app.js and call place() here.
//
// Pins are plain divIcons (a lettered circle) rather than Leaflet's image
// markers, so nothing beyond leaflet.js/.css has to be vendored or cached.

import { roundCoord } from "./state.js";

export const PIN_COLORS = { A: "#2563eb", B: "#ea580c" };

function pinIcon(id) {
  const L = window.L;
  return L.divIcon({
    className: "",
    html: `<div class="wx-pin" style="background:${PIN_COLORS[id]}">${id}</div>`,
    iconSize: [30, 30], iconAnchor: [15, 15],
  });
}

// Best-effort place name for a tapped point. Open-Meteo has no reverse
// geocoder, so this asks OpenStreetMap's Nominatim (light use, which two
// people tapping a map is, is within its usage policy). Falls back to the
// coordinates, and the user can rename a location anyway.
export async function reverseGeocode(lat, lon) {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=10&lat=${lat}&lon=${lon}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    const res = await fetch(url, { signal: controller.signal, headers: { "Accept-Language": "en" } });
    clearTimeout(timer);
    if (!res.ok) throw new Error();
    const body = await res.json();
    const a = body.address || {};
    return a.city || a.town || a.village || a.hamlet || a.municipality || a.county || a.state
      || (body.display_name || "").split(",")[0] || coordName(lat, lon);
  } catch {
    return coordName(lat, lon);
  }
}

export function coordName(lat, lon) {
  return `${Math.abs(lat).toFixed(3)}°${lat < 0 ? "S" : "N"} ${Math.abs(lon).toFixed(3)}°${lon < 0 ? "W" : "E"}`;
}

export class MapPicker {
  // onPlace(id, {lat, lon}) is called when the user taps or drags; the caller
  // looks up a name and stores the location.
  constructor(el, { onPlace }) {
    const L = window.L;
    this.onPlace = onPlace;
    this.active = "A";
    this.markers = {};
    this.map = L.map(el, { worldCopyJump: true, zoomControl: true }).setView([20, 0], 2);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 18,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(this.map);
    this.map.on("click", (e) => this._placed(this.active, e.latlng));
  }

  setActive(id) { this.active = id; }

  _placed(id, latlng) {
    const lat = roundCoord(latlng.lat);
    // Leaflet reports longitudes past +/-180 once the map has been panned
    // round the world; Open-Meteo wants them folded back.
    const lon = roundCoord(((latlng.lng + 540) % 360) - 180);
    this.onPlace(id, { lat, lon });
  }

  // Draws the pins for the current locations. Called after every change.
  sync(locs) {
    const L = window.L;
    for (const id of ["A", "B"]) {
      const loc = locs[id];
      if (!loc) {
        if (this.markers[id]) { this.markers[id].remove(); delete this.markers[id]; }
        continue;
      }
      if (!this.markers[id]) {
        this.markers[id] = L.marker([loc.lat, loc.lon], { icon: pinIcon(id), draggable: true, title: id })
          .addTo(this.map)
          .on("dragend", (e) => this._placed(id, e.target.getLatLng()));
      } else {
        this.markers[id].setLatLng([loc.lat, loc.lon]);
      }
      this.markers[id].bindTooltip(`${id}: ${loc.name || coordName(loc.lat, loc.lon)}`);
    }
  }

  // Zoom to show whichever pins exist.
  fit(locs) {
    const pts = ["A", "B"].map((id) => locs[id]).filter(Boolean).map((l) => [l.lat, l.lon]);
    if (pts.length === 1) this.map.setView(pts[0], Math.max(this.map.getZoom(), 8));
    else if (pts.length === 2) this.map.fitBounds(pts, { padding: [40, 40], maxZoom: 10 });
  }

  // Leaflet measures its container once; a map created or revealed inside a
  // collapsed card needs telling that it now has a size.
  invalidate() { setTimeout(() => this.map.invalidateSize(), 50); }
}
