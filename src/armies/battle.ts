import { performanceRangeLOD } from '@three.ez/simplify-geometry';
import type { SimplifyParams } from '@three.ez/simplify-geometry';
import { LoopOnce, LoopRepeat } from 'three';
import type { BufferGeometry, Scene } from 'three';
import { InstancedMesh2, reduceSkinInfluences } from '@three.ez/instanced-mesh';
import { Random } from '../random.js';
import { loadMonsters } from './monsters.js';
import type { MonsterAsset } from './monsters.js';
import { createBlobShadows, GroundMarks } from './field.js';
import type { CameraFocus } from './camera.js';
import { createLambertSkinMaterial } from './materials.js';
import { createScenery } from './scenery.js';

/** Clips of the Universal Animation Library baked for both monsters, in clip-index order. */
const CLIPS = [
  'Sword_Idle', 'Idle_Loop', 'Idle_Talking_Loop', 'Spell_Simple_Idle_Loop', 'Dance_Loop', 'Walk_Loop', 'Jog_Fwd_Loop', 'Sprint_Loop',
  'Sword_Attack', 'Punch_Jab', 'Punch_Cross', 'Hit_Chest', 'Hit_Head', 'Death01'
] as const;
type ClipName = (typeof CLIPS)[number];

function clip(name: ClipName): number {
  return CLIPS.indexOf(name);
}

const IDLES = [clip('Sword_Idle'), clip('Idle_Loop'), clip('Idle_Talking_Loop')];
const TAUNTS = [clip('Spell_Simple_Idle_Loop'), clip('Dance_Loop'), clip('Punch_Jab')];
const ATTACKS = [clip('Sword_Attack'), clip('Sword_Attack'), clip('Punch_Jab'), clip('Punch_Cross')];
const HITS = [clip('Hit_Chest'), clip('Hit_Head')];
const CELEBRATION = clip('Dance_Loop');
const WALK = clip('Walk_Loop');
const JOG = clip('Jog_Fwd_Loop');
const SPRINT = clip('Sprint_Loop');
const GUARD = clip('Sword_Idle');
const DEATH = clip('Death01');
/** Skin layer of each army: red Imps, blue Puglins. */
const ARMY_SKINS = [0, 2];

/** Fraction of the triangles of the models kept by the full level, with locked borders. */
const BASE_RATIO = 0.5;

/**
 * Simplified levels of the monsters without calibrated levels: the screen size under which each starts (projected radius over half
 * the view height) and its appearance error relative to the model (the performance range of `@three.ez/simplify-geometry`). Each
 * level starts where its error is about 1.5 pixels at 720p; the farthest also drops small disconnected parts.
 */
const LOD_LEVELS = [
  { screen: 0.2, error: performanceRangeLOD[0] }, { screen: 0.1, error: performanceRangeLOD[1] },
  { screen: 0.04, error: performanceRangeLOD[2] }, { screen: 0.02, error: performanceRangeLOD[3] }
];

/** Levels tuned with the LOD calibration example, by monster name: the simplification of each level and the screen size under which it starts. */
const CALIBRATED_LEVELS: Readonly<Partial<Record<string, { base: SimplifyParams; lods: Array<SimplifyParams & { screen: number }> }>>> = {
  Imp: {
    base: { ratio: 0.5, error: 0.25 },
    lods: [
      { screen: 0.18, ratio: 0.25, error: 0.25 },
      { screen: 0.1, ratio: 0.18, error: 0.25, prune: true },
      { screen: 0.065, ratio: 0.08, error: 0.25, prune: true },
      { screen: 0.03, ratio: 0.02, error: 0.25, prune: true }
    ]
  },
  Puglin: {
    base: { ratio: 0.5, error: 0.25 },
    lods: [
      { screen: 0.18, ratio: 0.25, error: 0.25 },
      { screen: 0.1, ratio: 0.14, error: 0.25, prune: true },
      { screen: 0.065, ratio: 0.11, error: 0.25, prune: true },
      { screen: 0.03, ratio: 0.02, error: 0.25, prune: true }
    ]
  }
};

/** Levels of the most detailed monster, the full model included: rows of the level statistics. */
export const LEVEL_COUNT = 1 + Math.max(LOD_LEVELS.length, ...Object.values(CALIBRATED_LEVELS).map((levels) => levels?.lods.length ?? 0));

/**
 * Skin error allowed on each simplified level, in pixels at 720p at the screen size where the level starts, as the simplification
 * error of the levels: `reduceSkinInfluences` keeps the fewest influences per vertex whose displacement stays under it in every
 * baked frame. Both monsters skin their farthest level, which draws most of the crowd, with one bone per vertex.
 */
const SKIN_ERROR_PIXELS = 1.5;
/**
 * Only levels that start at or under this screen size reduce their influences: the nearest level keeps four within the error
 * anyway, and its vertices would take about half of the reduction time at load.
 */
const SKIN_REDUCTION_SCREEN = 0.1;
/** Levels that start under this screen size read the nearest baked frame instead of blending two: a frame step moves a limb by about a pixel there. */
const NEAREST_FRAME_SCREEN = 0.07;

/**
 * Homes of an army: a random fraction {@link HOME_FILL} of the cells of a grid {@link HOME_CELL} meters wide, jittered within their
 * cells, over an area {@link HOME_ASPECT} times deeper than wide.
 */
