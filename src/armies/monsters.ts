import { AnimationClip, BufferAttribute, BufferGeometry, TextureLoader } from 'three';
import type { BindMode, DataArrayTexture, KeyframeTrack, Matrix4, MeshStandardMaterial, Object3D, Skeleton, SkinnedMesh, Texture } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { simplifyGeometry } from '@three.ez/simplify-geometry';
import type { SimplifyParams } from '@three.ez/simplify-geometry';
import { SkeletalAnimationBake } from '@three.ez/instanced-mesh';
import { createDataArrayTexture } from './texture-array.js';

/** Quaternius assets (CC0) shared with the bestiary showcase. */
export const assetBase = `${import.meta.env.BASE_URL}assets/`;

/** What to prepare for each monster type. */
export interface MonsterOptions {
  /** Clips of the Universal Animation Library to bake, in clip-index order. */
  clips: readonly string[];
  framesPerSecond: number;
  /** Fraction of the triangles of the model kept by the full level (borders locked), or `null` to keep the model as it is. */
  baseRatio: number | null;
  /**
   * Appearance error of each simplified level, relative to the size of the model (`@three.ez/simplify-geometry` ranges such as
   * `balancedRangeLOD`): each level keeps as few triangles as that error allows; the farthest also drops small disconnected parts.
   */
  lodErrors: readonly number[];
  /** Fraction kept by the shadow level, or `null` without one. */
  shadowRatio: number | null;
  /** Calibrated levels by monster name (`MonsterKind.name`), replacing `baseRatio` and `lodErrors` for that monster. */
  levels?: Readonly<Partial<Record<string, MonsterLevels>>>;
}

/** Simplification of each level of one monster, as exported by the LOD calibration example. */
export interface MonsterLevels {
  /** The full level, or `null` to keep the model as it is. */
  base: SimplifyParams | null;
  lods: readonly SimplifyParams[];
}

const MERGED_ATTRIBUTES = ['position', 'normal', 'uv', 'skinIndex', 'skinWeight'];

export interface MonsterKind {
  name: string;
  model: string;
  textures: readonly string[];
}

export const KINDS: readonly MonsterKind[] = [
  { name: 'Imp', model: 'Imp.glb', textures: ['T_Imp_BaseColor_1.png', 'T_Imp_BaseColor_2.png', 'T_Imp_BaseColor_3.png'] },
  { name: 'Puglin', model: 'Puglin.glb', textures: ['T_Puglin_BaseColor_1.png', 'T_Puglin_BaseColor_2.png', 'T_Puglin_BaseColor_3.png'] }
];

/** One monster type (Quaternius Bestiary): merged geometry and its levels, the rig, the exported material, its three skins and the clips baked once. */
export interface MonsterAsset {
  kind: MonsterKind;
  skeleton: Skeleton;
  bindMatrix: Matrix4;
  bindMode: BindMode;
  geometry: BufferGeometry;
  lods: BufferGeometry[];
  shadowLod: BufferGeometry | null;
  material: MeshStandardMaterial;
  /** The base-color variants as the layers of one sRGB array texture. */
  skins: DataArrayTexture;
  bake: SkeletalAnimationBake;
  /** Duration in seconds of each clip, indexed like `MonsterOptions.clips`. */
  durations: number[];
}

/** Loads both monsters and the animation library, retargets the clips onto each rig, bakes them and builds the levels. */
export async function loadMonsters(options: MonsterOptions): Promise<MonsterAsset[]> {
  const loader = new GLTFLoader();
  const textures = new TextureLoader();
  const [library, models, variants] = await Promise.all([
    loader.loadAsync(`${assetBase}UAL1_Standard.glb`),
    Promise.all(KINDS.map(async (kind) => loader.loadAsync(`${assetBase}${kind.model}`))),
    Promise.all(KINDS.map(async (kind) => Promise.all(kind.textures.map(async (file) => textures.loadAsync(`${assetBase}${file}`)))))
  ]);
  const mannequinPelvis = pelvisHeight(library.scene);

  return Promise.all(KINDS.map(async (kind, index) => createMonster(kind, models[index], variants[index], library, mannequinPelvis, options)));
}

async function createMonster(kind: MonsterKind, model: GLTF, variants: Texture[], library: GLTF, mannequinPelvis: number, options: MonsterOptions): Promise<MonsterAsset> {
  const root = model.scene;
  const meshes: SkinnedMesh[] = [];
  root.traverse((object) => {
    if ((object as Partial<SkinnedMesh>).isSkinnedMesh === true) meshes.push(object as SkinnedMesh);
  });
  const source = meshes[0];
  const geometry = mergeSkinnedGeometries(meshes);
  for (let i = 0, l = meshes.length; i < l; i++) meshes[i].removeFromParent();
  root.updateMatrixWorld(true);

  const bones = new Set<string>();
  root.traverse((object) => bones.add(object.name));
  const ratio = pelvisHeight(root) / mannequinPelvis;
  const bake = new SkeletalAnimationBake(source.skeleton);
  const durations: number[] = [];
  for (let i = 0, l = options.clips.length; i < l; i++) {
    const clip = retargetClip(findClip(library, options.clips[i]), bones, ratio);
    bake.addClip(root, clip, options.framesPerSecond);
    durations.push(clip.duration);
  }

  const skins = createDataArrayTexture(variants);
  for (let i = 0, l = variants.length; i < l; i++) variants[i].dispose();

  const shadowRatio = options.shadowRatio;
  const baseRatio = options.baseRatio;
  const last = options.lodErrors.length - 1;
  const calibrated = options.levels?.[kind.name];
  const baseParams = calibrated !== undefined ? calibrated.base : baseRatio === null ? null : { ratio: baseRatio, error: 1, lockBorder: true };
  const lodParams = calibrated?.lods ?? options.lodErrors.map((error, level) => ({ ratio: 0, error, prune: level === last }));
  const [base, lods, shadowLod] = await Promise.all([
    baseParams === null ? geometry : simplifyGeometry(geometry, baseParams).then(compactGeometry),
    Promise.all(lodParams.map(async (params) => simplifyGeometry(geometry, params).then(compactGeometry))),
    shadowRatio === null ? null : simplifyGeometry(geometry, { ratio: shadowRatio, error: 1, prune: true }).then(compactGeometry)
  ]);

  return {
    kind,
    skeleton: source.skeleton,
    bindMatrix: source.bindMatrix.clone(),
    bindMode: source.bindMode,
    geometry: base,
    lods,
    shadowLod,
    material: source.material as MeshStandardMaterial,
    skins,
    bake,
    durations
  };
}

