import * as THREE from 'three';
import {
  buildRoadGraphFromElements,
  fetchOsmElementsByBBox,
  metersToLatLon,
} from './osm.js';

export const CHUNK_SIZE = 260; // 260m x 260m por chunk
const PREFETCH_SUPER_RADIUS = 2; // Grade 5x5 chunks (~1.3km x 1.3km) por requisição

export class ChunkManager {
  constructor(
    scene,
    roadBuilder,
    cityBuilder,
    onStatusChange,
    onStatsChange
  ) {
    this.scene = scene;
    this.roadBuilder = roadBuilder;
    this.cityBuilder = cityBuilder;
    this.onStatusChange = onStatusChange;
    this.onStatsChange = onStatsChange;

    this.originLat = -22.5646;
    this.originLon = -47.4017;
    this.locationName = 'Centro, Limeira - SP';

    this.rawNodes = new Map();
    this.rawWays = new Map();
    this.globalGraph = {
      waysCount: 0,
      segments: [],
      nodes: [],
      buildings: [],
      parks: [],
      trees: [],
    };
    this.globalTrimMap = new Map();

    this.chunkBuckets = new Map();
    this.fetchedChunkKeys = new Set();

    this.chunks = new Map();
    this.chunksRoot = new THREE.Group();
    this.chunksRoot.name = 'Chunks_World_Root';
    this.scene.add(this.chunksRoot);

    this.bordersRoot = new THREE.Group();
    this.bordersRoot.name = 'Chunks_Borders_Root';
    this.scene.add(this.bordersRoot);

    this.currentCenterCx = null;
    this.currentCenterCz = null;
    this.renderDistance = 1; // 1 = 3x3 (9 chunks), 2 = 5x5 (25 chunks)

    this.renderOptions = {
      mode: 'deformed',
      showProps: true,
      showBuildings: true,
      showParks: true,
      autoFillLots: true,
      showOsmLines: false,
      showChunkBorders: true,
    };

    this.isFetching = false;
    this.pendingFetchCheck = false;
    this.buildQueue = [];
    this.isProcessingQueue = false;
  }

  chunkKey(cx, cz) {
    return `${cx},${cz}`;
  }

  worldToChunk(x, z) {
    return {
      cx: Math.floor((x + CHUNK_SIZE * 0.5) / CHUNK_SIZE),
      cz: Math.floor((z + CHUNK_SIZE * 0.5) / CHUNK_SIZE),
    };
  }

  chunkBoundsMeters(cx, cz) {
    const minX = (cx - 0.5) * CHUNK_SIZE;
    const maxX = (cx + 0.5) * CHUNK_SIZE;
    const minZ = (cz - 0.5) * CHUNK_SIZE;
    const maxZ = (cz + 0.5) * CHUNK_SIZE;
    return { minX, maxX, minZ, maxZ };
  }

  async resetOrigin(lat, lon, name) {
    this.originLat = lat;
    this.originLon = lon;
    this.locationName = name;

    this.buildQueue = [];
    this.clearAllChunks();
    this.rawNodes.clear();
    this.rawWays.clear();
    this.chunkBuckets.clear();
    this.fetchedChunkKeys.clear();
    this.globalGraph = {
      waysCount: 0,
      segments: [],
      nodes: [],
      buildings: [],
      parks: [],
      trees: [],
    };
    this.globalTrimMap.clear();

    this.currentCenterCx = null;
    this.currentCenterCz = null;

    await this.updateCameraTarget(0, 0, true);
  }

  clearAllChunks() {
    for (const chunk of this.chunks.values()) {
      this.disposeChunkMeshes(chunk);
    }
    this.chunks.clear();
    this.chunksRoot.clear();
    this.bordersRoot.clear();
  }

  disposeChunkMeshes(chunk) {
    if (chunk.group) {
      this.chunksRoot.remove(chunk.group);
      chunk.group.traverse((obj) => {
        if (obj.isMesh && !obj.isInstancedMesh) {
          obj.geometry.dispose();
        }
        if (obj.isLineSegments) {
          obj.geometry.dispose();
        }
      });
      chunk.group = null;
    }
    if (chunk.borderMesh) {
      this.bordersRoot.remove(chunk.borderMesh);
      chunk.borderMesh.geometry.dispose();
      chunk.borderMesh.material.dispose();
      chunk.borderMesh = null;
    }
  }

