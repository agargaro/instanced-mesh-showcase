import { Color, Matrix4, MeshStandardMaterial, Quaternion, Vector3 } from 'three';
import type { BufferGeometry } from 'three';
import { InstancedMesh2 } from '@three.ez/instanced-mesh';

const debrisCapacity = 4096;
const matrix = new Matrix4();
const position = new Vector3();
const quaternion = new Quaternion();
const scale = new Vector3();
const axis = new Vector3();
const heat = new Color();
const hot = new Color(1, 0.42, 0.1);

/** Hot rock fragments: one InstancedMesh2 with a per-instance emissive uniform that cools down over time. */
export class Debris {
  public readonly mesh: InstancedMesh2;
  private readonly _state = new Float32Array(debrisCapacity * 12);
  private readonly _active = new Int32Array(debrisCapacity);
  private _activeCount = 0;
  private readonly _expired: number[] = [];
  private readonly _spawned: number[] = [];

  public constructor(geometry: BufferGeometry) {
    this.mesh = new InstancedMesh2(geometry, new MeshStandardMaterial({ color: 0x8c8c8c, roughness: 0.9 }), { capacity: debrisCapacity, maxCapacity: debrisCapacity });
    this.mesh.initUniformsPerInstance({ fragment: { emissive: 'vec3' } });
    this.mesh.frustumCulled = false;
    // Create the color buffer now: the first setColorAt otherwise changes the shader during the first explosion.
    let warmId = 0;
    this.mesh.addInstances(1, (instance, id) => {
      instance.color = heat.setRGB(1, 1, 1);
      warmId = id;
    });
    this.mesh.removeInstances(warmId);
  }

  public get count(): number {
    return this._activeCount;
  }

  public spawn(origin: Vector3, size: number, color: Color): void {
    const free = debrisCapacity - this._activeCount;
    const count = Math.min(Math.round(10 + size * 7), 80, free);
    if (count <= 0) return;
    const spawned = this._spawned;
    spawned.length = 0;
    this.mesh.addInstances(count, (instance, id) => {
      instance.color = color;
      spawned.push(id);
    });
    const state = this._state;
    for (let i = 0; i < count; i++) {
      const id = spawned[i];
      const o = id * 12;
      axis.randomDirection();
      const speed = (2 + Math.random() * 8) * Math.sqrt(size);
      state[o] = origin.x + axis.x * size * 0.4;
      state[o + 1] = origin.y + axis.y * size * 0.4;
      state[o + 2] = origin.z + axis.z * size * 0.4;
      state[o + 3] = axis.x * speed;
      state[o + 4] = axis.y * speed;
      state[o + 5] = axis.z * speed;
      axis.randomDirection();
      state[o + 6] = axis.x;
      state[o + 7] = axis.y;
      state[o + 8] = axis.z;
      state[o + 9] = (Math.random() - 0.5) * 8;
      state[o + 10] = size * (0.04 + Math.random() * 0.1);
      state[o + 11] = 1.5 + Math.random() * 2.5;
      this._active[this._activeCount++] = id;
    }
  }

  /** Moves every fragment along Z, when the ship crosses the seam of the periodic field. */
  public shiftZ(offset: number): void {
    const state = this._state;
    for (let i = 0; i < this._activeCount; i++) state[this._active[i] * 12 + 2] += offset;
  }

  public update(delta: number, elapsed: number): void {
    const state = this._state;
    const active = this._active;
    const mesh = this.mesh;
    const expired = this._expired;
    expired.length = 0;
    for (let i = 0; i < this._activeCount; i++) {
      const id = active[i];
      const o = id * 12;
      state[o + 11] -= delta;
      const life = state[o + 11];
      if (life <= 0) {
        expired.push(id);
        active[i--] = active[--this._activeCount];
        continue;
      }
      const drag = Math.exp(-0.4 * delta);
      state[o + 3] *= drag;
      state[o + 4] *= drag;
      state[o + 5] *= drag;
      state[o] += state[o + 3] * delta;
      state[o + 1] += state[o + 4] * delta;
      state[o + 2] += state[o + 5] * delta;
      position.set(state[o], state[o + 1], state[o + 2]);
      axis.set(state[o + 6], state[o + 7], state[o + 8]);
      quaternion.setFromAxisAngle(axis, state[o + 9] * elapsed);
      const s = state[o + 10] * Math.min(1, life * 2);
      scale.set(s, s, s);
      mesh.setMatrixAt(id, matrix.compose(position, quaternion, scale));
      const t = Math.max(0, Math.min(1, (life - 0.6) / 1.4));
      mesh.setUniformAt(id, 'emissive', heat.copy(hot).multiplyScalar(t * t * 2.5));
    }
    if (expired.length > 0) mesh.removeInstances(...expired);
  }
}
