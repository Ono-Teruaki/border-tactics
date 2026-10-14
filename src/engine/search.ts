import { decideOrders, type AiParams } from './ai.ts'
import { observe, resolveTurn } from './game.ts'
import { createRng, type Rng } from './rng.ts'
import type { GameState, Intel, Observation, Order, Side, Unit } from './types.ts'

/**
 * 先読みする CPU。ヒューリスティック AI（decideOrders）で自分の手の候補をいくつか作り、
 * 相手の応手もいくつか予想して、実際に1〜2手シミュレーションした結果で手を選ぶ。
 * 盤面は自分から見えている情報だけで組み立てる（見えていない敵は最後に見た位置にいる前提）。
 */
export interface SearchOpts {
  /** 自分の手の候補数 */
  candidates: number
  /** 相手の応手の予想数 */
  replies: number
  /** 交戦の乱数を振り直す回数 */
  rolls: number
  /** 何手先まで見るか（1 = この手だけ、2 = 次の手も両軍ヒューリスティックで進める） */
  depth: 1 | 2
  /** 応手のうち最悪の結果をどれだけ重く見るか（0 = 平均、1 = 最悪） */
  worst: number
}

export const SEARCH_DEFAULT: SearchOpts = { candidates: 6, replies: 3, rolls: 2, depth: 2, worst: 0.3 }
/** ゲームの相手に使う設定（1手 0.1〜0.2秒ほど） */
export const SEARCH_GAME: SearchOpts = { candidates: 10, replies: 4, rolls: 3, depth: 2, worst: 0.3 }

/** 手の候補を作るための重みの揺らし方（基本の重み → 攻め → 守り → 撃ち合い重視 → 散開 …） */
const STYLES: ((p: AiParams) => AiParams)[] = [
  (p) => p,
  (p) => ({ ...p, aggression: p.aggression * 1.7, caution: p.caution * 0.5 }),
  (p) => ({ ...p, aggression: p.aggression * 0.6, caution: p.caution * 1.6 }),
  (p) => ({ ...p, fireWeight: (p.fireWeight ?? 1.5) * 2, focus: (p.focus ?? 0) + 0.8 }),
  (p) => ({ ...p, blob: 0, roofPref: p.roofPref + 0.6 }),
  (p) => ({ ...p, rush: p.rush + 1, aggression: p.aggression * 1.3 }),
  (p) => ({ ...p, noise: p.noise + 1.2 }),
  (p) => ({ ...p, noise: p.noise + 2.5 }),
]

/** 自分から見えている情報で、仮の盤面を組み立てる */
function hypothetical(obs: Observation): GameState {
  const me = obs.side
  const en = (1 - me) as Side
  const units: Unit[] = obs.mine.map((u) => structuredClone(u))
  for (const e of obs.enemies) {
    const c = obs.rules.classes[e.cls]
    units.push({ id: e.unitId, side: en, cls: e.cls, pos: { ...e.pos }, hp: e.hp ?? c.hp, alive: true, markedUntil: e.marked ? obs.turn : 0, suppressedUntil: 0, markCooldownUntil: 0, stealthUntil: 0, jammedUntil: 0 })
  }
  const intel: [Record<string, Intel>, Record<string, Intel>] = [{}, {}]
  for (const e of obs.enemies) intel[me][e.unitId] = { ...e, pos: { ...e.pos } }
  // 相手はこちらの位置を知っている前提（悲観的に見積もる）
  for (const u of obs.mine) intel[en][u.id] = { unitId: u.id, cls: u.cls, pos: { ...u.pos }, hp: u.hp, turn: obs.turn, visible: true }
  return { map: obs.map, rules: obs.rules, units, turn: obs.turn, kills: [...obs.kills], killCost: [...obs.killCost], intel, over: false, history: [], radarUntil: [0, 0] }
}

/** side から見た盤面の評価。撃破コストの差が主、残りHP（コスト重み）が従 */
function evaluate(s: GameState, side: Side): number {
  const en = 1 - side
  let v = (s.killCost[side] - s.killCost[en]) * 10
  for (const u of s.units) {
    if (!u.alive) continue
    const c = s.rules.classes[u.cls]
    const w = (u.hp / c.hp) * c.cost * 2
    v += u.side === side ? w : -w
  }
  return v
}

const ordersKey = (o: Order[]) => o.map((x) => `${x.unitId}:${x.dest.x},${x.dest.y}>${x.target ?? ''}`).join('|')

export function decideOrdersSearch(obs: Observation, rng: Rng, params: AiParams, opts: SearchOpts = SEARCH_DEFAULT): Order[] {
  const me = obs.side
  const en = (1 - me) as Side
  const base = hypothetical(obs)

  // 自分の手の候補（重複は除く）
  const cands: Order[][] = []
  const seen = new Set<string>()
  for (let i = 0; cands.length < opts.candidates && i < opts.candidates * 3; i++) {
    const o = decideOrders(obs, rng, STYLES[i % STYLES.length](params))
    const k = ordersKey(o)
    if (seen.has(k)) continue
    seen.add(k)
    cands.push(o)
  }
  if (cands.length === 1) return cands[0]

  // 相手の応手の予想（相手も同じ CPU の重みで、いくつかの揺らし方）
  const enemyObs = observe(base, en)
  const replies: Order[][] = []
  const seenR = new Set<string>()
  for (let i = 0; replies.length < opts.replies && i < opts.replies * 3; i++) {
    const o = decideOrders(enemyObs, rng, STYLES[i % STYLES.length](params))
    const k = ordersKey(o)
    if (seenR.has(k)) continue
    seenR.add(k)
    replies.push(o)
  }

  let best = cands[0]
  let bestScore = -Infinity
  for (const c of cands) {
    const vals: number[] = []
    for (const r of replies) {
      let sum = 0
      for (let roll = 0; roll < opts.rolls; roll++) {
        const sim = structuredClone(base)
        const simRng = createRng(Math.floor(rng.next() * 2 ** 31))
        resolveTurn(sim, (me === 0 ? [c, r] : [r, c]) as [Order[], Order[]], simRng)
        if (opts.depth === 2 && !sim.over) {
          const next = ([0, 1] as Side[]).map((s) => decideOrders(observe(sim, s), simRng, params)) as [Order[], Order[]]
          resolveTurn(sim, next, simRng)
        }
        sum += evaluate(sim, me)
      }
      vals.push(sum / opts.rolls)
    }
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length
    const score = (1 - opts.worst) * mean + opts.worst * Math.min(...vals)
    if (score > bestScore) (bestScore = score), (best = c)
  }
  return best
}
