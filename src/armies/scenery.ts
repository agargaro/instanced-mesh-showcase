import {
  BackSide, BufferAttribute, BufferGeometry, CanvasTexture, Color, ConeGeometry, CylinderGeometry, DirectionalLight, Float32BufferAttribute, Fog,
  HemisphereLight, Mesh, MeshBasicMaterial, MeshLambertMaterial, RepeatWrapping, Scene, SphereGeometry, SRGBColorSpace, Vector3
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { InstancedMesh2 } from '@three.ez/instanced-mesh';
import { Random } from '../random.js';

/** Late-afternoon sun: direction toward it, its color and the haze at the horizon (also the fog color). */
export const SUN_DIRECTION = new Vector3(-40, 34, 30).normalize();
const SUN_COLOR = 0xffe2bd;
const HORIZON = new Color(0xcbdae6);
const ZENITH = new Color(0x4f86c9);
const GLOW = new Color(0xffd9a6);
const GRASS = [new Color(0x405629), new Color(0x6e7d44)];
const HILLTOP = new Color(0x8a8650);
const EARTH = new Color(0x7b6040);
/** Meters covered by one tile of the grass detail texture. */
const DETAIL_TILE = 7;
/** Spacing of the terrain grid over the battlefield, and its growth per step outside. */
const GRID_STEP = 2.5;
const GRID_GROWTH = 1.12;
/** Width of the rise from the flat battlefield to the hills. */
const HILL_RISE = 70;

/** Ground, sky and lights around the battlefield: flat inside `halfWidth` × `halfDepth`, hills and woods outside. */
export interface Scenery {
  scene: Scene;
  /** Distance from the middle of the field to the sky: cameras should see this far. */
  radius: number;
}

/** Sky dome, haze, sun and sky light without shadow maps, the terrain and the woods on the hills. */
export function createScenery(halfWidth: number, halfDepth: number, seed: number): Scenery {
  const flatX = halfWidth * 1.3;
  const flatZ = halfDepth * 1.3;
  const radius = Math.max(halfWidth, halfDepth) * 5;
  const scene = new Scene();
  scene.background = HORIZON.clone();
  scene.fog = new Fog(HORIZON.clone(), Math.max(halfWidth, halfDepth) * 2, radius);
  const sun = new DirectionalLight(SUN_COLOR, 3);
  sun.position.copy(SUN_DIRECTION).multiplyScalar(100);
  scene.add(sun, new HemisphereLight(0xc4dcff, 0x6b5636, 1.6));
  scene.add(createSky(radius), createTerrain(flatX, flatZ, radius), createWoods(flatX, flatZ, radius, seed));
  return { scene, radius };
}

/** Height of the terrain: 0 on the battlefield, rolling hills rising beyond its edges. */
export function terrainHeight(x: number, z: number, flatX: number, flatZ: number): number {
  const dx = Math.max(Math.abs(x) - flatX, 0);
  const dz = Math.max(Math.abs(z) - flatZ, 0);
  const distance = Math.sqrt(dx * dx + dz * dz);
  if (distance === 0) return 0;
  const rise = Math.min(1, distance / HILL_RISE);
  const shape = 0.55 + 0.25 * Math.sin(x * 0.019 + 1.3) * Math.cos(z * 0.016 - 0.4) + 0.15 * Math.sin(x * 0.047 - z * 0.039) + 0.05 * Math.sin((x + z) * 0.11);
  return rise * rise * (3 - 2 * rise) * shape * (10 + distance * 0.09);
}

/** A dome colored by height: haze at the horizon, blue above, a warm glow around the sun. Unlit, unfogged, drawn first. */
function createSky(radius: number): Mesh {
  const geometry = new SphereGeometry(radius, 48, 24);
  const position = geometry.getAttribute('position');
  const colors = new Float32Array(position.count * 3);
  const direction = new Vector3();
  const color = new Color();
  for (let i = 0; i < position.count; i++) {
    direction.fromBufferAttribute(position, i).normalize();
    const up = Math.max(0, direction.y);
    color.copy(HORIZON).lerp(ZENITH, Math.pow(up, 0.55));
    color.lerp(GLOW, Math.pow(Math.max(0, direction.dot(SUN_DIRECTION)), 6) * 0.8);
    color.toArray(colors, i * 3);
  }
  geometry.setAttribute('color', new Float32BufferAttribute(colors, 3));
  const sky = new Mesh(geometry, new MeshBasicMaterial({ vertexColors: true, side: BackSide, fog: false, depthWrite: false }));
  sky.renderOrder = -10;
  return sky;
}

/**
 * The terrain as one grid, `GRID_STEP` meters apart over the battlefield and wider outside: vertex colors for the large-scale
 * variation (greens, warm hilltops, the trampled earth strip where the armies meet) times a tiled grass detail texture.
 */
function createTerrain(flatX: number, flatZ: number, radius: number): Mesh {
  const xs = createAxis(flatX, radius);
  const zs = createAxis(flatZ, radius);
  const columns = xs.length;
  const rows = zs.length;
  const positions = new Float32Array(columns * rows * 3);
  const uvs = new Float32Array(columns * rows * 2);
  const colors = new Float32Array(columns * rows * 3);
  const color = new Color();
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < columns; c++) {
      const i = r * columns + c;
      const x = xs[c];
      const z = zs[r];
      const y = terrainHeight(x, z, flatX, flatZ);
      positions[i * 3] = x;
      positions[i * 3 + 1] = y;
      positions[i * 3 + 2] = z;
      uvs[i * 2] = x / DETAIL_TILE;
      uvs[i * 2 + 1] = -z / DETAIL_TILE;
      groundColor(x, z, y, flatX, flatZ, color).toArray(colors, i * 3);
    }
  }
  const indices = new Uint32Array((columns - 1) * (rows - 1) * 6);
  let k = 0;
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < columns - 1; c++) {
      const a = r * columns + c;
      indices[k++] = a;
      indices[k++] = a + columns;
      indices[k++] = a + 1;
      indices[k++] = a + 1;
      indices[k++] = a + columns;
      indices[k++] = a + columns + 1;
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new BufferAttribute(uvs, 2));
  geometry.setAttribute('color', new BufferAttribute(colors, 3));
  geometry.setIndex(new BufferAttribute(indices, 1));
  geometry.computeVertexNormals();
  return new Mesh(geometry, new MeshLambertMaterial({ map: createDetailTexture(), vertexColors: true }));
}

