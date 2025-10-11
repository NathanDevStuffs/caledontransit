const WORKER_BASE = "https://caledon.nathanplayzofficial.workers.dev/";

/* TomTom map init (unchanged) */
const map = tt.map({
  key: 'XVUXC7GLhrBCR47wKHSTSabpLRTnEzv2',
  container: 'map',
  center: [-79.72748996039797, 43.872053075176915],
  zoom: 12
});
map.addControl(new tt.NavigationControl());
const popup = new tt.Popup({ closeButton: true, closeOnClick: true });

let userMarker = null;
let watchId = null;
let lastPosition = null;

document.getElementById('locateBtn').addEventListener('click', () => {
  if (!navigator.geolocation) return alert('Geolocation not supported.');

  if (!watchId) {
    watchId = navigator.geolocation.watchPosition(
      (position) => {
        const userLat = position.coords.latitude;
        const userLng = position.coords.longitude;
        lastPosition = [userLng, userLat];

        if (!userMarker) {
          const icon2 = document.createElement("img");
          icon2.src = "/locationpin.png";
          icon2.style.width = "40px";
          icon2.style.height = "40px";

          userMarker = new tt.Marker({ element: icon2 })
            .setLngLat(lastPosition)
            .addTo(map);
        } else {
          userMarker.setLngLat(lastPosition);
        }
      },
      (error) => console.error('Location error:', error.message),
      { enableHighAccuracy: true, maximumAge: 10000, timeout: 5000 }
    );
  } else if (lastPosition) {
    map.flyTo({ center: lastPosition, zoom: 15 });
  }
});

// CSV parser (unchanged)
function parseCSV(csv) {
  const lines = csv.trim().split('\n');
  const headers = lines.shift().split(',');
  return lines.map(line => {
    const parts = line.split(',');
    return headers.reduce((obj, header, i) => {
      obj[header] = parts[i];
      return obj;
    }, {});
  });
}

/* Service calendar (unchanged) */
async function getServiceCalendar() {
  const res = await fetch('/calendar.txt');
  const calendar = parseCSV(await res.text());
  const serviceMap = {};
  calendar.forEach(svc => {
    const start = svc.start_date ? new Date(svc.start_date.slice(0,4), svc.start_date.slice(4,6)-1, svc.start_date.slice(6,8)) : null;
    const end = svc.end_date ? new Date(svc.end_date.slice(0,4), svc.end_date.slice(4,6)-1, svc.end_date.slice(6,8)) : null;

    serviceMap[svc.service_id] = {
      monday: svc.monday === '1',
      tuesday: svc.tuesday === '1',
      wednesday: svc.wednesday === '1',
      thursday: svc.thursday === '1',
      friday: svc.friday === '1',
      saturday: svc.saturday === '1',
      sunday: svc.sunday === '1',
      startDate: start,
      endDate: end
    };
  });
  return serviceMap;
}

let tripDirectionMap = {};
let serviceMap = {};

// Build trip_id → shape_id mapping (now includes route 41 and route 81)
async function buildTripDirectionMap() {
  [serviceMap] = await Promise.all([getServiceCalendar()]);
  const tripsRes = await fetch("/trips.txt");
  const trips = parseCSV(await tripsRes.text());
  trips.forEach(trip => {
    if (trip.route_id === "41" || trip.route_id === "81") {
      tripDirectionMap[trip.trip_id] = trip.shape_id;
    }
  });
}


// Parse HH:MM:SS to Date (unchanged)
function parseTimeToDate(timeStr) {
  const [h, m, s] = timeStr.split(":").map(Number);
  const now = new Date();
  const dep = new Date(now);
  dep.setHours(h, m, s || 0, 0);
  if (h >= 24) dep.setDate(dep.getDate() + 1);
  return dep;
}

// Check if trip is running today (unchanged)
function isTripRunningToday(tripId, tripServiceMap) {
  const now = new Date();
  const day = now.getDay(); // 0=Sun, 1=Mon...
  
  const serviceId = tripServiceMap[tripId];
  if (!serviceId) return false;
  
  const svc = serviceMap[serviceId];
  if (!svc) return false;

  // check date range
  if (svc.startDate && now < svc.startDate) return false;
  if (svc.endDate && now > svc.endDate) return false;

  const dayMap = [svc.sunday, svc.monday, svc.tuesday, svc.wednesday, svc.thursday, svc.friday, svc.saturday];
  return dayMap[day];
}



