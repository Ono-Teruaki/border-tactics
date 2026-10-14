// 勝ちパターンの分析: 棋譜（シミュレーション）から、勝った側と負けた側で何が違うかを集計する
//   node sim/patterns.ts [--games 1500] [--variant sim/variants/ai-tuned-v091.json] [--mirror]
// --mirror: 両軍を同じ編成にして、動き方の差だけを見る
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { basename } from 'node:path'
import { AI_PRESETS, decideOrders } from '../src/engine/ai.ts'
import { canSee, createGame, gameResult, observe, resolveTurn } from '../src/engine/game.ts'
import { terrainId } from '../src/engine/grid.ts'
import { CURRENT_MAP_IDS, getMap } from '../src/engine/maps.ts'
import { createRng } from '../src/engine/rng.ts'
import { DEFAULT_RULES, mergeRules } from '../src/engine/rules.ts'
import type { Side } from '../src/engine/types.ts'
import { allComps } from './lib.ts'

const args = process.argv.slice(2)
const arg = (n: string, d: string) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d)
const GAMES = Number(arg('games', '1500'))
const VARIANT = arg('variant', '')
const MIRROR = args.includes('--mirror')
const VAR = VARIANT ? JSON.parse(readFileSync(VARIANT, 'utf8')) : {}
for (const [k, v] of Object.entries((VAR.ai ?? {}) as Record<string, object>)) Object.assign(AI_PRESETS[k], v)
const rules = mergeRules(DEFAULT_RULES, (({ ai: _a, maps: _m, ...o }) => o)(VAR))
const ids = Object.keys(rules.classes)
const legal = allComps(ids, rules.teamSize).filter((c) => ids.every((k) => c.filter((x) => x === k).length <= rules.skills.maxPerClass))
const OUT = arg('out', `patterns${VARIANT ? '-' + basename(VARIANT, '.json') : ''}${MIRROR ? '-mirror' : ''}`)

interface SideStats {
  firstKill: boolean
  firstSeen: boolean
  attacks: number
  focusTurns: number
  roofAttacks: number
  spotted: number
  hits: number
  shots: number
  meleeKills: number
  rangedKills: number
  leadAt6: number
  firstLoss?: string
  hpDealt: number
}

const rng0 = createRng(31)
const rows: { winner: Side | null; s: [SideStats, SideStats]; turns: number }[] = []
for (let k = 0; k < GAMES; k++) {
  const c0 = legal[Math.floor(rng0.next() * legal.length)]
  const c1 = MIRROR ? c0 : legal[Math.floor(rng0.next() * legal.length)]
  const map = getMap(CURRENT_MAP_IDS[k % CURRENT_MAP_IDS.length])
  const g = createGame(map, rules, [c0, c1])
  const rng = createRng(7000 + k * 17)
  const z = (): SideStats => ({ firstKill: false, firstSeen: false, attacks: 0, focusTurns: 0, roofAttacks: 0, spotted: 0, hits: 0, shots: 0, meleeKills: 0, rangedKills: 0, leadAt6: 0, hpDealt: 0 })
  const s: [SideStats, SideStats] = [z(), z()]
  let killDone = false
  let seenDone = false
  const byId = new Map(g.units.map((u) => [u.id, u]))
  while (!g.over) {
    const orders = ([0, 1] as Side[]).map((sd) => decideOrders(observe(g, sd), rng, AI_PRESETS.cpu)) as [any, any]
    const ev = resolveTurn(g, orders, rng)
    if (!seenDone) {
      const seen = ([0, 1] as Side[]).map((sd) => g.units.some((u) => u.alive && u.side === sd && g.units.some((e) => e.alive && e.side !== sd && canSee(map, rules, u.cls, u.pos, e.pos))))
      if (seen[0] !== seen[1]) (s[seen[0] ? 0 : 1].firstSeen = true), (seenDone = true)
      else if (seen[0]) seenDone = true
    }
    const perTarget = new Map<string, number>()
    const lastAttacker = new Map<string, { side: Side; melee: boolean }>()
    for (const e of ev) {
      if (e.type === 'attack') {
        const u = byId.get(e.unitId)!
        const st = s[u.side]
        st.attacks++
        st.shots += e.shots.length
        st.hits += e.shots.filter((x) => x.hit).length
        st.hpDealt += e.damage
        if (terrainId(map, e.from) === 'building') st.roofAttacks++
        if (e.spotted) st.spotted++
        perTarget.set(e.hitId, (perTarget.get(e.hitId) ?? 0) + 1)
        lastAttacker.set(e.hitId, { side: u.side, melee: Math.abs(e.from.x - e.target.x) + Math.abs(e.from.y - e.target.y) <= 1 })
      }
      if (e.type === 'bailout') {
        const v = byId.get(e.unitId)!
        const killer = (1 - v.side) as Side
        if (!killDone) (s[killer].firstKill = true), (killDone = true)
        if (!s[v.side].firstLoss) s[v.side].firstLoss = v.cls
        const la = lastAttacker.get(e.unitId)
        if (la) la.melee ? s[killer].meleeKills++ : s[killer].rangedKills++
      }
    }
    for (const [t, n] of perTarget) if (n >= 2) s[(1 - byId.get(t)!.side) as Side].focusTurns++
    if (g.turn === 7) {
      s[0].leadAt6 = g.killCost[0] - g.killCost[1]
      s[1].leadAt6 = -s[0].leadAt6
    }
  }
  rows.push({ winner: gameResult(g).winner.killCost, s, turns: g.history.length })
}

