import { dist, key, lineOfSight, reachable, samePos, terrain } from './grid.ts'
import type { Rng } from './rng.ts'
import type { GameEvent, GameResult, GameState, MapDef, Observation, Order, Pos, RulesConfig, Side, Unit, UnitClass, VictoryMode } from './types.ts'

export function createGame(map: MapDef, rules: RulesConfig, comps: [string[], string[]]): GameState {
  const units: Unit[] = []
  for (const side of [0, 1] as Side[]) {
    const comp = comps[side]
    if (comp.length !== rules.teamSize) throw new Error(`team size must be ${rules.teamSize}`)
    comp.forEach((cls, i) => {
      const c = rules.classes[cls]
      if (!c) throw new Error(`unknown class ${cls}`)
      units.push({ id: `${side}-${i}`, side, cls, pos: { ...map.spawns[side][i] }, hp: c.hp, alive: true })
    })
  }
  const state: GameState = { map, rules, units, turn: 1, kills: [0, 0], killCost: [0, 0], intel: [{}, {}], over: false, history: [] }
  // 出撃位置と編成はお互いに既知
  for (const u of units) {
    state.intel[(1 - u.side) as Side][u.id] = { unitId: u.id, cls: u.cls, pos: { ...u.pos }, hp: u.hp, turn: 0, visible: false }
  }
  updateIntel(state)
  return state
}

export const classOf = (rules: RulesConfig, u: { cls: string }): UnitClass => rules.classes[u.cls]

export function attackRange(map: MapDef, rules: RulesConfig, cls: string, at: Pos): number {
  return rules.classes[cls].range + terrain(map, rules, at).rangeBonus
}

export function visionRange(map: MapDef, rules: RulesConfig, cls: string, at: Pos): number {
  return rules.classes[cls].vision + terrain(map, rules, at).visionBonus
}

/** at にいる cls のユニットから target のマスが見えるか */
export function canSee(map: MapDef, rules: RulesConfig, cls: string, at: Pos, target: Pos): boolean {
  if (dist(at, target) > visionRange(map, rules, cls, at)) return false
  return lineOfSight(map, rules, at, target, terrain(map, rules, at).seesOverBlockers)
}

/** 射程と射線が通るか */
export function canStrike(map: MapDef, rules: RulesConfig, at: Pos, target: Pos, range: number): boolean {
  if (dist(at, target) > range) return false
  return lineOfSight(map, rules, at, target, terrain(map, rules, at).seesOverBlockers)
}

export function visibleEnemyIds(state: GameState, side: Side): Set<string> {
  const { map, rules } = state
  const mine = state.units.filter((u) => u.alive && u.side === side)
  const out = new Set<string>()
  for (const e of state.units) {
    if (!e.alive || e.side === side) continue
    if (mine.some((m) => canSee(map, rules, m.cls, m.pos, e.pos))) out.add(e.id)
  }
  return out
}

export function reachableFor(map: MapDef, rules: RulesConfig, u: Unit) {
  return reachable(map, rules, u.pos, classOf(rules, u).move)
}

export function isValidDest(state: GameState, u: Unit, dest: Pos): boolean {
  return reachableFor(state.map, state.rules, u).has(key(dest))
}

/** この移動をしても攻撃できるか（スナイパーの移動制限） */
export function canFireAfterMove(rules: RulesConfig, u: Unit, dest: Pos): boolean {
  return dist(u.pos, dest) <= classOf(rules, u).attackMaxMove
}

function updateIntel(state: GameState) {
  for (const side of [0, 1] as Side[]) {
    const intel = state.intel[side]
    const vis = visibleEnemyIds(state, side)
    for (const e of state.units) {
      if (e.side === side) continue
      if (!e.alive) {
        delete intel[e.id]
        continue
      }
      if (vis.has(e.id)) {
        intel[e.id] = { unitId: e.id, cls: e.cls, pos: { ...e.pos }, hp: e.hp, turn: state.turn, visible: true }
      } else if (intel[e.id]) {
        intel[e.id].visible = false
      }
    }
  }
}

function reveal(state: GameState, toSide: Side, u: Unit, turn: number) {
  const prev = state.intel[toSide][u.id]
  state.intel[toSide][u.id] = { unitId: u.id, cls: u.cls, pos: { ...u.pos }, hp: prev?.hp ?? null, turn, visible: false }
}

/**
 * 1ターンを同時解決する（state を直接更新）。
 * 1) 移動: 全員が同時に目的地へ。同じマスに複数が来たら、移動してきた側が元の位置へ弾かれる（連鎖も解決）。
 *    すれ違い・入れ替わりは許可（経路は問わない）。
 * 2) 自動攻撃: 移動後、射程・射線内にいて「見えている」敵を撃つ（sharedTargeting なら味方の視界も使える）。
 *    標的: 撃破できる敵 > 残りHPが少ない敵 > コストが高い敵 > 近い敵。既に倒しきれる敵には重ねない。
 *    射程の短いユニットから標的を決める（選択肢が少ない順）。ダメージはまとめて適用（相打ちあり）。
 * 3) HP0 はベイルアウト。攻撃した位置は相手に露見。
 */
