import type { RulesConfig, UnitClass } from './types.ts'

type ClassBase = Pick<UnitClass, 'id' | 'name' | 'kanji' | 'short' | 'hp' | 'atk' | 'def' | 'spd' | 'shots' | 'accuracy' | 'falloff' | 'move' | 'range' | 'vision' | 'cost'>
/** スキル系の項目は既定値（なし）で埋める */
function cls(c: ClassBase & Partial<UnitClass>): UnitClass {
  return { attackMaxMove: 99, closePenalty: 0, pursuit: false, markOnSight: false, sonar: 0, suppress: false, steadyAim: false, heal: 0, healRange: 1, guardReduce: 0, pen: 0, evac: false, stealth: 0, jamOnClimb: false, arc: false, blast: 0, ...c }
}

/** ルールとユニット性能はすべてここ。シミュレーションでは差分を上書きして比較する */
export const DEFAULT_RULES: RulesConfig = {
  classes: {
    attacker: cls({ id: 'attacker', name: 'アタッカー', kanji: '攻', short: 'A', hp: 28, atk: 14, def: 10, spd: 20, shots: 1, accuracy: 95, falloff: 0, move: 3, range: 1, vision: 3, cost: 2, pursuit: true }),
    gunner: cls({ id: 'gunner', name: 'ガンナー', kanji: '銃', short: 'G', hp: 22, atk: 9, def: 8, spd: 14, shots: 3, accuracy: 80, falloff: 10, move: 2, range: 3, vision: 4, cost: 2, closePenalty: 20, suppress: true }),
    sniper: cls({ id: 'sniper', name: 'スナイパー', kanji: '狙', short: 'S', hp: 16, atk: 20, def: 5, spd: 8, shots: 1, accuracy: 90, falloff: 5, move: 2, range: 6, vision: 5, cost: 3, attackMaxMove: 1, closePenalty: 45, steadyAim: true }),
    scout: cls({ id: 'scout', name: 'スカウト', kanji: '斥', short: 'R', hp: 16, atk: 6, def: 6, spd: 26, shots: 1, accuracy: 90, falloff: 0, move: 4, range: 1, vision: 6, cost: 1, markOnSight: true, sonar: 2 }),
    medic: cls({ id: 'medic', name: '衛生兵', kanji: '衛', short: 'M', hp: 20, atk: 6, def: 8, spd: 16, shots: 1, accuracy: 85, falloff: 8, move: 3, range: 2, vision: 4, cost: 2, heal: 6 }),
    jammer: cls({ id: 'jammer', name: 'ジャマー', kanji: '妨', short: 'J', hp: 20, atk: 7, def: 8, spd: 16, shots: 1, accuracy: 85, falloff: 8, move: 3, range: 2, vision: 4, cost: 2, jamOnClimb: true }),
    grenadier: cls({ id: 'grenadier', name: '擲弾兵', kanji: '擲', short: 'X', hp: 20, atk: 12, def: 7, spd: 12, shots: 1, accuracy: 70, falloff: 5, move: 2, range: 4, vision: 3, cost: 2, closePenalty: 30, arc: true, blast: 0.6 }),
    guardian: cls({ id: 'guardian', name: '防護兵', kanji: '護', short: 'D', hp: 30, atk: 8, def: 18, spd: 10, shots: 1, accuracy: 90, falloff: 0, move: 2, range: 1, vision: 3, cost: 2, guardReduce: 0.3 }),
  },
  teamSize: 4,
  turnLimit: 12,
  victory: 'killCost',
  terrain: {
    plain: { name: '地上', passable: true, moveCost: 1, blocksLos: false, visionBonus: 0, rangeBonus: 0, seesOverBlockers: false },
    building: { name: 'ビル', passable: true, moveCost: 2, blocksLos: true, visionBonus: 2, rangeBonus: 1, seesOverBlockers: true },
  },
  sharedTargeting: true,
  radar: true,
  radarMark: false,
  cover: { fireOverBuildings: false, wallHug: true },
  skills: { markDuration: 1, markAccBonus: 10, markPerTurn: 99, markCooldown: 0, suppressMove: 1, suppressAcc: 15, steadyAcc: 15, guardHitsPerTurn: 99, guardSameHeight: true, maxPerClass: 2, markTrigger: 'climb', stealthTrigger: 'descend', jamVision: 2, jamAcc: 20, jamDuration: 1, jamSilence: true, blastShape: 'plus' },
  vision: { deadZone: true },
  combat: { variance: 0.15, damageScale: 1, formula: 'ratio', armorK: 20, coverModel: 'exposure', coverMax: 40, coverHalf: 25, coverLight: 12, highGround: 10, lowGround: 10, minHit: 5, maxHit: 99, initiativeJitter: 2 },
  attackReveals: true,
  bumpReveals: true,
}

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] }
export type RulesOverride = DeepPartial<RulesConfig>

export function mergeRules(base: RulesConfig, override: RulesOverride | undefined): RulesConfig {
  return deepMerge(structuredClone(base), override ?? {}) as RulesConfig
}

function deepMerge(target: any, src: any): any {
  for (const k of Object.keys(src)) {
    const v = src[k]
    if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object') {
      deepMerge(target[k], v)
    } else {
      target[k] = v
    }
  }
  return target
}