const HOME_CELL = 1.6;
const HOME_FILL = 0.5;
const HOME_ASPECT = 1.8;
/** Distance between the front lines at home. */
const ARMY_GAP = 36;
/** Seconds of delay per meter from the front line when the battle starts: the charge sweeps back from the front. */
const DEPART_DELAY = 0.1;
/** Gaits: speeds in m/s with the playback rates that match them; a monster walks for a while, then jogs, then sprints at its foe. */
const WALK_SPEED = 1.6;
const WALK_RATE = 1;
const JOG_SPEED = 3.6;
const JOG_RATE = 1.05;
const SPRINT_SPEED = 5.6;
const SPRINT_RATE = 1;
const WALK_TIME = 1.8;
const SPRINT_RANGE = 9;
/** Distance at which a monster stops to fight its foe, and the farthest at which its blow still lands. */
const MELEE_RANGE = 1.25;
const REACH = 1.75;
/** Fraction of an attack clip at which the blow lands. */
const HIT_POINT = 0.45;
const HEALTH = 2;
const MAX_ATTACKERS = 3;
/** Monsters closer than this push each other apart, at this rate per meter of overlap. */
const SEPARATION = 1.05;
const SEPARATION_PUSH = 5;
/** Rate at which the velocity approaches the desired one (1/s), and the fastest turn (rad/s). */
const ACCELERATION = 6;
const TURN_RATE = 7;
const KNOCKBACK = 2.2;
/** Spatial hash: cell size and how many rings of cells a monster searches for a foe. */
const HASH_CELL = 2;
const SEARCH_RINGS = 5;
const SEARCH_RANGE = SEARCH_RINGS * HASH_CELL;
const VICTORY_TIME = 10;
/** Seconds a corpse lies after its death, then seconds it takes to sink. */
const CORPSE_TIME = 4;
const SINK_TIME = 2;
const SINK_DEPTH = 1.6;
const START_DELAY = 2;
/** Seconds without any attack after which a battle is over even if both armies have survivors. */
const STALEMATE_TIME = 15;
const HOLD = 0;
const MARCH = 1;
const FIGHT = 2;
const STAGGER = 3;
const DEAD = 4;
/**
 * A monster whose position moved less than this (meters) and whose heading turned less than {@link YAW_EPSILON} (radians) since
 * its matrix was last written keeps that matrix, and stays out of the next upload: a few millimeters at most, unseen. A heading
 * under the threshold writes only the translation, without the sine and cosine of the rotation.
 */
const POSITION_EPSILON = 1e-3;
const YAW_EPSILON = 2e-3;
/** Push of the last {@link separation} calls, per axis. */
let pushX = 0;
let pushZ = 0;

export interface BattleSettings {
  /** Starts a new battle a few seconds after one ends. */
  autoBattle: boolean;
  /** Chance that a blow wounds its target: two wounds kill. */
  lethality: number;
  /** Crossfade of every playback change, in seconds. */
  fade: number;
  /** Rate of the shared clock: 0 freezes the battle. */
  timeScale: number;
  blobShadows: boolean;
  /** Levels smaller than {@link NEAREST_FRAME_SCREEN} read the nearest baked frame (`interpolateFrames = false`). */
  nearestFrames: boolean;
  /** Frames between two decisions of a monster: each frame one slice of `1 / thinkInterval` of each army decides; every monster moves every frame. */
  thinkInterval: number;
}

/** Skinning cost of the levels of one monster type. */
export interface SkinningInfo {
  name: string;
  /** Influences per vertex that each level evaluates, the full model first. */
  influences: number[];
  /** Time spent by `reduceSkinInfluences` at load, in milliseconds. */
  reduceTime: number;
}

export interface BattleStats {
  /** Living monsters of each army. */
  alive: number[];
  /** Matrices written in the last frame. */
  moving: number;
  /** Matrices written with a new rotation in the last frame; the others only moved their translation. */
  rotated: number;
  /** Monsters in melee (attacking or reeling) in the last frame. */
  fighting: number;
  /** Monsters that decided in the last frame. */
  thinking: number;
  /** CPU time of the battle update, averaged over recent frames, in milliseconds. */
  updateTime: number;
  /** Playback records written in the last frame. */
  changes: number;
}

/** Monsters drawn by each level of the main pass in the last frame, and their triangles. */
export interface LevelStats {
  instances: number[];
  triangles: number[];
}

export interface Battle {
  scene: Scene;
  count: number;
  halfWidth: number;
  halfDepth: number;
  /** Distance from the middle of the field to the sky. */
  radius: number;
  /** Middle of the melee, or of both armies before it: where a camera should look. */
  focus: CameraFocus;
  settings: BattleSettings;
  stats: BattleStats;
  /** One entry per monster type. */
  skinning: SkinningInfo[];
  update: (delta: number) => void;
  /** Revives everyone at home and starts again. */
  restart: () => void;
  countLevels: (out: LevelStats) => LevelStats;
}

/** One army: its mesh and, per monster, home, position, velocity, heading, state, foe and playback. */
interface Army {
  mesh: InstancedMesh2;
  matrices: MatrixStorage;
  /** Heading last written to each matrix. */
  drawnYaw: Float32Array;
  durations: number[];
  /** Direction from the middle of the field toward the army (-1 Imps, +1 Puglins). */
  side: number;
  /** First index of the army in the blob shadows. */
  offset: number;
  total: number;
  homeX: Float32Array;
  homeZ: Float32Array;
  scale: Float32Array;
  x: Float32Array;
  z: Float32Array;
  vx: Float32Array;
  vz: Float32Array;
  yaw: Float32Array;
  /**
   * Decisions kept between turns: the velocity a monster heads for, its push away from its neighbors, and the heading it faces
   * (NaN to face where it moves).
   */
  desiredX: Float32Array;
  desiredZ: Float32Array;
  pushX: Float32Array;
  pushZ: Float32Array;
  faceYaw: Float32Array;
  state: Uint8Array;
  health: Uint8Array;
  /** Enemy ID the monster goes for, or -1; enemies going for each monster. */
  target: Int32Array;
  attackers: Uint8Array;
  /** Looping clip playing (gait, guard, idle), or -1 while a one-shot clip plays. */
  loop: Int16Array;
  endOf: Float64Array;
  hitAt: Float64Array;
  departAt: Float64Array;
  retargetAt: Float64Array;
  /** IDs of the dead whose corpses are still on the field, and the time of each death. */
  corpses: number[];
  diedAt: Float64Array;
  alive: number;
  centerX: number;
  centerZ: number;
  /** Extent along x of the living monsters. */
  minX: number;
  maxX: number;
  hash: SpatialHash;
}

