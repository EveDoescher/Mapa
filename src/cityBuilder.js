import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { TILE_SIZE } from './roadBuilder.js';

const SUBURBAN_HOUSES = [
  'suburban/building-type-a',
  'suburban/building-type-b',
  'suburban/building-type-c',
  'suburban/building-type-d',
  'suburban/building-type-e',
  'suburban/building-type-f',
  'suburban/building-type-g',
  'suburban/building-type-h',
  'suburban/building-type-i',
  'suburban/building-type-j',
  'suburban/building-type-k',
  'suburban/building-type-l',
];

const COMMERCIAL_BUILDINGS = [
  'commercial/building-a',
  'commercial/building-b',
  'commercial/building-c',
  'commercial/building-d',
  'commercial/building-e',
  'commercial/building-f',
  'commercial/building-g',
  'commercial/building-h',
  'commercial/building-i',
  'commercial/building-j',
];

const SKYSCRAPERS = [
  'commercial/building-skyscraper-a',
  'commercial/building-skyscraper-b',
  'commercial/building-skyscraper-c',
  'commercial/building-skyscraper-d',
];

const INDUSTRIAL_BUILDINGS = [
  'industrial/building-a',
  'industrial/building-b',
  'industrial/building-c',
  'industrial/building-d',
];

const NATURE_PROPS = [
  'suburban/tree-large',
  'suburban/tree-small',
  'nature/tree_oak',
  'nature/tree_detailed',
  'nature/tree_palmTall',
  'nature/tree_pineRoundA',
  'nature/plant_bushDetailed',
  'nature/flower_redA',
  'nature/flower_yellowA',
  'nature/flower_purpleA',
  'nature/rock_smallA',
  'nature/statue_obelisk',
  'nature/path_stoneCircle',
];

const ALL_CITY_MODELS = [
  ...SUBURBAN_HOUSES,
  ...COMMERCIAL_BUILDINGS,
  ...SKYSCRAPERS,
  ...INDUSTRIAL_BUILDINGS,
  ...NATURE_PROPS,
];

export class KenneyCityBuilder {
  constructor(roadBuilder) {
    this.roadBuilder = roadBuilder;
    this.loader = new GLTFLoader();
    this.templates = new Map();

    // Materiais para o piso das praças/parques
    this.parkGrassMaterial = new THREE.MeshStandardMaterial({
      color: 0x74c69d,
      roughness: 0.92,
      metalness: 0.02,
      side: THREE.DoubleSide,
    });
    this.parkBorderMaterial = new THREE.MeshStandardMaterial({
      color: 0xcbd5e1,
      roughness: 0.85,
      metalness: 0.05,
    });
  }

  async loadAssets(onProgress) {
    let loaded = 0;
    const promises = ALL_CITY_MODELS.map(async (modelPath) => {
      try {
        const gltf = await this.loader.loadAsync(`/models/${modelPath}.glb`);
        const parts = [];

        gltf.scene.updateMatrixWorld(true);
        gltf.scene.traverse((child) => {
          if (child.isMesh) {
            const geom = child.geometry.clone();
            geom.applyMatrix4(child.matrixWorld);
            geom.computeVertexNormals();

            if (child.material) {
              const mats = Array.isArray(child.material)
                ? child.material
                : [child.material];
              for (const m of mats) {
                if (m.map) {
                  m.map.colorSpace = THREE.SRGBColorSpace;
                  m.map.anisotropy = 8;
                }
                m.roughness = 0.85;
                m.metalness = 0.05;
              }
            }

            parts.push({
              geometry: geom,
              material: child.material,
            });
          }
        });

        if (parts.length > 0) {
          this.templates.set(modelPath, parts);
        }
      } catch (err) {
        console.warn(`Aviso: falha ao carregar /models/${modelPath}.glb`, err);
      }

      loaded++;
      if (onProgress) onProgress(loaded, ALL_CITY_MODELS.length, modelPath);
    });

    await Promise.all(promises);
  }

  /**
   * Constrói casas, prédios, praças arborizadas e árvores para uma chunk
   */
  buildCityChunk(chunkData, options = {}) {
    const {
      showBuildings = true,
      showParks = true,
      autoFillLots = true,
    } = options;

    const root = new THREE.Group();
    root.name = 'OSM_City_Root';

    const instances = new Map();
    for (const key of ALL_CITY_MODELS) {
      instances.set(key, []);
    }

    const addInstance = (key, position, rotY, scaleVec) => {
      const list = instances.get(key);
      if (!list) return;
      const matrix = new THREE.Matrix4();
      const quat = new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(0, 1, 0),
        rotY
      );
      matrix.compose(position, quat, scaleVec);
      list.push(matrix);
    };

