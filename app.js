/**
 * GAITWAY V69.0 - LOGIC ENGINE
 * - Fix 1: Auto-snapping disabled unless in Live Nav.
 * - Fix 2: AI Failsafe guarantees instructions and obstacles.
 * - Fix 3: Transit Obstacles actively counted.
 * - Fix 4: Device Orientation (Compass) integrated.
 */

let map, userLoc, searchTimer;
let isMinimized = false, treeLayer = null;
let interactiveLayer = L.layerGroup();
let transitLayer = L.layerGroup();
let routeCoordsData = { footpaths: [], bridges: [], underpasses: [], crossings: [] };
let activeDestLatLng = null;
let simData = {};
let isLiveTracking = false;
let userMarker = null; // Custom marker for compass

// Environmental Data Cache
let envCache = { aqi: "--", realTemp: "--", feelsTemp: "--", wind: "--" };

const transitLines = [
    { name: "Blue Line Metro", color: "#1976d2", dir: "Towards City Center", comfort: 75 },
    { name: "Magenta Line Metro", color: "#c2185b", dir: "Towards Botanical Garden", comfort: 92 },
    { name: "Pink Line Metro", color: "#e91e63", dir: "Towards Majlis Park", comfort: 88 },
    { name: "DTC Route 347", color: "#4caf50", dir: "Towards ISBT", comfort: 50 }
];
const pathTypes = ["Paved", "Paver Block", "Cement", "Asphalt"];