const dec = rows.filter((r) => r.winner !== null)
const pct = (x: number) => `${(x * 100).toFixed(1)}%`
const md: string[] = []
const o = (x = '') => (md.push(x), console.log(x))
o(`# 勝ちパターン: ${OUT}`)
o()
o(`- ${GAMES}戦（${MIRROR ? '両軍同じ編成' : 'ランダムな編成どうし'}、3マップ）。決着 ${dec.length}戦 / 引き分け ${rows.length - dec.length}戦（${pct((rows.length - dec.length) / rows.length)}）`)
if (VARIANT) o(`- variant: \`${VARIANT}\``)
o()
o('## 「これをした側」が勝つ割合（決着した試合）')
o('| 条件 | 当てはまる試合 | その側の勝率 |')
o('|---|---|---|')
const cond = (label: string, pick: (r: (typeof dec)[number]) => Side | null) => {
  const xs = dec.map((r) => ({ r, sd: pick(r) })).filter((x) => x.sd !== null)
  const w = xs.filter((x) => x.r.winner === x.sd).length
  o(`| ${label} | ${xs.length} | ${pct(w / Math.max(1, xs.length))} |`)
}
const more = (f: (st: SideStats) => number) => (r: (typeof dec)[number]) => (f(r.s[0]) > f(r.s[1]) ? 0 : f(r.s[1]) > f(r.s[0]) ? 1 : null)
cond('先に撃破した', (r) => (r.s[0].firstKill ? 0 : r.s[1].firstKill ? 1 : null))
cond('先に敵を見つけた', (r) => (r.s[0].firstSeen ? 0 : r.s[1].firstSeen ? 1 : null))
cond('6手目の終わりに撃破コストで勝っていた', (r) => (r.s[0].leadAt6 > 0 ? 0 : r.s[0].leadAt6 < 0 ? 1 : null))
cond('集中砲火（同じ手に2体以上で同じ敵）が多い', more((st) => st.focusTurns))
cond('撃った回数が多い', more((st) => st.attacks))
cond('命中率が高い', more((st) => st.hits / Math.max(1, st.shots)))
cond('屋上からの攻撃が多い', more((st) => st.roofAttacks))
cond('味方の索敵で撃った回数が多い', more((st) => st.spotted))
cond('削ったHPが多い', more((st) => st.hpDealt))
o()
o('## 逆転')
const behind = dec.filter((r) => r.s[0].leadAt6 !== 0)
const comeback = behind.filter((r) => (r.s[0].leadAt6 > 0 ? 1 : 0) === r.winner).length
o(`- 6手目の終わりに撃破コストで負けていた側が勝った割合: ${pct(comeback / Math.max(1, behind.length))}（${behind.length}戦中）`)
o()
o('## 勝った側と負けた側の平均（1試合あたり）')
o('| | 勝った側 | 負けた側 |')
o('|---|---|---|')
const avg = (f: (st: SideStats) => number, win: boolean) => dec.reduce((a, r) => a + f(r.s[win ? r.winner! : ((1 - r.winner!) as Side)]), 0) / dec.length
for (const [label, f] of [
  ['撃った回数', (st: SideStats) => st.attacks],
  ['集中砲火の回数', (st: SideStats) => st.focusTurns],
  ['命中率', (st: SideStats) => st.hits / Math.max(1, st.shots)],
  ['屋上からの攻撃', (st: SideStats) => st.roofAttacks],
  ['近接での撃破', (st: SideStats) => st.meleeKills],
  ['射撃での撃破', (st: SideStats) => st.rangedKills],
] as const)
  o(`| ${label} | ${label === '命中率' ? pct(avg(f, true)) : avg(f, true).toFixed(2)} | ${label === '命中率' ? pct(avg(f, false)) : avg(f, false).toFixed(2)} |`)
o()
o('## 最初に失ったクラスと、その側の勝率')
o('| 最初に失ったクラス | 試合 | 勝率 |')
o('|---|---|---|')
for (const c of ids) {
  const xs = dec.flatMap((r) => ([0, 1] as Side[]).filter((sd) => r.s[sd].firstLoss === c).map((sd) => r.winner === sd))
  if (xs.length) o(`| ${rules.classes[c].name} | ${xs.length} | ${pct(xs.filter(Boolean).length / xs.length)} |`)
}
mkdirSync('sim/results', { recursive: true })
writeFileSync(`sim/results/${OUT}.md`, md.join('\n') + '\n')
