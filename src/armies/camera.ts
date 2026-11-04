import type { PerspectiveCamera } from 'three';
import type { MapControls } from 'three/addons/controls/MapControls.js';

/** Seconds without input before the camera takes over, its orbit speed (`autoRotateSpeed`) and how fast it follows the fight (1/s). */
const IDLE_TIME = 6;
const ORBIT_SPEED = 0.6;
const FOLLOW_RATE = 0.35;

/** Point on the ground the camera should look at. */
export interface CameraFocus {
  x: number;
  z: number;
}

/**
 * A director for the map controls: after {@link IDLE_TIME} seconds without input the camera orbits slowly and drifts toward the
 * focus of the battle, keeping its distance and height; any touch, drag or wheel gives control back at once.
 */
export class CinematicCamera {
  public enabled = true;
  private _idle = 0;
  private _interacting = false;

  public constructor(private readonly _camera: PerspectiveCamera, private readonly _controls: MapControls) {
    _controls.autoRotateSpeed = ORBIT_SPEED;
    _controls.addEventListener('start', () => {
      this._interacting = true;
    });
    _controls.addEventListener('end', () => {
      this._interacting = false;
      this._idle = 0;
    });
  }

  /** Call before `controls.update`. */
  public update(delta: number, focus: CameraFocus): void {
    const controls = this._controls;
    if (!this.enabled || this._interacting) {
      this._idle = 0;
      controls.autoRotate = false;
      return;
    }
    this._idle += delta;
    const active = this._idle > IDLE_TIME;
    controls.autoRotate = active;
    if (!active) return;
    const blend = 1 - Math.exp(-FOLLOW_RATE * delta);
    const dx = (focus.x - controls.target.x) * blend;
    const dz = (focus.z - controls.target.z) * blend;
    controls.target.x += dx;
    controls.target.z += dz;
    this._camera.position.x += dx;
    this._camera.position.z += dz;
  }
}
