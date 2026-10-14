import { expectedDamage } from './combat.ts'
import { attackRange, canSee, canStrike, chebyshev, classOf, reachableFor, visionRange } from './game.ts'
import { dist, key, lineOfSight, samePos, terrain, terrainId } from './grid.ts'
import type { Rng } from './rng.ts'
import type { Intel, Observation, Order, Pos, Unit, UnitClass } from './types.ts'

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
  /** 近接ユニットが射手に詰め寄る意欲（相手の closePenalty が大きいほど強まる） */
  rush: number
  /** 射手が近接に寄られる位置を避ける意欲（自分の closePenalty が大きいほど強まる） */
  evade: number
  /** 何ターン前までの目撃情報を使うか */
  memory: number
  /** 同点崩し・揺らぎ */
  noise: number
  random?: boolean
}

export const AI_PRESETS: Record<string, AiParams> = {
  cpu: { name: 'cpu', aggression: 1, caution: 1, scouting: 0.6, roofPref: 0.6, rush: 0, evade: 0, memory: 4, noise: 0.3 },
  aggressive: { name: 'aggressive', aggression: 1.6, caution: 0.5, scouting: 0.4, roofPref: 0.4, rush: 0, evade: 0, memory: 4, noise: 0.3 },
  cautious: { name: 'cautious', aggression: 0.7, caution: 1.8, scouting: 0.8, roofPref: 1, rush: 0, evade: 0, memory: 4, noise: 0.3 },
  random: { name: 'random', aggression: 0, caution: 0, scouting: 0, roofPref: 0, rush: 0, evade: 0, memory: 0, noise: 1, random: true },
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
      dest: rng.pick([...reachableFor(map, rules, u, obs.turn).values()]).pos,
      target: seen.length ? rng.pick(seen).unitId : undefined,
    }))
  }
  const known: Known[] = obs.enemies
    .map((e) => ({ ...e, age: e.visible ? 0 : obs.turn - e.turn }))
    .filter((e) => e.age <= params.memory || e.turn === 0)
  const isSupport = (u: Unit) => classOf(rules, u).heal > 0 || classOf(rules, u).guardReduce > 0
  const ctx: Ctx = { obs, known, reserved: new Set(), planned: new Map(obs.mine.map((u) => [u.id, u.pos])), guards: [], rng, p: params }
  const orders = new Map<string, Order>()
  // 1) 支援役が先に位置を決める（味方の現在位置を基準）
  for (const u of obs.mine.filter(isSupport)) {
    const o = bestOrder(ctx, u)
    ctx.reserved.add(key(o.dest))
    ctx.planned.set(u.id, o.dest)
    if (classOf(rules, u).guardReduce > 0) ctx.guards.push(o.dest)
    orders.set(u.id, o)
  }
  // 2) 戦闘役（射程の長い順に良い位置を取る）。防護兵の隣は被弾リスクが下がる
  for (const u of obs.mine.filter((x) => !isSupport(x)).sort((a, b) => classOf(rules, b).range - classOf(rules, a).range)) {
    const o = bestOrder(ctx, u)
    ctx.reserved.add(key(o.dest))
    ctx.planned.set(u.id, o.dest)
    orders.set(u.id, o)
  }
  // 3) 支援役は、確定した味方の位置で「撃つか支援か」を決め直す
  for (const u of obs.mine.filter(isSupport)) {
    const o = orders.get(u.id)!
    const sup = supportValue(ctx, u, o.dest)
    const fire = fireValue(ctx, u, o.dest)
    orders.set(u.id, { ...o, target: sup.value >= fire.value * 1.5 * params.aggression || !fire.target ? undefined : fire.target })
  }
  return obs.mine.map((u) => orders.get(u.id)!)
}

interface Ctx {
  obs: Observation
  known: Known[]
  reserved: Set<string>
  /** 味方の（決定済みなら予定の）位置 */
  planned: Map<string, Pos>
  /** 防護兵の予定位置 */
  guards: Pos[]
  rng: Rng
  p: AiParams
}

