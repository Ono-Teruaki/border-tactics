import { canSee, canStrike, attackRange, classOf, moveAllowance, visionRange, watchRange } from './game.ts'
import { allPositions, dist, key, reachable, terrain } from './grid.ts'
import type { Rng } from './rng.ts'
import type { Intel, Observation, Order, Pos, Stance, Unit } from './types.ts'

/**
 * ヒューリスティックAI。Observation（自軍から見えている情報）だけで判断する。
 * 真の盤面は参照しない＝情報戦のルールを CPU も守る。
 */
export interface AiParams {
  name: string
  /** 接近・攻撃の重み */
  aggression: number
  /** 被弾リスク回避の重み */
  caution: number
  /** 高台・森の好み */
  terrainPref: number
  /** 危険なとき隠密を選ぶ傾向 */
  hideBias: number
  /** 置き撃ちのときに「敵は動かない」と見る確率の見積もり */
  stayGuess: number
  /** 何ターン前までの目撃情報を使うか */
  memory: number
  /** 同点崩し・揺らぎ */
  noise: number
  random?: boolean
}

export const AI_PRESETS: Record<string, AiParams> = {
  cpu: { name: 'cpu', aggression: 1, caution: 1, terrainPref: 0.6, hideBias: 0.5, stayGuess: 0.5, memory: 4, noise: 0.3 },
  aggressive: { name: 'aggressive', aggression: 1.6, caution: 0.4, terrainPref: 0.3, hideBias: 0.1, stayGuess: 0.5, memory: 4, noise: 0.3 },
  cautious: { name: 'cautious', aggression: 0.7, caution: 1.8, terrainPref: 1, hideBias: 1, stayGuess: 0.5, memory: 4, noise: 0.3 },
  random: { name: 'random', aggression: 0, caution: 0, terrainPref: 0, hideBias: 0, stayGuess: 0, memory: 0, noise: 1, random: true },
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
  if (params.random) return randomOrders(obs, rng)
  const { map, rules } = obs
  const known: Known[] = obs.enemies
    .map((e) => ({ ...e, age: e.visible ? 0 : obs.turn - e.turn }))
    .filter((e) => e.age <= params.memory || e.turn === 0)
  const fallbackGoal: Pos = { x: Math.floor(map.width / 2), y: Math.floor(map.height / 2) }
  const reserved = new Set<string>()
  const orders: Order[] = []
  // 射程の長いユニットから決める（良い位置を先に取る）
  const units = [...obs.mine].sort((a, b) => classOf(rules, b).range - classOf(rules, a).range)
  for (const u of units) {
    const best = bestOrderFor(obs, u, known, fallbackGoal, reserved, rng, params)
    reserved.add(key(best.dest))
    orders.push(best)
  }
  return orders
}

