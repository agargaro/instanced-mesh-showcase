import { ACESFilmicToneMapping, PerspectiveCamera } from 'three';
import { MapControls } from 'three/addons/controls/MapControls.js';
import { GUI } from 'three/addons/libs/lil-gui.module.min.js';
import Stats from 'stats-gl';
import { createBattle, LEVEL_COUNT } from './battle.js';
import type { Battle } from './battle.js';
import { CinematicCamera } from './camera.js';
import { createRenderer, getRendererOption, isWebGPURenderer, readBackend, readFrameInfo, rendererLabels, setRendererOption } from '../renderer.js';
import type { RendererOption } from '../renderer.js';

const touch = matchMedia('(pointer: coarse)').matches;
const params = new URLSearchParams(location.search);
/** `?debug=true` adds the battle data, the drawn instances per level and the skinning costs to the controls. */
const debug = params.get('debug') === 'true';

const loading = document.getElementById('loading') as HTMLDivElement;
const loadingText = document.getElementById('loading-text') as HTMLParagraphElement;
const rendererSelect = document.getElementById('renderer') as HTMLSelectElement;
const backendText = document.getElementById('backend') as HTMLParagraphElement;
const statsList = document.getElementById('stats') as HTMLDListElement;

function getCount(): number {
  const fallback = touch ? 4000 : 10000;
  const value = Number(params.get('count') ?? fallback);
  return Number.isSafeInteger(value) && value > 1 ? value : fallback;
}

function formatCount(value: number): string {
  if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (value >= 1e4) return `${(value / 1e3).toFixed(1)}k`;
  return String(value);
}

function formatTriangles(triangles: number): string {
  return triangles >= 1e6 ? `${(triangles / 1e6).toFixed(2)} M tris` : `${(triangles / 1e3).toFixed(0)} k tris`;
}

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
  document.body.dataset['state'] = 'error';
}

function fillRendererOptions(option: RendererOption): void {
  const keys: RendererOption[] = ['webgpu', 'fallback', 'webgl'];
  for (let i = 0; i < keys.length; i++) rendererSelect.add(new Option(rendererLabels[keys[i]], keys[i]));
  rendererSelect.value = option;
  rendererSelect.addEventListener('change', () => setRendererOption(rendererSelect.value as RendererOption));
}

