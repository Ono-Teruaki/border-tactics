import { AI_PRESETS, decideOrders, type AiParams } from '../src/engine/ai.ts'
import { createGame, gameResult, observe, resolveTurn, visibleEnemyIds } from '../src/engine/game.ts'
import { terrainId } from '../src/engine/grid.ts'
import { createRng } from '../src/engine/rng.ts'
import type { GameResult, MapDef, RulesConfig, Side } from '../src/engine/types.ts'

export interface MatchStats extends GameResult {
  /** [side][class] */
  kills: [number, number]
  classKills: [Record<string, number>, Record<string, number>]
  classDeaths: [Record<string, number>, Record<string, number>]
  attacks: [number, number]
  /** 撃った本人は見えていなかった（味方の索敵による）攻撃・撃破 */
  spottedAttacks: [number, number]
  spottedKills: [number, number]
  /** 屋上からの攻撃・撃破 */
  roofAttacks: [number, number]
  roofKills: [number, number]
  /** 屋上にいたユニット×ターン / 全ユニット×ターン */
  roofOccupancy: [number, number]
  /** 初めて敵を視認したターン（なければ null） */
  firstContact: [number | null, number | null]
  /** 敵を1体以上視認できていたターンの割合 */
  visibleShare: [number, number]
  /** 狙ったが撃てなかった理由の内訳 */
  noshot: Record<string, number>
  /** 弾単位の命中数 / 発射数 */
  shotsHit: number
  shotsFired: number
}

export function playMatch(map: MapDef, rules: RulesConfig, comps: [string[], string[]], ais: [AiParams, AiParams], seed: number): MatchStats {
  const g = createGame(map, rules, comps)
  const rng = createRng(seed)
  const classKills: MatchStats['classKills'] = [{}, {}]
  const classDeaths: MatchStats['classDeaths'] = [{}, {}]
  const attacks: [number, number] = [0, 0]
  const z = (): [number, number] => [0, 0]
  const spottedAttacks = z(), spottedKills = z(), roofAttacks = z(), roofKills = z()
  const roofUnitTurns = z(), unitTurns = z(), visTurns = z()
  const firstContact: [number | null, number | null] = [null, null]
  const noshot: Record<string, number> = {}
  let shotsHit = 0
  let shotsFired = 0
  const byId = new Map(g.units.map((u) => [u.id, u]))
  while (!g.over) {
    const orders = ([0, 1] as Side[]).map((s) => decideOrders(observe(g, s), rng, ais[s])) as [any, any]
    const turn = g.turn
    const events = resolveTurn(g, orders, rng)
    const killer = new Map<string, { cls: string; spotted: boolean; roof: boolean }>()
    for (const e of events) {
      if (e.type === 'attack') {
        const u = byId.get(e.unitId)!
        const roof = terrainId(map, e.from) === 'building'
        attacks[u.side]++
        if (e.spotted) spottedAttacks[u.side]++
        if (roof) roofAttacks[u.side]++
        killer.set(e.hitId, { cls: u.cls, spotted: e.spotted, roof })
        shotsFired += e.shots.length
        shotsHit += e.shots.filter((x) => x.hit).length
      }
      if (e.type === 'noshot') noshot[e.reason] = (noshot[e.reason] ?? 0) + 1
      if (e.type === 'bailout') {
        const v = byId.get(e.unitId)!
        const k = killer.get(v.id)
        const ks = (1 - v.side) as Side
        classKills[ks][k?.cls ?? '?'] = (classKills[ks][k?.cls ?? '?'] ?? 0) + 1
        classDeaths[v.side][v.cls] = (classDeaths[v.side][v.cls] ?? 0) + 1
        if (k?.spotted) spottedKills[ks]++
        if (k?.roof) roofKills[ks]++
      }
    }
    for (const s of [0, 1] as Side[]) {
      for (const u of g.units) {
        if (!u.alive || u.side !== s) continue
        unitTurns[s]++
        if (terrainId(map, u.pos) === 'building') roofUnitTurns[s]++
      }
      if (visibleEnemyIds(g, s).size > 0) {
        visTurns[s]++
        if (firstContact[s] === null) firstContact[s] = turn
      }
    }
  }
  const turns = g.history.length
  return {
    ...gameResult(g),
    classKills,
    classDeaths,
    attacks,
    spottedAttacks,
    spottedKills,
    roofAttacks,
    roofKills,
    roofOccupancy: [roofUnitTurns[0] / Math.max(1, unitTurns[0]), roofUnitTurns[1] / Math.max(1, unitTurns[1])],
    firstContact,
    visibleShare: [visTurns[0] / turns, visTurns[1] / turns],
    noshot,
    shotsHit,
    shotsFired,
  }
}

export function resolveAi(name: string): AiParams {
  const p = AI_PRESETS[name]
  if (!p) throw new Error(`unknown ai ${name}. choices: ${Object.keys(AI_PRESETS).join(', ')}`)
  return p
}

/** 4クラスから重複ありで teamSize 体選ぶ全編成 */
export function allComps(classIds: string[], size: number): string[][] {
  const out: string[][] = []
  const rec = (start: number, cur: string[]) => {
    if (cur.length === size) return void out.push([...cur])
    for (let i = start; i < classIds.length; i++) rec(i, [...cur, classIds[i]])
  }
  rec(0, [])
  return out
}

export const compLabel = (rules: RulesConfig, comp: string[]) => comp.map((c) => rules.classes[c].short).join('')
