import { dist, inBounds, terrainId } from './grid.ts'
import type { Rng } from './rng.ts'
import type { MapDef, Pos, RulesConfig, UnitClass } from './types.ts'

export type CoverLevel = 'none' | 'light' | 'half'

/**
 * 撃ち手から見た対象の隠れ具合。
 * - half: 撃ち手の方向（主方向）に面したビルに張り付いている
 * - light: 副方向（斜め側）にビルがある
 * 近接（距離1）は遮蔽なし。
 */
export function coverFrom(map: MapDef, from: Pos, target: Pos): CoverLevel {
  if (dist(from, target) <= 1 || terrainId(map, target) === 'building') return 'none'
  const dx = from.x - target.x
  const dy = from.y - target.y
  const isB = (p: Pos) => inBounds(map, p) && terrainId(map, p) === 'building'
  const xn = dx !== 0 ? { x: target.x + Math.sign(dx), y: target.y } : null
  const yn = dy !== 0 ? { x: target.x, y: target.y + Math.sign(dy) } : null
  const primary = Math.abs(dx) >= Math.abs(dy) ? [xn] : [yn]
  if (Math.abs(dx) === Math.abs(dy)) primary.push(yn)
  const secondary = [xn, yn].filter((n) => n && !primary.includes(n))
  if (primary.some((n) => n && isB(n))) return 'half'
  if (secondary.some((n) => n && isB(n))) return 'light'
  return 'none'
}

export interface HitOpts {
  /** 撃ち手がこの手で移動していない（狙撃態勢） */
  stationary?: boolean
  /** 対象がマークされている */
  marked?: boolean
  /** 撃ち手が制圧されている */
  suppressed?: boolean
}

/** 1発あたりの命中率（%）。距離による減衰・懐・遮蔽・高低差・スキル */
export function hitChance(map: MapDef, rules: RulesConfig, cls: UnitClass, from: Pos, target: Pos, opts: HitOpts = {}): { chance: number; cover: CoverLevel } {
  const c = rules.combat
  const sk = rules.skills
  const d = dist(from, target)
  const steady = cls.steadyAim && !!opts.stationary
  let p = cls.accuracy - cls.falloff * Math.max(0, d - 1)
  if (d <= 1) p -= cls.closePenalty
  if (steady) p += sk.steadyAcc
  if (opts.marked) p += sk.markAccBonus
  if (opts.suppressed) p -= sk.suppressAcc
  const cover = coverFrom(map, from, target)
  const coverMul = steady ? 0.5 : 1
  if (cover === 'half') p -= c.coverHalf * coverMul
  if (cover === 'light') p -= c.coverLight * coverMul
  const fromRoof = terrainId(map, from) === 'building'
  const toRoof = terrainId(map, target) === 'building'
  if (fromRoof && !toRoof) p += c.highGround
  if (!fromRoof && toRoof && d > 1) p -= c.lowGround
  return { chance: Math.max(c.minHit, Math.min(c.maxHit, Math.round(p))), cover }
}

/** 1発の基本ダメージ（乱数なし）。式は rules.combat.formula、pen は攻撃側の貫通 */
export function baseDamage(rules: RulesConfig, atk: number, def: number, pen = 0): number {
  const c = rules.combat
  const raw = c.formula === 'armor' ? (atk * c.armorK) / (c.armorK + Math.max(0, def - pen)) : (atk * atk) / (atk + def)
  return raw * c.damageScale
}

export function rollDamage(rules: RulesConfig, atk: number, def: number, rng: Rng, pen = 0): number {
  const v = rules.combat.variance
  return Math.max(1, Math.round(baseDamage(rules, atk, def, pen) * (1 + (rng.next() * 2 - 1) * v)))
}

/** 期待ダメージ（AI・UI予測用） */
export function expectedDamage(map: MapDef, rules: RulesConfig, atkCls: UnitClass, defCls: UnitClass, from: Pos, target: Pos, opts: HitOpts = {}): number {
  const { chance } = hitChance(map, rules, atkCls, from, target, opts)
  return (chance / 100) * atkCls.shots * Math.max(1, baseDamage(rules, atkCls.atk, defCls.def, atkCls.pen))
}

export function damageRange(rules: RulesConfig, atk: number, def: number, pen = 0): [number, number] {
  const b = baseDamage(rules, atk, def, pen)
  const v = rules.combat.variance
  return [Math.max(1, Math.round(b * (1 - v))), Math.max(1, Math.round(b * (1 + v)))]
}
