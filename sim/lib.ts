import { AI_PRESETS, decideOrders, type AiParams } from '../src/engine/ai.ts'
import { createGame, gameResult, observe, resolveTurn } from '../src/engine/game.ts'
import { createRng } from '../src/engine/rng.ts'
import type { GameResult, MapDef, RulesConfig, Side, Stance } from '../src/engine/types.ts'

export interface MatchStats extends GameResult {
  /** [side][class] */
  kills: [number, number]
  classKills: [Record<string, number>, Record<string, number>]
  classDeaths: [Record<string, number>, Record<string, number>]
  stances: [Record<Stance, number>, Record<Stance, number>]
  attacks: [number, number]
  hits: [number, number]
}

export function playMatch(map: MapDef, rules: RulesConfig, comps: [string[], string[]], ais: [AiParams, AiParams], seed: number): MatchStats {
  const g = createGame(map, rules, comps)
  const rng = createRng(seed)
  const stances: MatchStats['stances'] = [
    { attack: 0, watch: 0, hide: 0 },
    { attack: 0, watch: 0, hide: 0 },
  ]
  const classKills: MatchStats['classKills'] = [{}, {}]
  const classDeaths: MatchStats['classDeaths'] = [{}, {}]
  const attacks: [number, number] = [0, 0]
  const hits: [number, number] = [0, 0]
  const byId = new Map(g.units.map((u) => [u.id, u]))
  while (!g.over) {
    const orders = ([0, 1] as Side[]).map((s) => decideOrders(observe(g, s), rng, ais[s])) as [any, any]
    for (const s of [0, 1] as Side[]) for (const o of orders[s]) stances[s][o.stance as Stance]++
    const events = resolveTurn(g, orders, rng)
    const damagers = new Map<string, string>()
    for (const e of events) {
      if (e.type === 'attack') {
        const u = byId.get(e.unitId)!
        attacks[u.side]++
        if (e.hitId) {
          hits[u.side]++
          damagers.set(e.hitId, u.cls)
        }
      }
      if (e.type === 'bailout') {
        const v = byId.get(e.unitId)!
        const killerCls = damagers.get(v.id) ?? '?'
        const ks = (1 - v.side) as Side
        classKills[ks][killerCls] = (classKills[ks][killerCls] ?? 0) + 1
        classDeaths[v.side][v.cls] = (classDeaths[v.side][v.cls] ?? 0) + 1
      }
    }
  }
  return { ...gameResult(g), classKills, classDeaths, stances, attacks, hits }
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