/** Living monsters of an army bucketed by cell (counting sort, rebuilt every frame) with their positions, for neighbor queries. */
interface SpatialHash {
  minX: number;
  minZ: number;
  cellsX: number;
  cellsZ: number;
  /** First item of each cell; the last entry is the item count. */
  start: Int32Array;
  cursor: Int32Array;
  items: Int32Array;
  cellOf: Int32Array;
  x: Float32Array;
  z: Float32Array;
}

/** The battle: the armies charge front first, monsters pick foes nearby, fight in melee, reel and die; corpses sink after a while. */
class BattleState {
  public readonly settings: BattleSettings = {
    autoBattle: true, lethality: 0.4, fade: 0.25, timeScale: 1, blobShadows: true, nearestFrames: true, thinkInterval: 4
  };

  public readonly stats: BattleStats = { alive: [0, 0], moving: 0, rotated: 0, fighting: 0, thinking: 0, changes: 0, updateTime: 0 };
  public readonly focus: CameraFocus = { x: 0, z: 0 };
  private _fightX = 0;
  private _fightZ = 0;
  private _clock = 0;
  /** Waiting to start, fighting, or celebrating until `_stateEnd`. */
  private _state: 'waiting' | 'fighting' | 'celebrating' = 'waiting';
  private _stateEnd = 0;
  private _lastAttack = 0;
  private _winner: Army | null = null;
  /** `settings.nearestFrames` as last applied to the levels. */
  private _nearestFrames = true;
  /** Fighting frames so far: picks the slice of each army that decides. */
  private _tick = 0;
  /** Matrices of the blob shadows, one per monster at the offset of its army. */
  private readonly _blobMatrices: MatrixStorage;

  public constructor(
    private readonly _armies: Army[], private readonly _blobs: InstancedMesh2, private readonly _marks: GroundMarks,
    private readonly _random: Random
  ) {
    this._blobMatrices = matricesOf(_blobs);
  }

  /** Everyone alive, visible and at home, idling; the battle starts after a short delay. */
  public reset(): void {
    for (let a = 0; a < this._armies.length; a++) this.resetArmy(this._armies[a]);
    this._marks.clear();
    this._state = 'waiting';
    this._stateEnd = this._clock + START_DELAY;
    this._winner = null;
  }

  /** Monsters depart front first: the farther from the enemy, the later. */
  public start(): void {
    if (this._state !== 'waiting') return;
    this._state = 'fighting';
    this._lastAttack = this._clock;
    for (let a = 0; a < this._armies.length; a++) {
      const army = this._armies[a];
      for (let id = 0; id < army.total; id++) {
        const behind = Math.abs(army.homeX[id]) - ARMY_GAP / 2;
        army.departAt[id] = this._clock + behind * DEPART_DELAY + this._random.range(0, 0.8);
      }
    }
  }

  /** Small levels read the nearest frame or blend two; changing it rebuilds the shaders of those levels. */
  private applyNearestFrames(): void {
    this._nearestFrames = this.settings.nearestFrames;
    for (let a = 0; a < this._armies.length; a++) {
      const levels = this._armies[a].mesh.LODInfo?.render?.levels ?? [];
      for (let k = 1, l = levels.length; k < l; k++) {
        levels[k].object.interpolateFrames = !this._nearestFrames || levels[k].metric >= NEAREST_FRAME_SCREEN;
      }
    }
  }

  public update(delta: number): void {
    const start = performance.now();
    const step = delta * this.settings.timeScale;
    this._clock += step;
    this._fightX = 0;
    this._fightZ = 0;
    this.stats.moving = 0;
    this.stats.rotated = 0;
    this.stats.fighting = 0;
    this.stats.thinking = 0;
    this.stats.changes = 0;
    this._blobs.visible = this.settings.blobShadows;
    if (this.settings.nearestFrames !== this._nearestFrames) this.applyNearestFrames();
    if (this._state === 'waiting' && this._clock >= this._stateEnd) this.start();
    if (this._state === 'celebrating' && this._clock >= this._stateEnd && this.settings.autoBattle) this.reset();

    const [first, second] = this._armies;
    first.mesh.animationTime = this._clock;
    second.mesh.animationTime = this._clock;
    if (this._state === 'fighting' && step > 0) {
      buildHash(first);
      buildHash(second);
      this.thinkSlice(first, second);
      this.thinkSlice(second, first);
      this._tick++;
      this.move(first, step);
      this.move(second, step);
      this.updateFocus(first, second);
      if (first.alive === 0 || second.alive === 0 || this._clock - this._lastAttack > STALEMATE_TIME) this.celebrate();
    }
    if (step > 0) {
      this.sinkCorpses(first);
      this.sinkCorpses(second);
    }
    for (let a = 0; a < this._armies.length; a++) {
      this.expireClips(this._armies[a]);
      this.stats.alive[a] = this._armies[a].alive;
    }
    this._marks.flush(performance.now());
    this.stats.updateTime += (performance.now() - start - this.stats.updateTime) * 0.05;
  }

  private play(army: Army, id: number, clipIndex: number, time: number, speed: number, once: boolean): void {
    army.mesh.playAnimationAt(id, clipIndex, time, speed, once ? LoopOnce : LoopRepeat, this.settings.fade);
    army.loop[id] = once ? -1 : clipIndex;
    army.endOf[id] = once ? this._clock + (army.durations[clipIndex] - time) / speed : this._clock + this._random.range(4, 10);
    this.stats.changes++;
  }

  private pick(clips: readonly number[]): number {
    return clips[Math.floor(this._random.next() * clips.length)];
  }

  private rest(army: Army, id: number): void {
    if (this._random.next() < 0.15) this.play(army, id, this.pick(TAUNTS), 0, this._random.range(0.9, 1.1), true);
    else this.play(army, id, this.pick(IDLES), this._random.range(0, 2), this._random.range(0.85, 1.15), false);
  }

