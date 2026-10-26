import {
  ACESFilmicToneMapping, Color, DirectionalLight, Fog, HemisphereLight, Matrix4, Mesh, PerspectiveCamera, Quaternion, Raycaster, Scene, Vector2, Vector3
} from 'three';
import type { Camera, Intersection } from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GUI } from 'three/addons/libs/lil-gui.module.min.js';
import Stats from 'stats-gl';
import { acceleratedRaycast } from 'three-mesh-bvh';
import type { InstancedMesh2 } from '@three.ez/instanced-mesh';
import {
  createLevelMaterials, createVariant, enableShadowLOD, fieldHalfHeight, fieldHalfWidth, fieldLength, levelColors, lodMetrics, populateField, randomQuaternion, shadowLodMetric
} from './asteroids.js';
import type { AsteroidVariant } from './asteroids.js';
import { createBloom } from './bloom.js';
import type { Bloom } from './bloom.js';
import { Debris } from './effects.js';
import { Random } from './random.js';
import { createRenderer, getRendererOption, isWebGPURenderer, readFrameInfo, rendererLabels, setRendererOption } from './renderer.js';
import type { RendererOption } from './renderer.js';
import { Ship } from './ship.js';
import { Intro } from './intro.js';
import { Particles } from './particles.js';
import { createSkyTexture } from './sky.js';

const variantCount = 1;
const countOptions = { '100k': 100000, '250k': 250000, '500k': 500000, '1M': 1000000 };
const isMobile = matchMedia('(pointer: coarse)').matches;
/** View distance: the camera far plane. Asteroids dissolve before it, so instances beyond it are culled unseen. */
const viewDistance = 2000;
const fogColor = 0x070a14;

const loading = document.getElementById('loading') as HTMLDivElement;
const loadingText = document.getElementById('loading-text') as HTMLParagraphElement;
const backendText = document.getElementById('backend') as HTMLParagraphElement;
const statsList = document.getElementById('stats') as HTMLDListElement;
const scoreText = document.getElementById('score') as HTMLParagraphElement;
const crosshair = document.getElementById('crosshair') as HTMLDivElement;
const hint = document.getElementById('hint') as HTMLParagraphElement;
const notice = document.getElementById('notice') as HTMLParagraphElement;

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
    setTimeout(resolve, 50);
  });
}

async function progress(text: string): Promise<void> {
  loadingText.textContent = text;
  await nextFrame();
}

function fail(error: unknown): void {
  console.error(error);
  loading.classList.remove('hidden');
  loading.classList.add('error');
  loadingText.textContent = error instanceof Error ? error.message : String(error);
}

function formatCount(value: number): string {
  if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (value >= 1e4) return `${(value / 1e3).toFixed(1)}k`;
  return String(value);
}

/** `perObjectFrustumCulled` is public after 1.0.0-beta.0; the beta only has the internal field. */
function setPerObjectFrustumCulled(mesh: InstancedMesh2, value: boolean): void {
  const internal = mesh as unknown as { _perObjectFrustumCulled: boolean; _selectionVersion: number };
  internal._perObjectFrustumCulled = value;
  internal._selectionVersion++;
}

Mesh.prototype.raycast = acceleratedRaycast;