/** Grid coordinates from `-extent` to `extent`: `GRID_STEP` apart within `flat`, then wider by `GRID_GROWTH` per step. */
function createAxis(flat: number, extent: number): number[] {
  const half: number[] = [];
  let step = GRID_STEP;
  for (let value = 0; value < extent; value += value < flat ? GRID_STEP : (step *= GRID_GROWTH)) half.push(value);
  half.push(extent);
  const axis: number[] = [];
  for (let i = half.length - 1; i > 0; i--) axis.push(-half[i]);
  for (let i = 0; i < half.length; i++) axis.push(half[i]);
  return axis;
}

function groundColor(x: number, z: number, y: number, flatX: number, flatZ: number, out: Color): Color {
  const large = Math.sin(x * 0.045 + Math.cos(z * 0.031)) * Math.sin(z * 0.052 - 0.7);
  const small = Math.sin(x * 0.17 + Math.sin(z * 0.11) * 2) * Math.cos(z * 0.15 - Math.sin(x * 0.09));
  out.copy(GRASS[0]).lerp(GRASS[1], Math.min(1, Math.max(0, 0.5 + 0.4 * large + 0.22 * small)));
  out.lerp(HILLTOP, Math.min(1, y / 30) * 0.6);
  const strip = Math.max(0, 1 - Math.abs(x + 2 * Math.sin(z * 0.08)) / 9) * Math.max(0, Math.min(1, (flatZ - Math.abs(z)) / 12));
  out.lerp(EARTH, strip * strip * (0.65 + 0.2 * Math.sin(z * 0.37 + x * 0.21)));
  const edge = Math.max(Math.abs(x) - flatX, Math.abs(z) - flatZ);
  return out.multiplyScalar(edge > -6 && y < 1 ? 0.92 : 1);
}