function bestOrderFor(obs: Observation, u: Unit, known: Known[], goal: Pos, reserved: Set<string>, rng: Rng, p: AiParams): Order {
  const { map, rules } = obs
  const cls = classOf(rules, u)
  const normal = reachable(map, rules, u.pos, moveAllowance(rules, u, 'watch'))
  const hideReach = reachable(map, rules, u.pos, moveAllowance(rules, u, 'hide'))
  const visible = known.filter((e) => e.age === 0)
  const threats = known.filter((e) => e.age <= 2)
  const ideal = cls.range > 1 ? cls.range : cls.vision > 4 ? cls.vision - 2 : 1

  let best: { score: number; order: Order } | null = null
  for (const { pos } of normal.values()) {
    if (reserved.has(key(pos))) continue
    const t = terrain(map, rules, pos)
    const moved = dist(u.pos, pos)
    const canAttack = moved <= cls.attackMaxMove

    // 被弾リスク：このターン敵が移動して攻撃できる範囲にいるか
    let threat = 0
    for (const e of threats) {
      const ec = classOf(rules, e)
      const reach = ec.move + ec.range + e.age
      if (dist(pos, e.pos) <= reach) threat += ec.damage * (e.age === 0 ? 1 : 0.5) * (cls.hp <= ec.damage ? 1.5 : 1)
    }
    const conceal = t.concealRange !== null ? 0.4 : 1

    // 接近・距離取り
    let nearest = Infinity
    for (const e of known) nearest = Math.min(nearest, dist(pos, e.pos) + e.age)
    if (!known.length) nearest = dist(pos, goal)
    const progress = -Math.abs(nearest - ideal) * 0.4

    // 地形
    let terrainScore = 0
    if (t.rangeBonus > 0 && cls.range > 1) terrainScore += 1
    if (t.visionBonus > 0 && cls.vision >= 5) terrainScore += 0.8
    if (t.concealRange !== null) terrainScore += 0.5

    const base = p.aggression * progress + p.terrainPref * terrainScore + rng.next() * p.noise

    // 攻撃候補：見えている敵の現在位置に置き撃ち / 警戒
    if (canAttack) {
      const ar = attackRange(map, rules, u.cls, pos)
      const wr = watchRange(map, rules, u.cls, pos)
      for (const e of visible) {
        const ec = classOf(rules, e)
        const kill = (e.hp ?? ec.hp) <= cls.damage ? 1 + ec.cost * 0.5 : 1
        if (canStrike(map, rules, pos, e.pos, ar)) {
          // 動かなそうな敵（狙撃手・遮蔽にいる敵）ほど置き撃ちが当たる
          const stay = Math.min(0.95, p.stayGuess + (ec.attackMaxMove < 2 ? 0.3 : 0) + (terrain(map, rules, e.pos).concealRange !== null ? 0.1 : 0))
          const s = base + p.aggression * cls.damage * kill * stay * 1.5 - p.caution * threat * conceal * 0.6
          if (!best || s > best.score) best = { score: s, order: { unitId: u.id, dest: pos, stance: 'attack', target: { ...e.pos } } }
        }
      }
      // 警戒：移動後に敵が射程内に入ってきそうなら自動反撃
      let watchValue = 0
      for (const e of threats) {
        const d = dist(pos, e.pos)
        if (d <= wr + 1 && d <= visionRange(map, rules, u.cls, pos) && canSee(map, rules, u.cls, pos, e.pos, false)) {
          watchValue = Math.max(watchValue, cls.damage * 0.6)
        }
      }
      const s = base + p.aggression * watchValue - p.caution * threat * conceal * 0.6
      if (!best || s > best.score) best = { score: s, order: { unitId: u.id, dest: pos, stance: 'watch' } }
    } else {
      const s = base - p.caution * threat * conceal * 0.6
      if (!best || s > best.score) best = { score: s, order: { unitId: u.id, dest: pos, stance: 'watch' } }
    }

    // 隠密：攻撃しない代わりに見つかりにくい
    if (hideReach.has(key(pos))) {
      const s = base - p.caution * threat * 0.25 + p.hideBias * (threat > 0 ? 0.8 : 0) - 0.3
      if (!best || s > best.score) best = { score: s, order: { unitId: u.id, dest: pos, stance: 'hide' } }
    }
  }
  return best?.order ?? { unitId: u.id, dest: { ...u.pos }, stance: 'watch' }
}

function randomOrders(obs: Observation, rng: Rng): Order[] {
  const { map, rules } = obs
  const all = allPositions(map)
  return obs.mine.map((u) => {
    const stance = rng.pick<Stance>(['attack', 'watch', 'hide'])
    const reach = [...reachable(map, rules, u.pos, moveAllowance(rules, u, stance)).values()]
    const dest = rng.pick(reach).pos
    let target: Pos | undefined
    if (stance === 'attack') {
      const ar = attackRange(map, rules, u.cls, dest)
      const inRange = all.filter((q) => dist(q, dest) <= ar && dist(q, dest) > 0)
      target = inRange.length ? rng.pick(inRange) : undefined
    }
    return { unitId: u.id, dest, stance, target }
  })
}
