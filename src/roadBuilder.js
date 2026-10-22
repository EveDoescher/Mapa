import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { normalizeAngle } from './osm.js';

const MODEL_NAMES = [
  'road-straight',
  'road-crossing',
  'road-crossroad',
  'road-crossroad-path',
  'road-intersection',
  'road-intersection-path',
  'road-bend',
  'road-end-round',
  'road-roundabout',
  'road-bridge',
  'bridge-pillar',
  'light-curved',
  'light-square',
  'traffic-light',
  'electricity-pole',
  'road-sign-stop',
  'road-sign-street',
];

export const TILE_SIZE = 12;

// Hierarquia de alturas (CSG via Z-Buffer):
// Garante que onde duas ruas se fundem em Y ou se cruzam, o asfalto SEMPRE cubra o meio-fio interno!
const Y_CURB = 0.15; // Meio-fio externo cinza (0.4 .. 0.5)
const Y_SALMON = 0.18; // Guia interna salmão (0.3 .. 0.4)
const Y_ASPHALT = 0.21; // Pista de asfalto (-0.3 .. +0.3)
const Y_STRIPE = 0.225; // Faixas brancas e faixa de pedestre

export class KenneyRoadBuilder {
  constructor() {
    this.loader = new GLTFLoader();
    this.templates = new Map();
    this.sharedMaterial = null;
    this.paletteUvs = {
      asphalt: [0.28125, 0.875],
      salmon: [0.03125, 0.875],
      curbTop: [0.46875, 0.525],
      curbSide: [0.46875, 0.625],
      whiteLine: [0.40625, 0.875],
    };
  }

  async loadAssets(onProgress) {
    let loaded = 0;
    const promises = MODEL_NAMES.map(async (name) => {
      const gltf = await this.loader.loadAsync(`/models/roads/${name}.glb`);
      const meshes = [];

      gltf.scene.traverse((child) => {
        if (child.isMesh) {
          child.geometry.computeVertexNormals();
          if (child.material && child.material.map) {
            child.material.map.colorSpace = THREE.SRGBColorSpace;
            child.material.map.anisotropy = 8;
            child.material.roughness = 0.85;
            child.material.metalness = 0.05;
            if (!this.sharedMaterial) {
              this.sharedMaterial = child.material;
            }
          }
          meshes.push({
            geometry: child.geometry.clone(),
            material: child.material,
            matrix: child.matrixWorld.clone(),
          });
        }
      });

      if (meshes.length > 0) {
        const first = meshes[0];
        const geom = first.geometry.clone();
        geom.applyMatrix4(first.matrix);
        const needNonIndexed =
          name === 'road-straight' || name === 'road-crossing';
        const nonIndexed = needNonIndexed ? geom.toNonIndexed() : null;

        if (name === 'road-straight' && nonIndexed) {
          this.extractPaletteUvs(
            nonIndexed.attributes.position.array,
            nonIndexed.attributes.uv.array
          );
        }

        let vertexLayers = null;
        if (nonIndexed) {
          vertexLayers = this.classifyTemplateVertices(
            nonIndexed.attributes.position.array,
            nonIndexed.attributes.uv.array
          );
        }

        this.templates.set(name, {
          geometry: geom,
          material: first.material,
          nonIndexedPos: nonIndexed
            ? nonIndexed.attributes.position.array
            : null,
          nonIndexedUv: nonIndexed ? nonIndexed.attributes.uv.array : null,
          vertexLayers,
        });
      }

      loaded++;
      if (onProgress) onProgress(loaded, MODEL_NAMES.length, name);
    });

    await Promise.all(promises);
  }

  extractPaletteUvs(pos, uv) {
    const triCount = pos.length / 9;
    for (let t = 0; t < triCount; t++) {
      const i = t * 9;
      const uvi = t * 6;
      const avgY = (pos[i + 1] + pos[i + 4] + pos[i + 7]) / 3;
      const avgAbsZ =
        (Math.abs(pos[i + 2]) + Math.abs(pos[i + 5]) + Math.abs(pos[i + 8])) /
        3;
      const u = uv[uvi];
      const v = uv[uvi + 1];

      if (avgY > 0.008 && avgAbsZ < 0.009) {
        this.paletteUvs.whiteLine = [u, v];
      } else if (avgY > 0.008 && avgAbsZ > 0.05 && avgAbsZ < 0.25) {
        this.paletteUvs.asphalt = [u, v];
      } else if (
        avgY > 0.008 &&
        avgY < 0.015 &&
        avgAbsZ > 0.31 &&
        avgAbsZ < 0.39
      ) {
        this.paletteUvs.salmon = [u, v];
      } else if (avgY > 0.018 && avgAbsZ > 0.41) {
        this.paletteUvs.curbTop = [u, v];
      }
    }
  }