/* -------------------------
   Transit App integration (via your Worker)
   - findNearestTransitStop
   - fetchTransitDeparturesByGlobalId
   - fetchTransitDeparturesForGtfsStop
   - normalizeTransitDeparture
   -------------------------*/

/* pick nearest Transit stop returned by /nearbystops for a GTFS stop lat/lon */
async function findNearestTransitStop(lat, lon, max_distance = 400) {
  try {
    const url = `${WORKER_BASE}nearbystops?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}&max_distance=${encodeURIComponent(max_distance)}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const json = await res.json();
    const arr = Array.isArray(json) ? json : (json.stops || json.nearby_stops || []);
    if (!arr || !arr.length) return null;

    let best = null;
    const target = [Number(lon), Number(lat)];
    arr.forEach(ns => {
      const nsCoord = ns.lon ? [Number(ns.lon), Number(ns.lat)] :
                      ns.stop_lon ? [Number(ns.stop_lon), Number(ns.stop_lat)] :
                      (ns.coordinates ? [Number(ns.coordinates.lon), Number(ns.coordinates.lat)] : null);
      if (!nsCoord || nsCoord.some(x => !isFinite(x))) return;
      const dx = nsCoord[0] - target[0];
      const dy = nsCoord[1] - target[1];
      const d2 = dx*dx + dy*dy;
      if (best === null || d2 < best.d2) best = { d2, stop: ns };
    });
    
    console.log(best);
    return best ? best.stop : null;
    
  } catch (e) {
    console.warn("findNearestTransitStop error:", e);
    return null;
  }
}

/* convert a Transit departure object into { routeId, time:Date, displayTime } */
function normalizeTransitDeparture(item) {
  try {
    const now = new Date();
    let eta = null;

    // handle many possible fields returned by Transit API variants
    if (item.predicted_arrival_ts) eta = new Date(Number(item.predicted_arrival_ts) * 1000);
    else if (item.predicted_arrival_time) eta = new Date(item.predicted_arrival_time);
    else if (item.estimated_arrival_time) eta = new Date(item.estimated_arrival_time);
    else if (item.arrival_time && typeof item.arrival_time === "string" && item.arrival_time.includes("T")) eta = new Date(item.arrival_time);
    else if (item.arrival_time && item.arrival_time.match(/^\d{1,2}:\d{2}(:\d{2})?$/)) eta = parseTimeToDate(item.arrival_time);
    else if (typeof item.arrival_in_minutes === "number") eta = new Date(Date.now() + item.arrival_in_minutes * 60000);
    else if (typeof item.minutes_to_departure === "number") eta = new Date(Date.now() + item.minutes_to_departure * 60000);
    else if (item.departure_time_realtime) {
      const n = Number(item.departure_time_realtime);
      if (!isNaN(n)) eta = new Date(n * (n < 1e12 ? 1000 : 1));
    } else if (item.scheduled_time) eta = new Date(item.scheduled_time);

    if (!eta || isNaN(eta.getTime())) return null;

    const minutesAway = Math.round((eta - now) / 60000);
    let displayTime;
    if (minutesAway <= 0) displayTime = "Due";
    else if (minutesAway < 60) displayTime = `In ${minutesAway} min`;
    else displayTime = eta.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

    const routeId = item.route_short_name || item.route_id || (item.route && (item.route.short_name || item.route.long_name)) || (item.line && (item.line.short_name || item.line.name)) || "—";

    return { 
  routeId, 
  route_long_name: item.route_long_name || item.route?.long_name || "—",
  time: eta, 
  displayTime 
};
  } catch (e) {
    return null;
  }
}

/* call worker /stop_departures with a Transit global_stop_id and normalize */
async function fetchTransitDeparturesByGlobalId(globalId) {
  try {
    if (!globalId) return [];
    console.log("fetchTransitDeparturesByGlobalId globalId:", globalId);

    const url = `${WORKER_BASE}stop_departures?global_stop_id=${encodeURIComponent(globalId)}&should_update_realtime=true`;
    const res = await fetch(url);
    console.log("worker response status:", res.status);
    
    if (!res.ok) {
      console.warn("worker stop_departures status", res.status);
      return [];
    }

    const data = await res.json();
    console.log("full API response:", data);

    // route_departures is an array of route objects; each route has itineraries,
    // each itinerary has schedule_items (which contain departure_time/scheduled_departure_time)
    const routeDeps = Array.isArray(data.route_departures) ? data.route_departures : [];
    const departures = [];

    for (const route of routeDeps) {
      const routeName =
        route.route_short_name ||
        route.route_long_name ||
        route.real_time_route_id ||
        route.global_route_id ||
        (route.route_display_short_name && route.route_display_short_name.boxed_text) ||
        "Unknown";
        const routeLongName =
  route.route_long_name ||       // top-level long name
  route.route?.long_name ||      // fallback in case nested route object exists
  route.line?.name ||            // sometimes APIs use line.name
  route.route_short_name ||      // fallback to short name
  "—";                           // placeholder if nothing exists


      const itineraries = Array.isArray(route.itineraries) ? route.itineraries : [];
      for (const itin of itineraries) {
        // Only include schedule_items relevant to this global stop id.
        // Some itineraries include a closest_stop or a stops[] array — check both.
        const itinClosest = itin.closest_stop?.global_stop_id;
        const stopsMatch = Array.isArray(itin.stops) && itin.stops.some(s => s.global_stop_id === globalId);
        const closestMatch = itinClosest === globalId;

        // If neither clearly references the stop, still attempt to look at schedule_items
        // (because some responses might omit stop-level linkage); but prefer matching ones.
        const considerItinerary = closestMatch || stopsMatch || true;

        if (!considerItinerary) continue;

        const scheduleItems = Array.isArray(itin.schedule_items) ? itin.schedule_items : [];
        for (const si of scheduleItems) {
          // departure_time / scheduled_departure_time in sample are epoch seconds
          const ts = si.departure_time ?? si.scheduled_departure_time ?? si.arrival_time;
          if (!ts) continue;

          const time = new Date(Number(ts) * 1000);
          if (isNaN(time.getTime())) continue;

          const isCancelled = !!si.is_cancelled;
          const isRealtime = !!si.is_real_time;
          const minutesAway = Math.round((time.getTime() - Date.now()) / 60000);

          let displayTime;
          if (isCancelled) displayTime = "Cancelled";
          else if (minutesAway <= 0) displayTime = "Due";
          else if (minutesAway < 60) displayTime = `In ${minutesAway} min`;
          else displayTime = time.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

          const status = isCancelled ? "Cancelled" : (isRealtime ? "Live" : "Scheduled");

          departures.push({
  routeId: route.route_short_name || "—",
  route_long_name: routeLongName,
  time,
  status,
  displayTime,
  minutesAway,
  raw: si,
  route_raw: route,
  itinerary_raw: itin
});

        }
      }
    }

    // If nothing matched by stop-specific logic, as a last resort try to flatten all itineraries' schedule_items
    if (departures.length === 0 && routeDeps.length) {
      for (const route of routeDeps) {
        const routeName =
          route.route_short_name ||
          route.route_long_name ||
          route.global_route_id ||
          "Unknown";
        const itineraries = Array.isArray(route.itineraries) ? route.itineraries : [];
        for (const itin of itineraries) {
          const scheduleItems = Array.isArray(itin.schedule_items) ? itin.schedule_items : [];
          for (const si of scheduleItems) {
            const ts = si.departure_time ?? si.scheduled_departure_time ?? si.arrival_time;
            if (!ts) continue;
            const time = new Date(Number(ts) * 1000);
            if (isNaN(time.getTime())) continue;
            const isCancelled = !!si.is_cancelled;
            const isRealtime = !!si.is_real_time;
            const minutesAway = Math.round((time.getTime() - Date.now()) / 60000);
            let displayTime;
            if (isCancelled) displayTime = "Cancelled";
            else if (minutesAway <= 0) displayTime = "Due";
            else if (minutesAway < 60) displayTime = `In ${minutesAway} min`;
            else displayTime = time.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
            const status = isCancelled ? "Cancelled" : (isRealtime ? "Live" : "Scheduled");

            departures.push({
              routeId: routeName,
              time,
              status,
              displayTime,
              minutesAway,
              raw: si,
              route_raw: route,
              itinerary_raw: itin
            });
          }
        }
      }
    }

    // Sort and return next 5
    const normalized = departures
      .sort((a, b) => a.time - b.time)
      .slice(0, 5);

    console.log("normalized departures:", normalized);
    return normalized;
  } catch (e) {
    console.warn("fetchTransitDeparturesByGlobalId error:", e);
    return [];
  }
}


/* top-level: given GTFS stop object, find nearest Transit stop and fetch departures */
async function fetchTransitDeparturesForGtfsStop(stop) {
  try {
    if (!stop || !stop.stop_lat || !stop.stop_lon) return [];
    const found = await findNearestTransitStop(stop.stop_lat, stop.stop_lon, 400);
    if (!found) return [];
    const globalId = found.global_stop_id || found.id || found.stop_id || found.gtfs_id || null;
    if (!globalId) return [];
    const deps = await fetchTransitDeparturesByGlobalId(globalId);
    return deps;
  } catch (e) {
    console.warn("fetchTransitDeparturesForGtfsStop error:", e);
    return [];
  }
}

// Fallback: get scheduled departures from GTFS files
// Fallback: get scheduled departures from GTFS files (supports route 41 & 81)
async function getStopDepartures(stopId) {
  try {
    const [stopTimesRes, tripsRes] = await Promise.all([
      fetch("/stop_times.txt"),
      fetch("/trips.txt")
    ]);

    const stopTimes = parseCSV(await stopTimesRes.text());
    const trips = parseCSV(await tripsRes.text());

    // Build trip_id -> route_id AND trip_id -> service_id maps
    const tripRouteMap = {};
    const tripServiceMap = {};
    trips.forEach(t => {
      tripRouteMap[t.trip_id] = t.route_id;
      tripServiceMap[t.trip_id] = t.service_id;
    });

    const now = new Date();
    const allowedRoutes = new Set(['41', '81']); // allow both routes
	console.log(isTripRunningToday(st.trip_id, tripServiceMap));
    const departures = stopTimes
      .filter(st => st.stop_id === stopId && allowedRoutes.has(tripRouteMap[st.trip_id]) && isTripRunningToday(st.trip_id, tripServiceMap))
      .map(st => {
        const depTime = parseTimeToDate(st.departure_time);
        const minutesAway = Math.round((depTime - now) / 60000);
        let displayTime;

        if (minutesAway <= 0) displayTime = "Due • scheduled";
        else if (minutesAway < 60) displayTime = `In ${minutesAway} min • scheduled`;
        else displayTime = depTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + " • Scheduled";

        return {
          tripId: st.trip_id,
          routeId: tripRouteMap[st.trip_id], // will be "41" or "81"
          time: depTime,
          displayTime
        };
      })
      .filter(d => d.time > now)
      .sort((a, b) => a.time - b.time)
      .slice(0, 3);

    console.log("GTFS departures (fallback):", departures);
    return departures;

  } catch (e) {
    console.error("Failed to load stop_times departures (fallback):", e);
    return [];
  }
}




/* -------------------------
   Stop markers, loadRoute41Stops (uses Transit API for departures)
   -------------------------*/

let selectedDirection = "410008"; // default direction: northbound

// ---- Stop marker storage & guard ----
const stopMarkers = { "410008": [], "410007": [], "810002": [], "810005": [] }; // northbound, southbound
let stopsLoaded = false; // prevents double-loading



// ---- loadRoute41Stops: loads stops and creates markers for every direction a stop is used ----
async function loadRoute41Stops() {
  if (stopsLoaded) return;
  stopsLoaded = true;

  const [stopTimesRes, stopsRes] = await Promise.all([
    fetch("/stop_times.txt"),
    fetch("/stops.txt")
  ]);

  const stopTimes = parseCSV(await stopTimesRes.text());
  const stops = parseCSV(await stopsRes.text());

  const routeTrips = new Set(Object.keys(tripDirectionMap)); // now contains trips for route 41 & 81
  const routeStopIds = new Set(
    stopTimes.filter(st => routeTrips.has(st.trip_id)).map(st => st.stop_id)
  );

  // map shape_id to route number + direction label
  const shapeInfo = {
    '410008': { route: '41', dir: 'Northbound' },
    '410007': { route: '41', dir: 'Southbound' },
    '810005': { route: '81', dir: 'Northbound' },
    '810002': { route: '81', dir: 'Southbound' }
  };

  // iterate only stops that belong to these routes
  stops.filter(s => routeStopIds.has(s.stop_id)).forEach(stop => {
    const lat = parseFloat(stop.stop_lat);
    const lon = parseFloat(stop.stop_lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;

    // find all trips for this stop that belong to routeTrips (41 or 81)
    const stopTrips = stopTimes.filter(st => st.stop_id === stop.stop_id && routeTrips.has(st.trip_id));

    stopTrips.forEach(st => {
      const direction = tripDirectionMap[st.trip_id];
      if (!direction) return;

      // Avoid duplicate markers for same stop & direction using stop_id
      if (stopMarkers[direction].some(m => m.stopId === stop.stop_id)) return;

      // create marker element
      const icon = document.createElement("img");
      icon.src = "download (6).png";
      icon.style.width = "12px";
      icon.style.height = "12px";
      icon.style.cursor = "pointer";
		icon.alt = "Bus Stop Marker";

      // add marker to map
      const marker = new tt.Marker({ element: icon }).setLngLat([lon, lat]).addTo(map);

      // attach metadata so toggling is easy
      marker.stopId = stop.stop_id;
      marker.direction = direction; // shape_id like '410008' or '810002'
      marker.coords = { lat, lon };
      marker.stop = stop; // attach GTFS stop object for later use

      // store marker
      stopMarkers[direction].push(marker);

      // set initial visibility based on selectedDirection
      marker.getElement().style.display = (direction === selectedDirection) ? "block" : "none";

      // popup listener (uses Transit App via worker for departures)
      marker.getElement().addEventListener("click", async () => {
        // find a representative trip for this stop to determine shape/route
        const rep = stopTrips.find(x => x.stop_id === stop.stop_id && routeTrips.has(x.trip_id));
        const shape = tripDirectionMap[rep.trip_id];
        const info = shapeInfo[shape] || { route: '', dir: 'Unknown' };
        const directionLabel = `Route ${info.route} — ${info.dir}`;

        let departures = [];

        // Try fetching real-time departures from Transit API
        try {
          departures = await fetchTransitDeparturesForGtfsStop(stop);
        } catch (err) {
          console.error("Transit API error:", err);
          departures = [];
        }

        // If Transit API fails or returns empty, fall back to GTFS schedule
        if (!departures.length) {
          departures = await getStopDepartures(stop.stop_id);
        }


  // Build HTML with your current styling
  const depHtml = departures.length
    ? departures.map(d => `
      <li style="display:flex; align-items:center; justify-content:space-between; padding:4px 0; border-top:1px solid #eee; list-style-type: unset !important;margin-bottom: unset !important;background-color: unset !important;border-radius: unset !important;width: unset !important;text-align: unset !important;font-family: unset !important;height: unset!important;">
        <span style="font-weight:600; padding:2px 6px; border-radius:6px; background:#222; color:#fff;">${d.routeId}</span>
        <span style="flex:1; margin:0 6px;">${d.route_long_name || "Bolton"}</span>
        <span style="font-weight:600; white-space:nowrap;">${d.displayTime || d.time.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}</span>
      </li>`).join("")
    : `<li style="padding:6px 0; margin-bottom: 10px;list-style-type: unset !important;margin-bottom: 10px !important;background-color: unset !important;border-radius: unset !important;width: unset !important;text-align: unset !important;font-family: unset !important;height: unset!important;"><a href="/fare-info" style="color:#333; text-decoration:none;">No upcoming departures</a></li>`;

  const popupHTML = `
    <div style="font-family: system-ui, sans-serif; font-size:14px; min-width:240px;">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
        <b style="font-size:15px;">${stop.stop_name}</b>
      </div>
      <div style="margin-bottom:6px; font-size:13px; color:#444;">
        <span style="padding:2px 6px; border-radius:10px; background:#f1f1f1;">${directionLabel}</span>
      </div>
      <ul style="list-style:none; padding:0; margin:0;">${depHtml}</ul>
	  <div style="
    display: flex;
    justify-content: space-between;
"><div style="margin-top:6px;font-size: 12px;color:#666;">
        Updated ${new Date().toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}
      </div><img src="/transit-api-badge.png" style="
    width: 100px;
" alt="Powered by Transit API"></div>
    </div>`;

  new tt.Popup().setLngLat([lon, lat]).setHTML(popupHTML).addTo(map);
});




    });
  });
}

/* -------------------------
   Load routes (unchanged)
   -------------------------*/
async function loadRoutes() {
  const response = await fetch('/shapes.txt');
  const parsed = parseCSV(await response.text());
  const routes = [
    { id: '410008', color: '#FF3399', label: 'Northbound' },
    { id: '410007', color: '#3399FF', label: 'Southbound' },
	  { id: '810005', color: '#FF3399', label: 'Northbound' },
    { id: '810002', color: '#3399FF', label: 'Southbound' }
  ];

  for (const { id, color, label } of routes) {
    const shapePoints = parsed
      .filter(row => row.shape_id === id)
      .sort((a, b) => Number(a.shape_pt_sequence) - Number(b.shape_pt_sequence))
      .map(pt => [Number(pt.shape_pt_lon), Number(pt.shape_pt_lat)]);
    if (!shapePoints.length) continue;

    map.addSource(`route-${id}`, {
      type: 'geojson',
      data: { type: 'Feature', geometry: { type: 'LineString', coordinates: shapePoints } }
    });

    map.addLayer({
      id: `routeLineLayer-${id}`,
      type: 'line',
      source: `route-${id}`,
      layout: { 'line-join': 'round', 'line-cap': 'round', visibility: 'none' },
      paint: { 'line-color': color, 'line-width': 5 }
    });

    map.on('click', `routeLineLayer-${id}`, e => {
  const routeNumber = id.startsWith('81') ? '81' : (id.startsWith('41') ? '41' : '');
  popup.setLngLat(e.lngLat).setHTML(`<div class="tt-popup"><strong>Route ${routeNumber} - ${label}</strong></div>`).addTo(map);
});

  }
}

/* Show/hide route (unchanged) */
function updateRouteDisplay(selectedId) {
  const routes = ['410008', '410007', '810002', '810005'];

  // toggle route line layers if they exist
  routes.forEach(id => {
    const visibility = id === selectedId ? 'visible' : 'none';
    if (map.getLayer(`routeLineLayer-${id}`)) {
      map.setLayoutProperty(`routeLineLayer-${id}`, 'visibility', visibility);
    }
  });

  // toggle stop markers for all directions (41 & 81)
  routes.forEach(id => {
    if (!stopMarkers[id]) return;
    stopMarkers[id].forEach(marker => {
      const el = marker.getElement();
      el.style.display = (id === selectedId) ? 'block' : 'none';
    });
  });

  selectedDirection = selectedId;
  updateBusPositions(); // keep buses in sync
}


/* Live buses (unchanged) */
const busMarkers = {};
async function updateBusPositions() {
  try {
    const response = await fetch("https://caledon.nathanplayzofficial.workers.dev/");
    const data = await response.json();

    // include both route 41 and 81 vehicles
    data.entity
      .filter(ent => ent.vehicle?.trip?.route_id === "41" || ent.vehicle?.trip?.route_id === "81")
      .forEach(ent => {
        const veh = ent.vehicle;
        const id = veh.vehicle?.id || veh.id;
        const tripId = veh.trip?.trip_id;
        const lat = veh.position?.latitude;
        const lon = veh.position?.longitude;
        if (!lat || !lon) return;

        const direction = tripDirectionMap[tripId];
        if (direction !== selectedDirection) {
          if (busMarkers[id]) busMarkers[id].getElement().style.display = "none";
          return;
        }

        if (!busMarkers[id]) {
          const icon = document.createElement("img");
          icon.src = "/New Project (8).png";
          icon.style.width = "40px";
          icon.style.height = "40px";
          busMarkers[id] = new tt.Marker({ element: icon })
            .setLngLat([lon, lat])
            .setPopup(new tt.Popup().setHTML(`<b>Bus ${veh.vehicle?.label || id}</b>`))
            .addTo(map);
        } else {
          busMarkers[id].setLngLat([lon, lat]);
          busMarkers[id].getElement().style.display = "block";
        }
      });
  } catch (err) {
    console.error("Bus update failed:", err);
  }
}


/* Dropdown listener (unchanged) */
document.getElementById('directionSelect').addEventListener('change', e => {
  updateRouteDisplay(e.target.value);
});

/* Init */
map.on('load', async () => {
  await buildTripDirectionMap();
  await loadRoute41Stops();
  await loadRoutes();
  updateRouteDisplay(selectedDirection);
  updateBusPositions();
  setInterval(updateBusPositions, 15000);
});