  private resetArmy(army: Army): void {
    army.corpses.length = 0;
    army.alive = army.total;
    for (let id = 0; id < army.total; id++) {
      army.x[id] = army.homeX[id];
      army.z[id] = army.homeZ[id];
      army.vx[id] = 0;
      army.vz[id] = 0;
      army.desiredX[id] = 0;
      army.desiredZ[id] = 0;
      army.pushX[id] = 0;
      army.pushZ[id] = 0;
      army.faceYaw[id] = NaN;
      army.yaw[id] = -army.side * Math.PI / 2 + this._random.range(-0.6, 0.6);
      army.state[id] = HOLD;
      army.health[id] = HEALTH;
      army.target[id] = -1;
      army.attackers[id] = 0;
      army.hitAt[id] = Infinity;
      army.departAt[id] = Infinity;
      army.retargetAt[id] = 0;
      army.mesh.setVisibilityAt(id, true);
      this._blobs.setVisibilityAt(army.offset + id, true);
      this.place(army, id, 0, true);
      this.rest(army, id);
    }
  }

  /**
   * The monsters of an army whose turn it is to decide: the army is split into `thinkInterval` consecutive slices, and each frame
   * the next slice decides, so every monster decides once every `thinkInterval` frames.
   */
  private thinkSlice(army: Army, enemy: Army): void {
    const interval = Math.max(1, Math.round(this.settings.thinkInterval));
    const size = Math.ceil(army.total / interval);
    const begin = (this._tick % interval) * size;
    for (let id = begin, end = Math.min(army.total, begin + size); id < end; id++) this.think(army, enemy, id);
  }

  /**
   * A living monster decides: departs on its time, keeps or picks a foe nearby (else heads for the enemy army), picks the velocity
   * to walk, jog or sprint to it, fights it within reach, and measures its push away from its neighbors. {@link move} applies the
   * decision every frame until the next one.
   */
  private think(army: Army, enemy: Army, id: number): void {
    let state = army.state[id];
    if (state === DEAD) return;
    if (state === HOLD && this._clock < army.departAt[id]) return;
    if (state === HOLD) state = MARCH;
    this.stats.thinking++;
    const target = this.keepTarget(army, enemy, id, state);
    const x = army.x[id];
    const z = army.z[id];
    let desiredX = 0;
    let desiredZ = 0;
    let faceYaw = NaN;
    let gait = -1;
    if (target !== -1) {
      const dx = enemy.x[target] - x;
      const dz = enemy.z[target] - z;
      const distance = Math.sqrt(dx * dx + dz * dz) + 1e-6;
      if (state === MARCH && distance <= MELEE_RANGE) state = FIGHT;
      else if (state === FIGHT && distance > MELEE_RANGE + 0.5) state = MARCH;
      if (state === MARCH) {
        gait = this.gait(army, id, distance);
        desiredX = dx / distance * gaitSpeed(gait);
        desiredZ = dz / distance * gaitSpeed(gait);
      }
      if (distance < 4) faceYaw = Math.atan2(dx, dz);
    } else if (state !== STAGGER) {
      state = MARCH;
      const dx = enemy.centerX - x;
      const dz = (enemy.centerZ - z) * 0.35;
      const distance = Math.sqrt(dx * dx + dz * dz) + 1e-6;
      gait = this.gait(army, id, Infinity);
      desiredX = dx / distance * gaitSpeed(gait);
      desiredZ = dz / distance * gaitSpeed(gait);
    }
    army.state[id] = state;
    army.desiredX[id] = desiredX;
    army.desiredZ[id] = desiredZ;
    army.faceYaw[id] = faceYaw;
    if (state === MARCH) army.hitAt[id] = Infinity;

    pushX = 0;
    pushZ = 0;
    separation(army.hash, id, x, z);
    separation(enemy.hash, -1, x, z);
    army.pushX[id] = pushX;
    army.pushZ[id] = pushZ;

    if (state === MARCH && gait !== army.loop[id]) this.play(army, id, gait, this._random.range(0, 1), gaitRate(gait), false);
    if (state === FIGHT) this.fight(army, enemy, id);
    if (state === STAGGER && army.endOf[id] <= this._clock) army.state[id] = MARCH;
  }

  /**
   * Every frame, every monster on the move follows its last decision: its velocity approaches the desired one, its neighbors push
   * it, and it turns toward its foe or where it goes.
   */
  private move(army: Army, step: number): void {
    const blend = Math.min(1, ACCELERATION * step);
    for (let id = 0; id < army.total; id++) {
      const state = army.state[id];
      if (state === DEAD || state === HOLD) continue;
      const vx = army.vx[id] + (army.desiredX[id] - army.vx[id]) * blend;
      const vz = army.vz[id] + (army.desiredZ[id] - army.vz[id]) * blend;
      army.vx[id] = vx;
      army.vz[id] = vz;
      army.x[id] += (vx + army.pushX[id] * SEPARATION_PUSH) * step;
      army.z[id] += (vz + army.pushZ[id] * SEPARATION_PUSH) * step;
      const face = army.faceYaw[id];
      if (!Number.isNaN(face)) army.yaw[id] = turn(army.yaw[id], face, TURN_RATE * step);
      else if (vx * vx + vz * vz > 0.04) army.yaw[id] = turn(army.yaw[id], Math.atan2(vx, vz), TURN_RATE * step);
      this.place(army, id, 0, false);
      if (state === FIGHT || state === STAGGER) {
        this.stats.fighting++;
        this._fightX += army.x[id];
        this._fightZ += army.z[id];
      }
    }
  }

  /** The foe of a monster: dropped when dead, searched again while marching (or without one) every half second or so. */
  private keepTarget(army: Army, enemy: Army, id: number, state: number): number {
    let target = army.target[id];
    if (target !== -1 && enemy.state[target] === DEAD) target = this.setTarget(army, enemy, id, -1);
    if (target !== -1 && (state === FIGHT || state === STAGGER)) return target;
    if (this._clock < army.retargetAt[id]) return target;
    army.retargetAt[id] = this._clock + this._random.range(0.4, 0.9);
    const x = army.x[id];
    if (x < enemy.minX - SEARCH_RANGE || x > enemy.maxX + SEARCH_RANGE) return this.setTarget(army, enemy, id, -1);
    return this.setTarget(army, enemy, id, findFoe(enemy.hash, enemy, x, army.z[id], target));
  }

