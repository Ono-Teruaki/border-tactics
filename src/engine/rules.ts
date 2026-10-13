import type { RulesConfig } from './types.ts'

/** ルールとユニット性能はすべてここ。シミュレーションでは差分を上書きして比較する */
export const DEFAULT_RULES: RulesConfig = {
  classes: {
    attacker: { id: 'attacker', name: 'アタッカー', short: 'A', hp: 4, move: 3, range: 1, damage: 2, vision: 3, cost: 2, attackMaxMove: 99 },
    gunner: { id: 'gunner', name: 'ガンナー', short: 'G', hp: 3, move: 2, range: 3, damage: 1, vision: 4, cost: 2, attackMaxMove: 99 },
    sniper: { id: 'sniper', name: 'スナイパー', short: 'S', hp: 2, move: 2, range: 6, damage: 2, vision: 5, cost: 3, attackMaxMove: 1 },
    scout: { id: 'scout', name: 'スカウト', short: 'R', hp: 2, move: 4, range: 1, damage: 1, vision: 6, cost: 1, attackMaxMove: 99 },
  },
  teamSize: 4,
  turnLimit: 12,
  victory: 'killCost',
  terrain: {
    plain: { name: '平地', passable: true, moveCost: 1, blocksLos: false, concealRange: null, visionBonus: 0, rangeBonus: 0, seesOverCover: false },
    wall: { name: '建物', passable: false, moveCost: 99, blocksLos: true, concealRange: null, visionBonus: 0, rangeBonus: 0, seesOverCover: false },
    forest: { name: '森', passable: true, moveCost: 1, blocksLos: true, concealRange: 1, visionBonus: 0, rangeBonus: 0, seesOverCover: false },
    high: { name: '高台', passable: true, moveCost: 2, blocksLos: false, concealRange: null, visionBonus: 2, rangeBonus: 1, seesOverCover: true },
  },
  hideRevealRange: 1,
  hideMovePenalty: 1,
  watchRangePenalty: 1,
  watchDamagePenalty: 0,
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