    const segments = chunkData.neighborSegments || chunkData.segments || [];
    const parks = chunkData.parks || [];
    const buildings = chunkData.buildings || [];
    const trees = chunkData.trees || [];

    // Lista de círculos ocupados (x, z, r) para evitar sobreposição entre casas/árvores
    const occupied = [];

    // 1. Praças e Parques Arborizados (OSM leisure=park, landuse=grass, etc.)
    if (showParks) {
      for (const park of parks) {
        const parkMesh = this.buildParkSurface(park);
        if (parkMesh) root.add(parkMesh);
        this.populateParkProps(park, segments, occupied, addInstance);
      }

      // Árvores individuais mapeadas no OSM (natural=tree)
      for (const tree of trees) {
        if (!this.isNearAnyRoad(tree.x, tree.z, 5.5, segments)) {
          const treeKey = this.pickDeterministic(
            [
              'nature/tree_oak',
              'nature/tree_detailed',
              'suburban/tree-large',
              'nature/tree_palmTall',
            ],
            tree.x,
            tree.z
          );
          const s = 9 + (Math.abs(Math.sin(tree.x * 0.3)) * 4);
          addInstance(
            treeKey,
            new THREE.Vector3(tree.x, 0.05, tree.z),
            (tree.x + tree.z) % (Math.PI * 2),
            new THREE.Vector3(s, s, s)
          );
          occupied.push({ x: tree.x, z: tree.z, r: 3.5 });
        }
      }
    }

    // 2. Prédios e Casas mapeados diretamente no OSM (way["building"])
    if (showBuildings) {
      for (const bld of buildings) {
        this.placeOsmBuilding(bld, segments, parks, occupied, addInstance);
      }

      // 3. Auto-Loteamento Inteligente nas ruas onde o OSM não mapeou casas individuais
      if (autoFillLots) {
        this.populateProceduralStreetLots(
          chunkData.segments || [],
          segments,
          parks,
          occupied,
          addInstance
        );
      }
    }

    // 4. Gera os InstancedMeshes para cada peça 3D utilizada
    let totalPlaced = 0;
    for (const [key, matrices] of instances.entries()) {
      if (matrices.length === 0) continue;
      const parts = this.templates.get(key);
      if (!parts) continue;

      totalPlaced += matrices.length;

      for (let p = 0; p < parts.length; p++) {
        const part = parts[p];
        const instMesh = new THREE.InstancedMesh(
          part.geometry,
          part.material,
          matrices.length
        );
        instMesh.name = `CityInst_${key}_${p}`;
        instMesh.castShadow = true;
        instMesh.receiveShadow = true;
        instMesh.frustumCulled = false;

        for (let i = 0; i < matrices.length; i++) {
          instMesh.setMatrixAt(i, matrices[i]);
        }
        instMesh.instanceMatrix.needsUpdate = true;
        root.add(instMesh);
      }
    }