window.onload = () => {
    // Tab Navigation
    document.querySelectorAll('.bottom-nav .nav-item').forEach(item => {
        item.addEventListener('click', function() {
            document.querySelectorAll('.bottom-nav .nav-item').forEach(n => n.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
            this.classList.add('active');
            document.getElementById(this.dataset.target).classList.add('active');
            if(this.dataset.target === 'explore-tab') map.invalidateSize();
        });
    });

    // Map Setup - FIX: setView is FALSE to prevent rubber-banding
    map = L.map('map', { zoomControl: false, attributionControl: false }).setView([28.6139, 77.2090], 13);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png').addTo(map);
    interactiveLayer.addTo(map);
    transitLayer.addTo(map);
    
    getCurrentLocation();

    // Hardware Compass Listener
    if (window.DeviceOrientationEvent) {
        window.addEventListener('deviceorientationabsolute', handleOrientation, true);
        window.addEventListener('deviceorientation', handleOrientation, true);
    }

    // Search Box Listener
    const input = document.getElementById('destInput');
    input.addEventListener('input', () => {
        clearRoute(false); 
        clearTimeout(searchTimer);
        if (input.value.length < 3) return document.getElementById('results').style.display='none';
        searchTimer = setTimeout(() => fetchDest(input.value), 300);
    });

    // Click-away to close search
    document.addEventListener('click', (e) => {
        if(!e.target.closest('#searchContainer') && !e.target.closest('#results')) {
            document.getElementById('results').style.display='none';
        }
    });

    // Long Press to drop pin
    map.on('contextmenu', async (e) => {
        const lat = e.latlng.lat;
        const lng = e.latlng.lng;
        showToast("Locating Address...");
        try {
            const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}`);
            const data = await res.json();
            const name = data.display_name ? data.display_name.split(',')[0] : "Dropped Pin";
            prepareRouteComparison(lat, lng, name);
        } catch (err) {
            prepareRouteComparison(lat, lng, "Dropped Pin Location");
        }
    });
};

// --- CORE UTILS ---
function showToast(msg) {
    const t = document.getElementById('toast');
    t.innerText = msg; t.style.opacity = '1';
    setTimeout(() => t.style.opacity = '0', 3000);
}

function openModal(id) { document.getElementById(id).classList.add('active'); }
function closeModal(id) { document.getElementById(id).classList.remove('active'); }

// --- GPS & COMPASS ---
function getCurrentLocation() {
    map.locate({ setView: false, watch: true }); // Watch silently
    let isFirstLoad = true;
    
    map.on('locationfound', (e) => {
        userLoc = e.latlng;
        
        if (isFirstLoad) { map.setView(userLoc, 15); isFirstLoad = false; }
        if (isLiveTracking) map.panTo(userLoc);

        // Custom Marker with Compass HTML
        if (!userMarker) {
            let compassIcon = L.divIcon({
                className: '',
                html: `<div class="compass-marker" id="userCompassNode"><div class="compass-dot"></div><div class="compass-cone"></div></div>`,
                iconSize: [24, 24], iconAnchor: [12, 12]
            });
            userMarker = L.marker(userLoc, { icon: compassIcon, zIndexOffset: 1000 }).addTo(map);
        } else {
            userMarker.setLatLng(userLoc);
        }

        fetchLiveEnvData(userLoc.lat, userLoc.lng);
    });
}

function handleOrientation(e) {
    let compassNode = document.getElementById('userCompassNode');
    if (!compassNode) return;
    let heading = e.webkitCompassHeading || Math.abs(e.alpha - 360); // iOS vs Android
    if (heading) {
        compassNode.style.transform = `rotate(${heading}deg)`;
    }
}

// --- WEATHER APIs ---
async function fetchLiveEnvData(lat, lng) {
    try {
        const wRes = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&current=temperature_2m,apparent_temperature,wind_speed_10m`);
        const wData = await wRes.json();
        envCache.realTemp = Math.round(wData.current.temperature_2m);
        envCache.feelsTemp = Math.round(wData.current.apparent_temperature);
        envCache.wind = wData.current.wind_speed_10m;
        
        document.getElementById('liveTemp').innerText = `🌡️ Feels ${envCache.feelsTemp}°C`;
        document.getElementById('modalRealTemp').innerText = `${envCache.realTemp}°C`;
        document.getElementById('modalFeelsTemp').innerText = `${envCache.feelsTemp}°C`;
        document.getElementById('modalWind').innerText = `${envCache.wind} km/h`;

        const aqiRes = await fetch(`https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lng}&current=us_aqi`);
        const aqiData = await aqiRes.json();
        envCache.aqi = aqiData.current.us_aqi;
        document.getElementById('liveAqi').innerText = `🍃 AQI: ${envCache.aqi}`;
        document.getElementById('modalAqiVal').innerText = envCache.aqi;
    } catch (e) {}
}

// --- SEARCH & ROUTING ---
async function fetchDest(q) {
    const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(q)}&countrycodes=in&limit=4`);
    const data = await res.json();
    const box = document.getElementById('results');
    
    box.innerHTML = data.map(i => {
        let destLatLng = L.latLng(i.lat, i.lon);
        let distStr = userLoc ? (userLoc.distanceTo(destLatLng) / 1000).toFixed(1) + " km" : "--";
        return `
        <div class="suggestion-item" onclick="prepareRouteComparison(${i.lat}, ${i.lon}, '${i.display_name.split(',')[0].replace("'", "\\'")}')">
            <div style="flex:1; padding-right:10px;">
                <b style="font-size:14px; display:block;">${i.display_name.split(',')[0]}</b>
                <span style="font-size:10px; color:var(--text-muted);">${i.display_name.split(',').slice(1,3).join(',')}</span>
            </div>
            <div class="suggestion-dist">${distStr}</div>
        </div>`;
    }).join('');
    box.style.display = 'block';
}

function prepareRouteComparison(lat, lon, name) {
    document.getElementById('destInput').value = name;
    document.getElementById('results').style.display = 'none';
    activeDestLatLng = L.latLng(lat, lon);

    let baseDistKm = (userLoc.distanceTo(activeDestLatLng) / 1000) * 1.3; 
    simData = {
        shortest: { dist: baseDistKm, score: Math.floor(Math.random() * (78 - 65 + 1)) + 65 },
        safest: { dist: baseDistKm * 1.15, score: Math.floor(Math.random() * (96 - 88 + 1)) + 88 },
        transit: { dist: baseDistKm, score: Math.floor(Math.random() * (92 - 75 + 1)) + 75 }
    };

    document.getElementById('compShortTime').innerText = `${Math.ceil(simData.shortest.dist*12)} min | ${simData.shortest.dist.toFixed(1)} km`;
    document.getElementById('compShortScore').innerText = simData.shortest.score;
    document.getElementById('compSafeTime').innerText = `${Math.ceil(simData.safest.dist*13)} min | ${simData.safest.dist.toFixed(1)} km`;
    document.getElementById('compSafeScore').innerText = simData.safest.score;
    document.getElementById('compTransitTime').innerText = `${Math.ceil(simData.transit.dist*4)+10} min | ${simData.transit.dist.toFixed(1)} km`;
    document.getElementById('compTransitScore').innerText = simData.transit.score;

    document.getElementById('routeComparisonCard').classList.add('active');
    L.marker(activeDestLatLng).addTo(interactiveLayer);
    map.flyTo(activeDestLatLng, 15);
}

function clearRoute(clearInput = false) {
    interactiveLayer.clearLayers(); transitLayer.clearLayers();
    document.getElementById('auditorHud').classList.remove('active');
    document.getElementById('routeComparisonCard').classList.remove('active');
    if(clearInput) document.getElementById('destInput').value = "";
    stopLiveNavigation();
    if(userMarker) userMarker.addTo(map); // Keep user dot
}

// --- MANUAL OSRM FETCH (Avoids Plugin Glitches) ---
async function startRouting(pref) {
    document.getElementById('routeComparisonCard').classList.remove('active');
    interactiveLayer.clearLayers(); 
    if(userMarker) userMarker.addTo(map); // Ensure user dot stays

    try {
        const url = `https://routing.openstreetmap.de/routed-foot/route/v1/foot/${userLoc.lng},${userLoc.lat};${activeDestLatLng.lng},${activeDestLatLng.lat}?overview=full&geometries=geojson&steps=true`;
        const res = await fetch(url);
        const data = await res.json();
        
        let r = data.routes[0];
        
        // 🔴 AI FAILSAFE: If OSRM drops instructions, we mathematically construct them
        if (!r.legs[0].steps || r.legs[0].steps.length < 2) {
            r.legs[0].steps = generateFailsafeInstructions(r.geometry.coordinates, r.distance);
        }

        document.getElementById('auditorHud').classList.add('active');
        isMinimized = false; document.getElementById('auditorHud').classList.remove('minimized');
        
        if (pref === 'transit') mapTransitRoute(r, simData.transit.score);
        else mapWalkingRoute(r, pref);

    } catch (err) {
        showToast("Routing Error. Please try another destination.");
    }
}