  private setTarget(army: Army, enemy: Army, id: number, target: number): number {
    const previous = army.target[id];
    if (previous === target) return target;
    if (previous !== -1) enemy.attackers[previous]--;
    if (target !== -1) enemy.attackers[target]++;
    army.target[id] = target;
    return target;
  }

  /** Walks first, then jogs, and sprints at a foe in sight. */
  private gait(army: Army, id: number, distance: number): number {
    if (distance < SPRINT_RANGE) return SPRINT;
    return this._clock < army.departAt[id] + WALK_TIME ? WALK : JOG;
  }

  /**
   * Melee: an attack clip, a short guard pause, another attack. The blow lands partway through the attack, if the foe is still in
   * reach, with the lethality as its chance.
   */
  private fight(army: Army, enemy: Army, id: number): void {
    if (army.hitAt[id] <= this._clock) {
      army.hitAt[id] = Infinity;
      const target = army.target[id];
      if (target !== -1 && enemy.state[target] !== DEAD && this._random.next() < this.settings.lethality) {
        const dx = enemy.x[target] - army.x[id];
        const dz = enemy.z[target] - army.z[id];
        if (dx * dx + dz * dz <= REACH * REACH) this.wound(enemy, target, army, dx, dz);
      }
    }
    const loop = army.loop[id];
    if (loop === -1 && army.endOf[id] <= this._clock) {
      this.play(army, id, GUARD, this._random.range(0, 1), 1, false);
      army.endOf[id] = this._clock + this._random.range(0.15, 0.8);
    } else if (loop !== -1 && (loop !== GUARD || army.endOf[id] <= this._clock)) {
      const attack = this.pick(ATTACKS);
      const speed = this._random.range(0.9, 1.25);
      this.play(army, id, attack, 0, speed, true);
      army.hitAt[id] = this._clock + army.durations[attack] * HIT_POINT / speed;
      this._lastAttack = this._clock;
    }
  }

  /** A wound knocks the monster back and makes it reel (losing its pending blow); the last one kills it. */
  private wound(army: Army, id: number, attacker: Army, dx: number, dz: number): void {
    const length = Math.sqrt(dx * dx + dz * dz) + 1e-6;
    army.vx[id] += dx / length * KNOCKBACK;
    army.vz[id] += dz / length * KNOCKBACK;
    army.desiredX[id] = 0;
    army.desiredZ[id] = 0;
    army.health[id]--;
    this._marks.mark(army.x[id], army.z[id], 0.8, 0.5);
    if (army.health[id] === 0) {
      this.kill(army, id, attacker);
      return;
    }
    army.state[id] = STAGGER;
    army.hitAt[id] = Infinity;
    this.play(army, id, this.pick(HITS), 0, this._random.range(0.9, 1.2), true);
  }

  /** Plays the death clip with a random speed and a twist of the body; the corpse lies for a while, then sinks. */
  private kill(army: Army, id: number, attacker: Army): void {
    this.setTarget(army, attacker, id, -1);
    army.state[id] = DEAD;
    army.alive--;
    army.corpses.push(id);
    army.diedAt[id] = this._clock;
    army.yaw[id] += this._random.range(-0.6, 0.6);
    this._marks.mark(army.x[id], army.z[id], 1.3, 0.8);
    army.mesh.playAnimationAt(id, DEATH, 0, this._random.range(0.8, 1.2), LoopOnce, this.settings.fade);
    this.place(army, id, 0, false);
    this.stats.changes++;
  }

  /** The middle of the monsters in melee this frame, or of both armies before they meet. */
  private updateFocus(first: Army, second: Army): void {
    const fighting = this.stats.fighting;
    this.focus.x = fighting > 0 ? this._fightX / fighting : (first.centerX + second.centerX) / 2;
    this.focus.z = fighting > 0 ? this._fightZ / fighting : (first.centerZ + second.centerZ) / 2;
  }

  /** The army with more survivors celebrates; everyone stops where they are. */
  private celebrate(): void {
    const [first, second] = this._armies;
    this._state = 'celebrating';
    this._stateEnd = this._clock + VICTORY_TIME;
    this._winner = first.alive >= second.alive ? first : second;
    for (let a = 0; a < this._armies.length; a++) {
      const army = this._armies[a];
      const enemy = this._armies[1 - a];
      for (let id = 0; id < army.total; id++) {
        if (army.state[id] === DEAD) continue;
        this.setTarget(army, enemy, id, -1);
        army.state[id] = HOLD;
        army.hitAt[id] = Infinity;
        army.endOf[id] = this._clock;
      }
    }
  }

  /**
   * Corpses lying for {@link CORPSE_TIME} seconds sink into the ground over {@link SINK_TIME}, losing their blob shadow, and are
   * hidden once underground; they reappear when the battle restarts.
   */
  private sinkCorpses(army: Army): void {
    const corpses = army.corpses;
    for (let k = corpses.length - 1; k >= 0; k--) {
      const id = corpses[k];
      const sink = (this._clock - army.diedAt[id] - CORPSE_TIME) / SINK_TIME;
      if (sink <= 0) continue;
      if (sink >= 1) {
        army.mesh.setVisibilityAt(id, false);
        corpses[k] = corpses[corpses.length - 1];
        corpses.pop();
        continue;
      }
      this._blobs.setVisibilityAt(army.offset + id, false);
      this.place(army, id, -sink * SINK_DEPTH, false);
    }
  }

  /** Monsters standing still whose one-shot clip or idle stint ended pick the next one; the winners celebrate. */
  private expireClips(army: Army): void {
    for (let id = 0; id < army.total; id++) {
      if (army.state[id] !== HOLD || army.endOf[id] > this._clock) continue;
      if (this._state === 'celebrating' && army === this._winner) this.play(army, id, CELEBRATION, this._random.range(0, 1), 1, false);
      else this.rest(army, id);
    }
  }

