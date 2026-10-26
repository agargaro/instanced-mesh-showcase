import { Vector3 } from 'three';
import type { PerspectiveCamera } from 'three';

const duration = 7;
/** Camera offset from the ship at the start: front-right of the ship, looking back at it. */
const startOffset = new Vector3(36, 9, 46);
const position = new Vector3();
const target = new Vector3();

/** Smootherstep easing in [0, 1]. */
function ease(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return x * x * x * (x * (x * 6 - 15) + 10);
}

/**
 * Opening shot for videos: the camera starts beside the ship, swings around it to the chase position while the title and a
 * counter of the instances appear, then hands over to the game camera. Any input skips it.
 */
export class Intro {
  public active: boolean;
  private _time = 0;
  private readonly _overlay: HTMLElement;
  private readonly _counter: HTMLElement;
  private readonly _drawCalls: HTMLElement;
  private readonly _total: number;

  public constructor(enabled: boolean, total: number) {
    this.active = enabled;
    this._total = total;
    this._overlay = document.getElementById('intro') as HTMLElement;
    this._counter = document.getElementById('intro-count') as HTMLElement;
    this._drawCalls = document.getElementById('intro-calls') as HTMLElement;
    document.body.classList.toggle('intro', enabled);
    this._overlay.hidden = !enabled;
  }

  public skip(): void {
    if (!this.active) return;
    this._time = duration;
  }

  /** Moves the camera along the opening shot. Returns `false` once the intro is over. */
  public update(delta: number, camera: PerspectiveCamera, ship: Vector3, chaseOffset: Vector3, chaseLook: Vector3, drawCalls: number): boolean {
    if (!this.active) return false;
    this._time += delta;
    const t = ease(this._time / duration);

    // Swing around the ship on a horizontal arc, closing in and lowering to the chase offset.
    const startAngle = Math.atan2(startOffset.x, startOffset.z);
    const endAngle = Math.atan2(chaseOffset.x, chaseOffset.z);
    const angle = startAngle + (endAngle - startAngle) * t;
    const startRadius = Math.hypot(startOffset.x, startOffset.z);
    const endRadius = Math.hypot(chaseOffset.x, chaseOffset.z);
    const radius = startRadius + (endRadius - startRadius) * t;
    position.set(Math.sin(angle) * radius, startOffset.y + (chaseOffset.y - startOffset.y) * t, Math.cos(angle) * radius);
    camera.position.copy(ship).add(position);
    target.copy(chaseLook).multiplyScalar(t).add(ship);
    camera.lookAt(target);

    const counted = Math.round(this._total * ease(this._time / 3));
    this._counter.textContent = counted.toLocaleString('en-US');
    this._drawCalls.textContent = String(drawCalls);
    this._overlay.style.opacity = String(Math.min(1, this._time / 0.6, (duration - this._time) / 0.8));

    if (this._time >= duration) {
      this.active = false;
      this._overlay.hidden = true;
      document.body.classList.remove('intro');
      camera.position.copy(ship).add(chaseOffset);
      camera.lookAt(target.copy(ship).add(chaseLook));
    }
    return this.active;
  }
}
