import {
  BoxGeometry, BufferAttribute, CircleGeometry, DataTexture, ExtrudeGeometry, Group, LatheGeometry, Matrix4, Mesh, MeshStandardMaterial,
  NearestFilter, Quaternion, RGBAFormat, Shape, SphereGeometry, SRGBColorSpace, Vector2, Vector3
} from 'three';
import type { BufferGeometry } from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/** Largest angle between the flight direction and +Z. */
const maxAngle = 0.6;
const _direction = new Vector3();
const _matrix = new Matrix4();
const _origin = new Vector3();
const _up = new Vector3(0, 1, 0);
const _forward = new Vector3(0, 0, 1);
const _roll = new Quaternion();

/** Base colors (linear) of the parts. */
const hull = [0.62, 0.66, 0.72];
const panel = [0.32, 0.36, 0.42];
const dark = [0.06, 0.07, 0.09];
const accent = [1, 0.32, 0.06];
const glass = [0.02, 0.05, 0.12];

/** Texels of the emissive palette, addressed by the `uv.x` of each part. */
const glowNone = 0;
const glowEngine = 1;
const glowAccent = 2;
const glowCanopy = 3;
const glowCount = 4;

/**
 * Procedural spaceship flying along +Z (the nose is at +Z). Every part is merged in a single geometry with vertex colors
 * and an emissive palette texture, so the ship is one mesh, one material and one draw call.
 */
export class Ship extends Group {
  /** Constant flight speed, units per second. */
  public speed = 250;
  public readonly radius = 5;
  /** Engine nozzles in local space, where the exhaust is emitted. */
  /** Tip of the nose in local space, where shots start. */
  public readonly muzzle = new Vector3(0, 0, 6.6);
  public readonly nozzles = [new Vector3(1.55, -0.2, -4.6), new Vector3(-1.55, -0.2, -4.6)];
  private readonly _heading = new Vector3(0, 0, 1);
  private _bank = 0;

  public constructor() {
    super();
    const mesh = new Mesh(createShipGeometry(), createShipMaterial());
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.add(mesh);
  }

  /**
   * Turns towards `aim` (a world point) within `maxAngle` of +Z and moves forward. The ship stays within
   * `bounds` of the flight axis. Returns the distance travelled.
   */
  public advance(delta: number, aim: Vector3, bounds: Vector2): number {
    _direction.subVectors(aim, this.position);
    _direction.z = Math.max(_direction.z, 1);
    _direction.normalize();
    const limit = Math.sin(maxAngle);
    _direction.x = Math.max(-limit, Math.min(limit, _direction.x));
    _direction.y = Math.max(-limit, Math.min(limit, _direction.y));
    if (this.position.x > bounds.x && _direction.x > 0 || this.position.x < -bounds.x && _direction.x < 0) _direction.x = 0;
    if (this.position.y > bounds.y && _direction.y > 0 || this.position.y < -bounds.y && _direction.y < 0) _direction.y = 0;
    _direction.z = Math.sqrt(Math.max(0, 1 - _direction.x * _direction.x - _direction.y * _direction.y));

    const response = 1 - Math.exp(-3 * delta);
    this._heading.lerp(_direction, response).normalize();
    const bank = Math.max(-0.5, Math.min(0.5, -(_direction.x - this._heading.x) * 2.5));
    this._bank += (bank - this._bank) * response;
    _matrix.lookAt(this._heading, _origin, _up);
    this.quaternion.setFromRotationMatrix(_matrix).multiply(_roll.setFromAxisAngle(_forward, this._bank));

    const distance = this.speed * delta;
    this.position.addScaledVector(this._heading, distance);
    return distance;
  }

  /** Unit flight direction. */
  public get heading(): Vector3 {
    return this._heading;
  }
}

function createShipMaterial(): MeshStandardMaterial {
  const data = new Uint8Array([
    0, 0, 0, 255,
    120, 210, 255, 255,
    255, 110, 30, 255,
    40, 110, 255, 255
  ]);
  const emissiveMap = new DataTexture(data, glowCount, 1, RGBAFormat);
  emissiveMap.magFilter = emissiveMap.minFilter = NearestFilter;
  emissiveMap.colorSpace = SRGBColorSpace;
  emissiveMap.needsUpdate = true;
  return new MeshStandardMaterial({ vertexColors: true, metalness: 0.6, roughness: 0.32, emissive: 0xffffff, emissiveMap, emissiveIntensity: 2 });
}