  /**
   * Moves the matrix of a monster (and of its blob shadow, on the ground) to its position and heading, `y` up. Monsters only turn
   * about y and never change scale, so only the elements that change are written: the translation, and the four elements of the
   * rotation once the heading drifted past {@link YAW_EPSILON}. A monster that barely moved and turned keeps its matrix. Blob
   * shadows never rotate: they only write their translation. `force` writes the rotation and translation (after a reset).
   */
  private place(army: Army, id: number, y: number, force: boolean): void {
    const matrices = army.matrices;
    const array = matrices.array;
    const offset = id * 16;
    const x = army.x[id];
    const z = army.z[id];
    const yaw = army.yaw[id];
    const dx = x - array[offset + 12];
    const dy = y - array[offset + 13];
    const dz = z - array[offset + 14];
    const moved = force || dx * dx + dy * dy + dz * dz > POSITION_EPSILON * POSITION_EPSILON;
    const turned = force || Math.abs(yaw - army.drawnYaw[id]) > YAW_EPSILON;
    if (!moved && !turned) return;
    if (turned) {
      const scale = army.scale[id];
      const cos = Math.cos(yaw) * scale;
      const sin = Math.sin(yaw) * scale;
      array[offset] = cos;
      array[offset + 2] = -sin;
      array[offset + 8] = sin;
      array[offset + 10] = cos;
      army.drawnYaw[id] = yaw;
      this.stats.rotated++;
    }
    array[offset + 12] = x;
    array[offset + 13] = y;
    array[offset + 14] = z;
    matrices.markDirty(id);
    this.stats.moving++;
    if (y !== 0 || !moved) return;
    const blobs = this._blobMatrices;
    const blob = army.offset + id;
    blobs.array[blob * 16 + 12] = x;
    blobs.array[blob * 16 + 14] = z;
    blobs.markDirty(blob);
  }
}

/**
 * Two armies of Imps and Puglins scattered over the two halves of a field. When the battle starts they depart front first:
 * monsters walk, jog, then sprint at the nearest enemy not already fought by three, and meet in a melee where the front bends and
 * breaks. A blow lands partway through an attack with the lethality as its chance: the first wound knocks the monster back and makes
 * it reel, the second kills it. Corpses lie a few seconds, then sink; the survivors celebrate and a new battle starts. Free
 * movement with steering: a spatial hash rebuilt every frame finds the neighbors to keep apart and the foes to pick. Every monster
 * plays baked clips, the Imps in red skins and the Puglins in blue, each with its own tint; blows and falls stain the grass.
 * Phones: Lambert materials with a rim light and occlusion by height, no shadow maps (blob shadows instead), no post-processing.
 */
export async function createBattle(count: number, backend: string, seed = 5): Promise<Battle> {
  const assets = await loadMonsters({
    clips: CLIPS, framesPerSecond: 24, baseRatio: BASE_RATIO, lodErrors: LOD_LEVELS.map((level) => level.error), shadowRatio: null,
    levels: CALIBRATED_LEVELS
  });
  const levels = assets.map(createLevels);
  const random = new Random(seed);
  const perArmy = [Math.ceil(count / 2), Math.floor(count / 2)];
  const columns = Math.max(1, Math.ceil(Math.sqrt(perArmy[0] / HOME_FILL / HOME_ASPECT)));
  const rows = Math.max(1, Math.ceil(perArmy[0] / HOME_FILL / columns));
  const halfWidth = ARMY_GAP / 2 + columns * HOME_CELL + 10;
  const halfDepth = rows * HOME_CELL / 2 + 10;
  const armies = [
    createArmy(assets[0], levels[0], ARMY_SKINS[0], backend, perArmy[0], -1, 0, columns, rows, createHash(halfWidth * 1.3, halfDepth * 1.3, perArmy[0]), random),
    createArmy(assets[1], levels[1], ARMY_SKINS[1], backend, perArmy[1], 1, perArmy[0], columns, rows, createHash(halfWidth * 1.3, halfDepth * 1.3, perArmy[1]), random)
  ];
  const { scene, radius } = createScenery(halfWidth, halfDepth, seed);
  const marks = new GroundMarks(halfWidth * 1.3, halfDepth * 1.3);
  const blobs = createBlobShadows(count);
  for (let a = 0; a < armies.length; a++) placeBlobs(blobs, armies[a]);
  scene.add(marks.mesh, armies[0].mesh, armies[1].mesh, blobs);
  const battle = new BattleState(armies, blobs, marks, random);
  battle.reset();

  return {
    scene,
    count,
    halfWidth,
    halfDepth,
    radius,
    focus: battle.focus,
    settings: battle.settings,
    stats: battle.stats,
    skinning: levels.map((level) => level.skinning),
    update: (delta) => {
      battle.update(delta);
    },
    restart: () => {
      battle.reset();
    },
    countLevels: (out) => {
      out.instances.fill(0);
      out.triangles.fill(0);
      for (let a = 0; a < armies.length; a++) addLevelCounts(armies[a].mesh, out);
      return out;
    }
  };
}

/**
 * The mesh of one army and its homes: `count` cells of a grid of `columns` × `rows` beyond its front line, picked at random and
 * jittered.
 */