/** Grass speckles around white, so the texture modulates the vertex colors without changing their mean much. */
function createDetailTexture(): CanvasTexture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  if (context === null) throw new Error('Canvas 2D is unavailable.');
  const random = new Random(23);
  context.fillStyle = '#e6eadb';
  context.fillRect(0, 0, size, size);
  for (let i = 0; i < 1800; i++) {
    const light = random.range(-40, 25);
    context.fillStyle = `rgba(${String(Math.round(215 + light))}, ${String(Math.round(225 + light))}, ${String(Math.round(195 + light))}, 0.55)`;
    const x = random.range(0, size);
    const y = random.range(0, size);
    context.fillRect(x, y, random.range(1, 2.5), random.range(3, 7));
  }
  const texture = new CanvasTexture(canvas);
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

/** Pine woods in patches on the hills: one instanced mesh of simple pines, its BVH built once for the frustum culling. */
function createWoods(flatX: number, flatZ: number, radius: number, seed: number): InstancedMesh2 {
  const random = new Random(seed * 31 + 7);
  const spots: number[] = [];
  const reach = radius * 0.7;
  for (let attempt = 0; attempt < 60000 && spots.length < 2400 * 4; attempt++) {
    const x = random.range(-reach, reach);
    const z = random.range(-reach, reach);
    const dx = Math.max(Math.abs(x) - flatX, 0);
    const dz = Math.max(Math.abs(z) - flatZ, 0);
    if (dx * dx + dz * dz < 18 * 18) continue;
    const forest = Math.sin(x * 0.021 + 0.5) * Math.cos(z * 0.024 - 1.1) + 0.6 * Math.sin((x + z) * 0.043);
    if (forest < 0.35 + random.next() * 0.4) continue;
    spots.push(x, terrainHeight(x, z, flatX, flatZ) - 0.2, z, random.range(0.7, 1.35));
  }
  const material = new MeshLambertMaterial({ vertexColors: true, flatShading: true });
  const woods = new InstancedMesh2(createPine(), material, { capacity: spots.length / 4 });
  const tint = new Color();
  woods.addInstances(spots.length / 4, (instance, id) => {
    const scale = spots[id * 4 + 3];
    instance.position.set(spots[id * 4], spots[id * 4 + 1], spots[id * 4 + 2]);
    instance.rotateY(random.range(0, Math.PI * 2));
    instance.scale.set(scale, scale * random.range(0.85, 1.2), scale);
    woods.setColorAt(id, tint.setRGB(random.range(0.8, 1.05), random.range(0.85, 1.05), random.range(0.8, 1)));
  });
  woods.computeBVH();
  return woods;
}

/** A pine of 8-sided parts: a trunk and three cones, colored by vertex (bark, darker foliage below, lighter at the top). */
function createPine(): BufferGeometry {
  const parts = [paint(new CylinderGeometry(0.22, 0.32, 2.2, 6, 1).translate(0, 1.1, 0), new Color(0x5a3f26))];
  for (let t = 0; t < 3; t++) {
    const f = t / 2;
    const height = 3.4 - f * 1.1;
    const base = 1.6 + f * 2.6;
    const cone = new ConeGeometry(2.3 - f * 1.1, height, 8, 1).translate(0, base + height / 2, 0);
    parts.push(paint(cone, new Color(0x2f5a2c).lerp(new Color(0x4f7a38), f)));
  }
  return mergeGeometries(parts.map((part) => part.toNonIndexed()));
}

function paint(geometry: BufferGeometry, color: Color): BufferGeometry {
  const count = geometry.getAttribute('position').count;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) color.toArray(colors, i * 3);
  geometry.setAttribute('color', new Float32BufferAttribute(colors, 3));
  geometry.deleteAttribute('uv');
  return geometry;
}
