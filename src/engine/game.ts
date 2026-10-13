import { dist, inBounds, key, lineOfSight, reachable, samePos, terrain, terrainId } from './grid.ts'
import type { Rng } from './rng.ts'
import type { GameEvent, GameResult, GameState, MapDef, Observation, Order, Pos, RulesConfig, Side, StrikeBlock, Unit, UnitClass, VictoryMode } from './types.ts'

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

/**
 * 射撃の可否（射程・射線・遮蔽）。視界とは別物:
 * - 射線上にビルがあれば撃てない（屋上からでも。fireOverBuildings で緩和）
 * - 屋上から、撃ち手側のビルに張り付いている地上の敵は撃てない（真下は狙えない）
 */
export function strikeCheck(map: MapDef, rules: RulesConfig, at: Pos, target: Pos, range: number): StrikeBlock | null {
  if (dist(at, target) > range) return 'range'
  const fromRoof = terrainId(map, at) === 'building'
  if (!lineOfSight(map, rules, at, target, fromRoof && rules.cover.fireOverBuildings)) return 'blocked'
  if (rules.cover.wallHug && fromRoof && isWallHugging(map, at, target)) return 'cover'
  return null
}

export function canStrike(map: MapDef, rules: RulesConfig, at: Pos, target: Pos, range: number): boolean {
  return strikeCheck(map, rules, at, target, range) === null
}

/** target（地上）が、撃ち手 from の方向に面したビルに張り付いているか（主方向の隣接マスがビル） */
export function isWallHugging(map: MapDef, from: Pos, target: Pos): boolean {
  if (terrainId(map, target) === 'building') return false
  const dx = from.x - target.x
  const dy = from.y - target.y
  const sides: Pos[] = []
  if (Math.abs(dx) >= Math.abs(dy) && dx !== 0) sides.push({ x: target.x + Math.sign(dx), y: target.y })
  if (Math.abs(dy) >= Math.abs(dx) && dy !== 0) sides.push({ x: target.x, y: target.y + Math.sign(dy) })
  return sides.some((n) => inBounds(map, n) && terrainId(map, n) === 'building')
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
 * 2) 射撃: 命令で指定した敵が、移動後に見えていて（sharedTargeting なら味方の視界でも可）
 *    射程・射線・遮蔽をクリアしていれば命中。ダメージはまとめて適用（相打ちあり）。
 * 3) HP0 はベイルアウト。攻撃した位置は相手に露見。
 */
export function resolveTurn(state: GameState, orders: [Order[], Order[]], _rng: Rng): GameEvent[] {
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

  // --- 射撃（同時）: 指定した敵が移動後に見えていて、射程・射線・遮蔽をクリアしていれば命中 ---
  const teamVis: [Set<string>, Set<string>] = [visibleEnemyIds(state, 0), visibleEnemyIds(state, 1)]
  const assigned = new Map<string, number>()
  const attackers: Unit[] = []
  for (const u of alive) {
    const targetId = orders[u.side].find((x) => x.unitId === u.id)?.target
    if (!targetId) continue
    const t = alive.find((e) => e.id === targetId && e.side !== u.side)
    const cls = classOf(rules, u)
    let reason: StrikeBlock | null = null
    if (!t) reason = 'gone'
    else if (dist(origin.get(u.id)!, u.pos) > cls.attackMaxMove) reason = 'moved'
    else if (!(rules.sharedTargeting ? teamVis[u.side].has(t.id) : canSee(map, rules, u.cls, u.pos, t.pos))) reason = 'unseen'
    else reason = strikeCheck(map, rules, u.pos, t.pos, attackRange(map, rules, u.cls, u.pos))
    if (reason || !t) {
      events.push({ type: 'noshot', unitId: u.id, targetId, reason: reason ?? 'gone' })
      continue
    }
    assigned.set(t.id, (assigned.get(t.id) ?? 0) + cls.damage)
    events.push({ type: 'attack', unitId: u.id, from: { ...u.pos }, target: { ...t.pos }, hitId: t.id, damage: cls.damage, spotted: !canSee(map, rules, u.cls, u.pos, t.pos) })
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
