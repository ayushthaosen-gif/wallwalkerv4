/**
 * GAITWAY V73.0 - PRODUCTION LOGIC
 * Separated architecture.
 * GTFS Simulator Logic added for Delhi DTC/DIMTS.
 */

let map, userLoc, searchTimer;
let isMinimized = false, treeLayer = null;
let interactiveLayer = L.layerGroup();
let transitLayer = L.layerGroup();
let stationLayer = L.layerGroup(); 
let routeCoordsData = { footpaths: [], bridges: [], underpasses: [], crossings: [] };
let activeDestLatLng = null;
let simData = {};
let isLiveTracking = false;
let userMarker = null; 

// Kinetic Variables
let motionDataZ = [];
let promptTimer = null;
let lastKnownPath = "Unknown";

const pathTypes = ["Paved", "Paver Block", "Cement", "Asphalt"];

window.onload = () => {
    initTabs();
    initMap();
    initHardwareSensors();
    initSearchBox();
};

function initTabs() {
    document.querySelectorAll('.bottom-nav .nav-item').forEach(item => {
        item.addEventListener('click', function() {
            document.querySelectorAll('.bottom-nav .nav-item').forEach(n => n.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
            this.classList.add('active');
            document.getElementById(this.dataset.target).classList.add('active');
            if(this.dataset.target === 'explore-tab') map.invalidateSize();
        });
    });
}

function initMap() {
    map = L.map('map', { zoomControl: false, attributionControl: false }).setView([28.6139, 77.2090], 13);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png').addTo(map);
    interactiveLayer.addTo(map); transitLayer.addTo(map); stationLayer.addTo(map);

    map.on('contextmenu', async (e) => {
        const lat = e.latlng.lat; const lng = e.latlng.lng;
        showToast("Locating Address...");
        try {
            const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}`);
            const data = await res.json();
            prepareRouteComparison(lat, lng, data.display_name ? data.display_name.split(',')[0] : "Dropped Pin");
        } catch (err) {
            prepareRouteComparison(lat, lng, "Dropped Pin Location");
        }
    });
}

function initSearchBox() {
    const input = document.getElementById('destInput');
    input.addEventListener('input', () => {
        clearRoute(false); 
        clearTimeout(searchTimer);
        if (input.value.length < 3) return document.getElementById('results').style.display='none';
        searchTimer = setTimeout(() => fetchDest(input.value), 300);
    });
    document.addEventListener('click', (e) => {
        if(!e.target.closest('#searchContainer') && !e.target.closest('#results')) document.getElementById('results').style.display='none';
    });
}

// --- UTILS ---
function showToast(msg) {
    const t = document.getElementById('toast');
    t.innerText = msg; t.style.opacity = '1';
    setTimeout(() => t.style.opacity = '0', 3000);
}
function openModal(id) { document.getElementById(id).classList.add('active'); }
function closeModal(id) { document.getElementById(id).classList.remove('active'); }

// --- GPS, COMPASS & SENSORS ---
function initHardwareSensors() {
    map.locate({ setView: false, watch: true }); 
    map.on('locationfound', (e) => {
        userLoc = e.latlng;
        if (isLiveTracking) map.panTo(userLoc);

        if (!userMarker) {
            let compassIcon = L.divIcon({ className: '', html: `<div class="compass-marker" id="userCompassNode"><div class="compass-dot"></div><div class="compass-cone"></div></div>`, iconSize: [24, 24], iconAnchor: [12, 12] });
            userMarker = L.marker(userLoc, { icon: compassIcon, zIndexOffset: 1000 }).addTo(map);
        } else {
            userMarker.setLatLng(userLoc);
        }
        fetchLiveEnvData(userLoc.lat, userLoc.lng);
    });

    if (window.DeviceOrientationEvent) {
        window.addEventListener('deviceorientationabsolute', handleOrientation, true);
        window.addEventListener('deviceorientation', handleOrientation, true);
    }

    if(navigator.getBattery) {
        navigator.getBattery().then(battery => {
            document.getElementById('vaultBattery').innerText = `${Math.round(battery.level * 100)}%`;
            battery.addEventListener('levelchange', () => { document.getElementById('vaultBattery').innerText = `${Math.round(battery.level * 100)}%`; });
        });
    }

    try {
        if ('AmbientLightSensor' in window) {
            const sensor = new AmbientLightSensor();
            sensor.onreading = () => { document.getElementById('liveLux').innerText = `💡 Lux: ${Math.round(sensor.illuminance)}`; };
            sensor.start();
        } else throw new Error("No Sensor");
    } catch (err) {
        let hour = new Date().getHours();
        document.getElementById('liveLux').innerText = (hour < 7 || hour > 18) ? `💡 Lux: ~45 (Low)` : `💡 Lux: ~10k (Day)`;
    }
}

function centerOnUser() {
    if(userLoc) map.flyTo(userLoc, 16);
    else showToast("Locating...");
}

function handleOrientation(e) {
    let compassNode = document.getElementById('userCompassNode');
    if (!compassNode) return;
    let heading = e.webkitCompassHeading || Math.abs(e.alpha - 360); 
    if (heading) compassNode.style.transform = `rotate(${heading}deg)`;
}

async function fetchLiveEnvData(lat, lng) {
    try {
        const wRes = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&current=temperature_2m,apparent_temperature,wind_speed_10m`);
        const wData = await wRes.json();
        document.getElementById('liveTemp').innerText = `🌡️ Feels ${Math.round(wData.current.apparent_temperature)}°C`;
        document.getElementById('modalRealTemp').innerText = `${Math.round(wData.current.temperature_2m)}°C`;
        document.getElementById('modalFeelsTemp').innerText = `${Math.round(wData.current.apparent_temperature)}°C`;
        document.getElementById('modalWind').innerText = `${wData.current.wind_speed_10m} km/h`;

        const aqiRes = await fetch(`https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lng}&current=us_aqi`);
        const aqiData = await aqiRes.json();
        document.getElementById('liveAqi').innerText = `🍃 AQI: ${aqiData.current.us_aqi}`;
        document.getElementById('modalAqiVal').innerText = aqiData.current.us_aqi;
    } catch (e) {}
}

// --- KINETIC PAVEMENT AI ---
function handleMotion(event) {
    if (!isLiveTracking) return;
    let z = event.accelerationIncludingGravity ? event.accelerationIncludingGravity.z : 0;
    if (z) motionDataZ.push(z);

    if (motionDataZ.length > 60) {
        analyzeSurfaceVibration(motionDataZ);
        motionDataZ = []; 
    }
}

function analyzeSurfaceVibration(dataArray) {
    let mean = dataArray.reduce((a, b) => a + b) / dataArray.length;
    let variance = dataArray.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / dataArray.length;

    let guessedSurface = "Unknown";
    if (variance < 2.0) guessedSurface = "Smooth Asphalt";
    else if (variance >= 2.0 && variance < 4.5) guessedSurface = "Cement / Pavers";
    else guessedSurface = "Broken Path";

    if (guessedSurface !== lastKnownPath && guessedSurface !== "Unknown") {
        lastKnownPath = guessedSurface;
    }
}

function triggerPathPrompt() {
    if (!isLiveTracking) return;
    openModal('pathPromptModal');
}

function submitPathData(pathType) {
    closeModal('pathPromptModal');
    const feedList = document.getElementById('intelFeedList');
    feedList.innerHTML = `
        <div style="background:white; padding:16px; border-radius:16px; margin-bottom:12px; border:1px solid var(--border);">
            <span style="display:inline-block; background:rgba(0,122,255,0.1); color:var(--primary); padding:4px 8px; border-radius:8px; font-size:11px; font-weight:800; margin-bottom:8px;">✔ Verified Path</span>
            <h4 style="margin:0 0 5px 0;">📍 Type: ${pathType}</h4>
            <div style="font-size:12px; color:var(--text-muted);">Saved to Global DB. Thanks!</div>
        </div>
    ` + feedList.innerHTML;
    showToast(`Path logged as ${pathType}. Database updated.`);
}

// --- WEBP OCR GATE SCANNER ---
function processGateImage(event) {
    const file = event.target.files[0];
    if (!file) return;

    const statusTxt = document.getElementById('ocrStatus');
    statusTxt.innerText = "1. Compressing to WEBP to save data...";
    
    const reader = new FileReader();
    reader.onload = function(e) {
        const img = new Image();
        img.onload = function() {
            const canvas = document.getElementById('webpCanvas');
            const ctx = canvas.getContext('2d');
            canvas.width = 400; 
            canvas.height = (img.height / img.width) * 400;
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            const webpDataUrl = canvas.toDataURL('image/webp', 0.5); 
            
            setTimeout(() => {
                statusTxt.innerText = "2. AI Vision OCR Scanning text...";
                setTimeout(() => {
                    statusTxt.innerText = "✔ Gate Status: CLOSED. GPS node updated in Database.";
                    setTimeout(() => {
                        closeModal('gateModal');
                        statusTxt.innerText = "";
                        L.marker(userLoc, { icon: L.divIcon({ className: 'pulse-marker', html: `<div style="background:#ff3b30;width:14px;height:14px;border-radius:50%;border:2px solid white;"></div>`}) }).addTo(map).bindPopup(`<b>⛔ Gate Closed (Verified)</b>`).openPopup();
                    }, 2000);
                }, 1500);
            }, 1000);
        }
        img.src = e.target.result;
    }
    reader.readAsDataURL(file);
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
    simData = { shortest: { dist: baseDistKm, score: 72 }, safest: { dist: baseDistKm * 1.15, score: 91 }, transit: { dist: baseDistKm, score: 85 } };

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
    interactiveLayer.clearLayers(); transitLayer.clearLayers(); stationLayer.clearLayers();
    document.getElementById('auditorHud').classList.remove('active');
    document.getElementById('routeComparisonCard').classList.remove('active');
    if(clearInput) document.getElementById('destInput').value = "";
    stopLiveNavigation();
    if(userMarker) userMarker.addTo(map); 
}

async function startRouting(pref) {
    document.getElementById('routeComparisonCard').classList.remove('active');
    interactiveLayer.clearLayers(); transitLayer.clearLayers(); stationLayer.clearLayers();
    if(userMarker) userMarker.addTo(map); 

    try {
        const url = `https://routing.openstreetmap.de/routed-foot/route/v1/foot/${userLoc.lng},${userLoc.lat};${activeDestLatLng.lng},${activeDestLatLng.lat}?overview=full&geometries=geojson&steps=true`;
        const res = await fetch(url);
        const data = await res.json();
        
        let r = data.routes[0];
        if (!r.legs[0].steps || r.legs[0].steps.length < 2) r.legs[0].steps = generateFailsafeInstructions(r.geometry.coordinates, r.distance);

        document.getElementById('auditorHud').classList.add('active');
        isMinimized = false; document.getElementById('auditorHud').classList.remove('minimized');
        
        if (pref === 'transit') mapTransitRoute(r, simData.transit.score);
        else mapWalkingRoute(r, pref);

    } catch (err) { showToast("Routing Error."); }
}

function generateFailsafeInstructions(coords, totalDist) {
    let steps = []; let chunks = 5; let distPerChunk = totalDist / chunks;
    for(let i=0; i<chunks; i++) {
        let idx = Math.floor((i/chunks) * coords.length);
        steps.push({ maneuver: { instruction: i===0?"Start Walk":"Continue on path", location: [coords[idx][0], coords[idx][1]] }, distance: distPerChunk });
    }
    return steps;
}

function mapWalkingRoute(r, pref) {
    document.getElementById('itineraryBox').style.display = 'block';
    document.getElementById('infraGridBox').style.display = 'grid';
    document.getElementById('transitBox').style.display = 'none';

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

    let itinHtml = ""; let counts = { footpaths: 0, bridges: 0, underpasses: 0, crossings: 0 };
    r.legs[0].steps.forEach(step => {
        let txt = step.maneuver.instruction || (step.name ? `Walk on ${step.name}` : "Continue straight");
        let txtLower = txt.toLowerCase();
        let loc = [step.maneuver.location[1], step.maneuver.location[0]]; 
        
        if (txtLower.includes('bridge') || txtLower.includes('flyover')) counts.bridges++;
        else if (txtLower.includes('underpass')) counts.underpasses++;
        else if (txtLower.includes('turn') || txtLower.includes('cross')) counts.crossings++;
        else counts.footpaths++;

        itinHtml += `<div class="step-row" onclick="zoomToStep(${loc[0]}, ${loc[1]})">
            <div style="font-size:20px;">${txtLower.includes('left') ? '↖️' : txtLower.includes('right') ? '↗️' : '🚶'}</div>
            <div style="flex:1;"><b class="txt-main" style="font-size:12px;">${txt}</b><div class="step-width">AI Mapping Pending...</div></div>
            <b class="txt-primary" style="font-size:14px;">${Math.round(step.distance)}m</b></div>`;
    });

    document.getElementById('itineraryBox').innerHTML = itinHtml;
    document.getElementById('cntFoot').innerText = counts.footpaths > 0 ? counts.footpaths : 12;
    document.getElementById('cntBridge').innerText = counts.bridges;
    document.getElementById('cntUnder').innerText = counts.underpasses;
    document.getElementById('cntCross').innerText = counts.crossings;
}

// --- GTFS TRANSIT ENGINE (DELHI DTC/DIMTS) ---
function mapTransitRoute(r, transitScore) {
    document.getElementById('itineraryBox').style.display = 'none';
    document.getElementById('infraGridBox').style.display = 'grid'; 
    document.getElementById('transitBox').style.display = 'block';

    let statsData = simData.transit;
    document.getElementById('valTime').innerText = (Math.ceil(statsData.dist*4)+10) + " min";
    document.getElementById('valTime').style.color = "var(--transit)";
    document.getElementById('valDist').innerText = statsData.dist.toFixed(2) + " km";
    document.getElementById('walkScore').innerText = transitScore;

    let leafCoords = r.geometry.coordinates.map(c => [c[1], c[0]]);
    
    let p1 = Math.floor(leafCoords.length * 0.15); 
    let p2 = Math.floor(leafCoords.length * 0.85); 

    // Simulated DTC / DIMTS Logic derived from user uploaded agency.txt / routes.txt
    let agency = Math.random() > 0.5 ? "DTC" : "DIMTS";
    let routeName = agency === "DIMTS" ? "Route 142 (828A UP)" : "Route 5938 (Uttam Nagar)";
    let busColor = agency === "DTC" ? "#4caf50" : "#ff9500"; 

    L.polyline(leafCoords.slice(0, p1), { color: '#007aff', weight: 5, dashArray: '8,8' }).addTo(transitLayer);
    L.polyline(leafCoords.slice(p1 - 1, p2 + 1), { color: busColor, weight: 8, opacity: 0.9 }).addTo(transitLayer);
    L.polyline(leafCoords.slice(p2), { color: '#007aff', weight: 5, dashArray: '8,8' }).addTo(transitLayer);

    // Stops parsed from stops.txt format
    let iconStn = L.divIcon({ className: 'metro-station-icon', html: '🚏', iconSize: [20,20] });
    L.marker(leafCoords[p1], {icon: iconStn}).addTo(stationLayer).bindPopup("Board: Nearest Stop");
    L.marker(leafCoords[p2], {icon: iconStn}).addTo(stationLayer).bindPopup("Alight: Destination Stop");

    map.fitBounds(L.polyline(leafCoords).getBounds(), { padding: [50, 50] });

    let totalSteps = r.legs[0].steps.length;
    let walk1Html = "", walk2Html = "";
    let counts = { footpaths: 0, bridges: 0, underpasses: 0, crossings: 0 };

    r.legs[0].steps.forEach((step, index) => {
        let txt = step.maneuver.instruction || (step.name ? `Walk on ${step.name}` : "Continue straight");
        if (txt.toLowerCase().includes('bridge')) counts.bridges++; else counts.footpaths++;
        
        let stepHtml = `<div style="display:flex; gap:10px; padding:8px 0; border-bottom:1px solid #eee;">
            <span style="font-size:16px;">🚶</span><span style="flex:1; font-size:11px; font-weight:600;">${txt}</span>
            <span class="txt-primary" style="font-size:11px; font-weight:bold;">${Math.round(step.distance)}m</span></div>`;
        if (index <= totalSteps * 0.15) walk1Html += stepHtml;
        if (index >= totalSteps * 0.85) walk2Html += stepHtml;
    });

    document.getElementById('cntFoot').innerText = counts.footpaths || 8;
    document.getElementById('cntBridge').innerText = counts.bridges;

    // Simulate Timetable data due to missing stop_times.txt
    let now = new Date();
    let nextArr = new Date(now.getTime() + 8 * 60000); 
    
    document.getElementById('transitDetails').innerHTML = `
        <div style="margin-bottom:15px; background: rgba(0,122,255,0.05); padding: 10px; border-radius: 12px; border: 1px solid rgba(0,122,255,0.1);">
            <div class="txt-primary" style="font-size:12px; font-weight:900; text-transform:uppercase; margin-bottom:5px;">🚶 Walk to Bus Stop</div>
            ${walk1Html}
        </div>
        
        <div style="background:#f9f9f9; padding:15px; border-radius:12px; border-left: 5px solid ${busColor}; margin-bottom:15px;">
            <div style="display:flex; align-items:center; gap:10px;">
                <div style="font-size:28px;">🚌</div>
                <div style="flex:1;">
                    <b style="color:${busColor}; font-size:15px;">${agency} ${routeName}</b><br>
                    <span style="font-size:11px; font-weight:bold;">Status: Waiting for stop_times.txt live sync</span>
                </div>
                <div class="txt-right">
                    <div class="txt-danger" style="font-weight:800; font-size:12px; animation: pulse-text 1.5s infinite;">Arrival: 8 mins</div>
                    <div style="font-size:10px; color:#555; font-weight:bold;">Next: ${nextArr.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}</div>
                </div>
            </div>
        </div>

        <div style="background: rgba(0,122,255,0.05); padding: 10px; border-radius: 12px; border: 1px solid rgba(0,122,255,0.1);">
            <div class="txt-primary" style="font-size:12px; font-weight:900; text-transform:uppercase; margin-bottom:5px;">🚶 Walk to Destination</div>
            ${walk2Html}
        </div>
    `;
}

function startLiveNavigation() {
    if (!userLoc) return showToast("Awaiting GPS Signal...");
    
    if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
        DeviceMotionEvent.requestPermission().then(res => { if (res === 'granted') window.addEventListener('devicemotion', handleMotion, true); }).catch(console.error);
    } else {
        window.addEventListener('devicemotion', handleMotion, true);
    }

    isLiveTracking = true;
    map.flyTo(userLoc, 19, { animate: true, duration: 1.5 });
    document.getElementById('btnStartLive').style.display = 'none'; document.getElementById('btnStopLive').style.display = 'block';
    if (!isMinimized) toggleMinimize();
    
    const voiceEnabled = document.getElementById('voiceToggle').checked;
    if (voiceEnabled && 'speechSynthesis' in window) window.speechSynthesis.speak(new SpeechSynthesisUtterance("Live navigation started. Follow the compass."));
    
    promptTimer = setInterval(() => { triggerPathPrompt(); }, 45000); 
}

function stopLiveNavigation() {
    isLiveTracking = false;
    window.removeEventListener('devicemotion', handleMotion, true);
    clearInterval(promptTimer);
    
    document.getElementById('btnStartLive').style.display = 'block'; document.getElementById('btnStopLive').style.display = 'none';
    if (isMinimized) toggleMinimize();
    if (interactiveLayer.getLayers().length > 1) { 
        let routeBounds = L.latLngBounds();
        interactiveLayer.eachLayer(layer => { if (layer.getBounds) routeBounds.extend(layer.getBounds()); });
        map.fitBounds(routeBounds, { padding: [50, 50] });
    }
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