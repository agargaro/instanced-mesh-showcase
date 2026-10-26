# InstancedMesh2 · Asteroid Field

Showcase of [`@three.ez/instanced-mesh`](https://www.npmjs.com/package/@three.ez/instanced-mesh) `1.0.0-beta.0`: a spaceship flying through an endless field of hundreds of thousands of asteroids you can shoot.

- 3 procedural asteroid shapes, each an `InstancedMesh2` with **4 LODs simplified at runtime by meshoptimizer** (screen-size metric).
- Periodic field faded by fog: the camera far plane matches the fog, so culling only keeps the instances within view distance. Stars and the planet are baked into one equirectangular background texture: a single render pass.
- Distant asteroids dissolve with a screen-space dither in the last 10% of the view distance (patched `MeshLambertMaterial` on WebGL, `maskNode` on node materials).
- All effects (engine flame and smoke, explosion flash, sparks and dust, laser beams) in one `InstancedMesh2` of camera-facing soft particles sorted back-to-front: additive and translucent particles share a premultiplied-alpha material, so they cost one draw call. The ship is a single merged geometry: one draw call.
- Asteroid surface baked into vertex colors at generation (no texture): basalt, regolith, rust, mineral flecks, cheap ambient occlusion.
- **Shadow LOD**: shadows are drawn with LOD 2/3 geometry.
- **BVH** for frustum culling and raycasting.
- **Raycasting**: the ship shield raycasts ahead every frame; click an asteroid to destroy it; big ones split into smaller instances (`removeInstances` / `addInstances` with ID reuse), fragments are another `InstancedMesh2` with a per-instance `emissive` uniform.
- Switch between `WebGPURenderer` (WebGPU), `WebGPURenderer` with `forceWebGL`, and `WebGLRenderer` (`?renderer=webgpu|fallback|webgl`).
- Optional bloom, off by default: `EffectComposer` + `UnrealBloomPass` on WebGL, TSL `RenderPipeline` + `BloomNode` on WebGPU. ACES filmic tone mapping is always on (no extra pass).
- Opening shot for videos (skip with any key or tap, or open with `?intro=0`), touch controls on phones (drag to steer and fire), social preview card.
- Toggles: per-instance frustum culling, BVH, sorting, freeze culling, color by LOD, LOD quality, shadows, shadow LOD.
- HUD: FPS, CPU time of `render()`, draw calls and triangles of the whole frame (shadow passes included), instances per LOD, raycast time. GPU time is in the stats-gl panel (timestamp queries).

## Develop

```bash
npm install
npm run dev
```

## Deploy

Static Vite build (`npm run build` → `dist/`). On Vercel import the repository: the Vite preset is detected automatically.

The social preview tags need absolute URLs: the build uses `SITE_URL` if set, otherwise the production domain Vercel provides (`VERCEL_PROJECT_PRODUCTION_URL`). The preview image is `public/og-image.jpg`.
