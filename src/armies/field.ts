import { CanvasTexture, Mesh, MeshBasicMaterial, MeshLambertMaterial, PlaneGeometry, SRGBColorSpace } from 'three';
import { InstancedMesh2 } from '@three.ez/instanced-mesh';
import { SUN_DIRECTION } from './scenery.js';

/** Pixels of the ground marks texture per side, and the shortest time between two uploads of it, in milliseconds. */
const MARKS_SIZE = 512;
const MARKS_UPLOAD_INTERVAL = 400;

/**
 * Soft dark ovals under the monsters, stretched away from the sun: a cheap stand-in for shadow maps; one instance per monster,
 * moved with it.
 */
export function createBlobShadows(count: number): InstancedMesh2 {
  const geometry = new PlaneGeometry(1.3, 2.3);
  geometry.translate(0, 0.45, 0);
  geometry.rotateX(-Math.PI / 2);
  geometry.rotateY(Math.atan2(SUN_DIRECTION.x, SUN_DIRECTION.z));
  geometry.translate(0, 0.05, 0);
  const material = new MeshBasicMaterial({ map: createBlobTexture(), transparent: true, depthWrite: false, color: 0x000000, opacity: 0.55 });
  const blobs = new InstancedMesh2(geometry, material, { capacity: count });
  blobs.renderOrder = -1;
  return blobs;
}

/**
 * Trampled earth left where blows land and monsters fall: a transparent texture over the battlefield, drawn on a canvas and
 * uploaded at most every {@link MARKS_UPLOAD_INTERVAL} ms while it changes; cleared when a battle starts.
 */
export class GroundMarks {
  public readonly mesh: Mesh;
  private readonly _context: CanvasRenderingContext2D;
  private readonly _texture: CanvasTexture;
  private _dirty = false;
  private _uploadAt = 0;

  public constructor(private readonly _halfWidth: number, private readonly _halfDepth: number) {
    const canvas = document.createElement('canvas');
    canvas.width = MARKS_SIZE;
    canvas.height = MARKS_SIZE;
    const context = canvas.getContext('2d');
    if (context === null) throw new Error('Canvas 2D is unavailable.');
    this._context = context;
    this._texture = new CanvasTexture(canvas);
    this._texture.colorSpace = SRGBColorSpace;
    const material = new MeshLambertMaterial({ map: this._texture, transparent: true, depthWrite: false });
    this.mesh = new Mesh(new PlaneGeometry(_halfWidth * 2, _halfDepth * 2), material);
    this.mesh.rotation.x = -Math.PI / 2;
    this.mesh.position.y = 0.03;
    this.mesh.renderOrder = -2;
  }

  /** Darkens the ground around (`x`, `z`) within about `radius` meters, by `strength` in [0, 1]. */
  public mark(x: number, z: number, radius: number, strength: number): void {
    const u = (x / this._halfWidth + 1) * 0.5 * MARKS_SIZE;
    const v = (z / this._halfDepth + 1) * 0.5 * MARKS_SIZE;
    const r = radius / this._halfWidth * 0.5 * MARKS_SIZE;
    const context = this._context;
    for (let i = 0; i < 3; i++) {
      const cu = u + (i - 1) * r * 0.45;
      const cv = v + ((i * 7) % 3 - 1) * r * 0.35;
      const gradient = context.createRadialGradient(cu, cv, 0, cu, cv, r);
      gradient.addColorStop(0, `rgba(74, 52, 30, ${String(strength * 0.6)})`);
      gradient.addColorStop(1, 'rgba(74, 52, 30, 0)');
      context.fillStyle = gradient;
      context.fillRect(cu - r, cv - r, r * 2, r * 2);
    }
    this._dirty = true;
  }

  public clear(): void {
    this._context.clearRect(0, 0, MARKS_SIZE, MARKS_SIZE);
    this._dirty = true;
  }

  /** Uploads the marks drawn since the last upload, unless the previous one was too recent. */
  public flush(now: number): void {
    if (!this._dirty || now < this._uploadAt) return;
    this._texture.needsUpdate = true;
    this._dirty = false;
    this._uploadAt = now + MARKS_UPLOAD_INTERVAL;
  }
}

function createBlobTexture(): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const context = canvas.getContext('2d');
  if (context === null) throw new Error('Canvas 2D is unavailable.');
  const gradient = context.createRadialGradient(32, 32, 0, 32, 32, 32);
  gradient.addColorStop(0, 'rgba(255, 255, 255, 1)');
  gradient.addColorStop(0.55, 'rgba(255, 255, 255, 0.55)');
  gradient.addColorStop(1, 'rgba(255, 255, 255, 0)');
  context.fillStyle = gradient;
  context.fillRect(0, 0, 64, 64);
  return new CanvasTexture(canvas);
}