/**
 * Merges the parts of a model bound to one skeleton into one indexed geometry with the attributes skinning and lighting read:
 * `skinIndex` as 16-bit integers and every other attribute as floats, so the parts merge whatever their glTF component types.
 */
function mergeSkinnedGeometries(meshes: SkinnedMesh[]): BufferGeometry {
  const parts: BufferGeometry[] = [];
  for (let i = 0, l = meshes.length; i < l; i++) {
    const source = meshes[i].geometry;
    const part = new BufferGeometry();
    for (let a = 0, m = MERGED_ATTRIBUTES.length; a < m; a++) {
      const name = MERGED_ATTRIBUTES[a];
      const attribute = source.getAttribute(name);
      const values = name === 'skinIndex' ? new Uint16Array(attribute.count * attribute.itemSize) : new Float32Array(attribute.count * attribute.itemSize);
      for (let v = 0; v < attribute.count; v++) {
        for (let c = 0; c < attribute.itemSize; c++) values[v * attribute.itemSize + c] = attribute.getComponent(v, c);
      }
      part.setAttribute(name, new BufferAttribute(values, attribute.itemSize));
    }
    const index = source.getIndex();
    part.setIndex(index === null ? null : new BufferAttribute(new Uint32Array(index.array), 1));
    parts.push(part);
  }
  const merged = mergeGeometries(parts);
  merged.computeBoundingBox();
  merged.computeBoundingSphere();
  return merged;
}

/**
 * Keeps only the vertices the index references, in order of first use: simplification rewrites the index but keeps every vertex
 * of the model, so a far level would otherwise carry, bound and skin-reduce thousands of vertices it never draws.
 */
function compactGeometry(geometry: BufferGeometry): BufferGeometry {
  const index = geometry.getIndex();
  if (index === null) return geometry;
  const vertexCount = geometry.getAttribute('position').count;
  const remap = new Int32Array(vertexCount).fill(-1);
  const indices = new Uint32Array(index.count);
  let used = 0;
  for (let i = 0; i < index.count; i++) {
    const vertex = index.getX(i);
    if (remap[vertex] === -1) remap[vertex] = used++;
    indices[i] = remap[vertex];
  }
  const compact = new BufferGeometry();
  for (const name of Object.keys(geometry.attributes)) {
    const source = geometry.getAttribute(name);
    const size = source.itemSize;
    const values = name === 'skinIndex' ? new Uint16Array(used * size) : new Float32Array(used * size);
    for (let v = 0; v < vertexCount; v++) {
      const target = remap[v];
      if (target === -1) continue;
      for (let c = 0; c < size; c++) values[target * size + c] = source.getComponent(v, c);
    }
    compact.setAttribute(name, new BufferAttribute(values, size, source.normalized));
  }
  compact.setIndex(new BufferAttribute(indices, 1));
  compact.computeBoundingBox();
  compact.computeBoundingSphere();
  geometry.dispose();
  return compact;
}

/**
 * Keeps the rotations of the bones the rig has and the pelvis translation scaled by the ratio of the pelvis heights, so a clip of
 * the library mannequin plays on a monster of another size. The source clip is not modified.
 */
function retargetClip(clip: AnimationClip, bones: ReadonlySet<string>, pelvisRatio: number): AnimationClip {
  const tracks: KeyframeTrack[] = [];
  for (let i = 0, l = clip.tracks.length; i < l; i++) {
    const track = clip.tracks[i];
    const dot = track.name.lastIndexOf('.');
    const node = track.name.slice(0, dot);
    const property = track.name.slice(dot + 1);
    if (!bones.has(node)) continue;
    if (property === 'quaternion') tracks.push(track.clone());
    if (property !== 'position' || node !== 'pelvis') continue;
    const copy = track.clone();
    for (let j = 0, m = copy.values.length; j < m; j++) copy.values[j] *= pelvisRatio;
    tracks.push(copy);
  }
  return new AnimationClip(clip.name, clip.duration, tracks);
}

/** World height of the object named `pelvis` in the rest pose. */
function pelvisHeight(root: Object3D): number {
  const pelvis = root.getObjectByName('pelvis');
  if (pelvis === undefined) throw new Error('The rig has no pelvis.');
  root.updateMatrixWorld(true);
  return pelvis.matrixWorld.elements[13];
}

function findClip(gltf: GLTF, name: string): AnimationClip {
  const clip = gltf.animations.find((animation) => animation.name === name);
  if (clip === undefined) throw new Error(`Animation "${name}" not found.`);
  return clip;
}
