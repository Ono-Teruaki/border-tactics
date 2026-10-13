import { attackRange, canSee, canStrike, classOf, visionRange } from './game.ts'
import { dist, key, reachable, terrain } from './grid.ts'
import type { Rng } from './rng.ts'
import type { Intel, Observation, Order, Pos, Unit } from './types.ts'

/**
 * ヒューリスティックAI。Observation（自軍から見えている情報）だけで判断する。
 * 真の盤面は参照しない＝情報戦のルールを CPU も守る。
 */
export interface AiParams {
  name: string
  /** 接近・射撃機会の重み */
  aggression: number
  /** 被弾リスク回避の重み */
  caution: number
  /** 索敵（敵がいそうな場所を視界に入れる）の重み */
  scouting: number
  /** 屋上の好み */
  roofPref: number
  /** 何ターン前までの目撃情報を使うか */
  memory: number
  /** 同点崩し・揺らぎ */
  noise: number
  random?: boolean
}

export const AI_PRESETS: Record<string, AiParams> = {
  cpu: { name: 'cpu', aggression: 1, caution: 1, scouting: 0.6, roofPref: 0.6, memory: 4, noise: 0.3 },
  aggressive: { name: 'aggressive', aggression: 1.6, caution: 0.5, scouting: 0.4, roofPref: 0.4, memory: 4, noise: 0.3 },
  cautious: { name: 'cautious', aggression: 0.7, caution: 1.8, scouting: 0.8, roofPref: 1, memory: 4, noise: 0.3 },
  random: { name: 'random', aggression: 0, caution: 0, scouting: 0, roofPref: 0, memory: 0, noise: 1, random: true },
}

/** CPU が使う編成候補 */
export const CPU_COMPS: string[][] = [
  ['attacker', 'gunner', 'sniper', 'scout'],
  ['attacker', 'attacker', 'gunner', 'sniper'],
  ['gunner', 'gunner', 'sniper', 'scout'],
  ['attacker', 'attacker', 'gunner', 'scout'],
]

interface Known extends Intel {
  age: number
}

export function decideOrders(obs: Observation, rng: Rng, params: AiParams): Order[] {
  const { map, rules } = obs
  if (params.random) {
    return obs.mine.map((u) => ({ unitId: u.id, dest: rng.pick([...reachable(map, rules, u.pos, classOf(rules, u).move).values()]).pos }))
  }
  const known: Known[] = obs.enemies
    .map((e) => ({ ...e, age: e.visible ? 0 : obs.turn - e.turn }))
    .filter((e) => e.age <= params.memory || e.turn === 0)
  const reserved = new Set<string>()
  const orders: Order[] = []
  // 射程の長いユニットから決める（良い位置を先に取る）
  const units = [...obs.mine].sort((a, b) => classOf(rules, b).range - classOf(rules, a).range)
  for (const u of units) {
    const dest = bestDest(obs, u, known, reserved, rng, params)
    reserved.add(key(dest))
    orders.push({ unitId: u.id, dest })
  }
  return orders
}

function bestDest(obs: Observation, u: Unit, known: Known[], reserved: Set<string>, rng: Rng, p: AiParams): Pos {
  const { map, rules } = obs
  const cls = classOf(rules, u)
  const threats = known.filter((e) => e.age <= 2)
  const ideal = cls.range > 1 ? cls.range : cls.vision >= 6 ? cls.vision - 2 : 1
  const isScout = cls.vision >= 6

  let best: { score: number; pos: Pos } | null = null
  for (const { pos } of reachable(map, rules, u.pos, cls.move).values()) {
    if (reserved.has(key(pos))) continue
    const t = terrain(map, rules, pos)
    const canFire = dist(u.pos, pos) <= cls.attackMaxMove
    const ar = canFire ? attackRange(map, rules, u.cls, pos) : 0

    // 射撃機会：最近見た敵がその場に留まると仮定
    let fire = 0
    if (canFire) {
      for (const e of known) {
        if (e.age > 1) continue
        if (!canStrike(map, rules, pos, e.pos, ar)) continue
        const ec = classOf(rules, e)
        const kill = (e.hp ?? ec.hp) <= cls.damage ? 1 + ec.cost * 0.5 : 1
        fire = Math.max(fire, cls.damage * kill * (e.age === 0 ? 0.6 : 0.3))
      }
    }

    // 被弾リスク：敵が移動して射程に入れられるか
    let threat = 0
    for (const e of threats) {
      const ec = classOf(rules, e)
      if (dist(pos, e.pos) <= ec.move + ec.range + 1 + e.age) threat += ec.damage * (e.age === 0 ? 1 : 0.5) * (cls.hp <= ec.damage ? 1.5 : 1)
    }

    // 索敵：敵の（最終）位置を視界に収める
    let scout = 0
    for (const e of known) if (canSee(map, rules, u.cls, pos, e.pos)) scout += e.age === 0 ? 0.5 : 1
    if (isScout) scout *= 1.5

    // 距離取り
    let nearest = Infinity
    for (const e of known) nearest = Math.min(nearest, dist(pos, e.pos) + e.age * 0.5)
    const progress = Number.isFinite(nearest) ? -Math.abs(nearest - ideal) * 0.4 : 0

    const roof = t.visionBonus > 0 && (cls.range > 1 || isScout) ? 1 + visionRange(map, rules, u.cls, pos) * 0.05 : 0
    const score =
      p.aggression * (fire * 1.5 + progress) - p.caution * threat * 0.6 + p.scouting * scout + p.roofPref * roof + rng.next() * p.noise
    if (!best || score > best.score) best = { score, pos }
  }
  return best?.pos ?? { ...u.pos }
}