export function resolveTurn(state: GameState, orders: [Order[], Order[]], rng: Rng): GameEvent[] {
  if (state.over) return []
  const { map, rules } = state
  const events: GameEvent[] = []
  const alive = state.units.filter((u) => u.alive)
  const origin = new Map<string, Pos>()
  const proposed = new Map<string, Pos>()
  for (const u of alive) {
    const o = orders[u.side].find((x) => x.unitId === u.id)
    origin.set(u.id, { ...u.pos })
    proposed.set(u.id, o && isValidDest(state, u, o.dest) ? { ...o.dest } : { ...u.pos })
  }

  // --- 移動（衝突解決） ---
  const bounced = new Set<string>()
  const contact = new Set<string>()
  for (;;) {
    const occ = new Map<string, Unit[]>()
    for (const u of alive) {
      const k = key(proposed.get(u.id)!)
      if (!occ.has(k)) occ.set(k, [])
      occ.get(k)!.push(u)
    }
    let changed = false
    for (const group of occ.values()) {
      if (group.length < 2) continue
      const sides = new Set(group.map((u) => u.side))
      for (const u of group) {
        if (samePos(proposed.get(u.id)!, origin.get(u.id)!)) continue
        proposed.set(u.id, { ...origin.get(u.id)! })
        bounced.add(u.id)
        changed = true
      }
      if (sides.size > 1) for (const u of group) contact.add(u.id)
    }
    if (!changed) break
  }
  for (const u of alive) {
    const to = proposed.get(u.id)!
    const from = origin.get(u.id)!
    if (bounced.has(u.id)) events.push({ type: 'bounce', unitId: u.id, at: { ...to }, contact: contact.has(u.id) })
    else if (!samePos(from, to)) events.push({ type: 'move', unitId: u.id, from, to: { ...to } })
    u.pos = { ...to }
  }
  if (rules.bumpReveals) {
    for (const u of alive) if (contact.has(u.id)) reveal(state, (1 - u.side) as Side, u, state.turn)
  }

  // --- 自動攻撃（同時） ---
  const teamVis: [Set<string>, Set<string>] = [visibleEnemyIds(state, 0), visibleEnemyIds(state, 1)]
  const assigned = new Map<string, number>()
  const attackers: Unit[] = []
  const shooters = rng.shuffle([...alive]).sort((a, b) => attackRange(map, rules, a.cls, a.pos) - attackRange(map, rules, b.cls, b.pos))
  for (const u of shooters) {
    const cls = classOf(rules, u)
    if (dist(origin.get(u.id)!, u.pos) > cls.attackMaxMove) continue
    const ar = attackRange(map, rules, u.cls, u.pos)
    const cands = alive.filter((e) => {
      if (e.side === u.side) return false
      if (e.hp - (assigned.get(e.id) ?? 0) <= 0) return false
      const seen = rules.sharedTargeting ? teamVis[u.side].has(e.id) : canSee(map, rules, u.cls, u.pos, e.pos)
      return seen && canStrike(map, rules, u.pos, e.pos, ar)
    })
    if (!cands.length) continue
    const rem = (e: Unit) => e.hp - (assigned.get(e.id) ?? 0)
    cands.sort(
      (a, b) =>
        Number(rem(b) <= cls.damage) - Number(rem(a) <= cls.damage) ||
        rem(a) - rem(b) ||
        classOf(rules, b).cost - classOf(rules, a).cost ||
        dist(u.pos, a.pos) - dist(u.pos, b.pos),
    )
    const v = cands[0]
    assigned.set(v.id, (assigned.get(v.id) ?? 0) + cls.damage)
    const spotted = !canSee(map, rules, u.cls, u.pos, v.pos)
    events.push({ type: 'attack', unitId: u.id, from: { ...u.pos }, target: { ...v.pos }, hitId: v.id, damage: cls.damage, spotted })
    attackers.push(u)
  }
  for (const [id, dmg] of assigned) state.units.find((u) => u.id === id)!.hp -= dmg
  if (rules.attackReveals) for (const u of attackers) reveal(state, (1 - u.side) as Side, u, state.turn)
  for (const u of alive) {
    if (u.hp <= 0) {
      u.alive = false
      const other = (1 - u.side) as Side
      state.kills[other] += 1
      state.killCost[other] += classOf(rules, u).cost
      events.push({ type: 'bailout', unitId: u.id, at: { ...u.pos } })
    }
  }

  state.history.push(events)
  updateIntel(state)
  state.turn += 1
  const aliveCount = [0, 1].map((s) => state.units.filter((u) => u.alive && u.side === s).length)
  if (aliveCount[0] === 0 || aliveCount[1] === 0 || state.turn > rules.turnLimit) state.over = true
  return events
}

export function observe(state: GameState, side: Side): Observation {
  return {
    side,
    turn: state.turn,
    map: state.map,
    rules: state.rules,
    mine: state.units.filter((u) => u.alive && u.side === side).map((u) => ({ ...u, pos: { ...u.pos } })),
    enemies: Object.values(state.intel[side]).map((i) => ({ ...i, pos: { ...i.pos } })),
    enemyAlive: state.units.filter((u) => u.alive && u.side !== side).length,
    kills: [...state.kills] as [number, number],
    killCost: [...state.killCost] as [number, number],
  }
}

export function gameResult(state: GameState): GameResult {
  const alive: [number, number] = [0, 0]
  for (const u of state.units) if (u.alive) alive[u.side]++
  const cmp = (a: number, b: number): Side | null => (a > b ? 0 : b > a ? 1 : null)
  const winner: Record<VictoryMode, Side | null> = {
    annihilation: alive[1] === 0 && alive[0] > 0 ? 0 : alive[0] === 0 && alive[1] > 0 ? 1 : null,
    killCount: cmp(state.kills[0], state.kills[1]),
    killCost: cmp(state.killCost[0], state.killCost[1]),
  }
  return { turns: state.history.length, kills: [...state.kills] as [number, number], killCost: [...state.killCost] as [number, number], alive, winner }
}
