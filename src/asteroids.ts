import { MeshoptSimplifier } from 'meshoptimizer';
import { computeBoundsTree } from 'three-mesh-bvh';
import { BufferAttribute, BufferGeometry, Color, IcosahedronGeometry, Quaternion, Vector3 } from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { ImprovedNoise } from 'three/addons/math/ImprovedNoise.js';
import { InstancedMesh2 } from '@three.ez/instanced-mesh';
import { createFadeMaterial } from './fade.js';
import type { FadeMaterial } from './fade.js';
import { Random } from './random.js';

/** Fraction of LOD 0 triangles kept by LOD 1, 2 and 3. */
export const lodRatios = [0.3, 0.1, 0.03];
/** Screen-size thresholds (fraction of the view height) under which LOD 1, 2 and 3 are used. */
export const lodMetrics = [0.12, 0.04, 0.012];
/** Hysteresis of every level: an instance keeps its level until the threshold is crossed by this fraction, so levels do not flicker. */
export const lodHysteresis = 0.15;
/** Screen-size threshold under which shadows switch from LOD 2 to LOD 3 geometry. */
export const shadowLodMetric = 0.03;
export const levelColors = [0xffffff, 0x4fc3ff, 0xffd166, 0xff5c7a];

/** The field repeats every `fieldLength` along +Z, so the ship can fly straight forever. */
export const fieldLength = 16000;
/** Field slices copied across the seam, enough to cover the view distance ahead and the camera behind. */
export const seamAhead = 2400;
export const seamBehind = 600;
/** Half extents of the field across the flight axis; the ship stays a bit inside them. */
export const fieldHalfWidth = 2000;
export const fieldHalfHeight = 1200;
/** Extra slots for the pieces added when big asteroids split. */
const splitReserve = 4096;
/** Empty pocket around the ship start (it starts at z = 100 on the axis). */
const startClearLength = 700;
const startClearRadius = 110;
/** Fraction of a grid cell an asteroid can move from the cell center. */
const jitter = 0.9;

export interface AsteroidVariant {
  mesh: InstancedMesh2;
  /** LOD 0 to LOD 3. */
  geometries: BufferGeometry[];
}

/**
 * Displaced, cratered icosphere with about 2.4k triangles. Its surface pattern is baked into vertex colors (no texture, no
 * extra shader work): basalt and dust, warm iron-rich patches, faint flecks, darker cavities and crater floors as cheap
 * ambient occlusion.
 */
export function createAsteroidGeometry(seed: number): BufferGeometry {
  const random = new Random(seed);
  const noise = new ImprovedNoise();
  const source = new IcosahedronGeometry(1, 10);
  source.deleteAttribute('normal');
  source.deleteAttribute('uv');
  const geometry = mergeVertices(source);
  source.dispose();

  // Craters of mixed sizes: a few large basins and some small pits, with soft bowls and rounded rims.
  const craters: Vector3[] = [];
  const craterRadius: number[] = [];
  for (let i = 0; i < 12; i++) {
    craters.push(new Vector3(random.range(-1, 1), random.range(-1, 1), random.range(-1, 1)).normalize());
    craterRadius.push(0.12 + 0.38 * Math.pow(random.next(), 2));
  }

  const stretch = new Vector3(random.range(1, 1.4), random.range(0.75, 1), random.range(0.85, 1.1));
  const offset = random.range(0, 100);
  const position = geometry.getAttribute('position') as BufferAttribute;
  const dir = new Vector3();
  const colors = new Float32Array(position.count * 3);
  for (let i = 0, l = position.count; i < l; i++) {
    dir.fromBufferAttribute(position, i).normalize();
    const x = dir.x;
    const y = dir.y;
    const z = dir.z;

    // Rounded, lumpy shape: low-frequency noise dominates, small octaves only add gentle bumps.
    let height = 0;
    let amplitude = 0.3;
    let frequency = 1;
    for (let o = 0; o < 4; o++) {
      height += amplitude * noise.noise(x * frequency + offset, y * frequency, z * frequency - offset);
      amplitude *= 0.33;
      frequency *= 2;
    }

    let crater = 0;
    for (let c = 0; c < craters.length; c++) {
      const distance = dir.distanceTo(craters[c]) / craterRadius[c];
      if (distance >= 1.6) continue;
      const depth = craterRadius[c] * 0.3;
      const bowl = 1 - smooth(distance);
      const rim = Math.exp(-((distance - 1.05) * (distance - 1.05)) / 0.06);
      height += depth * (0.25 * rim - bowl);
      crater += 0.5 * rim - bowl;
    }
    const radius = 1 + height;
    position.setXYZ(i, x * radius * stretch.x, y * radius * stretch.y, z * radius * stretch.z);

    // Surface: cool basalt and pale dust, warm iron-rich patches, faint bright flecks; cavities and crater floors darker.
    const dust = smooth(0.5 + 1.3 * noise.noise(x * 1.6 + offset, y * 1.6, z * 1.6));
    let r = 0.14 + (0.46 - 0.14) * dust;
    let g = 0.14 + (0.44 - 0.14) * dust;
    let b = 0.16 + (0.42 - 0.16) * dust;
    const warm = 0.45 * smooth(1.8 * noise.noise(x * 2.2, y * 2.2 + offset, z * 2.2 - offset));
    r += (0.44 - r) * warm;
    g += (0.33 - g) * warm;
    b += (0.24 - b) * warm;
    const fleck = 0.5 * smooth(5 * noise.noise(x * 8 - offset, y * 8, z * 8 + offset) - 1.6);
    r += (0.7 - r) * fleck;
    g += (0.7 - g) * fleck;
    b += (0.68 - b) * fleck;
    const grain = 1 + 0.06 * noise.noise(x * 12 + offset, y * 12, z * 12);
    const occlusion = 0.65 + 0.45 * smooth((height + 0.2) / 0.4);
    const shade = Math.max(0.35, occlusion * grain * (1 + 0.18 * crater));
    colors[i * 3] = r * shade;
    colors[i * 3 + 1] = g * shade;
    colors[i * 3 + 2] = b * shade;
  }
  geometry.setAttribute('color', new BufferAttribute(colors, 3));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  geometry.computeBoundingBox();
  return geometry;
}

