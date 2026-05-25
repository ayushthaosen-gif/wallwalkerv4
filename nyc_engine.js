// NYC Transit Engine — subway routing and map display
// Uses MTA GTFS static data (window.NYC_SUBWAY) including real stop sequences and transfer connections
(function () {
  'use strict';

  function haversine(lat1, lng1, lat2, lng2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
      Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function getNearestStations(lat, lng, n, radiusKm) {
    n = n || 5;
    radiusKm = radiusKm || 1.5;
    const stations = window.NYC_SUBWAY.stations;
    const results = [];
    for (const id in stations) {
      const s = stations[id];
      const dist = haversine(lat, lng, s.lat, s.lng);
      if (dist <= radiusKm) results.push({ id, ...s, dist });
    }
    results.sort((a, b) => a.dist - b.dist);
    return results.slice(0, n);
  }

  // Count stops between two station IDs on a given line,
  // using the canonical GTFS stop order for accuracy.
  function countStops(line, fromId, toId) {
    const order = (window.NYC_SUBWAY.stopOrder || {})[line];
    if (order) {
      const fi = order.indexOf(fromId), ti = order.indexOf(toId);
      if (fi >= 0 && ti >= 0) return Math.abs(ti - fi) || 1;
    }
    // Fallback: count via lineIndex
    const lineIndex = _buildLineIndex();
    const ids = lineIndex[line] || [];
    const fi = ids.indexOf(fromId), ti = ids.indexOf(toId);
    if (fi < 0 || ti < 0) return Math.max(2, ids.length / 3 | 0);
    return Math.abs(ti - fi) || 1;
  }

  // Lazy-built line → [station_id] index
  let _lineIndexCache = null;
  function _buildLineIndex() {
    if (_lineIndexCache) return _lineIndexCache;
    const stations = window.NYC_SUBWAY.stations;
    const idx = {};
    for (const id in stations) {
      for (const line of stations[id].lines) {
        if (!idx[line]) idx[line] = [];
        idx[line].push(id);
      }
    }
    _lineIndexCache = idx;
    return idx;
  }

  // All station IDs reachable via in-complex walk from a given station
  function getTransferGroup(stationId) {
    const s = window.NYC_SUBWAY.stations[stationId];
    return s ? [stationId, ...(s.transfers || [])] : [stationId];
  }

  // BFS over stations, allowing up to 1 transfer (including walking transfers within a complex)
  function planJourney(fromLat, fromLng, toLat, toLng) {
    const stations = window.NYC_SUBWAY.stations;
    const lineIndex = _buildLineIndex();

    // Invalidate cache if station data changed
    _lineIndexCache = lineIndex;

    const fromCandidates = getNearestStations(fromLat, fromLng, 3, 1.2);
    const toCandidates   = getNearestStations(toLat,   toLng,   3, 1.2);

    if (!fromCandidates.length || !toCandidates.length) return null;

    const toIds = new Set(toCandidates.map(s => s.id));
    // Also include transfer groups of destination candidates
    toCandidates.forEach(s => {
      (s.transfers || []).forEach(tid => toIds.add(tid));
    });

    // ── Direct (same line, same station) ──
    for (const from of fromCandidates) {
      // Also search from any in-complex transfer station
      for (const boardId of getTransferGroup(from.id)) {
        const boardSt = stations[boardId];
        if (!boardSt) continue;
        for (const line of boardSt.lines) {
          for (const toId of lineIndex[line] || []) {
            if (toIds.has(toId)) {
              const to = { id: toId, ...stations[toId] };
              const numStops = countStops(line, boardId, toId);
              return {
                type: 'direct',
                line,
                from: { id: from.id, ...stations[from.id], dist: from.dist },
                boardStation: boardId !== from.id ? { id: boardId, ...boardSt } : null,
                to,
                numStops,
                walkToStation: from.dist,
                walkFromStation: haversine(toLat, toLng,
                  stations[toId]?.lat || to.lat,
                  stations[toId]?.lng || to.lng),
                transfers: 0
              };
            }
          }
        }
      }
    }

    // ── 1-transfer (including walking transfers via complex) ──
    for (const from of fromCandidates) {
      for (const boardId of getTransferGroup(from.id)) {
        const boardSt = stations[boardId];
        if (!boardSt) continue;
        for (const line1 of boardSt.lines) {
          for (const midId of lineIndex[line1] || []) {
            // At midId, can also walk to its transfer group
            for (const xferId of getTransferGroup(midId)) {
              const xferSt = stations[xferId];
              if (!xferSt) continue;
              for (const line2 of xferSt.lines) {
                if (line2 === line1) continue;
                for (const toId of lineIndex[line2] || []) {
                  if (toIds.has(toId)) {
                    const to = { id: toId, ...stations[toId] };
                    const numStops = countStops(line1, boardId, midId) +
                                     countStops(line2, xferId, toId);
                    return {
                      type: 'transfer',
                      line1,
                      line2,
                      from: { id: from.id, ...stations[from.id], dist: from.dist },
                      transfer: { id: midId, ...stations[midId] },
                      transferWalk: xferId !== midId
                        ? { id: xferId, ...xferSt }
                        : null,
                      to,
                      numStops,
                      walkToStation: from.dist,
                      walkFromStation: haversine(toLat, toLng,
                        stations[toId]?.lat || to.lat,
                        stations[toId]?.lng || to.lng),
                      transfers: 1
                    };
                  }
                }
              }
            }
          }
        }
      }
    }

    // Fallback: nearest-to-nearest suggestion
    const from = fromCandidates[0];
    const to   = toCandidates[0];
    return {
      type: 'suggestion',
      from,
      to,
      walkToStation: from.dist,
      walkFromStation: to.dist,
      transfers: null
    };
  }

  function lineColor(line) {
    const lines = window.NYC_SUBWAY.lines;
    return (lines[line] && lines[line].color) || '#888';
  }

  function lineTextColor(line) {
    const lines = window.NYC_SUBWAY.lines;
    return (lines[line] && lines[line].textColor) || '#fff';
  }

  function lineBadge(line) {
    const color = lineColor(line);
    const tc = lineTextColor(line);
    return `<span style="display:inline-block;background:${color};color:${tc};border-radius:50%;width:20px;height:20px;line-height:20px;text-align:center;font-size:11px;font-weight:700;margin:0 2px;">${line}</span>`;
  }

  function drawSubwayStops(lat, lng, layer, radiusKm) {
    radiusKm = radiusKm || 1.2;
    const nearby = getNearestStations(lat, lng, 10, radiusKm);

    nearby.forEach(function (s) {
      const color = lineColor(s.lines[0]);
      const badges = s.lines.map(l => {
        const tc = lineTextColor(l);
        return `<span style="background:${lineColor(l)};color:${tc};border-radius:50%;width:16px;height:16px;line-height:16px;text-align:center;font-size:9px;font-weight:700;display:inline-block;margin:1px;">${l}</span>`;
      }).join('');

      const icon = L.divIcon({
        className: '',
        html: `<div style="background:white;border:2.5px solid ${color};border-radius:50%;width:14px;height:14px;box-shadow:0 1px 4px rgba(0,0,0,0.3);"></div>`,
        iconSize: [14, 14],
        iconAnchor: [7, 7]
      });

      const marker = L.marker([s.lat, s.lng], { icon })
        .bindPopup(`<div style="min-width:140px"><strong style="font-size:13px;">🚇 ${s.name}</strong><br/><div style="margin-top:4px;">${badges}</div><div style="font-size:11px;color:#666;margin-top:3px;">${(s.dist * 1000).toFixed(0)}m away</div></div>`);
      layer.addLayer(marker);
    });
  }

  // Draw the full subway network polylines from NYC_SHAPES
  function drawSubwayNetwork(map, layer) {
    if (!window.NYC_SHAPES) return;
    const lines = window.NYC_SUBWAY.lines;

    // Routes to skip on overview (too short / confusing)
    const skip = new Set(['GS', 'FS', '6X', '7X', 'FX', 'SI']);

    for (const [routeId, pts] of Object.entries(window.NYC_SHAPES)) {
      if (skip.has(routeId)) continue;
      const color = lineColor(routeId);
      L.polyline(pts, {
        color,
        weight: 3,
        opacity: 0.75,
        smoothFactor: 1.5,
        interactive: false,
      }).addTo(layer);
    }
  }

  function buildJourneyHtml(journey, walkMinutes) {
    if (!journey) {
      return '<div style="padding:12px;color:#666;font-size:13px;">No nearby subway found. Consider walking or a taxi.</div>';
    }

    const wMin = walkMinutes || Math.round((journey.walkToStation || 0) * 12);
    const exitMin = Math.round((journey.walkFromStation || 0) * 12);

    if (journey.type === 'direct') {
      const boardNote = journey.boardStation
        ? `<span style="font-size:11px;color:#94a3b8;"> (walk to ${journey.boardStation.name})</span>`
        : '';
      return `
        <div style="padding:10px 12px;">
          <div style="font-size:12px;font-weight:600;color:#1e293b;margin-bottom:6px;">🚇 Subway Route</div>
          <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
            <span style="font-size:12px;color:#475569;">Walk ${wMin}min →</span>
            <span style="font-size:12px;color:#1e293b;font-weight:600;">${journey.from.name}</span>
            ${boardNote}
            <span style="font-size:12px;color:#475569;">→ Take</span>
            ${lineBadge(journey.line)}
            <span style="font-size:12px;color:#475569;">${journey.numStops} stops →</span>
            <span style="font-size:12px;color:#1e293b;font-weight:600;">${journey.to.name}</span>
            <span style="font-size:12px;color:#475569;">→ Walk ${exitMin}min</span>
          </div>
          <div style="font-size:11px;color:#64748b;margin-top:4px;">Direct · No transfers · ${journey.numStops} stops</div>
        </div>`;
    }

    if (journey.type === 'transfer') {
      const xferNote = journey.transferWalk
        ? `<span style="font-size:11px;color:#94a3b8;"> → walk to ${journey.transferWalk.name}</span>`
        : '';
      return `
        <div style="padding:10px 12px;">
          <div style="font-size:12px;font-weight:600;color:#1e293b;margin-bottom:6px;">🚇 Subway Route</div>
          <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
            <span style="font-size:12px;color:#475569;">Walk ${wMin}min →</span>
            <span style="font-size:12px;color:#1e293b;font-weight:600;">${journey.from.name}</span>
            <span style="font-size:12px;color:#475569;">→</span>
            ${lineBadge(journey.line1)}
            <span style="font-size:12px;color:#475569;">→ Transfer at</span>
            <span style="font-size:12px;color:#1e293b;font-weight:600;">${journey.transfer.name}</span>
            ${xferNote}
            <span style="font-size:12px;color:#475569;">→</span>
            ${lineBadge(journey.line2)}
            <span style="font-size:12px;color:#475569;">→</span>
            <span style="font-size:12px;color:#1e293b;font-weight:600;">${journey.to.name}</span>
            <span style="font-size:12px;color:#475569;">→ Walk ${exitMin}min</span>
          </div>
          <div style="font-size:11px;color:#64748b;margin-top:4px;">1 transfer · ${journey.numStops} stops total</div>
        </div>`;
    }

    // suggestion fallback
    return `
      <div style="padding:10px 12px;">
        <div style="font-size:12px;font-weight:600;color:#1e293b;margin-bottom:6px;">🚇 Nearby Subway</div>
        <div style="font-size:12px;color:#475569;">
          Nearest station: <strong>${journey.from.name}</strong> (${(journey.walkToStation * 1000).toFixed(0)}m)
          ${journey.from.lines.map(l => lineBadge(l)).join('')}
        </div>
        <div style="font-size:11px;color:#94a3b8;margin-top:4px;">Full routing not available for this pair</div>
      </div>`;
  }

  window.NycEngine = {
    getNearestStations,
    planJourney,
    drawSubwayStops,
    drawSubwayNetwork,
    buildJourneyHtml,
    lineColor,
    lineTextColor,
    lineBadge,
    countStops,
  };
})();