    return {
      group: root,
      totalCityProps: totalPlaced,
    };
  }

  /**
   * Cria a base 3D gramada da praça/parque seguindo o polígono real do OSM
   */
  buildParkSurface(park) {
    const pts = park.points;
    if (pts.length < 3) return null;

    // Shape 2D no plano (X, -Z) para que ao rotacionar X em -PI/2 fique em (X, Z)
    const shape = new THREE.Shape();
    shape.moveTo(pts[0].x, -pts[0].z);
    for (let i = 1; i < pts.length; i++) {
      shape.lineTo(pts[i].x, -pts[i].z);
    }
    shape.closePath();

    const geom = new THREE.ExtrudeGeometry(shape, {
      depth: 0.08,
      bevelEnabled: true,
      bevelThickness: 0.03,
      bevelSize: 0.25,
      bevelSegments: 1,
    });
    geom.rotateX(-Math.PI / 2);

    const mesh = new THREE.Mesh(geom, this.parkGrassMaterial);
    mesh.position.y = 0.01;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    return mesh;
  }

  /**
   * Popula o interior de uma praça/parque com árvores, arbustos, flores, pedras e coreto/monumento central
   */
  populateParkProps(park, segments, occupied, addInstance) {
    const { cx, cz, minX, maxX, minZ, maxZ, area, points } = park;

    // Se for uma praça relevante (> 800m²) e o centro estiver livre de ruas, coloca monumento + piso de pedra
    if (
      area > 800 &&
      this.isPointInPolygon(cx, cz, points) &&
      !this.isNearAnyRoad(cx, cz, 8, segments)
    ) {
      addInstance(
        'nature/path_stoneCircle',
        new THREE.Vector3(cx, 0.12, cz),
        0,
        new THREE.Vector3(10, 8, 10)
      );
      addInstance(
        'nature/statue_obelisk',
        new THREE.Vector3(cx, 0.14, cz),
        0,
        new THREE.Vector3(9, 9, 9)
      );
      occupied.push({ x: cx, z: cz, r: 7 });
    }

    // Amostragem em grade com jitter determinístico dentro do polígono da praça
    const step = area > 8000 ? 15 : 11;
    const treeModels = [
      'nature/tree_oak',
      'nature/tree_detailed',
      'nature/tree_palmTall',
      'nature/tree_pineRoundA',
      'suburban/tree-large',
      'suburban/tree-small',
    ];
    const detailModels = [
      'nature/plant_bushDetailed',
      'nature/flower_redA',
      'nature/flower_yellowA',
      'nature/flower_purpleA',
      'nature/rock_smallA',
    ];

    for (let x = minX + 4; x <= maxX - 4; x += step) {
      for (let z = minZ + 4; z <= maxZ - 4; z += step) {
        const hash = this.hash2D(x, z);
        const px = x + (hash - 0.5) * (step * 0.65);
        const pz = z + (((hash * 17) % 1) - 0.5) * (step * 0.65);

        if (!this.isPointInPolygon(px, pz, points)) continue;
        if (this.isNearAnyRoad(px, pz, 6.8, segments)) continue;
        if (this.isOverlappingOccupied(px, pz, 3.2, occupied)) continue;

        const rotY = hash * Math.PI * 2;

        if (hash < 0.62) {
          // Árvore
          const model = this.pickDeterministic(treeModels, px, pz);
          const isSuburbanTree = model.startsWith('suburban/');
          const scale = isSuburbanTree
            ? 11 + (hash * 4)
            : 7.5 + (hash * 3.5);
          addInstance(
            model,
            new THREE.Vector3(px, 0.11, pz),
            rotY,
            new THREE.Vector3(scale, scale, scale)
          );
          occupied.push({ x: px, z: pz, r: 3.8 });
        } else {
          // Arbusto / Flores / Pedra de jardim
          const model = this.pickDeterministic(detailModels, px, pz);
          const scale = 6.5 + (hash * 2.5);
          addInstance(
            model,
            new THREE.Vector3(px, 0.11, pz),
            rotY,
            new THREE.Vector3(scale, scale, scale)
          );
          occupied.push({ x: px, z: pz, r: 2.2 });
        }
      }
    }
  }

  /**
   * Posiciona um prédio/casa real do OSM virado de frente para a rua mais próxima
   */
  placeOsmBuilding(bld, segments, parks, occupied, addInstance) {
    const { cx, cz, width, depth, area, levels, buildingType } = bld;

    // Encontra a rua mais próxima para orientar a fachada (+Z do modelo aponta para a rua!)
    const nearest = this.findNearestRoadPoint(cx, cz, segments);
    let minRoadClearance = 6.5;
    if (nearest.segment) {
      minRoadClearance =
        TILE_SIZE * this.roadBuilder.getSegmentScale(nearest.segment) * 0.52 +
        3.2;
    }

    // Se o centroide do polígono estiver muito em cima da rua, afasta levemente na direção oposta à rua
    let bx = cx;
    let bz = cz;
    if (nearest.dist < minRoadClearance && nearest.dist > 0.1) {
      const pushDist = minRoadClearance - nearest.dist;
      const awayX = (cx - nearest.x) / nearest.dist;
      const awayZ = (cz - nearest.z) / nearest.dist;
      bx += awayX * pushDist;
      bz += awayZ * pushDist;
    }

    if (this.isOverlappingOccupied(bx, bz, 5.0, occupied)) return;

    // Ângulo para a porta da frente (+Z) olhar diretamente para a rua mais próxima
    let rotY = -bld.mainAngle;
    if (nearest.dist < 80) {
      rotY = Math.atan2(nearest.x - bx, nearest.z - bz);
    }

    // Escolhe o tipo de modelo baseado nas tags do OSM, níveis e rua em frente
    let pool = SUBURBAN_HOUSES;
    let baseScale = 12.5;

    if (
      buildingType === 'industrial' ||
      buildingType === 'warehouse' ||
      buildingType === 'manufacture'
    ) {
      pool = INDUSTRIAL_BUILDINGS;
      baseScale = 14.5;
    } else if (levels >= 6 || area > 1400) {
      pool = SKYSCRAPERS;
      baseScale = 14.0;
    } else if (
      buildingType === 'commercial' ||
      buildingType === 'retail' ||
      buildingType === 'apartments' ||
      buildingType === 'office' ||
      buildingType === 'public' ||
      buildingType === 'school' ||
      buildingType === 'hospital' ||
      buildingType === 'church' ||
      levels >= 3 ||
      area > 340 ||
      nearest.segment?.highwayType === 'primary' ||
      nearest.segment?.highwayType === 'secondary'
    ) {
      pool = COMMERCIAL_BUILDINGS;
      baseScale = 13.0;
    }

    const modelKey = this.pickDeterministic(pool, bx, bz);

    // Adapta levemente a escala ao lote mantendo proporção elegante e sem invadir a rua
    const maxRadius = Math.max(5.5, Math.min(11, Math.min(width, depth) * 0.55));
    const scaleXZ = Math.max(9.5, Math.min(16.0, baseScale * (maxRadius / 6.5)));
    const scaleY =
      levels >= 3
        ? scaleXZ * Math.min(1.6, 0.85 + levels * 0.1)
        : scaleXZ;

    addInstance(
      modelKey,
      new THREE.Vector3(bx, 0, bz),
      rotY,
      new THREE.Vector3(scaleXZ, scaleY, scaleXZ)
    );

    occupied.push({ x: bx, z: bz, r: scaleXZ * 0.42 });
  }

  /**
   * Loteia automaticamente as laterais das ruas onde o OSM não tem prédios individuais mapeados
   */
  populateProceduralStreetLots(
    chunkSegments,
    allSegments,
    parks,
    occupied,
    addInstance
  ) {
    for (const seg of chunkSegments) {
      if (
        seg.isBridge ||
        seg.isRoundabout ||
        seg.highwayType === 'service' ||
        seg.highwayType === 'motorway' ||
        seg.highwayType.endsWith('_link')
      ) {
        continue;
      }

      const roadW = TILE_SIZE * this.roadBuilder.getSegmentScale(seg);
      const isCommercialStreet =
        seg.highwayType === 'primary' ||
        seg.highwayType === 'secondary' ||
        seg.highwayType === 'tertiary';

      const lotSpacing = isCommercialStreet ? 15.5 : 14.0;
      const lotSetback = roadW * 0.5 + (isCommercialStreet ? 6.8 : 6.4);

      const pts = seg.points;
      for (let i = 0; i < pts.length - 1; i++) {
        const p0 = pts[i];
        const p1 = pts[i + 1];
        const dx = p1.x - p0.x;
        const dz = p1.z - p0.z;
        const segLen = Math.hypot(dx, dz);
        if (segLen < lotSpacing * 1.1) continue;

        const ux = dx / segLen;
        const uz = dz / segLen;
        const nx = -uz;
        const nz = ux;

        const numSteps = Math.floor((segLen - 8) / lotSpacing);
        for (let s = 1; s <= numSteps; s++) {
          const distAlong = 4 + (s - 0.5) * lotSpacing;
          const rx = p0.x + ux * distAlong;
          const rz = p0.z + uz * distAlong;

          // Tenta colocar dos dois lados da rua (side = +1 e side = -1)
          for (const side of [1, -1]) {
            const bx = rx + nx * side * lotSetback;
            const bz = rz + nz * side * lotSetback;

            const hash = this.hash2D(bx, bz);
            // Deixa alguns pequenos respiros orgânicos (~12%)
            if (hash > 0.88) continue;

            const clearanceRadius = isCommercialStreet ? 5.6 : 5.2;

            // 1. Não pode colidir com outro prédio/árvore já colocado
            if (this.isOverlappingOccupied(bx, bz, clearanceRadius, occupied)) {
              continue;
            }

            // 2. Não pode cair dentro de nenhuma rua vizinha
            if (
              this.isNearAnyRoad(
                bx,
                bz,
                roadW * 0.5 + 4.8,
                allSegments
              )
            ) {
              continue;
            }

            // 3. Não pode cair dentro de uma praça/parque do OSM
            if (this.isInsideAnyPark(bx, bz, parks)) {
              continue;
            }

            // Fachada (+Z do modelo) olhando diretamente para o ponto (rx, rz) da rua!
            const rotY = Math.atan2(rx - bx, rz - bz);

            let pool = SUBURBAN_HOUSES;
            let scale = 11.8 + hash * 2.2;

            if (isCommercialStreet) {
              pool =
                seg.highwayType === 'primary' && hash < 0.22
                  ? SKYSCRAPERS
                  : COMMERCIAL_BUILDINGS;
              scale = 12.2 + hash * 2.4;
            }

            const modelKey = this.pickDeterministic(pool, bx, bz);
            addInstance(
              modelKey,
              new THREE.Vector3(bx, 0, bz),
              rotY,
              new THREE.Vector3(scale, scale, scale)
            );
            occupied.push({ x: bx, z: bz, r: clearanceRadius });

            // Em casas residenciais, adiciona uma árvore de quintal/calçada ao lado quando houver espaço!
            if (!isCommercialStreet && hash < 0.55) {
              const tx = bx + ux * 5.2 + nx * side * 2.5;
              const tz = bz + uz * 5.2 + nz * side * 2.5;
              if (
                !this.isOverlappingOccupied(tx, tz, 2.8, occupied) &&
                !this.isNearAnyRoad(tx, tz, roadW * 0.5 + 3.0, allSegments) &&
                !this.isInsideAnyPark(tx, tz, parks)
              ) {
                const treeModel =
                  hash < 0.28 ? 'suburban/tree-large' : 'nature/tree_oak';
                const treeScale = treeModel.startsWith('suburban/') ? 11.5 : 7.5;
                addInstance(
                  treeModel,
                  new THREE.Vector3(tx, 0, tz),
                  hash * Math.PI * 2,
                  new THREE.Vector3(treeScale, treeScale, treeScale)
                );
                occupied.push({ x: tx, z: tz, r: 2.5 });
              }
            }
          }
        }
      }
    }
  }

  findNearestRoadPoint(px, pz, segments) {
    let bestDist = Infinity;
    let bestX = px;
    let bestZ = pz + 1;
    let bestSeg = null;

    for (const seg of segments) {
      const pts = seg.points;
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
        const d = Math.hypot(px - cx, pz - cz);
        if (d < bestDist) {
          bestDist = d;
          bestX = cx;
          bestZ = cz;
          bestSeg = seg;
        }
      }
    }

    return { dist: bestDist, x: bestX, z: bestZ, segment: bestSeg };
  }

  isNearAnyRoad(px, pz, minDist, segments) {
    for (const seg of segments) {
      const roadHalfW =
        TILE_SIZE * this.roadBuilder.getSegmentScale(seg) * 0.5;
      const threshold = Math.max(minDist, roadHalfW + 4.2);

      const pts = seg.points;
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
        if (Math.hypot(px - cx, pz - cz) < threshold) {
          return true;
        }
      }
    }
    return false;
  }

  isInsideAnyPark(px, pz, parks) {
    for (const park of parks) {
      if (
        px < park.minX - 3 ||
        px > park.maxX + 3 ||
        pz < park.minZ - 3 ||
        pz > park.maxZ + 3
      ) {
        continue;
      }
      if (this.isPointInPolygon(px, pz, park.points)) {
        return true;
      }
    }
    return false;
  }

  isOverlappingOccupied(px, pz, radius, occupied) {
    for (let i = 0; i < occupied.length; i++) {
      const item = occupied[i];
      const dx = px - item.x;
      const dz = pz - item.z;
      const minD = radius + item.r;
      if (dx * dx + dz * dz < minD * minD) {
        return true;
      }
    }
    return false;
  }

  isPointInPolygon(x, z, polygon) {
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const xi = polygon[i].x;
      const zi = polygon[i].z;
      const xj = polygon[j].x;
      const zj = polygon[j].z;

      const intersect =
        zi > z !== zj > z &&
        x < ((xj - xi) * (z - zi)) / (zj - zi + 1e-9) + xi;
      if (intersect) inside = !inside;
    }
    return inside;
  }

  hash2D(x, z) {
    const s = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453;
    return s - Math.floor(s);
  }

  pickDeterministic(arr, x, z) {
    const h = this.hash2D(x, z);
    const idx = Math.floor(h * arr.length) % arr.length;
    return arr[idx];
  }
}
