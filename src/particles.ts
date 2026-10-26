import {
  AddEquation, Color, CustomBlending, DataTexture, LinearMipmapLinearFilter, Matrix4, MeshBasicMaterial, OneFactor, OneMinusSrcAlphaFactor,
  PlaneGeometry, Quaternion, RGBAFormat, Vector3
} from 'three';
import type { Camera } from 'three';
import { InstancedMesh2 } from '@three.ez/instanced-mesh';
import type { Ship } from './ship.js';

const capacity = 2048;
/** Per ID: position (3), velocity or beam end (3), age, life, start size, end size, roll, spin, peak alpha, style. */
const stride = 14;

interface Style {
  /** Additive particles write alpha 0: with premultiplied blending they only add light. */
  additive: boolean;
  /** Fraction of the life spent fading in. */
  fadeIn: number;
  /** Velocity damping per second. */
  drag: number;
  start: Color;
  end: Color;
}

const flame = 0;
const smoke = 1;
const flash = 2;
const spark = 3;
const dust = 4;
const beam = 5;
const styles: Style[] = [
  { additive: true, fadeIn: 0.05, drag: 1.5, start: new Color(0.75, 0.92, 1), end: new Color(0.15, 0.35, 1) },
  { additive: false, fadeIn: 0.12, drag: 1.5, start: new Color(0.62, 0.74, 0.9), end: new Color(0.42, 0.44, 0.5) },
  { additive: true, fadeIn: 0.04, drag: 0, start: new Color(1.4, 1.05, 0.7), end: new Color(1, 0.3, 0.05) },
  { additive: true, fadeIn: 0.02, drag: 2.5, start: new Color(1.3, 0.8, 0.4), end: new Color(1, 0.25, 0.05) },
  { additive: false, fadeIn: 0.08, drag: 1.2, start: new Color(0.55, 0.48, 0.42), end: new Color(0.3, 0.3, 0.33) },
  { additive: true, fadeIn: 0, drag: 0, start: new Color(1.3, 0.7, 0.3), end: new Color(1, 0.35, 0.1) }
];

const matrix = new Matrix4();
const position = new Vector3();
const quaternion = new Quaternion();
const roll = new Quaternion();
const scale = new Vector3();
const color = new Color();
const axisX = new Vector3();
const axisY = new Vector3();
const axisZ = new Vector3();
const toCamera = new Vector3();

/**
 * All the visual effects in one InstancedMesh2, so one draw call: engine flame and smoke, explosion flash, sparks and dust,
 * laser beams. Camera-facing soft quads added and removed every frame and sorted back-to-front. Additive and translucent
 * particles share one material through premultiplied-alpha blending (`ONE, ONE_MINUS_SRC_ALPHA`): per-instance color is
 * premultiplied by the particle alpha and per-instance opacity is the alpha, or 0 for additive particles.
 */
export class Particles {
  public readonly mesh: InstancedMesh2;
  private readonly _ship: Ship;
  private readonly _state = new Float32Array(capacity * stride);
  private readonly _active = new Int32Array(capacity);
  private _activeCount = 0;
  private readonly _expired: number[] = [];
  private _flameTime = 0;
  private _smokeTime = 0;
  private readonly _origins = [new Vector3(), new Vector3()];
  private readonly _previous = [new Vector3(), new Vector3()];
  private _hasPrevious = false;
  private readonly _backward = new Vector3();
  private readonly _muzzle = new Vector3();
  /** Spawn arguments, read by the shared `addInstances` callback. */
  private _spawnStyle = 0;
  private _spawnIndex = 0;
  private _spawnDelta = 0;
  private readonly _spawnAt = new Vector3();
  private _spawnSize = 1;
  private readonly _spawnCallback: (instance: unknown, id: number) => void;

  public constructor(ship: Ship) {
    this._ship = ship;
    const material = new MeshBasicMaterial({
      map: createSoftTexture(),
      transparent: true,
      depthWrite: false,
      fog: false,
      blending: CustomBlending,
      blendEquation: AddEquation,
      blendSrc: OneFactor,
      blendDst: OneMinusSrcAlphaFactor
    });
    this.mesh = new InstancedMesh2(new PlaneGeometry(1, 1), material, { capacity, maxCapacity: capacity });
    this.mesh.sortObjects = true;
    this.mesh.frustumCulled = false;
    this._spawnCallback = (_instance, id) => this.init(id);
  }

  public get count(): number {
    return this._activeCount;
  }

  /** Moves every particle along Z, when the ship crosses the seam of the periodic field. */
  public shiftZ(offset: number): void {
    for (let i = 0; i < this._previous.length; i++) this._previous[i].z += offset;
    const state = this._state;
    for (let i = 0; i < this._activeCount; i++) {
      const o = this._active[i] * stride;
      state[o + 2] += offset;
      if (state[o + 13] === beam) state[o + 5] += offset;
    }
  }