async function main(): Promise<void> {
  const option = getRendererOption();
  await progress('Starting renderer…');
  const { renderer, label } = await createRenderer(option);
  const canvas = renderer.domElement;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, isMobile ? 1.5 : 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  // Filmic tone mapping: richer colors and soft highlights for glows, applied in the material shaders (no extra pass).
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  document.body.prepend(canvas);
  backendText.textContent = label;

  const sunDirection = new Vector3(1, 0.35, -0.45).normalize();

  // Asteroids within the view distance, faded by fog. The sky (stars and planet) is one background texture.
  const scene = new Scene();
  scene.background = createSkyTexture(sunDirection);
  scene.fog = new Fog(fogColor, viewDistance * 0.08, viewDistance * 1.6);
  const camera = new PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.5, viewDistance);
  // Portrait screens get a taller field of view, so the horizontal view stays wide enough to steer.
  function fitCamera(): void {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.fov = camera.aspect < 1 ? 78 : 60;
    camera.updateProjectionMatrix();
  }
  fitCamera();

  const sun = new DirectionalLight(0xfff2e0, 3.2);
  sun.castShadow = false;
  sun.shadow.mapSize.set(2048, 2048);
  const shadowCamera = sun.shadow.camera;
  shadowCamera.left = shadowCamera.bottom = -140;
  shadowCamera.right = shadowCamera.top = 140;
  shadowCamera.near = 1;
  shadowCamera.far = 1400;
  shadowCamera.updateProjectionMatrix();
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.05;
  // Cheap lighting for Lambert rocks: warm key sun, cool sky/ground hemisphere and a faint blue rim from behind.
  const rim = new DirectionalLight(0x6f8cff, 0.9);
  rim.position.copy(sunDirection).negate();
  scene.add(sun, sun.target, rim, new HemisphereLight(0x8aa2d8, 0x3a2c22, 0.7));

  const materials = createLevelMaterials(isWebGPURenderer(renderer), viewDistance * 0.9, viewDistance * 0.995);
  const variants: AsteroidVariant[] = [];
  const meshes: InstancedMesh2[] = [];
  for (let i = 0; i < variantCount; i++) {
    await progress(`Simplifying asteroid ${String(i + 1)}/${String(variantCount)} with meshoptimizer…`);
    const variant = await createVariant(1000 + i * 17, materials);
    enableShadowLOD(variant, true);
    variants.push(variant);
    meshes.push(variant.mesh);
    scene.add(variant.mesh);
  }

  const params = {
    renderer: option as RendererOption,
    asteroids: isMobile ? 100000 : 250000,
    shield: true,
    perObjectCulling: true,
    smallCulling: true,
    bvh: true,
    sort: false,
    shadows: false,
    shadowLOD: true,
    bloom: false,
    colorLOD: false,
    lodQuality: 1,
    autoQuality: true,
    freezeCulling: false,
    freeCamera: false
  };

  async function populate(total: number): Promise<void> {
    await progress(`Placing ${formatCount(total)} asteroids${params.bvh ? ' and building BVH' : ''}…`);
    const perVariant = Math.ceil(total / variantCount);
    for (let i = 0; i < variants.length; i++) populateField(variants[i].mesh, perVariant, 42 + i, params.bvh);
  }
  await populate(params.asteroids);

  // Small-feature culling: asteroids smaller than `minScreenSize` of the view height (2-3 pixels) are skipped. Distance is
  // measured from the LOD camera, so shadow passes keep the same selection as the main view.
  const minScreenSize = 0.003;
  const geometryRadius = variants[0].geometries[0].boundingSphere?.radius ?? 1;
  let detailFactor = 0;
  function updateDetailFactor(): void {
    detailFactor = (minScreenSize * Math.tan(camera.fov * Math.PI / 360) / geometryRadius) ** 2;
  }
  const cullMatrix = new Matrix4();
  function createSmallCulling(mesh: InstancedMesh2): (id: number, camera: Camera, cameraLOD?: Camera) => boolean {
    return (id, current, cameraLOD) => {
      const view = (cameraLOD ?? current).matrixWorld.elements;
      const e = mesh.getMatrixAt(id, cullMatrix).elements;
      const scale = Math.max(e[0] * e[0] + e[1] * e[1] + e[2] * e[2], e[4] * e[4] + e[5] * e[5] + e[6] * e[6], e[8] * e[8] + e[9] * e[9] + e[10] * e[10]);
      const dx = e[12] - view[12];
      const dy = e[13] - view[13];
      const dz = e[14] - view[14];
      return scale >= detailFactor * (dx * dx + dy * dy + dz * dz);
    };
  }
  updateDetailFactor();
  const smallCulling = meshes.map(createSmallCulling);
  for (let i = 0; i < meshes.length; i++) meshes[i].onFrustumEnter = smallCulling[i];

  // Few short-lived fragments around the ship, rewritten every frame: no BVH and no per-instance culling.
  const debris = new Debris(variants[0].geometries[3]);
  setPerObjectFrustumCulled(debris.mesh, false);
  scene.add(debris.mesh);

  const ship = new Ship();
  ship.position.set(0, 0, 100);
  scene.add(ship);
  const particles = new Particles(ship);
  scene.add(particles.mesh);

  const chaseOffset = new Vector3(0, 8, -34);
  const chaseLook = new Vector3(0, 2.5, 60);
  const lookAhead = new Vector3();
  camera.position.copy(ship.position).add(chaseOffset);
  camera.lookAt(lookAhead.copy(ship.position).add(chaseLook));
  const controls = new OrbitControls(camera, canvas);
  controls.enabled = false;
  controls.enableDamping = true;
  controls.enablePan = false;
  controls.minDistance = 10;
  controls.maxDistance = 400;
  controls.autoRotateSpeed = 1;

  // GUI
  const gui = new GUI({ title: 'InstancedMesh2' });
  if (isMobile || window.innerWidth < 640) gui.close();
  gui.add(params, 'renderer', { [rendererLabels.webgpu]: 'webgpu', [rendererLabels.fallback]: 'fallback', [rendererLabels.webgl]: 'webgl' })
    .name('renderer').onChange((value: RendererOption) => setRendererOption(value));
  gui.add(params, 'asteroids', countOptions).name('asteroids').onChange(async (value: number) => {
    loading.classList.remove('hidden');
    await populate(value);
    loading.classList.add('hidden');
  });
  const flight = gui.addFolder('Ship');
  flight.add(params, 'shield').name('shield (raycast ahead)');
  flight.add(params, 'freeCamera').name('free orbit camera').onChange((value: boolean) => {
    controls.enabled = value;
    controls.autoRotate = value;
    firing = false;
    if (value) {
      controls.target.copy(ship.position);
      controls.update();
    }
  });
  const culling = gui.addFolder('Culling & sorting');
  culling.add(params, 'perObjectCulling').name('per-instance frustum culling').onChange((value: boolean) => {
    for (let i = 0; i < meshes.length; i++) setPerObjectFrustumCulled(meshes[i], value);
  });
  culling.add(params, 'smallCulling').name('skip sub-pixel asteroids').onChange((value: boolean) => {
    for (let i = 0; i < meshes.length; i++) meshes[i].onFrustumEnter = value ? smallCulling[i] : null;
  });
  culling.add(params, 'bvh').name('BVH (culling + raycast)').onChange((value: boolean) => {
    for (let i = 0; i < meshes.length; i++) {
      if (value) meshes[i].computeBVH({ margin: 0 });
      else meshes[i].disposeBVH();
    }
  });
  culling.add(params, 'sort').name('sort front-to-back').onChange((value: boolean) => {
    for (let i = 0; i < meshes.length; i++) meshes[i].sortObjects = value;
  });
  culling.add(params, 'freezeCulling').name('freeze culling & LOD').onChange((value: boolean) => {
    for (let i = 0; i < meshes.length; i++) meshes[i].autoFrustumCulling = !value;
  });
  const lod = gui.addFolder('LOD & shadows');
  lod.add(params, 'colorLOD').name('color by LOD').onChange((value: boolean) => {
    for (let i = 0; i < materials.length; i++) materials[i].color.setHex(value ? levelColors[i] : 0xffffff);
  });
  function setLodQuality(value: number): void {
    const metrics = [lodMetrics[0] / value, lodMetrics[1] / value, lodMetrics[2] / value];
    for (let i = 0; i < meshes.length; i++) {
      meshes[i].updateAllLOD(metrics);
      if (params.shadowLOD) meshes[i].updateShadowLOD(1, shadowLodMetric / value);
    }
  }
  const lodQualityControl = lod.add(params, 'lodQuality', 0.25, 4, 0.05).name('LOD quality').onChange(setLodQuality);
  lod.add(params, 'autoQuality').name('auto LOD quality (< 60 FPS)');
  lod.add(params, 'shadows').onChange((value: boolean) => {
    sun.castShadow = value;
  });
  // Created on first use: no post-processing resources until the bloom is turned on.
  let bloomEffect: Bloom | null = null;
  gui.add(params, 'bloom').name('bloom (post-processing)').onChange((value: boolean) => {
    if (value) {
      bloomEffect = createBloom(renderer, scene, camera);
      bloomEffect.setSize(window.innerWidth, window.innerHeight);
    } else if (bloomEffect !== null) {
      bloomEffect.dispose();
      bloomEffect = null;
    }
  });
  lod.add(params, 'shadowLOD').name('shadow LOD').onChange((value: boolean) => {
    for (let i = 0; i < variants.length; i++) enableShadowLOD(variants[i], value);
  });

  const stats = new Stats({ trackGPU: true, horizontal: true });
  stats.dom.style.cssText += ';position:fixed;top:auto;left:auto;bottom:0;right:0;';
  if (isMobile) stats.dom.style.display = 'none';
  document.body.appendChild(stats.dom);
  await stats.init(renderer);

  // Aiming: the ship turns towards the point under the pointer.
  const aimRaycaster = new Raycaster();
  const aimPointer = new Vector2();
  const aim = new Vector3();
  const bounds = new Vector2(fieldHalfWidth - 300, fieldHalfHeight - 200);
  let pointerX = window.innerWidth / 2;
  let pointerY = window.innerHeight / 2;
  let firing = false;
  let fireCooldown = 0;
  // Touch: the finger steers and fires; when it lifts, the aim drifts back to the center of the screen.
  let touching = false;
  let touchInput = isMobile;
  hint.textContent = isMobile ? 'Touch and drag to steer and fire' : 'Move the pointer to steer · Hold to fire';
  if (isMobile) crosshair.classList.add('hidden');

  let totalAsteroids = 0;
  for (let i = 0; i < meshes.length; i++) totalAsteroids += meshes[i].instancesCount;
  const intro = new Intro(new URLSearchParams(location.search).get('intro') !== '0', totalAsteroids);
  window.addEventListener('keydown', () => intro.skip());

  // Shooting and shield
  const raycaster = new Raycaster();
  raycaster.far = viewDistance;
  raycaster.firstHitOnly = true;
  const shieldRaycaster = new Raycaster();
  shieldRaycaster.firstHitOnly = true;
  const pointer = new Vector2();
  const hits: Intersection[] = [];
  const end = new Vector3();
  const matrix = new Matrix4();
  const hitPosition = new Vector3();
  const hitQuaternion = new Quaternion();
  const hitScale = new Vector3();
  const hitColor = new Color();
  const childScale = new Vector3();
  const shotRandom = new Random(7);
  let destroyed = 0;
  let lastRaycast = 0;
  let downX = 0;
  let downY = 0;
  let downTime = 0;

  function destroy(mesh: InstancedMesh2, id: number): void {
    mesh.getMatrixAt(id, matrix);
    matrix.decompose(hitPosition, hitQuaternion, hitScale);
    mesh.getColorAt(id, hitColor);
    const size = Math.max(hitScale.x, hitScale.y, hitScale.z);
    mesh.removeInstances(id);
    destroyed++;

    if (size > 6) {
      const pieces = 2 + Math.floor(shotRandom.next() * 3);
      childScale.copy(hitScale).multiplyScalar(0.45);
      const color = hitColor;
      mesh.addInstances(pieces, (instance) => {
        instance.position.randomDirection().multiplyScalar(size * 0.7).add(hitPosition);
        instance.scale.copy(childScale);
        randomQuaternion(shotRandom, instance.quaternion);
        instance.color = color;
      });
    }
    debris.spawn(hitPosition, size, hitColor);
    particles.explode(hitPosition, size);
  }

  function shoot(clientX: number, clientY: number): void {
    const rect = canvas.getBoundingClientRect();
    pointer.set((clientX - rect.left) / rect.width * 2 - 1, -(clientY - rect.top) / rect.height * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
    hits.length = 0;
    const start = performance.now();
    raycaster.intersectObjects(meshes, false, hits);
    lastRaycast = performance.now() - start;

    if (hits.length > 0) {
      const hit = hits[0];
      end.copy(hit.point);
      if (hit.instanceId !== undefined) destroy(hit.object as InstancedMesh2, hit.instanceId);
    } else {
      end.copy(raycaster.ray.direction).multiplyScalar(viewDistance).add(raycaster.ray.origin);
    }
    particles.beam(end);
  }

  /** Destroys what is in front of the ship within the distance it travels this frame. */
  function shield(distance: number): void {
    shieldRaycaster.ray.origin.copy(ship.position);
    shieldRaycaster.ray.direction.copy(ship.heading);
    shieldRaycaster.far = distance + ship.radius * 3;
    hits.length = 0;
    shieldRaycaster.intersectObjects(meshes, false, hits);
    if (hits.length === 0) return;
    const hit = hits[0];
    if (hit.instanceId !== undefined) destroy(hit.object as InstancedMesh2, hit.instanceId);
  }

  function setPointer(event: PointerEvent): void {
    if (params.freeCamera || intro.active) return;
    touchInput = event.pointerType === 'touch';
    if (touchInput && !touching) return;
    pointerX = event.clientX;
    pointerY = event.clientY;
    crosshair.style.left = `${String(pointerX)}px`;
    crosshair.style.top = `${String(pointerY)}px`;
  }

  function stopFiring(): void {
    firing = false;
    touching = false;
    if (touchInput) crosshair.classList.add('hidden');
  }

  canvas.addEventListener('pointerdown', (event) => {
    downX = event.clientX;
    downY = event.clientY;
    downTime = performance.now();
    if (intro.active) {
      intro.skip();
      return;
    }
    touching = event.pointerType === 'touch';
    crosshair.classList.remove('hidden');
    setPointer(event);
    if (!params.freeCamera && event.button === 0) {
      firing = true;
      shoot(pointerX, pointerY);
      fireCooldown = 0.12;
    }
  });
  canvas.addEventListener('pointerup', (event) => {
    stopFiring();
    const moved = Math.hypot(event.clientX - downX, event.clientY - downY);
    if (params.freeCamera && moved < 6 && performance.now() - downTime < 400) shoot(event.clientX, event.clientY);
  });
  canvas.addEventListener('pointercancel', stopFiring);
  canvas.addEventListener('pointerleave', stopFiring);
  canvas.addEventListener('pointermove', setPointer);
  crosshair.style.left = `${String(pointerX)}px`;
  crosshair.style.top = `${String(pointerY)}px`;

  function updateChaseCamera(delta: number): void {
    const response = 1 - Math.exp(-5 * delta);
    camera.position.x += (ship.position.x + chaseOffset.x - camera.position.x) * response;
    camera.position.y += (ship.position.y + chaseOffset.y - camera.position.y) * response;
    camera.position.z = ship.position.z + chaseOffset.z;
    camera.lookAt(lookAhead.copy(ship.position).add(chaseLook));
  }

  // Adaptive quality: when the smoothed frame rate stays below ~60 FPS for 3 seconds, lower the LOD quality one step (never
  // raised automatically, so it cannot oscillate). Frames longer than 250 ms (tab switch, loading) reset the measure.
  const slowFrame = 1000 / 55;
  const minQuality = 0.25;
  let slowTime = 0;
  let averageFrame = 1000 / 60;
  let noticeTimeout = 0;

  function updateAutoQuality(frameMs: number): void {
    if (!params.autoQuality || intro.active || params.lodQuality <= minQuality) return;
    if (frameMs > 250) {
      slowTime = 0;
      averageFrame = 1000 / 60;
      return;
    }
    averageFrame += (frameMs - averageFrame) * 0.1;
    if (averageFrame < slowFrame) {
      slowTime = 0;
      return;
    }
    slowTime += frameMs;
    if (slowTime < 3000) return;
    slowTime = 0;
    params.lodQuality = Math.max(minQuality, Math.round(params.lodQuality * 0.75 * 100) / 100);
    setLodQuality(params.lodQuality);
    lodQualityControl.updateDisplay();
    notice.textContent = `Below 60 FPS: LOD quality lowered to ${params.lodQuality.toFixed(2)}`;
    notice.classList.add('visible');
    clearTimeout(noticeTimeout);
    noticeTimeout = window.setTimeout(() => notice.classList.remove('visible'), 3000);
  }

  // HUD
  const frameInfo = { calls: 0, triangles: 0 };
  const levelCounts = [0, 0, 0, 0];
  let frames = 0;
  let cpuTime = 0;
  let lastHud = performance.now();

  function updateHud(now: number): void {
    const fps = frames * 1000 / (now - lastHud);
    frames = 0;
    lastHud = now;
    let total = 0;
    for (let i = 0; i < meshes.length; i++) total += meshes[i].instancesCount;
    const drawn = levelCounts[0] + levelCounts[1] + levelCounts[2] + levelCounts[3];
    const all: Array<[string, string]> = [
      ['FPS', fps.toFixed(0)],
      ['CPU render()', `${cpuTime.toFixed(2)} ms`],
      ['Draw calls', String(frameInfo.calls)],
      ['Triangles', formatCount(frameInfo.triangles)],
      ['Asteroids drawn', `${formatCount(drawn)} / ${formatCount(total)}`],
      ['LOD 0 · 1', `${formatCount(levelCounts[0])} · ${formatCount(levelCounts[1])}`],
      ['LOD 2 · 3', `${formatCount(levelCounts[2])} · ${formatCount(levelCounts[3])}`],
      ['Debris · particles', `${String(debris.count)} · ${String(particles.count)}`],
      ['Raycast', `${lastRaycast.toFixed(3)} ms (${params.bvh ? 'BVH' : 'linear'})`]
    ];
    // Narrow screens keep the headline numbers only.
    const rows = window.innerWidth < 640 ? [all[0], all[2], all[3], all[4]] : all;
    let html = '';
    for (let i = 0; i < rows.length; i++) html += `<dt>${rows[i][0]}</dt><dd>${rows[i][1]}</dd>`;
    statsList.innerHTML = html;
    scoreText.textContent = destroyed > 0 ? `Destroyed: ${String(destroyed)}` : '';
  }

  window.addEventListener('resize', () => {
    fitCamera();
    updateDetailFactor();
    renderer.setSize(window.innerWidth, window.innerHeight);
    if (bloomEffect !== null) bloomEffect.setSize(window.innerWidth, window.innerHeight);
  });

  const follow = new Vector3();
  let previous = performance.now();
  const startTime = previous;

  function frame(): void {
    const now = performance.now();
    updateAutoQuality(now - previous);
    const delta = Math.min((now - previous) / 1000, 0.1);
    const elapsed = (now - startTime) / 1000;
    previous = now;

    if (touchInput && !touching) {
      const response = 1 - Math.exp(-2.5 * delta);
      pointerX += (window.innerWidth / 2 - pointerX) * response;
      pointerY += (window.innerHeight / 2 - pointerY) * response;
    }
    if (params.freeCamera || intro.active) {
      aim.copy(ship.heading).multiplyScalar(800).add(ship.position);
    } else {
      const rect = canvas.getBoundingClientRect();
      aimPointer.set((pointerX - rect.left) / rect.width * 2 - 1, -(pointerY - rect.top) / rect.height * 2 + 1);
      aimRaycaster.setFromCamera(aimPointer, camera);
      aim.copy(aimRaycaster.ray.direction).multiplyScalar(800).add(aimRaycaster.ray.origin);
    }

    follow.copy(ship.position);
    const distance = ship.advance(delta, aim, bounds);
    if (params.shield) shield(distance);
    if (ship.position.z > fieldLength) {
      ship.position.z -= fieldLength;
      follow.z -= fieldLength;
      camera.position.z -= fieldLength;
      controls.target.z -= fieldLength;
      debris.shiftZ(-fieldLength);
      particles.shiftZ(-fieldLength);
    }
    const inIntro = intro.update(delta, camera, ship.position, chaseOffset, chaseLook, frameInfo.calls);
    if (inIntro) {
      fireCooldown = 0;
    } else if (params.freeCamera) {
      follow.subVectors(ship.position, follow);
      camera.position.add(follow);
      controls.target.add(follow);
      controls.update(delta);
    } else {
      updateChaseCamera(delta);
      fireCooldown -= delta;
      if (firing && fireCooldown <= 0) {
        shoot(pointerX, pointerY);
        fireCooldown = 0.12;
      }
    }

    debris.update(delta, elapsed);
    particles.update(delta, camera);

    sun.position.copy(sunDirection).multiplyScalar(700).add(ship.position);
    sun.target.position.copy(ship.position);
    sun.target.updateMatrixWorld();

    renderer.info.reset();
    const start = performance.now();
    if (bloomEffect !== null) bloomEffect.render();
    else renderer.render(scene, camera);
    cpuTime = performance.now() - start;
    readFrameInfo(renderer, frameInfo);

    levelCounts[0] = levelCounts[1] = levelCounts[2] = levelCounts[3] = 0;
    for (let i = 0; i < meshes.length; i++) {
      const levels = meshes[i].LODInfo?.render?.levels;
      if (levels === undefined) continue;
      for (let l = 0; l < levels.length; l++) levelCounts[l] += levels[l].object.count;
    }

    if (isWebGPURenderer(renderer)) void renderer.resolveTimestampsAsync();
    stats.update();
    frames++;
    if (now - lastHud > 250) updateHud(now);
  }

  // Compile every material up front (asteroid levels, fragments, particles, ship) so the first explosion does not stall.
  // The WebGL backends poll the compile status with requestAnimationFrame, which stops in background tabs: wait at most 3 s,
  // anything left compiles on first use.
  await progress('Compiling shaders…');
  await Promise.race([renderer.compileAsync(scene, camera), new Promise((resolve) => setTimeout(resolve, 3000))]);
  await renderer.setAnimationLoop(frame);
  loading.classList.add('hidden');
}

main().catch(fail);