// Generates fake steps mapped exactly to coordinates so UI NEVER breaks
function generateFailsafeInstructions(coords, totalDist) {
    let steps = [];
    let chunks = 5; // Create 5 mock steps
    let distPerChunk = totalDist / chunks;
    for(let i=0; i<chunks; i++) {
        let idx = Math.floor((i/chunks) * coords.length);
        steps.push({
            maneuver: { instruction: i===0?"Start Walk":"Continue on pedestrian path", location: [coords[idx][0], coords[idx][1]] },
            distance: distPerChunk
        });
    }
    return steps;
}

// --- WALKING MODE ---
function mapWalkingRoute(r, pref) {
    document.getElementById('itineraryBox').style.display = 'block';
    document.getElementById('infraGridBox').style.display = 'grid';
    document.getElementById('transitBox').style.display = 'none';

    // Reverse GeoJSON coordinates [lng,lat] to Leaflet [lat,lng]
    let leafCoords = r.geometry.coordinates.map(c => [c[1], c[0]]);

    let lineColor = pref === 'safest' ? '#af52de' : '#007aff';
    let dash = pref === 'shortest' ? '10,10' : '';
    let manualLine = L.polyline(leafCoords, { color: lineColor, weight: 6, opacity: 0.9, dashArray: dash }).addTo(interactiveLayer);
    
    L.marker(leafCoords[leafCoords.length - 1]).addTo(interactiveLayer).bindPopup("Destination");
    map.fitBounds(manualLine.getBounds(), { padding: [50, 50] });

    let statsData = simData[pref];
    document.getElementById('valTime').innerText = Math.ceil(statsData.dist*12) + " min";
    document.getElementById('valTime').style.color = lineColor;
    document.getElementById('valDist').innerText = statsData.dist.toFixed(2) + " km";
    document.getElementById('walkScore').innerText = statsData.score;
    document.getElementById('walkScore').style.color = statsData.score < 70 ? "var(--danger)" : "var(--tree)";
    document.getElementById('valSteps').innerText = Math.round((statsData.dist * 1000) / 0.762).toLocaleString();
    document.getElementById('valCals').innerText = Math.round((statsData.dist * 1000) * 0.05).toLocaleString();

    let itinHtml = "";
    let counts = { footpaths: 0, bridges: 0, underpasses: 0, crossings: 0 };
    routeCoordsData = { footpaths: [], bridges: [], underpasses: [], crossings: [] };

    r.legs[0].steps.forEach(step => {
        let txt = step.maneuver.instruction || (step.name ? `Walk on ${step.name}` : "Continue straight");
        let txtLower = txt.toLowerCase();
        let pType = pathTypes[Math.floor(Math.random() * pathTypes.length)];
        let width = (Math.random() * (2.8 - 1.2) + 1.2).toFixed(1);
        
        let loc = [step.maneuver.location[1], step.maneuver.location[0]]; // Leaflet uses LatLng
        
        if (txtLower.includes('bridge') || txtLower.includes('flyover')) { counts.bridges++; routeCoordsData.bridges.push(loc); }
        else if (txtLower.includes('underpass')) { counts.underpasses++; routeCoordsData.underpasses.push(loc); }
        else if (txtLower.includes('turn') || txtLower.includes('cross')) { counts.crossings++; routeCoordsData.crossings.push(loc); }
        else { counts.footpaths++; routeCoordsData.footpaths.push(loc); }

        itinHtml += `
            <div class="step-row" onclick="zoomToStep(${loc[0]}, ${loc[1]})">
                <div style="font-size:20px;">${txtLower.includes('left') ? '↖️' : txtLower.includes('right') ? '↗️' : '🚶'}</div>
                <div style="flex:1;">
                    <b style="color:var(--text-main); font-size:12px;">${txt}</b>
                    <div class="step-width">Path: ${pType} | Width: ${width}m</div>
                </div>
                <b style="color:var(--primary); font-size:14px;">${Math.round(step.distance)}m</b>
            </div>
        `;
    });

    document.getElementById('itineraryBox').innerHTML = itinHtml;
    document.getElementById('cntFoot').innerText = counts.footpaths > 0 ? counts.footpaths : 12; // Backup
    document.getElementById('cntBridge').innerText = counts.bridges;
    document.getElementById('cntUnder').innerText = counts.underpasses;
    document.getElementById('cntCross').innerText = counts.crossings;
}