/** Clamps to [0, 1] with a smoothstep curve. */
function smooth(value: number): number {
  const t = Math.min(1, Math.max(0, value));
  return t * t * (3 - 2 * t);
}

/**
 * Copy of an indexed geometry with `ratio` of its triangles, simplified by meshoptimizer with `simplifyWithUpdate`: besides
 * collapsing edges it moves the remaining vertices and updates their normals and colors to best fit the original surface, so
 * levels keep the same silhouette and shading and the switch between them is hard to notice. `Regularize` keeps triangles
 * even, so low levels stay rounded instead of turning into slivers.
 */
export function simplifyGeometry(geometry: BufferGeometry, ratio: number): BufferGeometry {
  const result = geometry.clone();
  const index = result.getIndex();
  if (index === null) throw new Error('Simplification needs an indexed geometry.');
  const position = result.getAttribute('position') as BufferAttribute;
  const normal = result.getAttribute('normal') as BufferAttribute;
  const color = result.getAttribute('color') as BufferAttribute;
  const count = position.count;
  const attributes = new Float32Array(count * 6);
  for (let i = 0; i < count; i++) {
    attributes[i * 6] = normal.getX(i);
    attributes[i * 6 + 1] = normal.getY(i);
    attributes[i * 6 + 2] = normal.getZ(i);
    attributes[i * 6 + 3] = color.getX(i);
    attributes[i * 6 + 4] = color.getY(i);
    attributes[i * 6 + 5] = color.getZ(i);
  }
  const indices = new Uint32Array(index.array);
  const target = 3 * Math.floor(ratio * indices.length / 3);
  const [indexCount] = MeshoptSimplifier.simplifyWithUpdate(
    indices, position.array as Float32Array, 3, attributes, 6, [0.6, 0.6, 0.6, 1, 1, 1], null, target, 1, ['Regularize']
  );
  for (let i = 0; i < count; i++) {
    const nx = attributes[i * 6];
    const ny = attributes[i * 6 + 1];
    const nz = attributes[i * 6 + 2];
    const length = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    normal.setXYZ(i, nx / length, ny / length, nz / length);
    color.setXYZ(i, attributes[i * 6 + 3], attributes[i * 6 + 4], attributes[i * 6 + 5]);
  }
  result.setIndex(new BufferAttribute(indices.slice(0, indexCount), 1));
  result.computeBoundingSphere();
  return result;
}

/** One material per LOD level, dissolving between `fadeNear` and `fadeFar` view depth. */
export function createLevelMaterials(nodeMaterial: boolean, fadeNear: number, fadeFar: number): FadeMaterial[] {
  const materials: FadeMaterial[] = [];
  for (let i = 0; i < levelColors.length; i++) materials.push(createFadeMaterial(nodeMaterial, fadeNear, fadeFar));
  return materials;
}

export async function createVariant(seed: number, materials: FadeMaterial[]): Promise<AsteroidVariant> {
  await MeshoptSimplifier.ready;
  const lod0 = createAsteroidGeometry(seed);
  const geometries = [lod0];
  for (let i = 0; i < lodRatios.length; i++) geometries.push(simplifyGeometry(lod0, lodRatios[i]));
  // Raycasts test hit candidates against LOD 0: a triangle BVH (three-mesh-bvh) keeps that narrow phase cheap.
  computeBoundsTree.call(lod0);

  const mesh = new InstancedMesh2(lod0, materials[0], { useDistanceForLOD: false });
  for (let i = 1; i < geometries.length; i++) mesh.addLOD(geometries[i], materials[i], lodMetrics[i - 1], lodHysteresis);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return { mesh, geometries };
}