  /**
   * Classifica cada triângulo do .glb em sua camada de altura CSG:
   * 0 = Base chão (0m), 1 = Calçada cinza (Y_CURB), 2 = Guia salmão (Y_SALMON),
   * 3 = Asfalto (Y_ASPHALT), 4 = Faixa branca/pedestre (Y_STRIPE)
   */
  classifyTemplateVertices(pos, uv) {
    const vertCount = pos.length / 3;
    const layers = new Uint8Array(vertCount);
    const triCount = vertCount / 3;

    for (let t = 0; t < triCount; t++) {
      const i = t * 9;
      const avgAbsZ =
        (Math.abs(pos[i + 2]) + Math.abs(pos[i + 5]) + Math.abs(pos[i + 8])) /
        3;
      const maxY = Math.max(pos[i + 1], pos[i + 4], pos[i + 7]);

      let triLayer = 3; // asphalt default
      if ( avgAbsZ > 0.395 ) {
        triLayer = 1; // outer gray curb
      } else if (avgAbsZ > 0.295) {
        triLayer = 2; // salmon shoulder
      } else {
        // Dentro da pista (-0.3 .. +0.3): checa se é faixa branca/zebra ou asfalto
        const u = uv[t * 6];
        const isWhite = Math.abs(u - this.paletteUvs.whiteLine[0]) < 0.04;
        triLayer = isWhite ? 4 : 3;
      }

      for (let k = 0; k < 3; k++) {
        const vIdx = t * 3 + k;
        const vy = pos[vIdx * 3 + 1];
        if (vy <= 0.001) {
          layers[vIdx] = 0; // base no chão
        } else if (maxY > 0.015 && vy < 0.015 && avgAbsZ > 0.395) {
          layers[vIdx] = 2; // base do degrau interno entre salmão e calçada
        } else {
          layers[vIdx] = triLayer;
        }
      }
    }

    return layers;
  }

  computeNodeTrimMap(nodes) {
    const trimMap = new Map();

    for (const node of nodes) {
      const edges = node.uniqueEdges || [];
      const deg = edges.length;
      const widthScale = this.getNodeScale(edges);
      const worldTileSize = TILE_SIZE * widthScale;

      if (node.tags?.highway === 'mini_roundabout') {
        trimMap.set(node.id, {
          type: 'roundabout',
          radius: worldTileSize * 0.72,
          worldTileSize,
        });
      } else if (deg >= 3) {
        trimMap.set(node.id, {
          type: 'hub',
          radius: 0, // No modo 1B CSG as fitas vão até o nó e se fundem sem buracos!
          instancedRadius: worldTileSize * 0.48,
          worldTileSize,
        });
      } else if (deg === 2) {
        const dir0 = edges[0].angle + Math.PI;
        const dir1 = edges[1].angle;
        const tx = Math.cos(dir0) + Math.cos(dir1);
        const tz = Math.sin(dir0) + Math.sin(dir1);
        const len = Math.hypot(tx, tz) || 1;
        trimMap.set(node.id, {
          type: 'weld',
          radius: 0,
          instancedRadius: 0,
          worldTileSize,
          refAngle: edges[1].angle,
          nx: -tz / len,
          nz: tx / len,
        });
      } else if (deg === 1) {
        trimMap.set(node.id, {
          type: 'deadend',
          radius: worldTileSize * 0.44,
          instancedRadius: worldTileSize * 0.44,
          worldTileSize,
        });
      }
    }

    return trimMap;
  }

  buildRoadScene(graph, options = {}) {
    const {
      mode = 'deformed',
      showProps = true,
      showOsmLines = false,
      sharedNodeTrimMap = null,
    } = options;

    const root = new THREE.Group();
    root.name = 'OSM_Roads_Root';

    const instances = new Map();
    for (const name of MODEL_NAMES) {
      instances.set(name, []);
    }

    const addInstance = (name, position, rotY, scaleVec) => {
      const list = instances.get(name);
      if (!list) return;
      const matrix = new THREE.Matrix4();
      const quat = new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(0, 1, 0),
        rotY
      );
      matrix.compose(position, quat, scaleVec);
      list.push(matrix);
    };

    const nodeTrimMap =
      sharedNodeTrimMap || this.computeNodeTrimMap(graph.nodes);

    const customHubPositions = [];
    const customHubUvs = [];