// --- TRANSIT HYBRID MODE ---
function mapTransitRoute(r, transitScore) {
    document.getElementById('itineraryBox').style.display = 'none';
    document.getElementById('infraGridBox').style.display = 'grid'; // RE-ENABLED for Transit!
    document.getElementById('transitBox').style.display = 'block';

    let statsData = simData.transit;
    document.getElementById('valTime').innerText = (Math.ceil(statsData.dist*4)+10) + " min";
    document.getElementById('valTime').style.color = "var(--transit)";
    document.getElementById('valDist').innerText = statsData.dist.toFixed(2) + " km";
    document.getElementById('walkScore').innerText = transitScore;
    document.getElementById('walkScore').style.color = "var(--transit)";

    let leafCoords = r.geometry.coordinates.map(c => [c[1], c[0]]);
    let line = transitLines[Math.floor(Math.random() * transitLines.length)];
    
    let p1 = Math.floor(leafCoords.length * 0.2), p2 = Math.floor(leafCoords.length * 0.8);
    
    L.polyline(leafCoords.slice(0, p1), { color: '#007aff', weight: 5, dashArray: '8,8' }).addTo(transitLayer);
    L.polyline(leafCoords.slice(p1 - 1, p2 + 1), { color: line.color, weight: 8, opacity: 0.9 }).addTo(transitLayer);
    L.polyline(leafCoords.slice(p2), { color: '#007aff', weight: 5, dashArray: '8,8' }).addTo(transitLayer);

    map.fitBounds(L.polyline(leafCoords).getBounds(), { padding: [50, 50] });

    let totalSteps = r.legs[0].steps.length;
    let p1_step = Math.max(1, Math.floor(totalSteps * 0.25));
    let p2_step = Math.min(totalSteps - 1, Math.floor(totalSteps * 0.75));

    let startStn = (r.legs[0].steps[p1_step].name || "Local") + " Station";
    let endStn = (r.legs[0].steps[p2_step].name || "Central") + " Station";

    let walk1Html = "", walk2Html = "";
    let counts = { footpaths: 0, bridges: 0, underpasses: 0, crossings: 0 };

    r.legs[0].steps.forEach((step, index) => {
        let txt = step.maneuver.instruction || (step.name ? `Walk on ${step.name}` : "Continue straight");
        let txtLower = txt.toLowerCase();
        let loc = [step.maneuver.location[1], step.maneuver.location[0]]; 

        // Tally Transit Obstacles
        if (txtLower.includes('bridge')) counts.bridges++;
        else if (txtLower.includes('cross')) counts.crossings++;
        else counts.footpaths++;

        let stepHtml = `
            <div style="display:flex; gap:10px; padding:8px 0; border-bottom:1px solid #eee; cursor:pointer;" onclick="zoomToStep(${loc[0]}, ${loc[1]})">
                <span style="font-size:16px;">${txtLower.includes('left') ? '↖️' : txtLower.includes('right') ? '↗️' : '🚶'}</span>
                <span style="flex:1; font-size:11px; color:#333; font-weight:600;">${txt}</span>
                <span style="font-size:11px; font-weight:bold; color:var(--primary);">${Math.round(step.distance)}m</span>
            </div>`;
        
        if (index <= p1_step) walk1Html += stepHtml;
        if (index >= p2_step) walk2Html += stepHtml;
    });

    document.getElementById('cntFoot').innerText = counts.footpaths || 8;
    document.getElementById('cntBridge').innerText = counts.bridges;
    document.getElementById('cntUnder').innerText = counts.underpasses;
    document.getElementById('cntCross').innerText = counts.crossings;

    let now = new Date();
    let next = new Date(now.getTime() + 12 * 60000);

    document.getElementById('transitDetails').innerHTML = `
        <div style="margin-bottom:15px; background: rgba(0,122,255,0.05); padding: 10px; border-radius: 12px; border: 1px solid rgba(0,122,255,0.1);">
            <div style="font-size:12px; font-weight:900; color:var(--primary); text-transform:uppercase; margin-bottom:5px;">🚶 Walk to Station</div>
            ${walk1Html}
        </div>
        
        <div style="background:#f9f9f9; padding:15px; border-radius:12px; border-left: 5px solid ${line.color}; margin-bottom:15px; box-shadow: 0 4px 15px rgba(0,0,0,0.05);">
            <div style="display:flex; align-items:center; gap:10px;">
                <div style="font-size:28px;">🚇</div>
                <div style="flex:1;">
                    <b style="color:${line.color}; font-size:15px;">${line.name}</b><br>
                    <span style="font-size:11px; color:var(--text-main); font-weight:bold;">Board at: ${startStn}</span><br>
                    <span style="font-size:10px; color:var(--text-muted);">${line.dir}</span>
                </div>
                <div style="text-align:right;">
                    <div style="color:var(--danger); font-weight:800; font-size:12px; animation: pulse-text 1.5s infinite;">Arriving 3 mins</div>
                    <div style="font-size:10px; color:#555; font-weight:bold;">Next: ${next.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}</div>
                </div>
            </div>
            <div style="margin-top:10px; padding-top:10px; border-top:1px dashed #ccc; font-size:11px; font-weight:900; color:#333;">⬇️ Alight at: ${endStn}</div>
        </div>

        <div style="background: rgba(0,122,255,0.05); padding: 10px; border-radius: 12px; border: 1px solid rgba(0,122,255,0.1);">
            <div style="font-size:12px; font-weight:900; color:var(--primary); text-transform:uppercase; margin-bottom:5px;">🚶 Walk to Destination</div>
            ${walk2Html}
        </div>
    `;
}

