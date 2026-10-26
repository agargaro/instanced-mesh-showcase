import { WebGLRenderer } from 'three';
import { WebGPURenderer } from 'three/webgpu';
import { prepareInstancedRenderer } from '@three.ez/instanced-mesh';

export type RendererOption = 'webgpu' | 'fallback' | 'webgl';
export type AnyRenderer = WebGLRenderer | WebGPURenderer;

export const rendererLabels: Record<RendererOption, string> = {
  webgpu: 'WebGPURenderer',
  fallback: 'WebGPURenderer (forceWebGL)',
  webgl: 'WebGLRenderer'
};

export function getRendererOption(): RendererOption {
  const value = new URLSearchParams(location.search).get('renderer');
  return value === 'webgl' || value === 'fallback' ? value : 'webgpu';
}

export function setRendererOption(option: RendererOption): void {
  const url = new URL(location.href);
  url.searchParams.set('renderer', option);
  location.href = url.href;
}

export function isWebGPURenderer(renderer: AnyRenderer): renderer is WebGPURenderer {
  return (renderer as { isWebGPURenderer?: boolean }).isWebGPURenderer === true;
}

export async function createRenderer(option: RendererOption): Promise<{ renderer: AnyRenderer; label: string }> {
  const renderer: AnyRenderer = option === 'webgl'
    ? new WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })
    : new WebGPURenderer({ antialias: true, powerPreference: 'high-performance', trackTimestamp: true, forceWebGL: option === 'fallback' });

  await prepareInstancedRenderer(renderer);

  let label = 'WebGLRenderer · WebGL2';
  if (isWebGPURenderer(renderer)) {
    const native = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend === true;
    if (native) label = 'WebGPURenderer · WebGPU';
    else label = option === 'fallback' ? 'WebGPURenderer · WebGL2 (forceWebGL)' : 'WebGPURenderer · WebGL2 fallback (no WebGPU)';
  }

  renderer.info.autoReset = false;
  return { renderer, label };
}

/** Draw calls and triangles of the whole frame, shadow passes included (`info.autoReset` is off). */
export function readFrameInfo(renderer: AnyRenderer, target: { calls: number; triangles: number }): void {
  const render = renderer.info.render as { calls: number; drawCalls?: number; triangles: number };
  target.calls = isWebGPURenderer(renderer) ? (render.drawCalls ?? 0) : render.calls;
  target.triangles = render.triangles;
}
