// 指定した編成を、今の上位12編成と戦わせた平均勝ち点率（従来CPU）。テコ入れ案の素早い比較用
//   node sim/panel.ts AXVD,GSXV '{"classes":{"screener":{"cost":1}}}' ラベル
import { readFileSync } from 'node:fs'
import { AI_PRESETS, decideOrders } from '../src/engine/ai.ts'
import { createGame, gameResult, observe, resolveTurn } from '../src/engine/game.ts'
import { CURRENT_MAP_IDS, getMap } from '../src/engine/maps.ts'
import { createRng } from '../src/engine/rng.ts'
import { DEFAULT_RULES, mergeRules } from '../src/engine/rules.ts'
const [comps, variant, label] = [process.argv[2].split(','), process.argv[3] ?? '', process.argv[4] ?? '']
const rules = variant ? mergeRules(DEFAULT_RULES, JSON.parse(variant)) : DEFAULT_RULES
const by = Object.fromEntries(Object.values(rules.classes).map((c) => [c.short, c.id]))
const top = ['ASJX','AJXD','AGJX','AMJX','AGXD','AGSX','SJXD','ASXD','GSJX','GSXD','SRXD','SRJX']
const P = AI_PRESETS.strong
let tot = 0, nC = 0; const per: string[] = []
for (const c of comps) { let n = 0, pts = 0
  for (const o of top) for (const [mi, id] of CURRENT_MAP_IDS.entries()) for (const side of [0, 1] as const) for (let r = 0; r < 4; r++) {
    const A = [...c].map((x) => by[x]), B = [...o].map((x) => by[x])
    const g = createGame(getMap(id), rules, side === 0 ? [A, B] : [B, A]); const rng = createRng(900 + mi * 31 + r * 7 + side)
    while (!g.over) resolveTurn(g, [0, 1].map((s) => decideOrders(observe(g, s as any), rng, P)) as any, rng)
    const w = gameResult(g).winner.killCost; n++; pts += w === side ? 1 : w === null ? 0.5 : 0 }
  per.push(`${c} ${(pts / n * 100).toFixed(0)}%`); tot += pts / n; nC++ }
console.log(`${label.padEnd(18)} 平均 ${(tot / nC * 100).toFixed(1)}%  (${per.join(' ')})`)