async function main(): Promise<void> {
  const option = getRendererOption();
  fillRendererOptions(option);
  await progress('Starting renderer…');
  const { renderer, label } = await createRenderer(option);
  const backend = readBackend(renderer);
  renderer.debug.onShaderError = () => {
    throw new Error('Shader compilation failed.');
  };
  backendText.textContent = label;

  const canvas = renderer.domElement;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, touch ? 1.5 : 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  document.body.prepend(canvas);

  const count = getCount();
  await progress(`Baking ${formatCount(count)} monsters…`);
  const battle = await createBattle(count, backend);

  const camera = new PerspectiveCamera(35, 1, 1, battle.radius * 1.8);
  if (window.innerHeight > window.innerWidth) camera.position.set(-40, 15, 8);
  else camera.position.set(-30, 10, 36);
  const controls = new MapControls(camera, canvas);
  controls.target.set(0, 2, 0);
  controls.enableDamping = true;
  controls.minDistance = 8;
  controls.maxDistance = battle.halfWidth * 3;
  controls.maxPolarAngle = Math.PI * 0.42;
  const director = new CinematicCamera(camera, controls);

  const gui = new GUI({ title: 'Baked armies' });
  if (touch) gui.close();
  const actions = { charge: battle.charge, restart: battle.restart, cheer: battle.cheer };
  const behavior = gui.addFolder('Battle');
  behavior.add(actions, 'charge');
  behavior.add(actions, 'restart');
  behavior.add(actions, 'cheer');
  behavior.add(battle.settings, 'autoBattle').name('auto battle');
  behavior.add(battle.settings, 'lethality', 0.05, 1, 0.01).name('hit chance');
  behavior.add(battle.settings, 'fade', 0, 1, 0.05).name('crossfade (s)');
  behavior.add(battle.settings, 'timeScale', 0, 2, 0.05).name('clock rate');
  behavior.add(battle.settings, 'thinkInterval', 1, 10, 1).name('decide every N frames');
  behavior.add(battle.settings, 'blobShadows').name('blob shadows');
  behavior.add(battle.settings, 'nearestFrames').name('nearest frame, far LODs');
  behavior.add(director, 'enabled').name('cinematic camera');

  let updateDebug: (() => void) | null = null;
  if (debug) {
    const levelStats = { instances: new Array<number>(LEVEL_COUNT).fill(0), triangles: new Array<number>(LEVEL_COUNT).fill(0) };
    const data = { monsters: battle.count.toLocaleString('en-US'), imps: 0, puglins: 0, fighting: 0, moving: 0, thinking: 0, changes: 0, update: '' };
    const drawn: Record<string, string> = { total: '' };
    const statsFolder = gui.addFolder('Data');
    statsFolder.add(data, 'monsters').disable();
    statsFolder.add(data, 'imps').name('Imps alive').disable().listen();
    statsFolder.add(data, 'puglins').name('Puglins alive').disable().listen();
    statsFolder.add(data, 'fighting').name('in melee').disable().listen();
    statsFolder.add(data, 'moving').name('moving (matrices/frame)').disable().listen();
    statsFolder.add(data, 'thinking').name('deciding/frame').disable().listen();
    statsFolder.add(data, 'changes').name('clip changes/frame').disable().listen();
    statsFolder.add(data, 'update').name('battle CPU (ms/frame)').disable().listen();
    const drawFolder = gui.addFolder('Drawn');
    for (let k = 0; k < LEVEL_COUNT; k++) {
      const key = `level${String(k)}`;
      drawn[key] = '';
      drawFolder.add(drawn, key).name(k === 0 ? 'full model' : `LOD ${String(k)}`).disable().listen();
    }
    drawFolder.add(drawn, 'total').disable().listen();
    const skinningFolder = gui.addFolder('Skinning');
    const influences: Record<string, string> = {};
    for (let i = 0; i < battle.skinning.length; i++) {
      const info = battle.skinning[i];
      influences[info.name] = `${info.influences.join(' · ')} (${info.reduceTime.toFixed(0)} ms)`;
      skinningFolder.add(influences, info.name).name(`${info.name} influences`).disable();
    }

    updateDebug = () => {
      data.imps = battle.stats.alive[0];
      data.puglins = battle.stats.alive[1];
      data.fighting = battle.stats.fighting;
      data.moving = battle.stats.moving;
      data.changes = battle.stats.changes;
      data.thinking = battle.stats.thinking;
      data.update = battle.stats.updateTime.toFixed(2);
      battle.countLevels(levelStats);
      let instances = 0;
      let triangles = 0;
      for (let k = 0; k < LEVEL_COUNT; k++) {
        drawn[`level${String(k)}`] = `${levelStats.instances[k].toLocaleString('en-US')} · ${formatTriangles(levelStats.triangles[k])}`;
        instances += levelStats.instances[k];
        triangles += levelStats.triangles[k];
      }
      drawn['total'] = `${instances.toLocaleString('en-US')} · ${formatTriangles(triangles)}`;
    };
  }

  const stats = new Stats({ trackGPU: true, horizontal: true });
  stats.dom.style.cssText += ';position:fixed;top:auto;left:auto;bottom:0;right:0;';
  if (touch) stats.dom.style.display = 'none';
  document.body.appendChild(stats.dom);
  await stats.init(renderer);

  function resize(): void {
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', resize);
  resize();

  const frameInfo = { calls: 0, triangles: 0 };
  const levels = { instances: new Array<number>(LEVEL_COUNT).fill(0), triangles: new Array<number>(LEVEL_COUNT).fill(0) };
  let frames = 0;
  let cpuTime = 0;
  let lastHud = performance.now();

  function updateHud(now: number): void {
    const fps = frames * 1000 / (now - lastHud);
    frames = 0;
    lastHud = now;
    battle.countLevels(levels);
    let drawn = 0;
    for (let k = 0; k < LEVEL_COUNT; k++) drawn += levels.instances[k];
    const alive = battle.stats.alive[0] + battle.stats.alive[1];
    const all: Array<[string, string]> = [
      ['FPS', fps.toFixed(0)],
      ['CPU render()', `${cpuTime.toFixed(2)} ms`],
      ['Draw calls', String(frameInfo.calls)],
      ['Triangles', formatTriangles(frameInfo.triangles)],
      ['Monsters drawn', `${formatCount(drawn)} / ${formatCount(alive)}`],
      ['Imps · Puglins', `${formatCount(battle.stats.alive[0])} · ${formatCount(battle.stats.alive[1])}`],
      ['Moving · fighting', `${formatCount(battle.stats.moving)} · ${formatCount(battle.stats.fighting)}`]
    ];
    for (let k = 0; k < LEVEL_COUNT; k += 2) {
      const label = k + 1 < LEVEL_COUNT ? `LOD ${String(k)} · ${String(k + 1)}` : `LOD ${String(k)}`;
      const label0 = k === 0 && k + 1 < LEVEL_COUNT ? 'Full · LOD 1' : label;
      const value = k + 1 < LEVEL_COUNT ? `${formatCount(levels.instances[k])} · ${formatCount(levels.instances[k + 1])}` : formatCount(levels.instances[k]);
      all.push([label0, value]);
    }
    const rows = window.innerWidth < 640 ? [all[0], all[2], all[4], all[5]] : all;
    let html = '';
    for (let i = 0; i < rows.length; i++) html += `<dt>${rows[i][0]}</dt><dd>${rows[i][1]}</dd>`;
    statsList.innerHTML = html;
  }

  let running = true;
  let previous = performance.now();

  function frame(): void {
    if (!running) return;
    const now = performance.now();
    const delta = Math.min((now - previous) / 1000, 0.1);
    previous = now;

    try {
      battle.update(delta);
      director.update(delta, battle.focus);
      controls.update(delta);
      if (updateDebug !== null) updateDebug();

      renderer.info.reset();
      const start = performance.now();
      renderer.render(battle.scene, camera);
      cpuTime = performance.now() - start;
      readFrameInfo(renderer, frameInfo);

      if (isWebGPURenderer(renderer)) void renderer.resolveTimestampsAsync();
      stats.update();
      frames++;
      if (now - lastHud > 250) updateHud(now);
    } catch (error) {
      running = false;
      void renderer.setAnimationLoop(null);
      fail(error);
    }
  }

  await progress('Compiling shaders…');
  await Promise.race([renderer.compileAsync(battle.scene, camera), new Promise((resolve) => setTimeout(resolve, 3000))]);
  previous = performance.now();
  lastHud = previous;
  await renderer.setAnimationLoop(frame);
  document.body.dataset['state'] = 'running';
  loading.classList.add('hidden');
}

window.addEventListener('error', (event) => fail(event.error ?? event.message));
window.addEventListener('unhandledrejection', (event) => fail(event.reason));
main().catch(fail);
