import { dist, inBounds, key, lineOfSight, reachable, samePos, terrain, terrainId } from './grid.ts'
import type { Rng } from './rng.ts'
import { hitChance, rollDamage } from './combat.ts'
import type { GameEvent, GameResult, GameState, MapDef, Observation, Order, Pos, RulesConfig, ShotResult, Side, StrikeBlock, Unit, UnitClass, VictoryMode } from './types.ts'

export function createGame(map: MapDef, rules: RulesConfig, comps: [string[], string[]]): GameState {
  const units: Unit[] = []
  for (const side of [0, 1] as Side[]) {
    const comp = comps[side]
    if (comp.length !== rules.teamSize) throw new Error(`team size must be ${rules.teamSize}`)
    comp.forEach((cls, i) => {
      const c = rules.classes[cls]
      if (!c) throw new Error(`unknown class ${cls}`)
      units.push({ id: `${side}-${i}`, side, cls, pos: { ...map.spawns[side][i] }, hp: c.hp, alive: true, markedUntil: 0, suppressedUntil: 0, markCooldownUntil: 0, stealthUntil: 0, jammedUntil: 0 })
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
/** 周囲8マス判定用の距離 */
export const chebyshev = (a: Pos, b: Pos) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y))

export function attackRange(map: MapDef, rules: RulesConfig, cls: string, at: Pos): number {
  return rules.classes[cls].range + terrain(map, rules, at).rangeBonus
}

export function visionRange(map: MapDef, rules: RulesConfig, cls: string, at: Pos): number {
  return rules.classes[cls].vision + terrain(map, rules, at).visionBonus
}

/**
 * at にいる cls のユニットから target のマスが見えるか。
 * - 透視（sonar）の距離以内は無条件で見える
 * - 視界距離・視線（ビル）
 * - 死角: 屋上からでも、ビルの裏側に張り付いた地上のマスは見えない
 */
export function canSee(map: MapDef, rules: RulesConfig, cls: string, at: Pos, target: Pos, stealth = 0): boolean {
  const d = dist(at, target)
  const c = rules.classes[cls]
  if (c.sonar > 0 && d <= c.sonar) return true
  if (d > visionRange(map, rules, cls, at) - stealth) return false
  const fromRoof = terrainId(map, at) === 'building'
  if (!lineOfSight(map, rules, at, target, terrain(map, rules, at).seesOverBlockers)) return false
  if (rules.vision.deadZone && fromRoof && d > 1 && isWallHugging(map, at, target)) return false
  return true
}

/** 隠密中のユニットを見つけられる距離の減り幅 */
export function stealthOf(rules: RulesConfig, u: Unit, atTurn: number): number {
  return u.stealthUntil >= atTurn ? rules.classes[u.cls].stealth : 0
}

/** 近接クラス（素の射程が1）。隣接した相手への攻撃は、射撃ではなく近接攻撃になる */
export const isMeleeClass = (rules: RulesConfig, cls: string) => rules.classes[cls].range === 1

/**
 * 攻撃の可否（射程・射線・遮蔽）。視界とは別物:
 * - 射線上にビルがあれば撃てない（屋上からでも。fireOverBuildings で緩和）
 * - 屋上から、自分が乗っているビルに張り付いている地上の敵（真下）は撃てない。
 *   他のビルに張り付いている敵は撃てる（命中率の遮蔽がかかる）。
 *   これは射撃だけの制限で、近接クラスが隣接した敵を攻撃するときはかからない
 */
export function strikeCheck(map: MapDef, rules: RulesConfig, at: Pos, target: Pos, range: number, melee = false): StrikeBlock | null {
  const d = dist(at, target)
  if (d > range) return 'range'
  const fromRoof = terrainId(map, at) === 'building'
  if (!lineOfSight(map, rules, at, target, fromRoof && rules.cover.fireOverBuildings)) return 'blocked'
  if (rules.cover.wallHug && fromRoof && !melee && d === 1 && terrainId(map, target) !== 'building') return 'cover'
  return null
}

export function canStrike(map: MapDef, rules: RulesConfig, at: Pos, target: Pos, range: number, melee = false): boolean {
  return strikeCheck(map, rules, at, target, range, melee) === null
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

/** side から見えている敵。マークされた敵は視線がなくても見える（atTurn 時点で有効なマーク） */
export function visibleEnemyIds(state: GameState, side: Side, atTurn = state.turn): Set<string> {
  const { map, rules } = state
  const mine = state.units.filter((u) => u.alive && u.side === side)
  const out = new Set<string>()
  for (const e of state.units) {
    if (!e.alive || e.side === side) continue
    if (e.markedUntil >= atTurn || mine.some((m) => canSee(map, rules, m.cls, m.pos, e.pos, stealthOf(rules, e, atTurn) + jamOf(rules, m, atTurn)))) out.add(e.id)
  }
  return out
}

export const isSuppressed = (u: { suppressedUntil: number }, turn: number) => u.suppressedUntil >= turn
export const isMarked = (u: { markedUntil: number }, turn: number) => u.markedUntil >= turn
export const isJammed = (u: { jammedUntil: number }, turn: number) => u.jammedUntil >= turn
/** 見る側が妨害されているときの視界の減り幅 */
const jamOf = (rules: RulesConfig, u: Unit, turn: number) => (isJammed(u, turn) ? rules.skills.jamVision : 0)

export function moveOf(rules: RulesConfig, u: Unit, turn: number): number {
  return Math.max(0, classOf(rules, u).move - (isSuppressed(u, turn) ? rules.skills.suppressMove : 0))
}

export function reachableFor(map: MapDef, rules: RulesConfig, u: Unit, turn: number) {
  return reachable(map, rules, u.pos, moveOf(rules, u, turn))
}

export function isValidDest(state: GameState, u: Unit, dest: Pos): boolean {
  return reachableFor(state.map, state.rules, u, state.turn).has(key(dest))
}

/** この移動をしても攻撃できるか（スナイパーの移動制限） */
export function canFireAfterMove(rules: RulesConfig, u: Unit, dest: Pos): boolean {
  return dist(u.pos, dest) <= classOf(rules, u).attackMaxMove
}

function updateIntel(state: GameState) {
  for (const side of [0, 1] as Side[]) {
    const intel = state.intel[side]
    // 次の手の命令時点で有効なマークで判定する
    const vis = visibleEnemyIds(state, side, state.turn + 1)
    for (const e of state.units) {
      if (e.side === side) continue
      if (!e.alive) {
        delete intel[e.id]
        continue
      }
      if (vis.has(e.id)) {
        intel[e.id] = { unitId: e.id, cls: e.cls, pos: { ...e.pos }, hp: e.hp, turn: state.turn, visible: true, marked: e.markedUntil >= state.turn + 1 }
      } else if (intel[e.id]) {
        intel[e.id].visible = false
        intel[e.id].marked = false
      }
    }
  }
}

function reveal(state: GameState, toSide: Side, u: Unit, turn: number) {
  const prev = state.intel[toSide][u.id]
  state.intel[toSide][u.id] = { unitId: u.id, cls: u.cls, pos: { ...u.pos }, hp: prev?.hp ?? null, turn, visible: false }
}

function defeat(state: GameState, u: Unit, events: GameEvent[]) {
  u.hp = 0
  u.alive = false
  const other = (1 - u.side) as Side
  state.kills[other] += 1
  state.killCost[other] += classOf(state.rules, u).cost
  events.push({ type: 'bailout', unitId: u.id, at: { ...u.pos } })
}

/**
 * 1手を同時解決する（state を直接更新）。
 * 1) 移動: 追撃の補正 → 全員が同時に目的地へ。同じマスに複数が来たら、移動してきた側が元の位置へ弾かれる（連鎖も解決）
 * 2) 観測: スカウトが視界内の敵にマーク
 * 3) 交戦: 速の高い順に1体ずつ。防護兵（支援中）が周囲の味方への命中弾を肩代わり。ガンナーの制圧
 * 4) 支援: 衛生兵（支援中）が周囲の味方を回復
 * 5) 攻撃した位置は相手に露見
 * 「支援中」= 狙いを指定しなかったユニット
 */
export function resolveTurn(state: GameState, orders: [Order[], Order[]], rng: Rng): GameEvent[] {
  if (state.over) return []
  const { map, rules } = state
  const T = state.turn
  const events: GameEvent[] = []
  const alive = state.units.filter((u) => u.alive)
  const orderOf = (u: Unit) => orders[u.side].find((x) => x.unitId === u.id)
  const supporting = (u: Unit) => !orderOf(u)?.target
  const origin = new Map<string, Pos>()
  const proposed = new Map<string, Pos>()
  for (const u of alive) {
    const o = orderOf(u)
    origin.set(u.id, { ...u.pos })
    proposed.set(u.id, o && isValidDest(state, u, o.dest) ? { ...o.dest } : { ...u.pos })
  }

  // --- 追撃: pursuit を持つユニットは、狙った敵の移動先の隣へ（届く範囲で）行き先を変える ---
  const pursued = new Set<string>()
  for (const u of alive) {
    if (!classOf(rules, u).pursuit) continue
    const t = alive.find((e) => e.id === orderOf(u)?.target && e.side !== u.side)
    if (!t) continue
    const tp = proposed.get(t.id)!
    const want = proposed.get(u.id)!
    const cands = [...reachableFor(map, rules, u, T).values()].filter((r) => !samePos(r.pos, tp))
    cands.sort((a, b) => dist(a.pos, tp) - dist(b.pos, tp) || dist(a.pos, want) - dist(b.pos, want) || a.cost - b.cost)
    if (cands.length && dist(cands[0].pos, tp) < dist(want, tp)) {
      proposed.set(u.id, { ...cands[0].pos })
      pursued.add(u.id)
    }
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
    else if (!samePos(from, to)) events.push(pursued.has(u.id) ? { type: 'pursuit', unitId: u.id, from, to: { ...to } } : { type: 'move', unitId: u.id, from, to: { ...to } })
    u.pos = { ...to }
  }
  if (rules.bumpReveals) {
    for (const u of alive) if (contact.has(u.id)) reveal(state, (1 - u.side) as Side, u, T)
  }

  // --- 隠密: 条件を満たしたユニットは、この手と次の手、見つかりにくい ---
  for (const u of alive) {
    const c = classOf(rules, u)
    if (c.stealth <= 0) continue
    const fromRoof = terrainId(map, origin.get(u.id)!) === 'building'
    const onGround = terrainId(map, u.pos) !== 'building'
    if (rules.skills.stealthTrigger === 'descend' ? fromRoof && onGround : supporting(u)) u.stealthUntil = T + 1
  }

  // --- 妨害: 地上から屋上へ登ったジャマーが、見えている敵の視界と命中率を下げる ---
  for (const u of alive) {
    if (!classOf(rules, u).jamOnClimb) continue
    if (terrainId(map, origin.get(u.id)!) === 'building' || terrainId(map, u.pos) !== 'building') continue
    const seen = alive.filter((e) => e.side !== u.side && canSee(map, rules, u.cls, u.pos, e.pos, stealthOf(rules, e, T)))
    if (!seen.length) continue
    for (const e of seen) e.jammedUntil = Math.max(e.jammedUntil, T + rules.skills.jamDuration)
    events.push({ type: 'jam', unitId: u.id, targets: seen.map((e) => e.id) })
  }

  // --- 観測: スカウトが視界内の敵にマーク ---
  const sk = rules.skills
  for (const u of alive) {
    const c = classOf(rules, u)
    if (!c.markOnSight || u.markCooldownUntil >= T) continue
    const seen = alive
      .filter((e) => e.side !== u.side && canSee(map, rules, u.cls, u.pos, e.pos, stealthOf(rules, e, T) + jamOf(rules, u, T)))
      .sort((a, b) => dist(u.pos, a.pos) - dist(u.pos, b.pos))
      .slice(0, sk.markPerTurn)
    if (!seen.length) continue
    for (const e of seen) e.markedUntil = Math.max(e.markedUntil, T + sk.markDuration)
    if (sk.markCooldown > 0) u.markCooldownUntil = T + sk.markCooldown
    events.push({ type: 'mark', unitId: u.id, targets: seen.map((e) => e.id) })
  }

  // --- 交戦: 速の高い順に1体ずつ解決。撃つ前に撃破されたユニットは撃てない ---
  const teamVis: [Set<string>, Set<string>] = [visibleEnemyIds(state, 0), visibleEnemyIds(state, 1)]
  const attackers: Unit[] = []
  const guardUsed = new Map<string, number>()
  const queue = alive
    .map((u) => ({ u, targetId: orderOf(u)?.target, init: classOf(rules, u).spd + rng.next() * rules.combat.initiativeJitter }))
    .filter((q): q is { u: Unit; targetId: string; init: number } => !!q.targetId)
    .sort((a, b) => b.init - a.init)
  for (const { u, targetId } of queue) {
    const cls = classOf(rules, u)
    const t = state.units.find((e) => e.id === targetId && e.side !== u.side)
    let reason: StrikeBlock | null = null
    if (!u.alive) reason = 'down'
    else if (!t || !t.alive) reason = 'gone'
    else if (dist(origin.get(u.id)!, u.pos) > cls.attackMaxMove) reason = 'moved'
    else if (!(rules.sharedTargeting ? teamVis[u.side].has(t.id) : canSee(map, rules, u.cls, u.pos, t.pos))) reason = 'unseen'
    else reason = strikeCheck(map, rules, u.pos, t.pos, attackRange(map, rules, u.cls, u.pos), isMeleeClass(rules, u.cls))
    if (reason || !t) {
      events.push({ type: 'noshot', unitId: u.id, targetId, reason: reason ?? 'gone' })
      continue
    }
    const tc = classOf(rules, t)
    const { chance, cover } = hitChance(map, rules, cls, u.pos, t.pos, {
      stationary: samePos(origin.get(u.id)!, u.pos),
      marked: isMarked(t, T),
      suppressed: isSuppressed(u, T),
      jammed: isJammed(u, T),
    })
    const shots: ShotResult[] = []
    const downed: Unit[] = []
    for (let i = 0; i < cls.shots && t.hp > 0; i++) {
      const hit = rng.next() * 100 < chance
      if (!hit) {
        shots.push({ hit, damage: 0 })
        continue
      }
      // カバーリング: 支援中の防護兵が周囲8マスにいれば肩代わり
      const guard = alive
        .filter(
          (g) =>
            g.alive &&
            g.side === t.side &&
            g.id !== t.id &&
            classOf(rules, g).guardReduce > 0 &&
            supporting(g) &&
            chebyshev(g.pos, t.pos) <= 1 &&
            (!rules.skills.guardSameHeight || terrainId(map, g.pos) === terrainId(map, t.pos)) &&
            (guardUsed.get(g.id) ?? 0) < rules.skills.guardHitsPerTurn,
        )
        .sort((a, b) => b.hp - a.hp)[0]
      if (guard) {
        const gc = classOf(rules, guard)
        guardUsed.set(guard.id, (guardUsed.get(guard.id) ?? 0) + 1)
        const dmg = Math.max(1, Math.round(rollDamage(rules, cls.atk, gc.def, rng, cls.pen) * (1 - gc.guardReduce)))
        guard.hp -= dmg
        shots.push({ hit, damage: dmg, guardedBy: guard.id })
        if (guard.hp <= 0) downed.push(guard), (guard.alive = false)
      } else {
        const dmg = rollDamage(rules, cls.atk, tc.def, rng, cls.pen)
        t.hp -= dmg
        shots.push({ hit, damage: dmg })
      }
    }
    const direct = shots.filter((x) => x.hit && !x.guardedBy)
    const total = direct.reduce((a, x) => a + x.damage, 0)
    events.push({
      type: 'attack',
      unitId: u.id,
      from: { ...u.pos },
      target: { ...t.pos },
      hitId: t.id,
      chance,
      cover,
      shots,
      damage: total,
      targetHp: Math.max(0, t.hp),
      spotted: !canSee(map, rules, u.cls, u.pos, t.pos),
    })
    attackers.push(u)
    if (cls.suppress && shots.filter((x) => x.hit).length >= 2 && t.hp > 0) {
      t.suppressedUntil = Math.max(t.suppressedUntil, T + 1)
      events.push({ type: 'suppress', unitId: u.id, targetId: t.id })
    }
    for (const g of downed) {
      g.alive = true
      defeat(state, g, events)
    }
    if (t.hp <= 0) defeat(state, t, events)
  }

  // --- 後送: 衛生兵が、移動前に隣にいた傷ついた味方を自分の隣へ引っ張ってくる ---
  for (const u of alive) {
    const c = classOf(rules, u)
    if (!u.alive || !c.evac || !supporting(u)) continue
    const ally = alive
      .filter((a) => a.alive && a.side === u.side && a.id !== u.id && a.hp < classOf(rules, a).hp && chebyshev(origin.get(a.id)!, origin.get(u.id)!) <= 1)
      .sort((a, b) => classOf(rules, b).hp - b.hp - (classOf(rules, a).hp - a.hp))[0]
    if (!ally || chebyshev(ally.pos, u.pos) <= 1) continue
    const enemies = state.units.filter((e) => e.alive && e.side !== u.side)
    const taken = new Set(state.units.filter((x) => x.alive && x.id !== ally.id).map((x) => key(x.pos)))
    const spots: Pos[] = []
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const p = { x: u.pos.x + dx, y: u.pos.y + dy }
        if ((dx || dy) && inBounds(map, p) && terrain(map, rules, p).passable && !taken.has(key(p))) spots.push(p)
      }
    if (!spots.length) continue
    const safety = (p: Pos) => (enemies.length ? Math.min(...enemies.map((e) => dist(p, e.pos))) : 0)
    spots.sort((a, b) => safety(b) - safety(a) || dist(a, ally.pos) - dist(b, ally.pos))
    events.push({ type: 'evac', unitId: u.id, allyId: ally.id, from: { ...ally.pos }, to: { ...spots[0] } })
    ally.pos = { ...spots[0] }
  }

  // --- 支援: 衛生兵の回復 ---
  for (const u of alive) {
    const c = classOf(rules, u)
    if (!u.alive || c.heal <= 0 || !supporting(u)) continue
    const healed: { id: string; amount: number }[] = []
    for (const a of alive) {
      if (!a.alive || a.side !== u.side || a.id === u.id || chebyshev(a.pos, u.pos) > c.healRange) continue
      const amount = Math.min(c.heal, classOf(rules, a).hp - a.hp)
      if (amount <= 0) continue
      a.hp += amount
      healed.push({ id: a.id, amount })
    }
    if (healed.length) events.push({ type: 'heal', unitId: u.id, targets: healed })
  }

  if (rules.attackReveals) for (const u of attackers) reveal(state, (1 - u.side) as Side, u, T)

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