/** 移動先 pos からの射撃の見込み（敵がその場に留まると仮定） */
function fireValue(ctx: Ctx, u: Unit, pos: Pos): { value: number; target?: string } {
  const { map, rules } = ctx.obs
  const cls = classOf(rules, u)
  if (dist(u.pos, pos) > cls.attackMaxMove) return { value: 0 }
  const ar = attackRange(map, rules, u.cls, pos)
  let value = 0
  let target: string | undefined
  for (const e of ctx.known) {
    if (e.age > 0) continue
    // 追撃持ちは、敵が多少動いても届く前提で見積もる
    const reach = cls.pursuit ? dist(pos, e.pos) <= cls.move + 1 : canStrike(map, rules, pos, e.pos, ar)
    if (!reach) continue
    const ec = classOf(rules, e)
    const hp = e.hp ?? ec.hp
    const exp =
      expectedDamage(map, rules, cls, ec, cls.pursuit ? e.pos : pos, e.pos, { stationary: samePos(pos, u.pos), marked: !!e.marked }) *
      (cls.pursuit && dist(pos, e.pos) > 1 ? 0.6 : 1)
    const kill = exp >= hp ? 1 + ec.cost * 0.5 : 1
    // マーク中の敵は次の手も見え続けるので、狙いを継続しやすい
    const v = Math.min(1, exp / hp) * 3 * kill * 0.6 * (e.marked ? 1.15 : 1)
    if (v > value) (value = v), (target = e.unitId)
  }
  return { value, target }
}

/** pos にいる味方が受けそうな被ダメージ（HP比） */
function threatAt(ctx: Ctx, cls: UnitClass, hp: number, pos: Pos): number {
  const { map, rules } = ctx.obs
  let threat = 0
  for (const e of ctx.known) {
    if (e.age > 2) continue
    const ec = classOf(rules, e)
    if (dist(pos, e.pos) > ec.move + ec.range + 1 + e.age) continue
    const exp = expectedDamage(map, rules, ec, cls, e.pos, pos)
    threat += Math.min(1.5, (exp / Math.max(1, hp)) * 3) * (e.age === 0 ? 1 : 0.5)
  }
  return threat
}

/** 支援（狙いなし）にした場合の価値 */
function supportValue(ctx: Ctx, u: Unit, pos: Pos): { value: number } {
  const { rules } = ctx.obs
  const c = classOf(rules, u)
  let value = 0
  for (const a of ctx.obs.mine) {
    if (a.id === u.id) continue
    const ap = ctx.planned.get(a.id) ?? a.pos
    const ac = classOf(rules, a)
    if (c.heal > 0 && chebyshev(ap, pos) <= c.healRange) value += (Math.min(c.heal, ac.hp - a.hp) / 10) * 1.2
    if (c.guardReduce > 0 && chebyshev(ap, pos) <= 1 && (!rules.skills.guardSameHeight || terrainId(ctx.obs.map, ap) === terrainId(ctx.obs.map, pos)))
      value += threatAt(ctx, ac, a.hp, ap) * 0.5
  }
  return { value }
}