  reindexSpatialBuckets() {
    this.chunkBuckets.clear();

    const getBucket = (cx, cz) => {
      const k = this.chunkKey(cx, cz);
      let b = this.chunkBuckets.get(k);
      if (!b) {
        b = {
          nodes: [],
          segments: [],
          buildings: [],
          parks: [],
          trees: [],
        };
        this.chunkBuckets.set(k, b);
      }
      return b;
    };

    for (const n of this.globalGraph.nodes) {
      const { cx, cz } = this.worldToChunk(n.x, n.z);
      getBucket(cx, cz).nodes.push(n);
    }

    for (const s of this.globalGraph.segments) {
      const { cx, cz } = this.worldToChunk(s.midX, s.midZ);
      getBucket(cx, cz).segments.push(s);
    }

    for (const bld of this.globalGraph.buildings || []) {
      const { cx, cz } = this.worldToChunk(bld.cx, bld.cz);
      getBucket(cx, cz).buildings.push(bld);
    }

    for (const park of this.globalGraph.parks || []) {
      const { cx, cz } = this.worldToChunk(park.cx, park.cz);
      getBucket(cx, cz).parks.push(park);
    }

    for (const tree of this.globalGraph.trees || []) {
      const { cx, cz } = this.worldToChunk(tree.x, tree.z);
      getBucket(cx, cz).trees.push(tree);
    }
  }

