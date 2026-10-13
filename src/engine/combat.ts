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

/** 1発あたりの命中率（%）。距離による減衰・遮蔽・高低差 */
export function hitChance(map: MapDef, rules: RulesConfig, cls: UnitClass, from: Pos, target: Pos): { chance: number; cover: CoverLevel } {
  const c = rules.combat
  const d = dist(from, target)
  let p = cls.accuracy - cls.falloff * Math.max(0, d - 1)
  if (d <= 1) p -= cls.closePenalty
  const cover = coverFrom(map, from, target)
  if (cover === 'half') p -= c.coverHalf
  if (cover === 'light') p -= c.coverLight
  const fromRoof = terrainId(map, from) === 'building'
  const toRoof = terrainId(map, target) === 'building'
  if (fromRoof && !toRoof) p += c.highGround
  if (!fromRoof && toRoof && d > 1) p -= c.lowGround
  return { chance: Math.max(c.minHit, Math.min(c.maxHit, Math.round(p))), cover }
}

/** 1発の基本ダメージ（乱数なし） */
export function baseDamage(atk: number, def: number): number {
  return (atk * atk) / (atk + def)
}

export function rollDamage(rules: RulesConfig, atk: number, def: number, rng: Rng): number {
  const v = rules.combat.variance
  return Math.max(1, Math.round(baseDamage(atk, def) * (1 + (rng.next() * 2 - 1) * v)))
}

/** 期待ダメージ（AI・UI予測用） */
export function expectedDamage(map: MapDef, rules: RulesConfig, atkCls: UnitClass, defCls: UnitClass, from: Pos, target: Pos): number {
  const { chance } = hitChance(map, rules, atkCls, from, target)
  return (chance / 100) * atkCls.shots * Math.max(1, baseDamage(atkCls.atk, defCls.def))
}

export function damageRange(rules: RulesConfig, atk: number, def: number): [number, number] {
  const b = baseDamage(atk, def)
  const v = rules.combat.variance
  return [Math.max(1, Math.round(b * (1 - v))), Math.max(1, Math.round(b * (1 + v)))]
}
