import { CanvasTexture, EquirectangularReflectionMapping, SRGBColorSpace, Vector3 } from 'three';
import { Random } from './random.js';

const width = 4096;
const height = 2048;
/** Direction of the planet center and its angular radius. */
const planetDirection = new Vector3(-0.55, 0.12, 1).normalize();
const planetAngle = 0.34;
/** Spin axis of the planet, tilted, for its bands. */
const planetAxis = new Vector3(0.3, 1, 0.15).normalize();

/**
 * Equirectangular sky drawn once on a canvas: nebula, stars and a banded, sun-lit planet with an atmosphere rim. It is the
 * scene background, so the whole sky, planet included, costs a single draw call and no extra render pass.
 */
export function createSkyTexture(sunDirection: Vector3): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d') as CanvasRenderingContext2D;
  context.fillStyle = '#04060d';
  context.fillRect(0, 0, width, height);
  const nebula = context.createRadialGradient(1300, 900, 0, 1300, 900, 1100);
  nebula.addColorStop(0, 'rgba(90, 60, 140, 0.35)');
  nebula.addColorStop(1, 'rgba(0, 0, 0, 0)');
  context.fillStyle = nebula;
  context.fillRect(0, 0, width, height);
  const random = new Random(99);
  for (let i = 0; i < 9000; i++) {
    const x = random.next() * width;
    const y = height * (0.5 + Math.asin(random.range(-1, 1)) / Math.PI);
    const brightness = Math.pow(random.next(), 3);
    context.fillStyle = `rgba(${200 + random.next() * 55}, ${210 + random.next() * 45}, 255, ${0.25 + brightness * 0.75})`;
    const r = 0.5 + brightness * 1.3;
    context.fillRect(x, y, r, r);
  }
  drawPlanet(context, sunDirection);

  const texture = new CanvasTexture(canvas);
  texture.mapping = EquirectangularReflectionMapping;
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

/** Ray-traces the planet into the pixels around its direction, with the equirectangular mapping of three.js backgrounds. */
function drawPlanet(context: CanvasRenderingContext2D, sun: Vector3): void {
  const latitude = Math.asin(planetDirection.y);
  const longitude = Math.atan2(planetDirection.z, planetDirection.x);
  const margin = planetAngle * 1.25;
  const lonMargin = margin / Math.cos(Math.abs(latitude) + margin);
  const x0 = Math.floor((longitude - lonMargin) / (Math.PI * 2) * width + width / 2);
  const x1 = Math.ceil((longitude + lonMargin) / (Math.PI * 2) * width + width / 2);
  const y0 = Math.floor((0.5 - (latitude + margin) / Math.PI) * height);
  const y1 = Math.ceil((0.5 - (latitude - margin) / Math.PI) * height);
  const image = context.getImageData(x0, y0, x1 - x0, y1 - y0);
  const data = image.data;

  const cosPlanet = Math.cos(planetAngle);
  const sinPlanet = Math.sin(planetAngle);
  const dir = new Vector3();
  const normal = new Vector3();
  for (let py = y0; py < y1; py++) {
    const lat = (0.5 - (py + 0.5) / height) * Math.PI;
    for (let px = x0; px < x1; px++) {
      const lon = ((px + 0.5) / width - 0.5) * Math.PI * 2;
      dir.set(Math.cos(lon) * Math.cos(lat), Math.sin(lat), Math.sin(lon) * Math.cos(lat));
      const cosAngle = dir.dot(planetDirection);
      const k = ((py - y0) * (x1 - x0) + (px - x0)) * 4;

      if (cosAngle < cosPlanet) {
        // Atmosphere glow just outside the limb.
        const outside = (Math.acos(Math.min(1, cosAngle)) - planetAngle) / (planetAngle * 0.12);
        if (outside < 1) {
          const glow = (1 - outside) * (1 - outside) * Math.max(0.15, 0.5 + 0.5 * dir.dot(sun));
          blend(data, k, 120, 170, 255, glow * 0.6);
        }
        continue;
      }

      // Unit sphere at distance 1 / sin(angle): intersect the view ray and get the surface normal.
      const distance = 1 / sinPlanet;
      const b = distance * cosAngle;
      const t = b - Math.sqrt(Math.max(0, b * b - distance * distance + 1));
      normal.copy(dir).multiplyScalar(t).addScaledVector(planetDirection, -distance);

      const band = normal.dot(planetAxis);
      const stripes = Math.sin(band * 23) * 0.5 + Math.sin(band * 9 + 2) * 0.35 + Math.sin(band * 61) * 0.08;
      const light = Math.max(0, normal.dot(sun));
      const shade = 0.06 + 0.94 * Math.pow(light, 0.8);
      const rim = Math.pow(1 - Math.max(0, -normal.dot(dir)), 3);
      let r = (196 + stripes * 40) * shade;
      let g = (150 + stripes * 32) * shade;
      let bl = (104 + stripes * 22) * shade;
      r += rim * 70 * (0.3 + light);
      g += rim * 110 * (0.3 + light);
      bl += rim * 170 * (0.3 + light);
      data[k] = Math.min(255, r);
      data[k + 1] = Math.min(255, g);
      data[k + 2] = Math.min(255, bl);
      data[k + 3] = 255;
    }
  }
  context.putImageData(image, x0, y0);
}

function blend(data: Uint8ClampedArray, k: number, r: number, g: number, b: number, alpha: number): void {
  data[k] += (r - data[k]) * alpha;
  data[k + 1] += (g - data[k + 1]) * alpha;
  data[k + 2] += (b - data[k + 2]) * alpha;
}