function createArmy(
  asset: MonsterAsset, levels: ArmyLevels, skin: number, backend: string, count: number, side: number, offset: number, columns: number,
  rows: number, hash: SpatialHash, random: Random
): Army {
  const mesh = createArmyMesh(asset, levels, skin, backend, count);
  const army: Army = {
    mesh, matrices: matricesOf(mesh), drawnYaw: new Float32Array(count), durations: asset.durations, side, offset, total: count,
    homeX: new Float32Array(count), homeZ: new Float32Array(count),
    scale: new Float32Array(count), x: new Float32Array(count), z: new Float32Array(count), vx: new Float32Array(count),
    vz: new Float32Array(count), yaw: new Float32Array(count), desiredX: new Float32Array(count), desiredZ: new Float32Array(count),
    pushX: new Float32Array(count), pushZ: new Float32Array(count), faceYaw: new Float32Array(count).fill(NaN),
    state: new Uint8Array(count), health: new Uint8Array(count),
    target: new Int32Array(count), attackers: new Uint8Array(count), loop: new Int16Array(count), endOf: new Float64Array(count),
    hitAt: new Float64Array(count), departAt: new Float64Array(count), retargetAt: new Float64Array(count), corpses: [], diedAt: new Float64Array(count),
    alive: count,
    centerX: 0, centerZ: 0, minX: 0, maxX: 0, hash
  };
  const cells = pickCells(columns * rows, count, random);
  army.mesh.addInstances(count, (instance, id) => {
    const column = cells[id] % columns;
    const row = Math.floor(cells[id] / columns);
    army.homeX[id] = side * (ARMY_GAP / 2 + (column + random.range(0.15, 0.85)) * HOME_CELL);
    army.homeZ[id] = (row + random.range(0.15, 0.85) - rows / 2) * HOME_CELL;
    army.scale[id] = random.range(0.9, 1.12);
    instance.position.set(army.homeX[id], 0, army.homeZ[id]);
    instance.scale.setScalar(army.scale[id]);
  });
  return army;
}

/** `count` distinct cells out of `total`, in random order: a partial Fisher-Yates shuffle. */
function pickCells(total: number, count: number, random: Random): Int32Array {
  const cells = new Int32Array(total);
  for (let i = 0; i < total; i++) cells[i] = i;
  for (let i = 0; i < count; i++) {
    const j = i + Math.floor(random.next() * (total - i));
    const cell = cells[j];
    cells[j] = cells[i];
    cells[i] = cell;
  }
  return cells.subarray(0, count);
}

/** Simplified levels of a monster with reduced skin influences, and the screen size under which each starts. */
interface ArmyLevels {
  geometries: BufferGeometry[];
  screens: number[];
  skinning: SkinningInfo;
}

/**
 * Reduces the skin influences of the far simplified levels of a monster within {@link SKIN_ERROR_PIXELS}, measured over every
 * frame of its bake: farther levels tolerate a larger error relative to the model, so they keep fewer influences. The projected radius
 * at the start of a level is `screen · 360` pixels at 720p, so the model is at most `screen · 720` pixels tall or wide.
 */
function createLevels(asset: MonsterAsset): ArmyLevels {
  const screens = (CALIBRATED_LEVELS[asset.kind.name]?.lods ?? LOD_LEVELS).map((level) => level.screen);
  const geometries: BufferGeometry[] = [];
  const influences = [countInfluences(asset.geometry)];
  const start = performance.now();
  for (let i = 0, l = screens.length; i < l; i++) {
    if (screens[i] > SKIN_REDUCTION_SCREEN) {
      geometries.push(asset.lods[i]);
      influences.push(countInfluences(asset.lods[i]));
      continue;
    }
    const error = SKIN_ERROR_PIXELS / (screens[i] * 720);
    const reduced = reduceSkinInfluences(asset.lods[i], asset.bake, { error, bindMatrix: asset.bindMatrix });
    geometries.push(reduced.geometry);
    influences.push(reduced.influences);
  }
  return { geometries, screens, skinning: { name: asset.kind.name, influences, reduceTime: performance.now() - start } };
}

/** Slots a geometry uses: one more than the last slot with a nonzero weight in any vertex, as the shaders count them. */
function countInfluences(geometry: BufferGeometry): number {
  const weights = geometry.getAttribute('skinWeight');
  let count = 1;
  for (let v = 0; v < weights.count; v++) {
    for (let k = 3; k >= count; k--) {
      if (weights.getComponent(v, k) === 0) continue;
      count = k + 1;
      break;
    }
  }
  return count;
}

function createArmyMesh(asset: MonsterAsset, levels: ArmyLevels, skin: number, backend: string, count: number): InstancedMesh2 {
  asset.geometry.computeBoundingBox();
  const height = asset.geometry.boundingBox?.max.y ?? 1;
  const material = createLambertSkinMaterial(asset.material, asset.skins, skin, height, backend);
  const mesh = new InstancedMesh2(asset.geometry, material, { capacity: Math.max(1, count), useDistanceForLOD: false });
  for (let i = 0, l = levels.screens.length; i < l; i++) {
    const screen = levels.screens[i];
    mesh.addLOD(levels.geometries[i], material, screen, 0, { interpolateFrames: screen >= NEAREST_FRAME_SCREEN });
  }
  mesh.initSkeleton(asset.skeleton, true, asset.bindMatrix);
  mesh.bindMode = asset.bindMode;
  mesh.setAnimationBake(asset.bake, true);
  return mesh;
}

function createHash(halfWidth: number, halfDepth: number, count: number): SpatialHash {
  const cellsX = Math.ceil(halfWidth * 2 / HASH_CELL);
  const cellsZ = Math.ceil(halfDepth * 2 / HASH_CELL);
  return {
    minX: -halfWidth, minZ: -halfDepth, cellsX, cellsZ, start: new Int32Array(cellsX * cellsZ + 1), cursor: new Int32Array(cellsX * cellsZ + 1),
    items: new Int32Array(count), cellOf: new Int32Array(count), x: new Float32Array(count), z: new Float32Array(count)
  };
}

function cellColumn(hash: SpatialHash, x: number): number {
  return Math.min(hash.cellsX - 1, Math.max(0, Math.floor((x - hash.minX) / HASH_CELL)));
}

function cellRow(hash: SpatialHash, z: number): number {
  return Math.min(hash.cellsZ - 1, Math.max(0, Math.floor((z - hash.minZ) / HASH_CELL)));
}