    for (const node of graph.nodes) {
      const edges = node.uniqueEdges || [];
      const deg = edges.length;
      const info = nodeTrimMap.get(node.id);
      const worldTileSize =
        info?.worldTileSize || TILE_SIZE * this.getNodeScale(edges);

      if (info?.type === 'roundabout') {
        addInstance(
          'road-roundabout',
          new THREE.Vector3(node.x, 0.02, node.z),
          0,
          new THREE.Vector3(
            worldTileSize * 0.55,
            worldTileSize,
            worldTileSize * 0.55
          )
        );
      } else if (deg === 1) {
        const exitAngle = edges[0].angle;
        const seg = edges[0].segment;
        const segLen = seg.totalLen || 20;
        const effTrim = Math.min(info?.radius || 4, segLen * 0.35);
        const w = TILE_SIZE * this.getSegmentScale(seg);
        if (effTrim >= w * 0.25) {
          addInstance(
            'road-end-round',
            new THREE.Vector3(node.x, 0.01, node.z),
            -exitAngle,
            new THREE.Vector3(effTrim * 2.05, w * 1.1, w)
          );
        }
      } else if (mode === 'instanced') {
        if (deg >= 4) {
          const baseAngle = edges[0].angle;
          const hasSignal =
            node.tags?.highway === 'traffic_signals' ||
            edges.some(
              (e) =>
                e.highwayType === 'primary' || e.highwayType === 'secondary'
            );
          addInstance(
            hasSignal ? 'road-crossroad-path' : 'road-crossroad',
            new THREE.Vector3(node.x, 0.015, node.z),
            -baseAngle,
            new THREE.Vector3(worldTileSize, worldTileSize, worldTileSize)
          );
        } else if (deg === 3) {
          const { branchAngle, isMajor } = this.analyzeTJunction(edges);
          addInstance(
            isMajor ? 'road-intersection-path' : 'road-intersection',
            new THREE.Vector3(node.x, 0.012, node.z),
            -branchAngle + Math.PI / 2,
            new THREE.Vector3(worldTileSize, worldTileSize, worldTileSize)
          );
        }
      } else if (mode === 'deformed' && deg >= 2) {
        // Disco concêntrico CSG + Chanfros suaves de esquina (sem jamais criar laços!)
        this.buildCsgJunctionCapAndFillets(
          node,
          customHubPositions,
          customHubUvs
        );

        if (showProps && deg >= 3) {
          const hasSignal =
            node.tags?.highway === 'traffic_signals' ||
            edges.some(
              (e) =>
                e.highwayType === 'primary' || e.highwayType === 'secondary'
            );
          this.placeIntersectionProps(
            node,
            edges[0].angle,
            worldTileSize,
            addInstance,
            hasSignal,
            graph.segments
          );
        }
      }
    }

    let totalSegmentsPlaced = 0;

    if (mode === 'instanced') {
      totalSegmentsPlaced += this.buildInstancedSegments(
        graph.segments,
        nodeTrimMap,
        addInstance,
        showProps
      );
    } else {
      const deformedResult = this.buildDeformedSegments(
        graph.segments,
        nodeTrimMap,
        addInstance,
        showProps,
        customHubPositions,
        customHubUvs
      );
      if (deformedResult.mesh) {
        root.add(deformedResult.mesh);
      }
      totalSegmentsPlaced += deformedResult.count;
    }

    let totalInstances = totalSegmentsPlaced;
    for (const [name, matrices] of instances.entries()) {
      if (matrices.length === 0) continue;
      const tpl = this.templates.get(name);
      if (!tpl) continue;

      const instMesh = new THREE.InstancedMesh(
        tpl.geometry,
        tpl.material,
        matrices.length
      );
      instMesh.name = `Instanced_${name}`;
      instMesh.castShadow = !name.startsWith('road-');
      instMesh.receiveShadow = true;

      for (let i = 0; i < matrices.length; i++) {
        instMesh.setMatrixAt(i, matrices[i]);
      }
      instMesh.instanceMatrix.needsUpdate = true;
      instMesh.frustumCulled = false;
      root.add(instMesh);

      if (mode === 'instanced' || !name.startsWith('road-straight')) {
        totalInstances += matrices.length;
      }
    }

    if (showOsmLines) {
      root.add(this.buildDebugLines(graph.segments));
    }

