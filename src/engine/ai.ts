import { expectedDamage } from './combat.ts'
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
    const seen = obs.enemies.filter((e) => e.visible)
    return obs.mine.map((u) => ({
      unitId: u.id,
      dest: rng.pick([...reachable(map, rules, u.pos, classOf(rules, u).move).values()]).pos,
      target: seen.length ? rng.pick(seen).unitId : undefined,
    }))
  }
  const known: Known[] = obs.enemies
    .map((e) => ({ ...e, age: e.visible ? 0 : obs.turn - e.turn }))
    .filter((e) => e.age <= params.memory || e.turn === 0)
  const reserved = new Set<string>()
  const orders: Order[] = []
  // 射程の長いユニットから決める（良い位置を先に取る）
  const units = [...obs.mine].sort((a, b) => classOf(rules, b).range - classOf(rules, a).range)
  for (const u of units) {
    const o = bestOrder(obs, u, known, reserved, rng, params)
    reserved.add(key(o.dest))
    orders.push(o)
  }
  return orders
}

function bestOrder(obs: Observation, u: Unit, known: Known[], reserved: Set<string>, rng: Rng, p: AiParams): Order {
  const { map, rules } = obs
  const cls = classOf(rules, u)
  const threats = known.filter((e) => e.age <= 2)
  const ideal = cls.range > 1 ? cls.range : cls.vision >= 6 ? cls.vision - 2 : 1
  const isScout = cls.vision >= 6

  let best: { score: number; pos: Pos; target?: string } | null = null
  for (const { pos } of reachable(map, rules, u.pos, cls.move).values()) {
    if (reserved.has(key(pos))) continue
    const t = terrain(map, rules, pos)
    const canFire = dist(u.pos, pos) <= cls.attackMaxMove
    const ar = canFire ? attackRange(map, rules, u.cls, pos) : 0

    // 射撃機会：最近見た敵がその場に留まると仮定
    let fire = 0
    let target: string | undefined
    if (canFire) {
      for (const e of known) {
        if (e.age > 0) continue
        if (!canStrike(map, rules, pos, e.pos, ar)) continue
        const ec = classOf(rules, e)
        const hp = e.hp ?? ec.hp
        const exp = expectedDamage(map, rules, cls, ec, pos, e.pos)
        const kill = exp >= hp ? 1 + ec.cost * 0.5 : 1
        const v = Math.min(1, exp / hp) * 3 * kill * 0.6
        if (v > fire) (fire = v), (target = e.unitId)
      }
    }

    // 被弾リスク：敵が移動して射程に入れられるか
    // 遮蔽を考慮：敵の現在位置から見た自分の隠れ具合で期待被ダメージが下がる
    let threat = 0
    for (const e of threats) {
      const ec = classOf(rules, e)
      if (dist(pos, e.pos) > ec.move + ec.range + 1 + e.age) continue
      const exp = expectedDamage(map, rules, ec, cls, e.pos, pos)
      threat += Math.min(1.5, (exp / u.hp) * 3) * (e.age === 0 ? 1 : 0.5)
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
    if (!best || score > best.score) best = { score, pos, target }
  }
  const dest = best?.pos ?? { ...u.pos }
  // 射程内に見込みがなければ、最も近い視認中の敵を狙っておく（相手が寄ってくれば当たる）
  let target = best?.target
  if (!target) {
    const vis = known.filter((e) => e.age === 0).sort((a, b) => dist(dest, a.pos) - dist(dest, b.pos))
    target = vis[0]?.unitId
  }
  return { unitId: u.id, dest, target }
}
