import type { RulesConfig } from './types.ts'

/** ルールとユニット性能はすべてここ。シミュレーションでは差分を上書きして比較する */
export const DEFAULT_RULES: RulesConfig = {
  classes: {
    attacker: { id: 'attacker', name: 'アタッカー', kanji: '攻', short: 'A', hp: 4, move: 3, range: 1, damage: 2, vision: 3, cost: 2, attackMaxMove: 99 },
    gunner: { id: 'gunner', name: 'ガンナー', kanji: '銃', short: 'G', hp: 3, move: 2, range: 3, damage: 1, vision: 4, cost: 2, attackMaxMove: 99 },
    sniper: { id: 'sniper', name: 'スナイパー', kanji: '狙', short: 'S', hp: 2, move: 2, range: 6, damage: 2, vision: 5, cost: 3, attackMaxMove: 1 },
    scout: { id: 'scout', name: 'スカウト', kanji: '斥', short: 'R', hp: 2, move: 4, range: 1, damage: 1, vision: 6, cost: 1, attackMaxMove: 99 },
  },
  teamSize: 4,
  turnLimit: 12,
  victory: 'killCost',
  terrain: {
    plain: { name: '地上', passable: true, moveCost: 1, blocksLos: false, visionBonus: 0, rangeBonus: 0, seesOverBlockers: false },
    building: { name: 'ビル', passable: true, moveCost: 2, blocksLos: true, visionBonus: 2, rangeBonus: 1, seesOverBlockers: true },
  },
  sharedTargeting: true,
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