  /** Explosion of an asteroid of radius `size`: flash, sparks and a dust cloud. */
  public explode(at: Vector3, size: number): void {
    this._spawnAt.copy(at);
    this._spawnSize = size;
    this.spawn(flash, 1, 0);
    this.spawn(spark, Math.min(24, 6 + Math.round(size * 2)), 0);
    this.spawn(dust, Math.min(14, 4 + Math.round(size)), 0);
  }

  /** Laser beam from the ship muzzle to `to`; its start follows the muzzle while it fades. */
  public beam(to: Vector3): void {
    this._spawnAt.copy(to);
    this.spawn(beam, 1, 0);
  }

  public update(delta: number, camera: Camera): void {
    this.age(delta);
    this.emitExhaust(delta);
    const ship = this._ship;
    ship.localToWorld(this._muzzle.copy(ship.muzzle));
    const active = this._active;
    for (let i = 0; i < this._activeCount; i++) this.write(active[i], camera);
  }

  private age(delta: number): void {
    const state = this._state;
    const active = this._active;
    const expired = this._expired;
    expired.length = 0;
    for (let i = 0; i < this._activeCount; i++) {
      const id = active[i];
      const o = id * stride;
      state[o + 6] += delta;
      if (state[o + 6] >= state[o + 7]) {
        expired.push(id);
        active[i--] = active[--this._activeCount];
        continue;
      }
      if (state[o + 13] === beam) continue;
      const drag = Math.exp(-styles[state[o + 13]].drag * delta);
      state[o + 3] *= drag;
      state[o + 4] *= drag;
      state[o + 5] *= drag;
      state[o] += state[o + 3] * delta;
      state[o + 1] += state[o + 4] * delta;
      state[o + 2] += state[o + 5] * delta;
    }
    if (expired.length > 0) this.mesh.removeInstances(...expired);
  }

  private emitExhaust(delta: number): void {
    const ship = this._ship;
    ship.updateMatrixWorld();
    const origins = this._origins;
    const previous = this._previous;
    for (let i = 0; i < origins.length; i++) {
      ship.localToWorld(origins[i].copy(ship.nozzles[i]));
      if (!this._hasPrevious) previous[i].copy(origins[i]);
    }
    this._hasPrevious = true;
    this._backward.copy(ship.heading).negate();

    this._flameTime += delta;
    const flames = Math.floor(this._flameTime / 0.003);
    this._flameTime -= flames * 0.003;
    this.spawn(flame, flames * origins.length, delta);

    this._smokeTime += delta;
    const puffs = Math.floor(this._smokeTime / 0.009);
    this._smokeTime -= puffs * 0.009;
    this.spawn(smoke, puffs * origins.length, delta);

    for (let i = 0; i < origins.length; i++) previous[i].copy(origins[i]);
  }

  private spawn(style: number, count: number, delta: number): void {
    const allowed = Math.min(count, capacity - this._activeCount);
    if (allowed <= 0) return;
    this._spawnStyle = style;
    this._spawnIndex = 0;
    this._spawnDelta = delta;
    this.mesh.addInstances(allowed, this._spawnCallback);
  }