    return {
      group: root,
      totalTiles: totalInstances,
    };
  }

  /**
   * Gera um disco concêntrico Kenney (Asfalto > Salmão > Calçada Cinza) no nó + chanfros nas esquinas >= 50°.
   * Como Asfalto > Salmão > Calçada no eixo Y, qualquer interseção de qualquer ângulo se funde sem falhas!
   */
  buildCsgJunctionCapAndFillets(node, outPos, outUv) {
    const edges = node.uniqueEdges || [];
    if (edges.length < 2) return;

    const isBridge = edges.some((e) => e.segment.isBridge);
    const yBase = isBridge ? 2.8 : 0;

    let maxW = 0;
    for (const e of edges) {
      const w = TILE_SIZE * this.getSegmentScale(e.segment);
      if (w > maxW) maxW = w;
    }

    const uvAsphalt = this.paletteUvs.asphalt;
    const uvSalmon = this.paletteUvs.salmon;
    const uvCurbTop = this.paletteUvs.curbTop;
    const uvCurbSide = this.paletteUvs.curbSide;

    const pushTriUp = (ax, ay, az, bx, by, bz, cx, cy, cz, uv) => {
      const crossY = (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
      if (crossY > 0) {
        outPos.push(ax, ay, az, cx, cy, cz, bx, by, bz);
      } else {
        outPos.push(ax, ay, az, bx, by, bz, cx, cy, cz);
      }
      outUv.push(uv[0], uv[1], uv[0], uv[1], uv[0], uv[1]);
    };

    const pushWallQuad = (
      ax,
      ay,
      az,
      bx,
      by,
      bz,
      cx,
      cy,
      cz,
      dx,
      dy,
      dz,
      uv
    ) => {
      outPos.push(ax, ay, az, bx, by, bz, cx, cy, cz);
      outPos.push(ax, ay, az, cx, cy, cz, dx, dy, dz);
      outPos.push(ax, ay, az, cx, cy, cz, bx, by, bz);
      outPos.push(ax, ay, az, dx, dy, dz, cx, cy, cz);
      for (let i = 0; i < 12; i++) {
        outUv.push(uv[0], uv[1]);
      }
    };

    // 1. Disco concêntrico de união no centro do nó
    const SEGMENTS = 16;
    const rAsphalt = maxW * 0.3;
    const rSalmon = maxW * 0.4;
    const rCurb = maxW * 0.5;

    const y0 = yBase;
    const yCurb = yBase + Y_CURB;
    const ySalmon = yBase + Y_SALMON;
    const yAsphalt = yBase + Y_ASPHALT;

    for (let i = 0; i < SEGMENTS; i++) {
      const a0 = (i / SEGMENTS) * Math.PI * 2;
      const a1 = ((i + 1) / SEGMENTS) * Math.PI * 2;
      const c0 = Math.cos(a0);
      const s0 = Math.sin(a0);
      const c1 = Math.cos(a1);
      const s1 = Math.sin(a1);

      // Círculo de Asfalto (0 .. 0.3 W)
      pushTriUp(
        node.x,
        yAsphalt,
        node.z,
        node.x + c0 * rAsphalt,
        yAsphalt,
        node.z + s0 * rAsphalt,
        node.x + c1 * rAsphalt,
        yAsphalt,
        node.z + s1 * rAsphalt,
        uvAsphalt
      );

      // Anel Salmão (0.3 W .. 0.4 W)
      pushTriUp(
        node.x + c0 * rAsphalt,
        ySalmon,
        node.z + s0 * rAsphalt,
        node.x + c0 * rSalmon,
        ySalmon,
        node.z + s0 * rSalmon,
        node.x + c1 * rSalmon,
        ySalmon,
        node.z + s1 * rSalmon,
        uvSalmon
      );
      pushTriUp(
        node.x + c0 * rAsphalt,
        ySalmon,
        node.z + s0 * rAsphalt,
        node.x + c1 * rSalmon,
        ySalmon,
        node.z + s1 * rSalmon,
        node.x + c1 * rAsphalt,
        ySalmon,
        node.z + s1 * rAsphalt,
        uvSalmon
      );

      // Anel Calçada Cinza (0.4 W .. 0.5 W)
      pushTriUp(
        node.x + c0 * rSalmon,
        yCurb,
        node.z + s0 * rSalmon,
        node.x + c0 * rCurb,
        yCurb,
        node.z + s0 * rCurb,
        node.x + c1 * rCurb,
        yCurb,
        node.z + s1 * rCurb,
        uvCurbTop
      );
      pushTriUp(
        node.x + c0 * rSalmon,
        yCurb,
        node.z + s0 * rSalmon,
        node.x + c1 * rCurb,
        yCurb,
        node.z + s1 * rCurb,
        node.x + c1 * rSalmon,
        yCurb,
        node.z + s1 * rCurb,
        uvCurbTop
      );

      // Parede externa da calçada até o chão
      pushWallQuad(
        node.x + c0 * rCurb,
        yCurb,
        node.z + s0 * rCurb,
        node.x + c0 * rCurb,
        y0,
        node.z + s0 * rCurb,
        node.x + c1 * rCurb,
        y0,
        node.z + s1 * rCurb,
        node.x + c1 * rCurb,
        yCurb,
        node.z + s1 * rCurb,
        uvCurbSide
      );
    }

    // 2. Chanfro suave nas esquinas de cruzamentos (apenas para ângulos entre 55° e 145°)
    if (edges.length >= 3) {
      for (let k = 0; k < edges.length; k++) {
        const e0 = edges[k];
        const e1 = edges[(k + 1) % edges.length];
        let diff = normalizeAngle(e1.angle - e0.angle);
        if (diff < 0) diff += Math.PI * 2;

        if (diff >= 0.95 && diff <= 2.55) {
          const w0 = TILE_SIZE * this.getSegmentScale(e0.segment);
          const w1 = TILE_SIZE * this.getSegmentScale(e1.segment);
          const wAvg = (w0 + w1) * 0.5;
          const dist = wAvg * 0.62;

          const p0x = node.x + Math.cos(e0.angle) * dist;
          const p0z = node.z + Math.sin(e0.angle) * dist;
          const p1x = node.x + Math.cos(e1.angle) * dist;
          const p1z = node.z + Math.sin(e1.angle) * dist;

          // Preenche o triângulo interno de esquina com asfalto para arredondar a conversão
          const n0x = -Math.sin(e0.angle);
          const n0z = Math.cos(e0.angle);
          const n1x = -Math.sin(e1.angle);
          const n1z = Math.cos(e1.angle);

          pushTriUp(
            node.x,
            yAsphalt,
            node.z,
            p0x + n0x * (0.3 * w0),
            yAsphalt,
            p0z + n0z * (0.3 * w0),
            p1x - n1x * (0.3 * w1),
            yAsphalt,
            p1z - n1z * (0.3 * w1),
            uvAsphalt
          );
          pushTriUp(
            node.x,
            ySalmon,
            node.z,
            p0x + n0x * (0.4 * w0),
            ySalmon,
            p0z + n0z * (0.4 * w0),
            p1x - n1x * (0.4 * w1),
            ySalmon,
            p1z - n1z * (0.4 * w1),
            uvSalmon
          );
          pushTriUp(
            node.x,
            yCurb,
            node.z,
            p0x + n0x * (0.5 * w0),
            yCurb,
            p0z + n0z * (0.5 * w0),
            p1x - n1x * (0.5 * w1),
            yCurb,
            p1z - n1z * (0.5 * w1),
            uvCurbTop
          );
        }
      }
    }
  }

  buildInstancedSegments(segments, nodeTrimMap, addInstance, showProps) {
    let count = 0;

    for (const seg of segments) {
      const widthScale = this.getSegmentScale(seg);
      const tileWidth = TILE_SIZE * widthScale;

      const sInfo = nodeTrimMap.get(seg.startNode.id);
      const eInfo = nodeTrimMap.get(seg.endNode.id);
      const trimStart = Math.min(
        sInfo?.instancedRadius || 0,
        (seg.totalLen || 20) * 0.35
      );
      const trimEnd = Math.min(
        eInfo?.instancedRadius || 0,
        (seg.totalLen || 20) * 0.35
      );

      const trimmedPts = this.trimPolyline(seg.points, trimStart, trimEnd);
      if (trimmedPts.length < 2) continue;

      let accumulatedLampDist = 0;
      let lampSide = 1;

      for (let i = 0; i < trimmedPts.length - 1; i++) {
        const p0 = trimmedPts[i];
        const p1 = trimmedPts[i + 1];
        const dx = p1.x - p0.x;
        const dz = p1.z - p0.z;
        const segLen = Math.hypot(dx, dz);
        if (segLen < 0.8) continue;

        const dir = Math.atan2(dz, dx);
        const rotY = -dir;

        const numTiles = Math.max(1, Math.round(segLen / tileWidth));
        const stepLen = segLen / numTiles;
        const yBase = seg.isBridge ? 2.8 : 0;

        for (let t = 0; t < numTiles; t++) {
          const frac = (t + 0.5) / numTiles;
          const cx = p0.x + dx * frac;
          const cz = p0.z + dz * frac;

          const isNearJunction =
            (i === 0 && t === 0 && trimStart > 0 && numTiles >= 3) ||
            (i === trimmedPts.length - 2 &&
              t === numTiles - 1 &&
              trimEnd > 0 &&
              numTiles >= 3);

          let modelName = 'road-straight';
          if (seg.isBridge) {
            modelName = 'road-bridge';
          } else if (isNearJunction) {
            modelName = 'road-crossing';
          }

          addInstance(
            modelName,
            new THREE.Vector3(cx, yBase, cz),
            rotY,
            new THREE.Vector3(stepLen * 1.03, tileWidth, tileWidth)
          );
          count++;

          if (seg.isBridge && t % 2 === 0) {
            addInstance(
              'bridge-pillar',
              new THREE.Vector3(cx, 0, cz),
              rotY,
              new THREE.Vector3(tileWidth, yBase, tileWidth)
            );
          }

          accumulatedLampDist += stepLen;
          if (
            showProps &&
            !seg.isBridge &&
            accumulatedLampDist >= tileWidth * 1.8
          ) {
            accumulatedLampDist = 0;
            this.placeRoadsideProp(
              cx,
              cz,
              dir,
              tileWidth,
              lampSide,
              seg,
              segments,
              addInstance
            );
            lampSide *= -1;
          }
        }
      }
    }

    return count;
  }

  /**
   * Modo 1B: Malha contínua deformada a partir do road-straight.glb e road-crossing.glb
   * com camadas de altura CSG para fusão limpa em qualquer ângulo!
   */
  buildDeformedSegments(
    segments,
    nodeTrimMap,
    addInstance,
    showProps,
    hubPositions = [],
    hubUvs = []
  ) {
    const straightTpl = this.templates.get('road-straight');
    const crossingTpl = this.templates.get('road-crossing') || straightTpl;
    if (!straightTpl || !straightTpl.nonIndexedPos) {
      return { mesh: null, count: 0 };
    }

    const straightPos = straightTpl.nonIndexedPos;
    const straightUv = straightTpl.nonIndexedUv;
    const straightLayers = straightTpl.vertexLayers;
    const straightVerts = straightPos.length / 3;

    const crossingPos = crossingTpl.nonIndexedPos || straightPos;
    const crossingUv = crossingTpl.nonIndexedUv || straightUv;
    const crossingLayers = crossingTpl.vertexLayers || straightLayers;
    const crossingVerts = crossingPos.length / 3;

    const preparedSegments = [];
    let totalStraightSlices = 0;
    let totalCrossingSlices = 0;

    for (const seg of segments) {
      const widthScale = this.getSegmentScale(seg);
      const tileWidth = TILE_SIZE * widthScale;

      const startInfo = nodeTrimMap.get(seg.startNode.id);
      const endInfo = nodeTrimMap.get(seg.endNode.id);

      // Apenas ruas sem saída recuam para encaixar o road-end-round.glb;
      // nos cruzamentos a fita vai até o centro do nó para nunca abrir frestas!
      const trimStart =
        startInfo?.type === 'deadend'
          ? Math.min(startInfo.radius, (seg.totalLen || 20) * 0.35)
          : 0;
      const trimEnd =
        endInfo?.type === 'deadend'
          ? Math.min(endInfo.radius, (seg.totalLen || 20) * 0.35)
          : 0;

      const trimmedPts = this.trimPolyline(seg.points, trimStart, trimEnd);
      if (trimmedPts.length < 2) continue;

      const frames = this.sampleSmoothFrames(
        trimmedPts,
        tileWidth * 0.8,
        startInfo,
        endInfo
      );
      if (frames.length < 2) continue;

      const numSlices = frames.length - 1;
      const canHaveCrosswalk =
        !seg.isBridge &&
        seg.highwayType !== 'service' &&
        numSlices >= 4;

      // Coloca a faixa de pedestre na fatia 1 (logo antes do cruzamento) e numSlices - 2
      const crossStartIdx =
        canHaveCrosswalk && startInfo?.type === 'hub' ? 1 : -1;
      const crossEndIdx =
        canHaveCrosswalk && endInfo?.type === 'hub' ? numSlices - 2 : -1;

      for (let i = 0; i < numSlices; i++) {
        if (i === crossStartIdx || i === crossEndIdx) {
          totalCrossingSlices++;
        } else {
          totalStraightSlices++;
        }
      }

      preparedSegments.push({
        seg,
        frames,
        tileWidth,
        startInfo,
        endInfo,
        crossStartIdx,
        crossEndIdx,
      });
    }

    const hubVertCount = hubPositions.length / 3;
    const totalVerts =
      totalStraightSlices * straightVerts +
      totalCrossingSlices * crossingVerts +
      hubVertCount;

    if (totalVerts === 0) return { mesh: null, count: 0 };

    const allPositions = new Float32Array(totalVerts * 3);
    const allUvs = new Float32Array(totalVerts * 2);

    allPositions.set(hubPositions, 0);
    allUvs.set(hubUvs, 0);

    let posOffset = hubPositions.length;
    let uvOffset = hubUvs.length;

    for (let sIdx = 0; sIdx < preparedSegments.length; sIdx++) {
      const {
        seg,
        frames,
        tileWidth,
        startInfo,
        endInfo,
        crossStartIdx,
        crossEndIdx,
      } = preparedSegments[sIdx];

      const yOffset = seg.isBridge ? 2.8 : 0;
      // Micro-offset determinístico por segmento para evitar Z-fighting de mesma cor
      const microBias = (sIdx % 11) * 0.00015;
      const numSlices = frames.length - 1;

      for (let i = 0; i < numSlices; i++) {
        const f0 = frames[i];
        const f1 = frames[i + 1];
        const dx = f1.x - f0.x;
        const dz = f1.z - f0.z;
        const dnx = f1.nx - f0.nx;
        const dnz = f1.nz - f0.nz;

        const isCrossing = i === crossStartIdx || i === crossEndIdx;
        const srcPos = isCrossing ? crossingPos : straightPos;
        const srcUv = isCrossing ? crossingUv : straightUv;
        const srcLayers = isCrossing ? crossingLayers : straightLayers;
        const vCount = isCrossing ? crossingVerts : straightVerts;

        // Oculta a faixa branca central exatamente sobre o núcleo do cruzamento (i=0 ou i=numSlices-1)
        const hideCenterStripe =
          !isCrossing &&
          ((i === 0 && startInfo?.type === 'hub') ||
            (i === numSlices - 1 && endInfo?.type === 'hub'));

        for (let v = 0; v < vCount; v++) {
          const v3 = v * 3;
          const v2 = v * 2;
          const vx = srcPos[v3];
          const vz = srcPos[v3 + 2];
          const layer = srcLayers[v];

          const t = vx + 0.5;
          const cx = f0.x + dx * t;
          const cz = f0.z + dz * t;
          const nx = f0.nx + dnx * t;
          const nz = f0.nz + dnz * t;
          const latOffset = vz * tileWidth;

          let wy = yOffset;
          if (layer === 1) {
            wy += Y_CURB + microBias;
          } else if (layer === 2) {
            wy += Y_SALMON + microBias;
          } else if (layer === 3) {
            wy += Y_ASPHALT + microBias;
          } else if (layer === 4) {
            wy += (hideCenterStripe ? Y_ASPHALT - 0.005 : Y_STRIPE) + microBias;
          }

          allPositions[posOffset++] = cx + nx * latOffset;
          allPositions[posOffset++] = wy;
          allPositions[posOffset++] = cz + nz * latOffset;

          allUvs[uvOffset++] = srcUv[v2];
          allUvs[uvOffset++] = srcUv[v2 + 1];
        }

        if (seg.isBridge && i % 2 === 0) {
          const dir = Math.atan2(dz, dx);
          addInstance(
            'bridge-pillar',
            new THREE.Vector3((f0.x + f1.x) * 0.5, 0, (f0.z + f1.z) * 0.5),
            -dir,
            new THREE.Vector3(tileWidth, yOffset, tileWidth)
          );
        }

        if (
          showProps &&
          !seg.isBridge &&
          i >= 1 &&
          i < numSlices - 1 &&
          i % 2 === 1
        ) {
          const dir = Math.atan2(dz, dx);
          const side = i % 4 === 1 ? 1 : -1;
          this.placeRoadsideProp(
            (f0.x + f1.x) * 0.5,
            (f0.z + f1.z) * 0.5,
            dir,
            tileWidth,
            side,
            seg,
            segments,
            addInstance
          );
        }
      }
    }

    const mergedGeom = new THREE.BufferGeometry();
    mergedGeom.setAttribute(
      'position',
      new THREE.BufferAttribute(allPositions, 3)
    );
    mergedGeom.setAttribute('uv', new THREE.BufferAttribute(allUvs, 2));
    mergedGeom.computeVertexNormals();

    const mesh = new THREE.Mesh(mergedGeom, straightTpl.material);
    mesh.name = 'Deformed_Kenney_Roads';
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;

    return {
      mesh,
      count: totalStraightSlices + totalCrossingSlices,
    };
  }

  /**
   * Verifica se um ponto (px, pz) invade a pista de outra rua próxima (evita postes no meio de junções em Y!)
   */
  isPointInsideOtherRoad(px, pz, ownerSeg, allSegments) {
    for (const other of allSegments) {
      if (other === ownerSeg) continue;
      const otherW = TILE_SIZE * this.getSegmentScale(other);
      const minAllowedDist = otherW * 0.43;

      const pts = other.points;
      for (let i = 0; i < pts.length - 1; i++) {
        const ax = pts[i].x;
        const az = pts[i].z;
        const bx = pts[i + 1].x;
        const bz = pts[i + 1].z;

        const abx = bx - ax;
        const abz = bz - az;
        const lenSq = abx * abx + abz * abz;
        let t = 0;
        if (lenSq > 0.01) {
          t = Math.max(
            0,
            Math.min(1, ((px - ax) * abx + (pz - az) * abz) / lenSq)
          );
        }
        const cx = ax + abx * t;
        const cz = az + abz * t;
        if (Math.hypot(px - cx, pz - cz) < minAllowedDist) {
          return true;
        }
      }
    }
    return false;
  }

  placeRoadsideProp(
    cx,
    cz,
    roadDir,
    tileWidth,
    side,
    seg,
    allSegments,
    addInstance
  ) {
    const nx = -Math.sin(roadDir) * side;
    const nz = Math.cos(roadDir) * side;

    const curbDist = tileWidth * 0.44;
    const px = cx + nx * curbDist;
    const pz = cz + nz * curbDist;

    if (this.isPointInsideOtherRoad(px, pz, seg, allSegments)) {
      return;
    }

    const propRotY = side === 1 ? -roadDir : -roadDir + Math.PI;
    const propScale = tileWidth * 0.95;

    let propModel = 'light-curved';
    if (seg.highwayType === 'primary' || seg.highwayType === 'trunk') {
      propModel = 'light-square';
    } else if (
      seg.highwayType === 'residential' &&
      Math.abs(Math.sin(cx)) < 0.3
    ) {
      propModel = 'electricity-pole';
    }

    addInstance(
      propModel,
      new THREE.Vector3(px, Y_CURB, pz),
      propRotY,
      new THREE.Vector3(propScale, propScale, propScale)
    );
  }

  placeIntersectionProps(
    node,
    refAngle,
    worldTileSize,
    addInstance,
    hasTrafficLight,
    allSegments = []
  ) {
    const cornerDist = worldTileSize * 0.56;
    const propScale = worldTileSize * 0.95;

    const c1Angle = refAngle + Math.PI * 0.3;
    const x1 = node.x + Math.cos(c1Angle) * cornerDist;
    const z1 = node.z + Math.sin(c1Angle) * cornerDist;

    if (!this.isPointInsideOtherRoad(x1, z1, null, allSegments)) {
      addInstance(
        hasTrafficLight ? 'traffic-light' : 'road-sign-stop',
        new THREE.Vector3(x1, Y_CURB, z1),
        -refAngle,
        new THREE.Vector3(propScale, propScale, propScale)
      );
    }

    const c2Angle = refAngle - Math.PI * 0.7;
    const x2 = node.x + Math.cos(c2Angle) * cornerDist;
    const z2 = node.z + Math.sin(c2Angle) * cornerDist;

    if (!this.isPointInsideOtherRoad(x2, z2, null, allSegments)) {
      addInstance(
        'road-sign-street',
        new THREE.Vector3(x2, Y_CURB, z2),
        -refAngle + Math.PI,
        new THREE.Vector3(propScale, propScale, propScale)
      );
    }
  }

  analyzeTJunction(edges) {
    let bestPair = [0, 1];
    let bestDiffFromPi = Infinity;

    for (let i = 0; i < 3; i++) {
      for (let j = i + 1; j < 3; j++) {
        const diff = Math.abs(normalizeAngle(edges[i].angle - edges[j].angle));
        const err = Math.abs(Math.PI - diff);
        if (err < bestDiffFromPi) {
          bestDiffFromPi = err;
          bestPair = [i, j];
        }
      }
    }

    const branchIdx = [0, 1, 2].find((idx) => !bestPair.includes(idx)) ?? 2;
    const isMajor = edges.some(
      (e) => e.highwayType === 'primary' || e.highwayType === 'secondary'
    );

    return {
      branchAngle: edges[branchIdx].angle,
      isMajor,
    };
  }

  getSegmentScale(seg) {
    let base = this.getHighwayScale(seg.highwayType);
    // Pistas de mão única (avenidas divididas, alças de acesso) são mais estreitas para preservar o canteiro central!
    if (seg.isOneway) {
      base *= 0.74;
    }
    return base;
  }

  getHighwayScale(highwayType) {
    if (highwayType && highwayType.endsWith('_link')) {
      return 0.72;
    }
    switch (highwayType) {
      case 'motorway':
      case 'trunk':
      case 'primary':
        return 1.08;
      case 'secondary':
      case 'tertiary':
        return 0.94;
      case 'service':
      case 'living_street':
        return 0.68;
      default:
        return 0.84;
    }
  }

  getNodeScale(edges) {
    let maxScale = 0.7;
    for (const e of edges) {
      const s = e.segment
        ? this.getSegmentScale(e.segment)
        : this.getHighwayScale(e.highwayType);
      if (s > maxScale) maxScale = s;
    }
    return maxScale;
  }

  trimPolyline(points, trimStart, trimEnd) {
    if (points.length < 2) return [];
    let pts = points.map((p) => ({ x: p.x, z: p.z }));

    let remStart = trimStart;
    while (remStart > 0 && pts.length >= 2) {
      const d = Math.hypot(pts[1].x - pts[0].x, pts[1].z - pts[0].z);
      if (d <= remStart && pts.length > 2) {
        remStart -= d;
        pts.shift();
      } else {
        const r = Math.min(0.9, remStart / (d || 1));
        pts[0] = {
          x: pts[0].x + (pts[1].x - pts[0].x) * r,
          z: pts[0].z + (pts[1].z - pts[0].z) * r,
        };
        remStart = 0;
      }
    }

    let remEnd = trimEnd;
    while (remEnd > 0 && pts.length >= 2) {
      const last = pts.length - 1;
      const d = Math.hypot(
        pts[last].x - pts[last - 1].x,
        pts[last].z - pts[last - 1].z
      );
      if (d <= remEnd && pts.length > 2) {
        remEnd -= d;
        pts.pop();
      } else {
        const r = Math.min(0.9, remEnd / (d || 1));
        pts[last] = {
          x: pts[last].x + (pts[last - 1].x - pts[last].x) * r,
          z: pts[last].z + (pts[last - 1].z - pts[last].z) * r,
        };
        remEnd = 0;
      }
    }

    return pts;
  }

  sampleSmoothFrames(points, stepSize, startInfo = null, endInfo = null) {
    const sampled = [{ x: points[0].x, z: points[0].z }];
    for (let i = 0; i < points.length - 1; i++) {
      const p0 = points[i];
      const p1 = points[i + 1];
      const d = Math.hypot(p1.x - p0.x, p1.z - p0.z);
      const steps = Math.max(1, Math.round(d / stepSize));
      for (let s = 1; s <= steps; s++) {
        const t = s / steps;
        sampled.push({
          x: p0.x + (p1.x - p0.x) * t,
          z: p0.z + (p1.z - p0.z) * t,
        });
      }
    }

    const frames = [];
    for (let i = 0; i < sampled.length; i++) {
      let tx = 0;
      let tz = 0;

      if (i > 0) {
        const dx = sampled[i].x - sampled[i - 1].x;
        const dz = sampled[i].z - sampled[i - 1].z;
        const l = Math.hypot(dx, dz) || 1;
        tx += dx / l;
        tz += dz / l;
      }
      if (i < sampled.length - 1) {
        const dx = sampled[i + 1].x - sampled[i].x;
        const dz = sampled[i + 1].z - sampled[i].z;
        const l = Math.hypot(dx, dz) || 1;
        tx += dx / l;
        tz += dz / l;
      }

      const tl = Math.hypot(tx, tz) || 1;
      tx /= tl;
      tz /= tl;

      let nx = -tz;
      let nz = tx;

      if (i === 0 && startInfo?.type === 'weld') {
        const segDir = Math.atan2(tz, tx);
        const sameDir =
          Math.abs(normalizeAngle(segDir - startInfo.refAngle)) < Math.PI * 0.5;
        nx = sameDir ? startInfo.nx : -startInfo.nx;
        nz = sameDir ? startInfo.nz : -startInfo.nz;
      } else if (i === sampled.length - 1 && endInfo?.type === 'weld') {
        const segDir = Math.atan2(tz, tx);
        const sameDir =
          Math.abs(normalizeAngle(segDir - endInfo.refAngle)) < Math.PI * 0.5;
        nx = sameDir ? endInfo.nx : -endInfo.nx;
        nz = sameDir ? endInfo.nz : -endInfo.nz;
      }

      frames.push({
        x: sampled[i].x,
        z: sampled[i].z,
        nx,
        nz,
      });
    }

    return frames;
  }

  buildDebugLines(segments) {
    const positions = [];
    for (const seg of segments) {
      for (let i = 0; i < seg.points.length - 1; i++) {
        const a = seg.points[i];
        const b = seg.points[i + 1];
        positions.push(a.x, 0.65, a.z, b.x, 0.65, b.z);
      }
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(positions, 3)
    );
    const mat = new THREE.LineBasicMaterial({ color: 0x0284c7 });
    const lines = new THREE.LineSegments(geom, mat);
    lines.frustumCulled = false;
    return lines;
  }
}
