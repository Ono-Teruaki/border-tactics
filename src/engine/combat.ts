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

/**
 * 撃ち手から見て、対象の体のどれだけがビルに隠れているか（0 = 全身見える、1 = 全部隠れる）。
 * 対象のマスに、射線と直角に5本の線（体の幅）を引き、撃ち手からそれぞれへの射線が
 * 途中のビルのマスを通るかを数える。撃ち手・対象のマス自身は数えない
 */
const hiddenCache = new WeakMap<MapDef, Map<number, number>>()

export function hiddenFraction(map: MapDef, from: Pos, target: Pos): number {
  if (dist(from, target) <= 1 || terrainId(map, target) === 'building') return 0
  // 地形は変わらないので、マップと位置の組ごとに覚えておく
  let cache = hiddenCache.get(map)
  if (!cache) hiddenCache.set(map, (cache = new Map()))
  const k = ((from.x * 64 + from.y) * 64 + target.x) * 64 + target.y
  const hit = cache.get(k)
  if (hit !== undefined) return hit
  const v = computeHidden(map, from, target)
  cache.set(k, v)
  return v
}

function computeHidden(map: MapDef, from: Pos, target: Pos): number {
  const vx = target.x - from.x
  const vy = target.y - from.y
  const len = Math.hypot(vx, vy)
  const px = -vy / len
  const py = vx / len
  const offsets = [-0.36, -0.18, 0, 0.18, 0.36]
  let blocked = 0
  for (const o of offsets) {
    const tx = target.x + px * o
    const ty = target.y + py * o
    const steps = Math.ceil(Math.hypot(tx - from.x, ty - from.y) / 0.05)
    for (let i = 1; i < steps; i++) {
      const x = Math.round(from.x + ((tx - from.x) * i) / steps)
      const y = Math.round(from.y + ((ty - from.y) * i) / steps)
      if ((x === from.x && y === from.y) || (x === target.x && y === target.y)) continue
      if (inBounds(map, { x, y }) && terrainId(map, { x, y }) === 'building') {
        blocked++
        break
      }
    }
  }
  return blocked / offsets.length
}

export interface HitOpts {
  /** 撃ち手がこの手で移動していない（狙撃態勢） */
  stationary?: boolean
  /** 対象がマークされている */
  marked?: boolean
  /** 撃ち手が制圧されている */
  suppressed?: boolean
  /** 撃ち手が妨害されている */
  jammed?: boolean
}

/** 1発あたりの命中率（%）。距離による減衰・懐・遮蔽・高低差・スキル */
export function hitChance(map: MapDef, rules: RulesConfig, cls: UnitClass, from: Pos, target: Pos, opts: HitOpts = {}): { chance: number; cover: CoverLevel; coverPenalty: number } {
  const c = rules.combat
  const sk = rules.skills
  const d = dist(from, target)
  const steady = cls.steadyAim && !!opts.stationary
  let p = cls.accuracy - cls.falloff * Math.max(0, d - 1)
  if (d <= 1) p -= cls.closePenalty
  if (steady) p += sk.steadyAcc
  if (opts.marked) p += sk.markAccBonus
  if (opts.suppressed) p -= sk.suppressAcc
  if (opts.jammed) p -= sk.jamAcc
  const coverMul = steady ? 0.5 : 1
  let cover: CoverLevel
  let coverPenalty = 0
  if (c.coverModel === 'exposure') {
    // 隠れている割合に比例して下げる
    const hidden = hiddenFraction(map, from, target)
    coverPenalty = Math.round(c.coverMax * hidden * coverMul)
    cover = hidden >= 0.4 ? 'half' : hidden > 0 ? 'light' : 'none'
  } else {
    cover = coverFrom(map, from, target)
    if (cover === 'half') coverPenalty = c.coverHalf * coverMul
    if (cover === 'light') coverPenalty = c.coverLight * coverMul
  }
  p -= coverPenalty
  const fromRoof = terrainId(map, from) === 'building'
  const toRoof = terrainId(map, target) === 'building'
  if (fromRoof && !toRoof) p += c.highGround
  if (!fromRoof && toRoof && d > 1) p -= c.lowGround
  return { chance: Math.max(c.minHit, Math.min(c.maxHit, Math.round(p))), cover, coverPenalty: Math.round(coverPenalty) }
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

/** 残りHP hpLeft の敵を、この1手で倒し切れる確率（弾ごとの命中を二項分布で、ダメージは平均値で見積もる） */
export function killChance(map: MapDef, rules: RulesConfig, atkCls: UnitClass, defCls: UnitClass, from: Pos, target: Pos, hpLeft: number, opts: HitOpts = {}): number {
  if (hpLeft <= 0) return 1
  const p = hitChance(map, rules, atkCls, from, target, opts).chance / 100
  const need = Math.ceil(hpLeft / Math.max(1, baseDamage(rules, atkCls.atk, defCls.def, atkCls.pen)))
  const n = atkCls.shots
  if (need > n) return 0
  let total = 0
  let comb = 1
  for (let i = 0; i <= n; i++) {
    if (i > 0) comb = (comb * (n - i + 1)) / i
    if (i >= need) total += comb * p ** i * (1 - p) ** (n - i)
  }
  return total
}

export function damageRange(rules: RulesConfig, atk: number, def: number, pen = 0): [number, number] {
  const b = baseDamage(rules, atk, def, pen)
  const v = rules.combat.variance
  return [Math.max(1, Math.round(b * (1 - v))), Math.max(1, Math.round(b * (1 + v)))]
}
