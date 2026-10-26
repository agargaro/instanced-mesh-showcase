import { MeshLambertMaterial } from 'three';
import type { Color, Material } from 'three';
import { MeshLambertNodeMaterial } from 'three/webgpu';
import { interleavedGradientNoise, positionView, screenCoordinate, smoothstep, uniform } from 'three/tsl';

export type FadeMaterial = Material & { color: Color };

/**
 * Lambert material (the cheapest lit one: rocks need no specular) that dissolves with a screen-space dither between
 * `near` and `far` view depth, so distant asteroids vanish into whatever is behind them (stars, planet) instead of popping
 * in with the fog color.
 * `WebGLRenderer` needs a patched `MeshLambertMaterial`, `WebGPURenderer` a node material with a mask.
 */
export function createFadeMaterial(nodeMaterial: boolean, near: number, far: number): FadeMaterial {
  if (nodeMaterial) {
    const material = new MeshLambertNodeMaterial({ vertexColors: true });
    const fade = smoothstep(uniform(near), uniform(far), positionView.z.negate());
    material.maskNode = interleavedGradientNoise(screenCoordinate.xy).greaterThanEqual(fade);
    return material;
  }

  const material = new MeshLambertMaterial({ vertexColors: true });
  material.onBeforeCompile = (shader) => {
    shader.uniforms['fadeNear'] = { value: near };
    shader.uniforms['fadeFar'] = { value: far };
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', `uniform float fadeNear;
uniform float fadeFar;
float fadeNoise(vec2 p) {
  return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
}
void main() {`)
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
  if (fadeNoise(gl_FragCoord.xy) < smoothstep(fadeNear, fadeFar, vViewPosition.z)) discard;`);
  };
  material.customProgramCacheKey = () => 'dither-fade';
  return material;
}
