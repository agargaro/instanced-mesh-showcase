import { HalfFloatType, Vector2, WebGLRenderTarget } from 'three';
import type { Camera, Scene, WebGLRenderer } from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { pass } from 'three/tsl';
import { RenderPipeline } from 'three/webgpu';
import type { WebGPURenderer } from 'three/webgpu';
import { isWebGPURenderer } from './renderer.js';
import type { AnyRenderer } from './renderer.js';

/** Bloom strength, blur radius and the linear (pre tone mapping) brightness above which pixels glow. `UnrealBloomPass` glows
 * more than `BloomNode` with the same values, so the WebGL strength is scaled down to look alike. */
const strength = 0.8;
const radius = 0.35;
const threshold = 1;

export interface Bloom {
  render(): void;
  setSize(width: number, height: number): void;
  dispose(): void;
}

/**
 * Optional bloom. `WebGLRenderer` uses `EffectComposer` with `UnrealBloomPass`; `WebGPURenderer` (both backends) a TSL
 * `RenderPipeline` with `BloomNode`. Both render the scene to a half-float target with 4x MSAA, add the bloom and then apply
 * tone mapping and the output color space. It adds several full-screen passes: it is off by default.
 */
export function createBloom(renderer: AnyRenderer, scene: Scene, camera: Camera): Bloom {
  if (isWebGPURenderer(renderer)) return createNodeBloom(renderer, scene, camera);
  return createComposerBloom(renderer, scene, camera);
}

function createNodeBloom(renderer: WebGPURenderer, scene: Scene, camera: Camera): Bloom {
  const pipeline = new RenderPipeline(renderer);
  const scenePass = pass(scene, camera, { samples: 4 });
  const color = scenePass.getTextureNode('output');
  pipeline.outputNode = color.add(bloom(color, strength, radius, threshold));
  return {
    render: () => pipeline.render(),
    setSize: () => undefined,
    dispose: () => {
      pipeline.dispose();
      scenePass.dispose();
    }
  };
}

function createComposerBloom(renderer: WebGLRenderer, scene: Scene, camera: Camera): Bloom {
  const size = renderer.getDrawingBufferSize(new Vector2());
  const target = new WebGLRenderTarget(size.x, size.y, { type: HalfFloatType, samples: 4 });
  const composer = new EffectComposer(renderer, target);
  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(new UnrealBloomPass(size, strength * 0.7, radius, threshold));
  composer.addPass(new OutputPass());
  return {
    render: () => composer.render(),
    setSize: (width, height) => {
      composer.setPixelRatio(renderer.getPixelRatio());
      composer.setSize(width, height);
    },
    dispose: () => composer.dispose()
  };
}