  private init(id: number): void {
    const state = this._state;
    const o = id * stride;
    const style = this._spawnStyle;
    const at = this._spawnAt;
    const size = this._spawnSize;
    let age = 0;
    state[o + 10] = Math.random() * Math.PI * 2;
    state[o + 11] = (Math.random() - 0.5) * 2;
    state[o + 13] = style;

    if (style === flame || style === smoke) {
      // A random point on the path the nozzle covered this frame; the particle is as old as the time since it passed there.
      const nozzle = this._spawnIndex % this._origins.length;
      const along = Math.random();
      position.lerpVectors(this._origins[nozzle], this._previous[nozzle], along);
      age = along * this._spawnDelta;
      const backward = this._backward;
      const speed = style === flame ? random(10, 20) : random(2, 6);
      const spread = style === flame ? 2 : 5;
      state[o + 3] = backward.x * speed + (Math.random() - 0.5) * spread;
      state[o + 4] = backward.y * speed + (Math.random() - 0.5) * spread;
      state[o + 5] = backward.z * speed + (Math.random() - 0.5) * spread;
      state[o + 7] = style === flame ? random(0.05, 0.11) : random(1.1, 2);
      state[o + 8] = style === flame ? random(1.4, 1.9) : random(1, 1.6);
      state[o + 9] = style === flame ? random(0.3, 0.6) : random(4.5, 8);
      state[o + 12] = style === flame ? random(0.55, 0.9) : random(0.4, 0.7);
    } else if (style === beam) {
      position.copy(this._muzzle);
      state[o + 3] = at.x;
      state[o + 4] = at.y;
      state[o + 5] = at.z;
      state[o + 7] = 0.16;
      state[o + 8] = 1.2;
      state[o + 9] = 0;
      state[o + 12] = 1;
    } else {
      position.copy(at);
      axisX.randomDirection();
      const speed = style === flash ? 0 : style === spark ? random(20, 60) * Math.sqrt(size) : random(2, 8) * Math.sqrt(size);
      state[o + 3] = axisX.x * speed;
      state[o + 4] = axisX.y * speed;
      state[o + 5] = axisX.z * speed;
      if (style === dust) position.addScaledVector(axisX, size * 0.5);
      state[o + 7] = style === flash ? 0.4 : style === spark ? random(0.3, 0.6) : random(1.2, 2.2);
      state[o + 8] = style === flash ? size * 1.5 : style === spark ? random(0.5, 1) * Math.sqrt(size) : size * random(0.6, 1);
      state[o + 9] = style === flash ? size * 4 : style === spark ? 0.1 : size * random(2.2, 3.2);
      state[o + 12] = style === flash ? 1 : style === spark ? 1 : random(0.35, 0.55);
    }

    state[o] = position.x + state[o + 3] * age;
    state[o + 1] = position.y + state[o + 4] * age;
    state[o + 2] = position.z + state[o + 5] * age;
    if (style === beam) {
      state[o] = position.x;
      state[o + 1] = position.y;
      state[o + 2] = position.z;
    }
    state[o + 6] = age;
    this._active[this._activeCount++] = id;
    this._spawnIndex++;
  }

  private write(id: number, camera: Camera): void {
    const state = this._state;
    const o = id * stride;
    const kind = state[o + 13];
    const style = styles[kind];
    const age = state[o + 6];
    const t = age / state[o + 7];
    const eased = 1 - (1 - t) * (1 - t);
    const size = state[o + 8] + (state[o + 9] - state[o + 8]) * eased;

    if (kind === beam) {
      // Quad stretched from the muzzle to the end point, turned around its axis to face the camera.
      const muzzle = this._muzzle;
      axisY.set(state[o + 3] - muzzle.x, state[o + 4] - muzzle.y, state[o + 5] - muzzle.z);
      const length = axisY.length();
      axisY.divideScalar(length);
      position.copy(muzzle).addScaledVector(axisY, length / 2);
      toCamera.subVectors(camera.position, position);
      axisX.crossVectors(axisY, toCamera).normalize();
      axisZ.crossVectors(axisX, axisY);
      matrix.makeBasis(axisX.multiplyScalar(size), axisY.multiplyScalar(length), axisZ).setPosition(position);
    } else {
      const angle = (state[o + 10] + state[o + 11] * age) * 0.5;
      roll.set(0, 0, Math.sin(angle), Math.cos(angle));
      quaternion.copy(camera.quaternion).multiply(roll);
      position.set(state[o], state[o + 1], state[o + 2]);
      scale.set(size, size, size);
      matrix.compose(position, quaternion, scale);
    }
    this.mesh.setMatrixAt(id, matrix);

    const fade = t < style.fadeIn ? t / style.fadeIn : (1 - t) / (1 - style.fadeIn);
    const alpha = state[o + 12] * fade * fade;
    color.copy(style.start).lerp(style.end, Math.min(1, t * 1.5)).multiplyScalar(alpha);
    this.mesh.setColorAt(id, color);
    this.mesh.setOpacityAt(id, style.additive ? 0 : alpha);
  }
}

function random(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

/** Soft, slightly cloudy round mask, premultiplied: rgb = alpha. */
function createSoftTexture(): DataTexture {
  const size = 128;
  const data = new Uint8Array(size * size * 4);
  const blobs: number[] = [];
  for (let i = 0; i < 10; i++) blobs.push(Math.random() * size, Math.random() * size, size * (0.12 + Math.random() * 0.15));
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x + 0.5) / size * 2 - 1;
      const dy = (y + 0.5) / size * 2 - 1;
      const radial = Math.max(0, 1 - Math.sqrt(dx * dx + dy * dy));
      let cloud = 0;
      for (let b = 0; b < blobs.length; b += 3) {
        const bx = (x - blobs[b]) / blobs[b + 2];
        const by = (y - blobs[b + 1]) / blobs[b + 2];
        cloud += Math.exp(-(bx * bx + by * by));
      }
      const value = Math.min(1, radial * radial * (0.7 + 0.3 * Math.min(1, cloud))) * 255;
      const k = (y * size + x) * 4;
      data[k] = data[k + 1] = data[k + 2] = data[k + 3] = value;
    }
  }
  const texture = new DataTexture(data, size, size, RGBAFormat);
  texture.minFilter = LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}