function bestOrder(ctx: Ctx, u: Unit): Order {
  const { obs, known, rng, p } = ctx
  const { map, rules } = obs
  const cls = classOf(rules, u)
  const ideal = cls.range > 1 ? cls.range : cls.vision >= 6 ? cls.vision - 2 : cls.heal > 0 || cls.guardReduce > 0 ? 3 : 1
  const isScout = cls.vision >= 6
  const isSupport = cls.heal > 0 || cls.guardReduce > 0

  let best: { score: number; pos: Pos; target?: string } | null = null
  for (const { pos } of reachableFor(map, rules, u, obs.turn).values()) {
    if (ctx.reserved.has(key(pos))) continue
    const t = terrain(map, rules, pos)
    const fire = fireValue(ctx, u, pos)
    const sup = isSupport ? supportValue(ctx, u, pos).value : 0

    // 被弾リスク（遮蔽込み）。防護兵の隣なら軽減
    let threat = threatAt(ctx, cls, u.hp, pos)
    if (!isSupport && ctx.guards.some((g) => chebyshev(g, pos) <= 1 && (!rules.skills.guardSameHeight || terrainId(map, g) === terrainId(map, pos)))) threat *= 0.5

    // 索敵：敵の（最終）位置を視界に収める。観測持ちは「見失った敵を見つけ直す」「味方の射程にいる敵をマークする」を重視
    let scout = 0
    for (const e of known) {
      if (!canSee(map, rules, u.cls, pos, e.pos)) continue
      if (!cls.markOnSight) {
        scout += e.age === 0 ? 0.5 : 1
        continue
      }
      let v = e.age === 0 ? 0.6 : 1.4
      // 味方の射手がこの敵を撃てそうなら、マークの価値が上がる
      for (const a of obs.mine) {
        if (a.id === u.id) continue
        const ac = classOf(rules, a)
        if (ac.range > 1 && dist(ctx.planned.get(a.id) ?? a.pos, e.pos) <= attackRange(map, rules, a.cls, ctx.planned.get(a.id) ?? a.pos)) v += 0.6
      }
      // 透視でしか見えない（ビルの裏）敵を暴く
      if (cls.sonar > 0 && dist(pos, e.pos) <= cls.sonar && !canSeeNoSonar(map, rules, u.cls, pos, e.pos)) v += 0.8
      scout += v
    }
    if (isScout) scout *= 1.5

    // 詰め寄り / 回避
    let rush = 0
    let evade = 0
    for (const e of known) {
      if (e.age > 1) continue
      const ec = classOf(rules, e)
      const d = dist(pos, e.pos)
      if (cls.range <= 1 && ec.range > 1) {
        const w = 1 + ec.closePenalty / 30
        rush += d <= 1 ? w : d <= 2 ? w * 0.4 : 0
      } else if (cls.range > 1 && ec.range <= 1 && cls.closePenalty > 0) {
        if (d <= ec.move + 1) evade -= (cls.closePenalty / 30) * (e.age === 0 ? 1 : 0.5)
      }
    }

    // 距離取り
    let nearest = Infinity
    for (const e of known) nearest = Math.min(nearest, dist(pos, e.pos) + e.age * 0.5)
    const progress = Number.isFinite(nearest) ? -Math.abs(nearest - ideal) * 0.4 : 0

    // 支援役は味方の近くにいたい
    let cohesion = 0
    if (isSupport) for (const [id, ap] of ctx.planned) if (id !== u.id && chebyshev(ap, pos) <= 1) cohesion += 0.4

    const roof = t.visionBonus > 0 && (cls.range > 1 || isScout) ? 1 + visionRange(map, rules, u.cls, pos) * 0.05 : 0
    const action = Math.max(fire.value * 1.5, sup)
    const score =
      p.aggression * (action + progress) - p.caution * threat * 0.6 + p.scouting * scout + p.roofPref * roof + p.rush * rush + p.evade * evade + cohesion + rng.next() * p.noise
    if (!best || score > best.score) best = { score, pos, target: sup > fire.value * 1.5 ? undefined : fire.target }
  }
  const dest = best?.pos ?? { ...u.pos }
  // 射程内に見込みがなければ、最も近い視認中の敵を狙っておく（相手が寄ってくれば当たる）。支援役は除く
  let target = best?.target
  if (!target && !isSupport) {
    const vis = known.filter((e) => e.age === 0).sort((a, b) => dist(dest, a.pos) - dist(dest, b.pos))
    target = vis[0]?.unitId
  }
  return { unitId: u.id, dest, target }
}

/** 透視を使わない場合に見えるか（透視の価値の見積もり用） */
function canSeeNoSonar(map: Observation['map'], rules: Observation['rules'], cls: string, at: Pos, target: Pos): boolean {
  if (dist(at, target) > visionRange(map, rules, cls, at)) return false
  return lineOfSight(map, rules, at, target, terrain(map, rules, at).seesOverBlockers)
}
