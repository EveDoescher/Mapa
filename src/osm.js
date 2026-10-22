const OVERPASS_ENDPOINTS = [
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass-api.de/api/interpreter',
];

const EXCLUDED_HIGHWAYS = new Set([
  'footway',
  'path',
  'steps',
  'pedestrian',
  'cycleway',
  'bridleway',
  'corridor',
  'elevator',
  'platform',
  'proposed',
  'construction',
]);

const PARK_LEISURE = new Set([
  'park',
  'garden',
  'playground',
  'nature_reserve',
  'common',
  ' square',
]);

const PARK_LANDUSE = new Set([
  'grass',
  'forest',
  'meadow',
  'recreation_ground',
  'village_green',
  'greenfield',
]);

/**
 * Busca coordenadas (lat, lon) a partir do nome de um lugar via Nominatim (OSM)
 */
export async function geocodeLocation(query) {
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(query)}`;
  const res = await fetch(url, {
    headers: { 'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8' },
  });
  if (!res.ok) throw new Error('Falha ao buscar endereço no Nominatim');
  const data = await res.json();
  if (!data || data.length === 0) {
    throw new Error(`Lugar não encontrado: "${query}"`);
  }
  return {
    lat: parseFloat(data[0].lat),
    lon: parseFloat(data[0].lon),
    displayName: data[0].display_name,
  };
}

/**
 * Converte (lat, lon) em metros locais (x, z) relativos à origem (originLat, originLon)
 */
export function latLonToMeters(lat, lon, originLat, originLon) {
  const R = 6378137;
  const dLat = ((lat - originLat) * Math.PI) / 180;
  const dLon = ((lon - originLon) * Math.PI) / 180;
  const cosLat = Math.cos((originLat * Math.PI) / 180);

  const x = dLon * R * cosLat; // Leste = +X
  const z = -dLat * R; // Norte = -Z
  return { x, z };
}

/**
 * Converte metros locais (x, z) de volta para (lat, lon) relativos à origem (originLat, originLon)
 */
export function metersToLatLon(x, z, originLat, originLon) {
  const R = 6378137;
  const cosLat = Math.cos((originLat * Math.PI) / 180);

  const dLat = -z / R;
  const dLon = x / (R * cosLat);

  return {
    lat: originLat + (dLat * 180) / Math.PI,
    lon: originLon + (dLon * 180) / Math.PI,
  };
}

/**
 * Busca ruas, prédios/casas, praças/parques e árvores do OSM dentro de uma Bounding Box
 */
export async function fetchOsmElementsByBBox(south, west, north, east) {
  const bboxStr = `${south.toFixed(5)},${west.toFixed(5)},${north.toFixed(5)},${east.toFixed(5)}`;
  const query = `[out:json][timeout:25];(way["highway"]["highway"!~"^(footway|path|steps|pedestrian|cycleway|corridor|platform|proposed|construction)$"](${bboxStr});way["building"](${bboxStr});way["leisure"~"^(park|garden|playground|nature_reserve)$"](${bboxStr});way["landuse"~"^(grass|forest|meadow|recreation_ground|village_green)$"](${bboxStr});node["natural"="tree"](${bboxStr}););out body;>;out skel qt;`;

  const controller = new AbortController();

  const requests = OVERPASS_ENDPOINTS.map(async (endpoint) => {
    const response = await fetch(endpoint, {
      method: 'POST',
      body: 'data=' + encodeURIComponent(query),
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const json = await response.json();
    if (!json || !json.elements) throw new Error('Resposta vazia');
    return json.elements;
  });

  try {
    const elements = await Promise.any(requests);
    controller.abort();
    return elements;
  } catch (err) {
    throw new Error(
      'Servidores Overpass ocupados no momento. Tente novamente em instantes.'
    );
  }
}

/**
 * Constrói o grafo de ruas + listas de prédios, praças e árvores a partir dos elementos do OSM
 */
export function buildRoadGraphFromElements(
  rawNodesMap,
  rawWaysMap,
  originLat,
  originLon
) {
  const nodes = new Map();
  const roadWays = [];
  const buildingWays = [];
  const parkWays = [];
  const trees = [];

  for (const [id, el] of rawNodesMap.entries()) {
    if (el._x === undefined || el._originLat !== originLat) {
      const { x, z } = latLonToMeters(el.lat, el.lon, originLat, originLon);
      el._x = x;
      el._z = z;
      el._originLat = originLat;
    }
    const nodeObj = {
      id,
      lat: el.lat,
      lon: el.lon,
      x: el._x,
      z: el._z,
      tags: el.tags || {},
      neighbors: new Set(),
      wayCount: 0,
      connectedEdges: [],
    };
    nodes.set(id, nodeObj);

    if (el.tags && el.tags.natural === 'tree') {
      trees.push({ id, x: el._x, z: el._z });
    }
  }

  for (const way of rawWaysMap.values()) {
    const tags = way.tags;
    if (!tags) continue;

    if (tags.highway && !EXCLUDED_HIGHWAYS.has(tags.highway)) {
      roadWays.push(way);
    } else if (tags.building) {
      buildingWays.push(way);
    } else if (
      PARK_LEISURE.has(tags.leisure) ||
      PARK_LANDUSE.has(tags.landuse)
    ) {
      parkWays.push(way);
    }
  }

  // 1. Processa Ruas
  for (const way of roadWays) {
    const nodeIds = way.nodes || [];
    for (let i = 0; i < nodeIds.length; i++) {
      const curr = nodes.get(nodeIds[i]);
      if (!curr) continue;
      curr.wayCount += 1;
      if (i > 0 && nodes.has(nodeIds[i - 1])) {
        curr.neighbors.add(nodeIds[i - 1]);
      }
      if (i < nodeIds.length - 1 && nodes.has(nodeIds[i + 1])) {
        curr.neighbors.add(nodeIds[i + 1]);
      }
    }
  }

  const segments = [];
  for (const way of roadWays) {
    const nodeIds = way.nodes || [];
    if (nodeIds.length < 2) continue;

    const isRoundabout = way.tags.junction === 'roundabout';
    const isBridge = way.tags.bridge === 'yes' || way.tags.bridge === 'viaduct';
    const isOneway =
      way.tags.oneway === 'yes' ||
      way.tags.oneway === '1' ||
      isRoundabout ||
      way.tags.highway.endsWith('_link');
    const highwayType = way.tags.highway;
    const name = way.tags.name || '';

    let currentChain = [nodes.get(nodeIds[0])];

    for (let i = 1; i < nodeIds.length; i++) {
      const node = nodes.get(nodeIds[i]);
      if (!node) continue;
      currentChain.push(node);

      const isEndOfWay = i === nodeIds.length - 1;
      const chainLen = Math.hypot(
        node.x - currentChain[0].x,
        node.z - currentChain[0].z
      );
      const isRealIntersection = node.neighbors.size >= 3;
      const isLongChunkSplit = chainLen > 180 && node.wayCount >= 1;

      if (
        (isRealIntersection || isEndOfWay || isLongChunkSplit) &&
        currentChain.length >= 2
      ) {
        const cleanPoints = [];
        for (const pt of currentChain) {
          if (
            cleanPoints.length === 0 ||
            Math.hypot(
              pt.x - cleanPoints[cleanPoints.length - 1].x,
              pt.z - cleanPoints[cleanPoints.length - 1].z
            ) > 0.4
          ) {
            cleanPoints.push(pt);
          }
        }

        if (cleanPoints.length >= 2) {
          const startNode = cleanPoints[0];
          const endNode = cleanPoints[cleanPoints.length - 1];

          let totalLen = 0;
          for (let k = 0; k < cleanPoints.length - 1; k++) {
            totalLen += Math.hypot(
              cleanPoints[k + 1].x - cleanPoints[k].x,
              cleanPoints[k + 1].z - cleanPoints[k].z
            );
          }

          const midPt = cleanPoints[Math.floor(cleanPoints.length / 2)];
          const midX = (startNode.x + endNode.x + midPt.x) / 3;
          const midZ = (startNode.z + endNode.z + midPt.z) / 3;

          const seg = {
            id: `${way.id}_${startNode.id}_${endNode.id}_${i}`,
            wayId: way.id,
            name,
            highwayType,
            isRoundabout,
            isBridge,
            isOneway,
            points: cleanPoints,
            totalLen,
            startNode,
            endNode,
            midX,
            midZ,
          };
          segments.push(seg);

          const p1 = cleanPoints[1];
          const dirFromStart = Math.atan2(
            p1.z - startNode.z,
            p1.x - startNode.x
          );
          startNode.connectedEdges.push({
            angle: dirFromStart,
            segment: seg,
            isStart: true,
            highwayType,
          });

          const pPrev = cleanPoints[cleanPoints.length - 2];
          const dirFromEnd = Math.atan2(
            pPrev.z - endNode.z,
            pPrev.x - endNode.x
          );
          endNode.connectedEdges.push({
            angle: dirFromEnd,
            segment: seg,
            isStart: false,
            highwayType,
          });
        }

        currentChain = [node];
      }
    }
  }

  const activeNodes = [];
  for (const node of nodes.values()) {
    if (node.connectedEdges.length > 0) {
      const uniqueEdges = [];
      for (const edge of node.connectedEdges) {
        const duplicate = uniqueEdges.some(
          (e) =>
            e.segment.id === edge.segment.id ||
            Math.abs(normalizeAngle(e.angle - edge.angle)) < 0.14
        );
        if (!duplicate) uniqueEdges.push(edge);
      }
      uniqueEdges.sort((a, b) => a.angle - b.angle);
      node.uniqueEdges = uniqueEdges;
      activeNodes.push(node);
    }
  }

  // 2. Processa Polígonos de Prédios/Casas do OSM
  const buildings = [];
  for (const way of buildingWays) {
    const poly = extractWayPolygon(way, nodes);
    if (!poly || poly.points.length < 3) continue;

    const tags = way.tags || {};
    const levels = parseInt(tags['building:levels'], 10) || 0;
    buildings.push({
      id: way.id,
      tags,
      buildingType: tags.building,
      levels,
      name: tags.name || '',
      points: poly.points,
      cx: poly.cx,
      cz: poly.cz,
      width: poly.width,
      depth: poly.depth,
      area: poly.area,
      mainAngle: poly.mainAngle,
    });
  }

  // 3. Processa Polígonos de Praças e Parques do OSM
  const parks = [];
  for (const way of parkWays) {
    const poly = extractWayPolygon(way, nodes);
    if (!poly || poly.points.length < 3 || poly.area < 40) continue;

    parks.push({
      id: way.id,
      tags: way.tags || {},
      name: way.tags?.name || '',
      points: poly.points,
      cx: poly.cx,
      cz: poly.cz,
      minX: poly.minX,
      maxX: poly.maxX,
      minZ: poly.minZ,
      maxZ: poly.maxZ,
      area: poly.area,
    });
  }

  return {
    waysCount: roadWays.length,
    segments,
    nodes: activeNodes,
    buildings,
    parks,
    trees,
  };
}

function extractWayPolygon(way, nodesMap) {
  const nodeIds = way.nodes || [];
  if (nodeIds.length < 3) return null;

  const pts = [];
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;

  for (let i = 0; i < nodeIds.length; i++) {
    const n = nodesMap.get(nodeIds[i]);
    if (!n) continue;
    // Evita repetir o último ponto se for igual ao primeiro
    if (
      i === nodeIds.length - 1 &&
      pts.length > 0 &&
      Math.hypot(n.x - pts[0].x, n.z - pts[0].z) < 0.2
    ) {
      continue;
    }
    pts.push({ x: n.x, z: n.z });
    if (n.x < minX) minX = n.x;
    if (n.x > maxX) maxX = n.x;
    if (n.z < minZ) minZ = n.z;
    if (n.z > maxZ) maxZ = n.z;
  }

  if (pts.length < 3) return null;

  // Centroide e área (Shoelace) + aresta mais longa para achar ângulo dominante
  let signedArea = 0;
  let cx = 0;
  let cz = 0;
  let longestEdgeSq = 0;
  let mainAngle = 0;

  for (let i = 0; i < pts.length; i++) {
    const p0 = pts[i];
    const p1 = pts[(i + 1) % pts.length];
    const cross = p0.x * p1.z - p1.x * p0.z;
    signedArea += cross;
    cx += (p0.x + p1.x) * cross;
    cz += (p0.z + p1.z) * cross;

    const dx = p1.x - p0.x;
    const dz = p1.z - p0.z;
    const lenSq = dx * dx + dz * dz;
    if (lenSq > longestEdgeSq) {
      longestEdgeSq = lenSq;
      mainAngle = Math.atan2(dz, dx);
    }
  }

  signedArea *= 0.5;
  const area = Math.abs(signedArea);
  if (area < 4) return null;

  if (Math.abs(signedArea) > 0.01) {
    cx /= 6 * signedArea;
    cz /= 6 * signedArea;
  } else {
    cx = (minX + maxX) * 0.5;
    cz = (minZ + maxZ) * 0.5;
  }

  // Calcula larguras projetadas no ângulo principal (Oriented Bounding Box)
  const cosA = Math.cos(-mainAngle);
  const sinA = Math.sin(-mainAngle);
  let uMin = Infinity;
  let uMax = -Infinity;
  let vMin = Infinity;
  let vMax = -Infinity;

  for (const p of pts) {
    const dx = p.x - cx;
    const dz = p.z - cz;
    const u = dx * cosA - dz * sinA;
    const v = dx * sinA + dz * cosA;
    if (u < uMin) uMin = u;
    if (u > uMax) uMax = u;
    if (v < vMin) vMin = v;
    if (v > vMax) vMax = v;
  }

  return {
    points: pts,
    cx,
    cz,
    minX,
    maxX,
    minZ,
    maxZ,
    width: Math.max(4, uMax - uMin),
    depth: Math.max(4, vMax - vMin),
    area,
    mainAngle,
  };
}

export function normalizeAngle(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}