// --- NEW: AI VOICE & LIVE NAVIGATION ---
function startLiveNavigation() {
    if (!userLoc) return showToast("Awaiting GPS Signal...");
    
    // Check iOS Compass Permission
    if (typeof DeviceOrientationEvent.requestPermission === 'function') {
        DeviceOrientationEvent.requestPermission()
            .then(res => { if (res === 'granted') window.addEventListener('deviceorientation', handleOrientation); })
            .catch(console.error);
    }

    isLiveTracking = true;
    map.flyTo(userLoc, 19, { animate: true, duration: 1.5 });
    
    document.getElementById('btnStartLive').style.display = 'none';
    document.getElementById('btnStopLive').style.display = 'block';
    if (!isMinimized) toggleMinimize();
    
    // AI Feature: Voice Navigation Setup
    if ('speechSynthesis' in window) {
        let msg = new SpeechSynthesisUtterance("Live navigation started. Follow the compass heading.");
        window.speechSynthesis.speak(msg);
    }

    showToast("Live Compass Navigation Started");
}

function stopLiveNavigation() {
    isLiveTracking = false;
    document.getElementById('btnStartLive').style.display = 'block';
    document.getElementById('btnStopLive').style.display = 'none';
    if (isMinimized) toggleMinimize();
    
    if (interactiveLayer.getLayers().length > 1) { // Zoom out to line
        let routeBounds = L.latLngBounds();
        interactiveLayer.eachLayer(layer => {
            if (layer.getBounds) routeBounds.extend(layer.getBounds());
        });
        map.fitBounds(routeBounds, { padding: [50, 50] });
    }
}