/** Buckets the living monsters of an army by cell, and stores its middle and its extent along x. */
function buildHash(army: Army): void {
  const hash = army.hash;
  const start = hash.start;
  start.fill(0);
  let sumX = 0;
  let sumZ = 0;
  let minX = Infinity;
  let maxX = -Infinity;
  for (let id = 0; id < army.total; id++) {
    if (army.state[id] === DEAD) {
      hash.cellOf[id] = -1;
      continue;
    }
    const x = army.x[id];
    const z = army.z[id];
    const cell = cellRow(hash, z) * hash.cellsX + cellColumn(hash, x);
    hash.cellOf[id] = cell;
    hash.x[id] = x;
    hash.z[id] = z;
    start[cell + 1]++;
    sumX += x;
    sumZ += z;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
  }
  army.centerX = army.alive > 0 ? sumX / army.alive : 0;
  army.centerZ = army.alive > 0 ? sumZ / army.alive : 0;
  army.minX = minX;
  army.maxX = maxX;
  for (let c = 1, l = start.length; c < l; c++) start[c] += start[c - 1];
  const cursor = hash.cursor;
  cursor.set(start);
  for (let index = 0, l = hash.cellOf.length; index < l; index++) {
    const cell = hash.cellOf[index];
    if (cell !== -1) hash.items[cursor[cell]++] = index;
  }
}

/**
 * Adds to {@link pushX} and {@link pushZ} the push away from the monsters of a hash closer than {@link SEPARATION} (`self` aside),
 * in meters of overlap.
 */
function separation(hash: SpatialHash, self: number, x: number, z: number): void {
  const cx = cellColumn(hash, x);
  const cz = cellRow(hash, z);
  for (let j = Math.max(0, cz - 1), jl = Math.min(hash.cellsZ - 1, cz + 1); j <= jl; j++) {
    for (let i = Math.max(0, cx - 1), il = Math.min(hash.cellsX - 1, cx + 1); i <= il; i++) {
      const cell = j * hash.cellsX + i;
      for (let k = hash.start[cell], end = hash.start[cell + 1]; k < end; k++) {
        const other = hash.items[k];
        if (other === self) continue;
        const dx = x - hash.x[other];
        const dz = z - hash.z[other];
        const squared = dx * dx + dz * dz;
        if (squared >= SEPARATION * SEPARATION) continue;
        const distance = Math.sqrt(squared);
        if (distance < 1e-4) {
          pushX += self < other ? 0.5 : -0.5;
          continue;
        }
        const overlap = (SEPARATION - distance) / distance;
        pushX += dx * overlap;
        pushZ += dz * overlap;
      }
    }
  }
}

/**
 * The living enemy nearest to (x, z) within {@link SEARCH_RINGS} cells of the enemy hash that is not already fought by
 * {@link MAX_ATTACKERS} (the current foe aside), or -1.
 */
function findFoe(hash: SpatialHash, enemy: Army, x: number, z: number, current: number): number {
  const cx = cellColumn(hash, x);
  const cz = cellRow(hash, z);
  let best = -1;
  let bestSquared = Infinity;
  for (let ring = 0; ring <= SEARCH_RINGS; ring++) {
    for (let j = cz - ring; j <= cz + ring; j++) {
      if (j < 0 || j >= hash.cellsZ) continue;
      const stride = j === cz - ring || j === cz + ring || ring === 0 ? 1 : ring * 2;
      for (let i = cx - ring; i <= cx + ring; i += stride) {
        if (i < 0 || i >= hash.cellsX) continue;
        const cell = j * hash.cellsX + i;
        for (let k = hash.start[cell], end = hash.start[cell + 1]; k < end; k++) {
          const foe = hash.items[k];
          if (foe !== current && enemy.attackers[foe] >= MAX_ATTACKERS) continue;
          const dx = hash.x[foe] - x;
          const dz = hash.z[foe] - z;
          const squared = dx * dx + dz * dz;
          if (squared >= bestSquared) continue;
          bestSquared = squared;
          best = foe;
        }
      }
    }
    const reach = ring * HASH_CELL;
    if (best !== -1 && bestSquared <= reach * reach) return best;
  }
  return best;
}

function gaitSpeed(gait: number): number {
  if (gait === SPRINT) return SPRINT_SPEED;
  return gait === WALK ? WALK_SPEED : JOG_SPEED;
}

function gaitRate(gait: number): number {
  if (gait === SPRINT) return SPRINT_RATE;
  return gait === WALK ? WALK_RATE : JOG_RATE;
}

/** Turns a heading toward another by at most `limit` radians, the short way round. */
function turn(from: number, to: number, limit: number): number {
  let difference = to - from;
  difference -= Math.round(difference / (Math.PI * 2)) * Math.PI * 2;
  return from + Math.max(-limit, Math.min(limit, difference));
}

/**
 * The matrices of a mesh as `InstancedMesh2` stores them at runtime: 16 floats per instance, column-major, and the marks of the
 * changes the next draw uploads. `matricesBuffer` is typed as `InstanceDataBuffer`, which declares neither. Writing only the
 * elements that change skips composing and copying whole matrices (`setMatrixAt`): for 10,000 monsters and their shadows,
 * 0.2 to 0.55 ms per frame instead of about 1 ms. Safe here because the meshes have no entity array and no BVH to keep in sync.
 */
interface MatrixStorage {
  readonly array: Float32Array;
  markDirty: (id: number) => void;
}

function matricesOf(mesh: InstancedMesh2): MatrixStorage {
  if (mesh.instances !== null || mesh.bvh !== null) throw new Error('Direct matrix writes would leave the entities or the BVH stale.');
  return mesh.matricesBuffer as unknown as MatrixStorage;
}

function placeBlobs(blobs: InstancedMesh2, army: Army): void {
  blobs.addInstances(army.total, (instance, id) => {
    instance.scale.setScalar(army.scale[id]);
  });
}

function addLevelCounts(mesh: InstancedMesh2, out: LevelStats): void {
  const levels = mesh.LODInfo?.render?.levels ?? [];
  for (let k = 0, l = levels.length; k < l; k++) {
    const object = levels[k].object;
    const index = object.geometry.getIndex();
    const triangles = (index === null ? object.geometry.getAttribute('position').count : index.count) / 3;
    out.instances[k] += object.count;
    out.triangles[k] += object.count * triangles;
  }
}
