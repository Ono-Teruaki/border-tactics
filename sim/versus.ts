// 編成どうしの対戦（対策の評価用）。従来 CPU と先読み CPU を両軍それぞれ選べる
//   node sim/versus.ts --comp AMJD --vs SRXD [--reps 8] [--maps block9,alley11,plaza7]
//     [--ai sim/variants/x.json] [--opp-ai sim/variants/y.json]   CPU の重み（variant の ai.cpu、既定は strong）
//     [--search] [--opp-search]                                    先読み CPU にする
//     [--search-opts '{"candidates":10,"evalAdvance":1}'] [--opp-search-opts '{...}']
// 編成は クラスの頭文字（A=アタッカー G=ガンナー S=スナイパー R=スカウト M=衛生兵 J=ジャマー X=擲弾兵 D=防護兵）
import { readFileSync } from 'node:fs'
import { AI_PRESETS, decideOrders, type AiParams } from '../src/engine/ai.ts'
import { createGame, gameResult, observe, resolveTurn } from '../src/engine/game.ts'
import { CURRENT_MAP_IDS, getMap } from '../src/engine/maps.ts'
import { createRng } from '../src/engine/rng.ts'
import { DEFAULT_RULES } from '../src/engine/rules.ts'
import { decideOrdersSearch, SEARCH_GAME, type SearchOpts } from '../src/engine/search.ts'
import type { Observation, Order, Side } from '../src/engine/types.ts'

const args = process.argv.slice(2)
const arg = (n: string, d = '') => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d)
const flag = (n: string) => args.includes(`--${n}`)
const rules = DEFAULT_RULES
const byShort = Object.fromEntries(Object.values(rules.classes).map((c) => [c.short, c.id]))
const comp = (s: string) => [...s].map((ch) => byShort[ch] ?? (() => { throw new Error(`unknown class ${ch}`) })())
const aiOf = (path: string): AiParams => (path ? { ...AI_PRESETS.strong, ...JSON.parse(readFileSync(path, 'utf8')).ai.cpu } : AI_PRESETS.strong)

type Player = { label: string; decide: (obs: Observation, rng: ReturnType<typeof createRng>) => Order[] }
function player(aiPath: string, search: boolean, searchOpts: string): Player {
  const p = aiOf(aiPath)
  const so: SearchOpts = { ...SEARCH_GAME, ...JSON.parse(searchOpts || '{}') }
  return {
    label: `${search ? '先読み' : '従来'}${aiPath ? `(${aiPath.split('/').pop()})` : ''}`,
    decide: search ? (obs, rng) => decideOrdersSearch(obs, rng, p, so) : (obs, rng) => decideOrders(obs, rng, p),
  }
}

const A = arg('comp'), B = arg('vs')
if (!A || !B) throw new Error('--comp と --vs を指定してください（例: --comp AMJD --vs SRXD）')
const me = player(arg('ai'), flag('search'), arg('search-opts'))
const op = player(arg('opp-ai'), flag('opp-search'), arg('opp-search-opts'))
const reps = Number(arg('reps', '8'))
const maps = (arg('maps') ? arg('maps').split(',') : CURRENT_MAP_IDS).map(getMap)
let n = 0, w = 0, d = 0, kills = 0, deaths = 0
const t0 = Date.now()
for (const [mi, map] of maps.entries())
  for (const side of [0, 1] as Side[])
    for (let r = 0; r < reps; r++) {
      const g = createGame(map, rules, side === 0 ? [comp(A), comp(B)] : [comp(B), comp(A)])
      const rng = createRng(7000 + mi * 97 + side * 13 + r * 7)
      while (!g.over) {
        const orders = ([0, 1] as Side[]).map((s) => (s === side ? me : op).decide(observe(g, s), rng)) as [Order[], Order[]]
        resolveTurn(g, orders, rng)
      }
      const res = gameResult(g)
      n++
      const win = res.winner.killCost
      if (win === side) w++
      else if (win === null) d++
      kills += res.kills[side]
      deaths += res.kills[1 - side]
    }
const pct = (x: number) => `${((x / n) * 100).toFixed(0)}%`
console.log(`${me.label} ${A} 対 ${op.label} ${B}: 勝ち点率 ${(((w + d / 2) / n) * 100).toFixed(1)}%（勝${pct(w)} 分${pct(d)} 負${pct(n - w - d)}、1試合の撃破 ${(kills / n).toFixed(2)} - ${(deaths / n).toFixed(2)}）${n}戦 ${((Date.now() - t0) / 1000).toFixed(0)}秒`)