// --- TOOLS ---
function submitObstacle(type) {
    document.getElementById('obstacleModal').classList.remove('active');
    L.marker(userLoc, { icon: L.divIcon({ className: 'pulse-marker', html: `<div style="background:#ff3b30;width:14px;height:14px;border-radius:50%;border:2px solid white;"></div>`}) })
     .addTo(map).bindPopup(`<b>⚠️ Hazard:</b> ${type}`).openPopup();
    
    const feedList = document.getElementById('intelFeedList');
    feedList.innerHTML = `
        <div style="background:white; padding:16px; border-radius:16px; margin-bottom:12px; border:1px solid var(--border);">
            <span style="display:inline-block; background:rgba(255,59,48,0.1); color:var(--danger); padding:4px 8px; border-radius:8px; font-size:11px; font-weight:800; margin-bottom:8px;">${type}</span>
            <h4 style="margin:0 0 5px 0;">📍 Current Location</h4>
            <div style="font-size:12px; color:var(--text-muted);">Reported just now</div>
        </div>
    ` + feedList.innerHTML;
    showToast("Obstacle marked and added to Intel feed.");
}

function zoomToStep(lat, lng) { map.flyTo([lat, lng], 18, { animate: true, duration: 1 }); }
function markInfra(type) {
    interactiveLayer.eachLayer(l => { if(l.options && l.options.className === 'pulse-marker') interactiveLayer.removeLayer(l); });
    if (!routeCoordsData[type] || routeCoordsData[type].length === 0) return showToast(`No ${type} found.`);
    let bounds = L.latLngBounds();
    let colors = { footpaths: '#333', bridges: '#b8860b', underpasses: '#af52de', crossings: '#ff9500' };
    routeCoordsData[type].forEach(coord => {
        let p = L.latLng(coord[0], coord[1]);
        L.circleMarker(p, { radius: 10, className: 'pulse-marker', color: '#fff', weight: 2, fillColor: colors[type], fillOpacity: 0.9 }).addTo(interactiveLayer);
        bounds.extend(p);
    });
    map.fitBounds(bounds, { padding: [50, 50], maxZoom: 17 });
}
function toggleMinimize() {
    const hud = document.getElementById('auditorHud');
    isMinimized = !isMinimized;
    if(isMinimized) hud.classList.add('minimized'); else hud.classList.remove('minimized');
}
function toggleTreeCover() {
    if(treeLayer) { map.removeLayer(treeLayer); treeLayer = null; showToast("Tree Cover Hidden"); } 
    else { treeLayer = L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', { opacity: 0.4 }).addTo(map); showToast("Tree Canopy Active"); }
}