export function enableShadowLOD(variant: AsteroidVariant, enabled: boolean): void {
  const mesh = variant.mesh;
  mesh.clearShadowLOD();
  if (!enabled) return;
  mesh.addShadowLOD(variant.geometries[2]);
  mesh.addShadowLOD(variant.geometries[3], shadowLodMetric);
}

const tint = new Color();

/**
 * Fills the field box with `count` asteroids with power-law sizes, one per cell of a jittered grid: the density is even, with no
 * empty pockets or clumps that pure random placement creates. Asteroids near both ends are duplicated across the seam: the
 * field is periodic and the ship is moved back by `fieldLength` when it crosses it.
 */
export function populateField(mesh: InstancedMesh2, count: number, seed: number, useBVH: boolean): void {
  const random = new Random(seed);
  const data = new Float32Array(count * 13);
  const width = fieldHalfWidth * 2;
  const height = fieldHalfHeight * 2;
  const cell = Math.cbrt(width * height * fieldLength / count);
  const nx = Math.max(1, Math.round(width / cell));
  const ny = Math.max(1, Math.round(height / cell));
  const cellX = width / nx;
  const cellY = height / ny;
  const cellZ = fieldLength * nx * ny / count;
  let duplicates = 0;
  for (let i = 0; i < count; i++) {
    const o = i * 13;
    data[o] = -fieldHalfWidth + (i % nx + 0.5 + (random.next() - 0.5) * jitter) * cellX;
    data[o + 1] = -fieldHalfHeight + (Math.floor(i / nx) % ny + 0.5 + (random.next() - 0.5) * jitter) * cellY;
    data[o + 2] = (Math.floor(i / (nx * ny)) + 0.5 + (random.next() - 0.5) * jitter) * cellZ;
    // Keep the start of the flight clear, so the opening shot frames the ship and the field, not one rock.
    if (data[o + 2] < startClearLength && Math.abs(data[o]) < startClearRadius && Math.abs(data[o + 1]) < startClearRadius) {
      data[o] = (data[o] < 0 ? -1 : 1) * (startClearRadius + Math.abs(data[o]));
    }
    const size = Math.min(1.2 * Math.pow(1 - random.next(), -0.7), 80);
    data[o + 3] = size * random.range(0.65, 1.35);
    data[o + 4] = size * random.range(0.65, 1.35);
    data[o + 5] = size * random.range(0.65, 1.35);
    randomQuaternion(random, _quaternion);
    data[o + 6] = _quaternion.x;
    data[o + 7] = _quaternion.y;
    data[o + 8] = _quaternion.z;
    data[o + 9] = _quaternion.w;
    // Three families of rocks: dark carbon-rich, warm stony and pale metallic.
    const family = random.next();
    if (family < 0.5) tint.setHSL(random.range(0.06, 0.1), random.range(0.05, 0.15), random.range(0.55, 0.75));
    else if (family < 0.88) tint.setHSL(random.range(0.06, 0.09), random.range(0.2, 0.35), random.range(0.82, 0.95));
    else tint.setHSL(random.range(0.55, 0.62), random.range(0.05, 0.12), random.range(0.9, 1));
    data[o + 10] = tint.r;
    data[o + 11] = tint.g;
    data[o + 12] = tint.b;
    if (data[o + 2] < seamAhead || data[o + 2] > fieldLength - seamBehind) duplicates++;
  }

  mesh.disposeBVH();
  mesh.clearInstances();
  // Allocate once with room for the pieces of split asteroids: buffers never grow (and never get reallocated) during play.
  mesh.ensureCapacity(count + duplicates + splitReserve);
  let next = 0;
  let duplicate = false;
  mesh.addInstances(count + duplicates, (instance) => {
    let o = next * 13;
    let z = data[o + 2];
    if (duplicate) {
      while (data[o + 2] >= seamAhead && data[o + 2] <= fieldLength - seamBehind) o = ++next * 13;
      z = data[o + 2] < seamAhead ? data[o + 2] + fieldLength : data[o + 2] - fieldLength;
      next++;
    } else if (++next === count) {
      next = 0;
      duplicate = true;
    }
    instance.position.set(data[o], data[o + 1], z);
    instance.scale.set(data[o + 3], data[o + 4], data[o + 5]);
    instance.quaternion.set(data[o + 6], data[o + 7], data[o + 8], data[o + 9]);
    instance.color = tint.setRGB(data[o + 10], data[o + 11], data[o + 12]);
  });
  mesh.computeBoundingSphere();
  if (useBVH) mesh.computeBVH({ margin: 0 });
}

const _quaternion = new Quaternion();

/** Uniform random rotation (Shoemake). */
export function randomQuaternion(random: Random, target: { set(x: number, y: number, z: number, w: number): unknown }): void {
  const u1 = random.next();
  const u2 = random.range(0, Math.PI * 2);
  const u3 = random.range(0, Math.PI * 2);
  const a = Math.sqrt(1 - u1);
  const b = Math.sqrt(u1);
  target.set(a * Math.sin(u2), a * Math.cos(u2), b * Math.sin(u3), b * Math.cos(u3));
}
