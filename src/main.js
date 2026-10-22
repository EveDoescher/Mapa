import './style.css';
import * as THREE from 'three';
import { MapControls } from 'three/addons/controls/MapControls.js';
import { geocodeLocation } from './osm.js';
import { KenneyRoadBuilder } from './roadBuilder.js';
import { KenneyCityBuilder } from './cityBuilder.js';
import { ChunkManager } from './chunkManager.js';

const canvas = document.getElementById('scene-canvas');
const statusBar = document.getElementById('status-bar');
const statChunk = document.getElementById('stat-chunk');
const statWays = document.getElementById('stat-ways');
const statDraws = document.getElementById('stat-draws');

const searchForm = document.getElementById('search-form');
const searchInput = document.getElementById('search-input');
const modeSelect = document.getElementById('mode-select');
const chunkRadiusSelect = document.getElementById('chunk-radius-select');
const toggleBuildings = document.getElementById('toggle-buildings');
const toggleAutofill = document.getElementById('toggle-autofill');
const toggleParks = document.getElementById('toggle-parks');
const toggleProps = document.getElementById('toggle-props');
const toggleChunkBorders = document.getElementById('toggle-chunk-borders');
const toggleOsmLines = document.getElementById('toggle-osm-lines');
const presetChips = document.querySelectorAll('.chip');

// --- 1. Cena Three.js (Céu Claro Diurno) ---
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x93c5fd);
scene.fog = new THREE.FogExp2(0xcbd5e1, 0.00042);

const camera = new THREE.PerspectiveCamera(
  45,
  window.innerWidth / window.innerHeight,
  1,
  4500
);
camera.position.set(0, 220, 250);

const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  powerPreference: 'high-performance',
});
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;

// Controles estilo Google Earth
const controls = new MapControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.07;
controls.maxPolarAngle = Math.PI / 2 - 0.04;
controls.minDistance = 15;
controls.maxDistance = 1800;

// Iluminação diurna clara
const hemiLight = new THREE.HemisphereLight(0xffffff, 0x86efac, 1.45);
hemiLight.position.set(0, 300, 0);
scene.add(hemiLight);

const dirLight = new THREE.DirectionalLight(0xfffbeb, 1.85);
dirLight.position.set(160, 320, 140);
dirLight.castShadow = true;
dirLight.shadow.mapSize.set(2048, 2048);
dirLight.shadow.camera.near = 10;
dirLight.shadow.camera.far = 1200;
const d = 420;
dirLight.shadow.camera.left = -d;
dirLight.shadow.camera.right = d;
dirLight.shadow.camera.top = d;
dirLight.shadow.camera.bottom = -d;
dirLight.shadow.bias = -0.0005;
scene.add(dirLight);
scene.add(dirLight.target);

// Chão claro
const groundGeo = new THREE.PlaneGeometry(8000, 8000);
const groundMat = new THREE.MeshStandardMaterial({
  color: 0xd9ead3,
  roughness: 0.95,
  metalness: 0.0,
});
const groundMesh = new THREE.Mesh(groundGeo, groundMat);
groundMesh.rotation.x = -Math.PI / 2;
groundMesh.position.y = -0.05;
groundMesh.receiveShadow = true;
scene.add(groundMesh);

// --- 2. Builders & ChunkManager ---
const roadBuilder = new KenneyRoadBuilder();
const cityBuilder = new KenneyCityBuilder(roadBuilder);
let latestTileCount = 0;

function setStatus(msg, isError = false) {
  statusBar.textContent = msg;
  statusBar.style.color = isError ? '#f87171' : '#38bdf8';
  statusBar.style.borderColor = isError
    ? 'rgba(248, 113, 113, 0.35)'
    : 'rgba(56, 189, 248, 0.25)';
}

const chunkManager = new ChunkManager(
  scene,
  roadBuilder,
  cityBuilder,
  setStatus,
  ({ activeChunks, cachedChunks, totalTiles, centerChunk }) => {
    statChunk.textContent = `[${centerChunk}]`;
    statWays.textContent = `${activeChunks} / ${cachedChunks}`;
    latestTileCount = totalTiles;
  }
);

async function teleportToLocation(lat, lon, label) {
  controls.target.set(0, 0, 0);
  camera.position.set(0, 220, 250);
  controls.update();
  await chunkManager.resetOrigin(lat, lon, label);
}

// --- 3. Eventos de UI ---
searchForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = searchInput.value.trim();
  if (!q) return;

  try {
    setStatus(`Localizando "${q}" no OpenStreetMap...`);
    const loc = await geocodeLocation(q);
    await teleportToLocation(loc.lat, loc.lon, loc.displayName.split(',')[0]);
  } catch (err) {
    setStatus(err.message, true);
  }
});

presetChips.forEach((chip) => {
  chip.addEventListener('click', () => {
    const lat = parseFloat(chip.dataset.lat);
    const lon = parseFloat(chip.dataset.lon);
    const name = chip.dataset.name;
    searchInput.value = name;
    teleportToLocation(lat, lon, name);
  });
});

modeSelect.addEventListener('change', () => {
  chunkManager.setRenderOptions({ mode: modeSelect.value });
});

chunkRadiusSelect.addEventListener('change', () => {
  chunkManager.setRenderDistance(parseInt(chunkRadiusSelect.value, 10));
});

toggleBuildings.addEventListener('change', () => {
  chunkManager.setRenderOptions({ showBuildings: toggleBuildings.checked });
});

toggleAutofill.addEventListener('change', () => {
  chunkManager.setRenderOptions({ autoFillLots: toggleAutofill.checked });
});

toggleParks.addEventListener('change', () => {
  chunkManager.setRenderOptions({ showParks: toggleParks.checked });
});

toggleProps.addEventListener('change', () => {
  chunkManager.setRenderOptions({ showProps: toggleProps.checked });
});

toggleChunkBorders.addEventListener('change', () => {
  chunkManager.setRenderOptions({
    showChunkBorders: toggleChunkBorders.checked,
  });
});

toggleOsmLines.addEventListener('change', () => {
  chunkManager.setRenderOptions({ showOsmLines: toggleOsmLines.checked });
});

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// --- 4. Inicialização ---
let isReady = false;
let lastChunkCheckTime = 0;

async function init() {
  try {
    await roadBuilder.loadAssets((loaded, total, name) => {
      setStatus(`Carregando kit de ruas (${loaded}/${total}): ${name}.glb`);
    });

    await cityBuilder.loadAssets((loaded, total, name) => {
      setStatus(
        `Carregando kits de cidade e natureza (${loaded}/${total}): ${name}.glb`
      );
    });

    isReady = true;
    await teleportToLocation(-22.5646, -47.4017, 'Centro, Limeira - SP');
  } catch (err) {
    console.error(err);
    setStatus(`Erro ao carregar modelos 3D: ${err.message}`, true);
  }
}

function animate(now = 0) {
  requestAnimationFrame(animate);
  controls.update();

  groundMesh.position.x = controls.target.x;
  groundMesh.position.z = controls.target.z;
  dirLight.position.set(
    controls.target.x + 160,
    320,
    controls.target.z + 140
  );
  dirLight.target.position.set(controls.target.x, 0, controls.target.z);

  if (isReady && now - lastChunkCheckTime > 200) {
    lastChunkCheckTime = now;
    chunkManager.updateCameraTarget(controls.target.x, controls.target.z);
  }

  renderer.render(scene, camera);
  statDraws.textContent = `${latestTileCount} / ${renderer.info.render.calls} dc`;
}

init();
animate();