/** Non-indexed copy of a part with a constant vertex color and the emissive palette entry `glow`. */
function paint(geometry: BufferGeometry, color: number[], glow: number): BufferGeometry {
  const part = geometry.index !== null ? geometry.toNonIndexed() : geometry;
  const count = part.getAttribute('position').count;
  const colors = new Float32Array(count * 3);
  const uvs = new Float32Array(count * 2);
  const u = (glow + 0.5) / glowCount;
  for (let i = 0; i < count; i++) {
    colors[i * 3] = color[0];
    colors[i * 3 + 1] = color[1];
    colors[i * 3 + 2] = color[2];
    uvs[i * 2] = u;
    uvs[i * 2 + 1] = 0.5;
  }
  part.setAttribute('color', new BufferAttribute(colors, 3));
  part.setAttribute('uv', new BufferAttribute(uvs, 2));
  return part;
}

/** Lathe around +Z from (radius, z) pairs. */
function lathe(profile: number[], segments: number): BufferGeometry {
  const points: Vector2[] = [];
  for (let i = 0; i < profile.length; i += 2) points.push(new Vector2(profile[i], profile[i + 1]));
  return new LatheGeometry(points, segments).rotateX(Math.PI / 2);
}

/** Flat plate in the XZ plane from (x, z) pairs, `thickness` thick and slightly bevelled. */
function plate(outline: number[], thickness: number): BufferGeometry {
  const shape = new Shape();
  shape.moveTo(outline[0], outline[1]);
  for (let i = 2; i < outline.length; i += 2) shape.lineTo(outline[i], outline[i + 1]);
  const geometry = new ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: true, bevelThickness: 0.04, bevelSize: 0.04, bevelSegments: 1 });
  return geometry.translate(0, 0, -thickness / 2).rotateX(Math.PI / 2);
}

function createShipGeometry(): BufferGeometry {
  const parts: BufferGeometry[] = [];

  // Fuselage, flattened, with a dark spine stripe and a glowing accent band.
  parts.push(paint(lathe([0, -4.4, 0.75, -4.4, 1.05, -3.6, 1.2, -1, 1.05, 1.8, 0.7, 4, 0.3, 5.6, 0, 6.3], 24).scale(1.1, 0.75, 1), hull, glowNone));
  parts.push(paint(new BoxGeometry(0.35, 0.12, 6).translate(0, 0.88, -0.6), panel, glowNone));
  parts.push(paint(lathe([1.23, -1.6, 1.23, -1.25], 24).scale(1.1, 0.75, 1), accent, glowAccent));
  parts.push(paint(new SphereGeometry(0.72, 24, 14).scale(0.85, 0.62, 2.1).translate(0, 0.55, 1.7), glass, glowCanopy));

  for (let side = -1; side <= 1; side += 2) {
    // Swept wing with an orange tip and a dark trailing panel.
    parts.push(paint(plate([side * 0.9, 1.2, side * 5.4, -2.3, side * 5.7, -3.3, side * 0.9, -3.2], 0.16).translate(0, -0.25, 0), hull, glowNone));
    parts.push(paint(plate([side * 5.25, -2.1, side * 5.75, -2.5, side * 5.95, -3.35, side * 5.55, -3.35], 0.2).translate(0, -0.25, 0), accent, glowAccent));
    parts.push(paint(plate([side * 1.2, -2.6, side * 4.8, -3.0, side * 4.8, -3.2, side * 1.2, -3.15], 0.18).translate(0, -0.25, 0), panel, glowNone));

    // Engine nacelle with a dark intake and a glowing nozzle.
    const x = side * 1.55;
    parts.push(paint(lathe([0.5, -4.4, 0.6, -3.6, 0.62, -1.5, 0.52, -0.2, 0.3, 0.2], 18).translate(x, -0.2, 0), panel, glowNone));
    parts.push(paint(new CircleGeometry(0.42, 18).rotateY(Math.PI).translate(x, -0.2, -4.41), [0.4, 0.8, 1], glowEngine));
    parts.push(paint(new CircleGeometry(0.3, 18).translate(x, -0.2, 0.21), dark, glowNone));

    // Canted tail fin.
    parts.push(paint(plate([0, -1.6, 0, -3.9, 1.5, -4.2, 1.6, -3.3], 0.12).rotateZ(Math.PI / 2 - side * 0.35).translate(side * 0.75, 0.55, 0), hull, glowNone));
  }

  const geometry = mergeGeometries(parts);
  for (let i = 0; i < parts.length; i++) parts[i].dispose();
  if (geometry === null) throw new Error('Cannot merge the ship parts.');
  geometry.computeBoundingSphere();
  return geometry;
}
