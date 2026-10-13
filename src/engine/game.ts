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
      units.push({ id: `${side}-${i}`, side, cls, pos: { ...map.spawns[side][i] }, hp: c.hp, hidden: false, alive: true })
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

export function moveAllowance(rules: RulesConfig, u: Unit, stance: Order['stance']): number {
  return Math.max(0, classOf(rules, u).move - (stance === 'hide' ? rules.hideMovePenalty : 0))
}

export function attackRange(map: MapDef, rules: RulesConfig, cls: string, at: Pos): number {
  return rules.classes[cls].range + terrain(map, rules, at).rangeBonus
}

export function watchRange(map: MapDef, rules: RulesConfig, cls: string, at: Pos): number {
  return Math.max(1, attackRange(map, rules, cls, at) - rules.watchRangePenalty)
}

export function visionRange(map: MapDef, rules: RulesConfig, cls: string, at: Pos): number {
  return rules.classes[cls].vision + terrain(map, rules, at).visionBonus
}

/** viewer(at, cls) から target(pos, hidden) が見えるか */
export function canSee(map: MapDef, rules: RulesConfig, cls: string, at: Pos, target: Pos, targetHidden: boolean): boolean {
  const d = dist(at, target)
  if (d > visionRange(map, rules, cls, at)) return false
  if (targetHidden && d > rules.hideRevealRange) return false
  const conceal = terrain(map, rules, target).concealRange
  if (conceal !== null && d > conceal) return false
  return lineOfSight(map, rules, at, target, terrain(map, rules, at).seesOverCover)
}

/** 攻撃が届くか（射程と視線。目視は不要＝置き撃ちができる） */
export function canStrike(map: MapDef, rules: RulesConfig, at: Pos, target: Pos, range: number): boolean {
  if (dist(at, target) > range) return false
  return lineOfSight(map, rules, at, target, terrain(map, rules, at).seesOverCover)
}

export function visibleEnemyIds(state: GameState, side: Side): Set<string> {
  const { map, rules } = state
  const mine = state.units.filter((u) => u.alive && u.side === side)
  const out = new Set<string>()
  for (const e of state.units) {
    if (!e.alive || e.side === side) continue
    if (mine.some((m) => canSee(map, rules, m.cls, m.pos, e.pos, e.hidden))) out.add(e.id)
  }
  return out
}

export function isValidDest(state: GameState, u: Unit, dest: Pos, stance: Order['stance']): boolean {
  return reachable(state.map, state.rules, u.pos, moveAllowance(state.rules, u, stance)).has(key(dest))
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
 * 2) 攻撃: 移動後の位置から一斉に判定し、ダメージはまとめて適用（相打ちあり）。
 * 3) HP0 はベイルアウト。攻撃した位置は相手に露見。
 */
export function resolveTurn(state: GameState, orders: [Order[], Order[]], rng: Rng): GameEvent[] {
  if (state.over) return []
  const { map, rules } = state
  const events: GameEvent[] = []
  const alive = state.units.filter((u) => u.alive)
  const orderOf = new Map<string, Order>()
  for (const side of [0, 1] as Side[]) {
    for (const o of orders[side]) {
      const u = alive.find((x) => x.id === o.unitId)
      if (u && u.side === side) orderOf.set(u.id, o)
    }
  }
  const origin = new Map<string, Pos>()
  const proposed = new Map<string, Pos>()
  for (const u of alive) {
    let o = orderOf.get(u.id)
    if (!o || !isValidDest(state, u, o.dest, o.stance)) {
      o = { unitId: u.id, dest: { ...u.pos }, stance: o?.stance ?? 'watch', target: o?.target }
      orderOf.set(u.id, o)
    }
    u.hidden = o.stance === 'hide'
    origin.set(u.id, { ...u.pos })
    proposed.set(u.id, { ...o.dest })
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

  // --- 攻撃（同時） ---
  const damage = new Map<string, number>()
  const attackers: Unit[] = []
  for (const u of alive) {
    const o = orderOf.get(u.id)!
    const cls = classOf(rules, u)
    if (o.stance === 'hide') continue
    const moved = dist(origin.get(u.id)!, u.pos)
    if (moved > cls.attackMaxMove) continue
    if (o.stance === 'attack' && o.target) {
      if (!canStrike(map, rules, u.pos, o.target, attackRange(map, rules, u.cls, u.pos))) continue
      const victim = alive.find((e) => e.side !== u.side && samePos(e.pos, o.target!))
      events.push({ type: 'attack', unitId: u.id, from: { ...u.pos }, target: { ...o.target }, hitId: victim?.id ?? null, damage: victim ? cls.damage : 0, watch: false })
      if (victim) damage.set(victim.id, (damage.get(victim.id) ?? 0) + cls.damage)
      attackers.push(u)
    } else if (o.stance === 'watch') {
      const wr = watchRange(map, rules, u.cls, u.pos)
      const cands = alive.filter(
        (e) => e.side !== u.side && dist(u.pos, e.pos) <= wr && canSee(map, rules, u.cls, u.pos, e.pos, e.hidden),
      )
      if (!cands.length) continue
      rng.shuffle(cands)
      cands.sort((a, b) => a.hp - b.hp || dist(u.pos, a.pos) - dist(u.pos, b.pos))
      const victim = cands[0]
      const dmg = Math.max(1, cls.damage - rules.watchDamagePenalty)
      events.push({ type: 'attack', unitId: u.id, from: { ...u.pos }, target: { ...victim.pos }, hitId: victim.id, damage: dmg, watch: true })
      damage.set(victim.id, (damage.get(victim.id) ?? 0) + dmg)
      attackers.push(u)
    }
  }
  for (const [id, dmg] of damage) {
    const v = state.units.find((u) => u.id === id)!
    v.hp -= dmg
  }
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