  /**
   * Coleta os segmentos da chunk (cx, cz) + das 8 chunks vizinhas para que casas/praças na borda
   * da chunk não invadam ruas que acabaram de cruzar a fronteira da chunk vizinha!
   */
  getNeighborSegments(cx, cz) {
    const result = [];
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const b = this.chunkBuckets.get(this.chunkKey(cx + dx, cz + dz));
        if (b && b.segments.length > 0) {
          for (let i = 0; i < b.segments.length; i++) {
            result.push(b.segments[i]);
          }
        }
      }
    }
    return result;
  }

  async updateCameraTarget(targetX, targetZ, force = false) {
    const { cx, cz } = this.worldToChunk(targetX, targetZ);

    if (!force && cx === this.currentCenterCx && cz === this.currentCenterCz) {
      return;
    }

    this.currentCenterCx = cx;
    this.currentCenterCz = cz;

    const R = this.renderDistance;
    const requiredKeys = new Set();
    const needsNetworkFetch = [];

    for (let dx = -R; dx <= R; dx++) {
      for (let dz = -R; dz <= R; dz++) {
        const ncx = cx + dx;
        const ncz = cz + dz;
        const key = this.chunkKey(ncx, ncz);
        requiredKeys.add(key);

        let chunk = this.chunks.get(key);
        if (!chunk) {
          chunk = {
            cx: ncx,
            cz: ncz,
            key,
            status: 'unloaded',
            group: null,
            borderMesh: null,
            tileCount: 0,
            builtSegCount: -1,
            active: true,
          };
          this.chunks.set(key, chunk);
        } else {
          chunk.active = true;
          if (chunk.group) chunk.group.visible = true;
        }

        if (!this.fetchedChunkKeys.has(key)) {
          needsNetworkFetch.push(chunk);
        } else if (chunk.status === 'unloaded') {
          this.enqueueChunkBuild(chunk);
        }

        this.updateChunkBorderVisual(chunk, ncx === cx && ncz === cz);
      }
    }

    for (const [key, chunk] of this.chunks.entries()) {
      if (!requiredKeys.has(key)) {
        chunk.active = false;
        if (chunk.group) chunk.group.visible = false;
        if (chunk.borderMesh) chunk.borderMesh.visible = false;
      }
    }

    this.emitStats();

    if (needsNetworkFetch.length > 0) {
      await this.fetchSuperRegion(cx, cz, needsNetworkFetch);
    } else {
      this.onStatusChange(
        `Chunk [${cx}, ${cz}] ativa (Cache RAM instantâneo ⚡)`
      );
      this.checkBackgroundPrefetch(cx, cz);
    }
  }

  enqueueChunkBuild(chunk) {
    chunk.status = 'queued';
    if (!this.buildQueue.includes(chunk)) {
      this.buildQueue.push(chunk);
    }
    if (!this.isProcessingQueue) {
      this.processBuildQueue();
    }
  }

  processBuildQueue() {
    if (this.buildQueue.length === 0) {
      this.isProcessingQueue = false;
      this.emitStats();
      return;
    }

    this.isProcessingQueue = true;
    const start = performance.now();

    while (this.buildQueue.length > 0 && performance.now() - start < 7) {
      const chunk = this.buildQueue.shift();
      this.buildSingleChunkMesh(chunk);
    }

    this.emitStats();
    requestAnimationFrame(() => this.processBuildQueue());
  }

  checkBackgroundPrefetch(cx, cz) {
    if (this.isFetching) return;
    const R = this.renderDistance + 1;
    for (let dx = -R; dx <= R; dx++) {
      for (let dz = -R; dz <= R; dz++) {
        if (!this.fetchedChunkKeys.has(this.chunkKey(cx + dx, cz + dz))) {
          this.fetchSuperRegion(cx, cz, []);
          return;
        }
      }
    }
  }

  async fetchSuperRegion(centerCx, centerCz, waitingChunks) {
    for (const ch of waitingChunks) {
      if (ch.status === 'unloaded') ch.status = 'loading';
      this.updateChunkBorderVisual(
        ch,
        ch.cx === this.currentCenterCx && ch.cz === this.currentCenterCz
      );
    }

    if (this.isFetching) {
      this.pendingFetchCheck = true;
      return;
    }

    this.isFetching = true;
    const SR = Math.max(PREFETCH_SUPER_RADIUS, this.renderDistance + 1);

    try {
      const minChunkX = centerCx - SR;
      const maxChunkX = centerCx + SR;
      const minChunkZ = centerCz - SR;
      const maxChunkZ = centerCz + SR;

      const bMin = this.chunkBoundsMeters(minChunkX, minChunkZ);
      const bMax = this.chunkBoundsMeters(maxChunkX, maxChunkZ);

      const margin = 50;
      const sw = metersToLatLon(
        bMin.minX - margin,
        bMax.maxZ + margin,
        this.originLat,
        this.originLon
      );
      const ne = metersToLatLon(
        bMax.maxX + margin,
        bMin.minZ - margin,
        this.originLat,
        this.originLon
      );

      this.onStatusChange(
        `Baixando ruas, prédios e praças do OSM em [${centerCx}, ${centerCz}]...`
      );

      const t0 = performance.now();
      const elements = await fetchOsmElementsByBBox(
        sw.lat,
        sw.lon,
        ne.lat,
        ne.lon
      );

      for (const el of elements) {
        if (el.type === 'node') {
          if (!this.rawNodes.has(el.id) || el.tags) {
            this.rawNodes.set(el.id, el);
          }
        } else if (el.type === 'way') {
          this.rawWays.set(el.id, el);
        }
      }

      const coreR = Math.max(1, SR - 1);
      for (let x = centerCx - coreR; x <= centerCx + coreR; x++) {
        for (let z = centerCz - coreR; z <= centerCz + coreR; z++) {
          this.fetchedChunkKeys.add(this.chunkKey(x, z));
        }
      }

      this.globalGraph = buildRoadGraphFromElements(
        this.rawNodes,
        this.rawWays,
        this.originLat,
        this.originLon
      );
      this.globalTrimMap = this.roadBuilder.computeNodeTrimMap(
        this.globalGraph.nodes
      );
      this.reindexSpatialBuckets();

      for (const ch of this.chunks.values()) {
        const bucket = this.chunkBuckets.get(ch.key);
        const segCount = bucket
          ? bucket.segments.length +
            bucket.buildings.length +
            bucket.parks.length
          : 0;

        if (
          ch.status !== 'ready' ||
          (ch.builtSegCount !== segCount && segCount > 0)
        ) {
          this.enqueueChunkBuild(ch);
        }
      }

      const dt = Math.round(performance.now() - t0);
      this.onStatusChange(
        `Região [${this.currentCenterCx}, ${this.currentCenterCz}] pronta (${dt}ms) • Arraste para explorar!`
      );
    } catch (err) {
      console.error(err);
      for (const ch of waitingChunks) {
        if (ch.status === 'loading') ch.status = 'unloaded';
      }
      this.onStatusChange(`Erro ao baixar região: ${err.message}`, true);
    } finally {
      this.isFetching = false;
      if (this.pendingFetchCheck) {
        this.pendingFetchCheck = false;
        const stillMissing = Array.from(this.chunks.values()).filter(
          (c) => c.active && !this.fetchedChunkKeys.has(c.key)
        );
        if (stillMissing.length > 0) {
          this.fetchSuperRegion(
            this.currentCenterCx,
            this.currentCenterCz,
            stillMissing
          );
        }
      }
    }
  }

  buildSingleChunkMesh(chunk) {
    const bucket = this.chunkBuckets.get(chunk.key) || {
      nodes: [],
      segments: [],
      buildings: [],
      parks: [],
      trees: [],
    };

    if (chunk.group) {
      this.chunksRoot.remove(chunk.group);
      chunk.group.traverse((obj) => {
        if (obj.isMesh && !obj.isInstancedMesh) {
          obj.geometry.dispose();
        }
        if (obj.isLineSegments) {
          obj.geometry.dispose();
        }
      });
    }

    const chunkContainer = new THREE.Group();
    chunkContainer.name = `Chunk_${chunk.cx}_${chunk.cz}`;

    // 1. Constrói as Ruas da Chunk
    const { group: roadGroup, totalTiles } = this.roadBuilder.buildRoadScene(
      {
        waysCount: bucket.segments.length,
        nodes: bucket.nodes,
        segments: bucket.segments,
      },
      {
        mode: this.renderOptions.mode,
        showProps: this.renderOptions.showProps,
        showOsmLines: this.renderOptions.showOsmLines,
        sharedNodeTrimMap: this.globalTrimMap,
      }
    );
    chunkContainer.add(roadGroup);

    // 2. Constrói Casas, Prédios e Praças Arborizadas da Chunk
    let totalCityProps = 0;
    if (
      this.cityBuilder &&
      (this.renderOptions.showBuildings || this.renderOptions.showParks)
    ) {
      const neighborSegments = this.getNeighborSegments(chunk.cx, chunk.cz);
      const cityResult = this.cityBuilder.buildCityChunk(
        {
          segments: bucket.segments,
          neighborSegments,
          buildings: bucket.buildings,
          parks: bucket.parks,
          trees: bucket.trees,
        },
        {
          showBuildings: this.renderOptions.showBuildings,
          showParks: this.renderOptions.showParks,
          autoFillLots: this.renderOptions.autoFillLots,
        }
      );
      chunkContainer.add(cityResult.group);
      totalCityProps = cityResult.totalCityProps;
    }

    chunkContainer.visible = chunk.active;
    this.chunksRoot.add(chunkContainer);

    chunk.group = chunkContainer;
    chunk.tileCount = totalTiles + totalCityProps;
    chunk.builtSegCount =
      bucket.segments.length + bucket.buildings.length + bucket.parks.length;
    chunk.status = 'ready';

    this.updateChunkBorderVisual(
      chunk,
      chunk.cx === this.currentCenterCx && chunk.cz === this.currentCenterCz
    );
  }

  updateChunkBorderVisual(chunk, isCenter) {
    if (!chunk.borderMesh) {
      const { minX, maxX, minZ, maxZ } = this.chunkBoundsMeters(
        chunk.cx,
        chunk.cz
      );
      const pad = 1.5;
      const pts = [
        new THREE.Vector3(minX + pad, 0.25, minZ + pad),
        new THREE.Vector3(maxX - pad, 0.25, minZ + pad),
        new THREE.Vector3(maxX - pad, 0.25, maxZ - pad),
        new THREE.Vector3(minX + pad, 0.25, maxZ - pad),
        new THREE.Vector3(minX + pad, 0.25, minZ + pad),
      ];
      const geom = new THREE.BufferGeometry().setFromPoints(pts);
      const mat = new THREE.LineBasicMaterial({
        color: 0x38bdf8,
        transparent: true,
        opacity: 0.55,
      });
      chunk.borderMesh = new THREE.Line(geom, mat);
      chunk.borderMesh.frustumCulled = false;
      this.bordersRoot.add(chunk.borderMesh);
    }

    chunk.borderMesh.visible =
      chunk.active &&
      (this.renderOptions.showChunkBorders || chunk.status === 'loading');

    if (chunk.status === 'loading' || chunk.status === 'queued') {
      chunk.borderMesh.material.color.setHex(0xfbbf24);
      chunk.borderMesh.material.opacity = 0.9;
    } else if (isCenter) {
      chunk.borderMesh.material.color.setHex(0xf472b6);
      chunk.borderMesh.material.opacity = 0.85;
    } else {
      chunk.borderMesh.material.color.setHex(0x38bdf8);
      chunk.borderMesh.material.opacity = 0.35;
    }
  }

  setRenderOptions(newOptions) {
    const prevBorders = this.renderOptions.showChunkBorders;
    this.renderOptions = { ...this.renderOptions, ...newOptions };

    if (
      Object.keys(newOptions).length === 1 &&
      newOptions.showChunkBorders !== undefined &&
      prevBorders !== newOptions.showChunkBorders
    ) {
      for (const ch of this.chunks.values()) {
        this.updateChunkBorderVisual(
          ch,
          ch.cx === this.currentCenterCx && ch.cz === this.currentCenterCz
        );
      }
      return;
    }

    this.buildQueue = [];
    for (const ch of this.chunks.values()) {
      if (ch.status === 'ready' && ch.active) {
        this.enqueueChunkBuild(ch);
      }
    }
  }

  setRenderDistance(newRadius) {
    this.renderDistance = newRadius;
    const cx = this.currentCenterCx ?? 0;
    const cz = this.currentCenterCz ?? 0;
    this.updateCameraTarget(cx * CHUNK_SIZE, cz * CHUNK_SIZE, true);
  }

  emitStats() {
    let activeChunks = 0;
    let totalTiles = 0;
    for (const ch of this.chunks.values()) {
      if (ch.active && ch.status === 'ready') {
        activeChunks++;
        totalTiles += ch.tileCount;
      }
    }
    if (this.onStatsChange) {
      this.onStatsChange({
        activeChunks,
        cachedChunks: this.fetchedChunkKeys.size,
        totalTiles,
        centerChunk: `${this.currentCenterCx ?? 0}, ${this.currentCenterCz ?? 0}`,
      });
    }
  }
}
