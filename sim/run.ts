// バランス検証スイート
//   npm run sim                         … 既定ルールで全項目
//   npm run sim -- --variant sim/variants/xxx.json   … ルール差分で実行
//   npm run sim -- --games 100 --quick  … 軽量版（編成総当たりを省略）
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'
import { CPU_COMPS } from '../src/engine/ai.ts'
import { MAPS } from '../src/engine/maps.ts'
import { DEFAULT_RULES, mergeRules, type RulesOverride } from '../src/engine/rules.ts'
import type { MapDef, RulesConfig, Side, VictoryMode } from '../src/engine/types.ts'
import { allComps, compLabel, playMatch, resolveAi, type MatchStats } from './lib.ts'

const args = process.argv.slice(2)
const arg = (name: string, def?: string) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : def
}
const flag = (name: string) => args.includes(`--${name}`)

const variantPath = arg('variant')
const variant: RulesOverride & { maps?: string[] } = variantPath ? JSON.parse(readFileSync(variantPath, 'utf8')) : {}
const { maps: mapIds, ...override } = variant
const rules = mergeRules(DEFAULT_RULES, override)
const maps: MapDef[] = mapIds ? MAPS.filter((m) => mapIds.includes(m.id)) : MAPS
const GAMES = Number(arg('games', '200'))
const SEED = Number(arg('seed', '1'))
const name = arg('out', variantPath ? basename(variantPath, '.json') : 'default')!
const MODES: VictoryMode[] = ['annihilation', 'killCount', 'killCost']
const classIds = Object.keys(rules.classes)
const balanced = classIds.slice(0, rules.teamSize)
while (balanced.length < rules.teamSize) balanced.push(classIds[0])

const pct = (x: number) => `${(x * 100).toFixed(1)}%`
const md: string[] = []
const json: Record<string, unknown> = { variant, rules }
const out = (s = '') => {
  md.push(s)
  console.log(s)
}

interface Agg {
  n: number
  win: Record<VictoryMode, number>
  draw: Record<VictoryMode, number>
  turns: number
  stances: Record<string, number>
  attacks: number
  hits: number
}
const newAgg = (): Agg => ({ n: 0, win: { annihilation: 0, killCount: 0, killCost: 0 }, draw: { annihilation: 0, killCount: 0, killCost: 0 }, turns: 0, stances: {}, attacks: 0, hits: 0 })
/** 「主役側(hero)」視点で集計 */
function add(agg: Agg, r: MatchStats, hero: Side) {
  agg.n++
  agg.turns += r.turns
  for (const m of MODES) {
    if (r.winner[m] === hero) agg.win[m]++
    if (r.winner[m] === null) agg.draw[m]++
  }
  for (const [k, v] of Object.entries(r.stances[hero])) agg.stances[k] = (agg.stances[k] ?? 0) + v
  agg.attacks += r.attacks[hero]
  agg.hits += r.hits[hero]
}
const winCells = (a: Agg) => MODES.map((m) => `${pct(a.win[m] / a.n)} / ${pct(a.draw[m] / a.n)}`).join(' | ')
const MODE_HEADER = '| 全滅 勝/分 | 撃破数 勝/分 | 撃破コスト 勝/分 |'

/** hero(aiA, compA) vs (aiB, compB) を先後入れ替えながら games 戦 */
function series(map: MapDef, r: RulesConfig, aiA: string, compA: string[], aiB: string, compB: string[], games: number, seed: number, agg = newAgg()) {
  for (let i = 0; i < games; i++) {
    const heroSide: Side = (i % 2) as Side
    const comps: [string[], string[]] = heroSide === 0 ? [compA, compB] : [compB, compA]
    const ais: [any, any] = heroSide === 0 ? [resolveAi(aiA), resolveAi(aiB)] : [resolveAi(aiB), resolveAi(aiA)]
    add(agg, playMatch(map, r, comps, ais, seed + i * 7919), heroSide)
  }
  return agg
}

const t0 = Date.now()
out(`# シミュレーション結果: ${name}`)
out()
out(`- 試行数: ${GAMES}/条件, seed=${SEED}, マップ: ${maps.map((m) => m.name).join(', ')}`)
out(`- 勝利条件(既定): ${rules.victory}, ターン上限: ${rules.turnLimit}`)
if (variantPath) out(`- 差分: \`${JSON.stringify(variant)}\``)
out()

// 1. 戦略に意味があるか
out('## 1. 戦略性チェック（CPU vs ランダム）')
out('CPU側の勝率。ここが高くないと「考えて動かす意味」が薄い。')
out()
out(`| マップ ${MODE_HEADER} 平均ターン |`)
out('|---|---|---|---|---|')
for (const map of maps) {
  const a = series(map, rules, 'cpu', balanced, 'random', balanced, GAMES, SEED)
  out(`| ${map.name} | ${winCells(a)} | ${(a.turns / a.n).toFixed(1)} |`)
}
out()

// 2. 先後（上下）バイアス
out('## 2. 陣地バイアス（CPU同士・同編成, side0=下側の勝率）')
out()
out(`| マップ ${MODE_HEADER}`)
out('|---|---|---|---|')
for (const map of maps) {
  const agg = newAgg()
  for (let i = 0; i < GAMES; i++) add(agg, playMatch(map, rules, [balanced, balanced], [resolveAi('cpu'), resolveAi('cpu')], SEED + i * 7919), 0)
  out(`| ${map.name} | ${winCells(agg)} |`)
}
out()

// 3. クリア可能性
out('## 3. クリア可能性（プレイヤー代理AI vs CPU。CPUは編成候補からランダム）')
out('プレイヤー編成 × 代理AIスタイル。人間がCPUに勝てる余地の目安。')
out()
const playerComps = [balanced, ...CPU_COMPS.slice(1), ['sniper', 'sniper', 'scout', 'scout'], ['attacker', 'attacker', 'attacker', 'attacker']].filter((c) => c.every((x) => rules.classes[x]))
const clear: Record<string, unknown> = {}
out(`| 編成 | 代理AI ${MODE_HEADER} 平均ターン |`)
out('|---|---|---|---|---|---|')
for (const comp of playerComps) {
  for (const proxy of ['cpu', 'aggressive', 'cautious']) {
    const agg = newAgg()
    for (const map of maps) {
      CPU_COMPS.forEach((cc, j) => series(map, rules, proxy, comp, 'cpu', cc, Math.ceil(GAMES / CPU_COMPS.length / 2), SEED + j * 101, agg))
    }
    clear[`${compLabel(rules, comp)}/${proxy}`] = agg
    out(`| ${compLabel(rules, comp)} | ${proxy} | ${winCells(agg)} | ${(agg.turns / agg.n).toFixed(1)} |`)
  }
}
json.clearability = clear
out()

// 4. 全体傾向（CPU同士、ランダム編成）
out('## 4. 全体傾向（CPU同士, 全編成からランダム）')
const comps = allComps(classIds, rules.teamSize)
{
  const agg = newAgg()
  let annihil = 0
  const classK: Record<string, number> = {}
  const classD: Record<string, number> = {}
  const classN: Record<string, number> = {}
  let i = 0
  for (const map of maps) {
    for (let k = 0; k < GAMES; k++, i++) {
      const ca = comps[(k * 17 + 3) % comps.length]
      const cb = comps[(k * 29 + 11) % comps.length]
      const r = playMatch(map, rules, [ca, cb], [resolveAi('cpu'), resolveAi('cpu')], SEED + i * 31)
      add(agg, r, 0)
      if (r.alive[0] === 0 || r.alive[1] === 0) annihil++
      for (const s of [0, 1] as Side[]) {
        for (const [c, v] of Object.entries(r.classKills[s])) classK[c] = (classK[c] ?? 0) + v
        for (const [c, v] of Object.entries(r.classDeaths[s])) classD[c] = (classD[c] ?? 0) + v
      }
      for (const c of [...ca, ...cb]) classN[c] = (classN[c] ?? 0) + 1
    }
  }
  const totalSt = Object.values(agg.stances).reduce((a, b) => a + b, 0)
  out()
  out(`- 平均ターン: ${(agg.turns / agg.n).toFixed(1)} / 上限 ${rules.turnLimit}`)
  out(`- 全滅決着率: ${pct(annihil / agg.n)}`)
  out(`- 引き分け率: ${MODES.map((m) => `${m} ${pct(agg.draw[m] / agg.n)}`).join(', ')}`)
  out(`- 行動選択率(side0): ${Object.entries(agg.stances).map(([k, v]) => `${k} ${pct(v / totalSt)}`).join(', ')}`)
  out(`- 攻撃命中率(side0): ${pct(agg.hits / Math.max(1, agg.attacks))}`)
  out()
  out('| クラス | 出撃数 | 撃破/出撃 | 被撃破率 |')
  out('|---|---|---|---|')
  for (const c of classIds) {
    out(`| ${rules.classes[c].name} | ${classN[c] ?? 0} | ${((classK[c] ?? 0) / (classN[c] || 1)).toFixed(2)} | ${pct((classD[c] ?? 0) / (classN[c] || 1))} |`)
  }
  json.overall = { agg, annihil, classK, classD, classN }
}
out()

// 5. 編成総当たり
if (!flag('quick')) {
  out(`## 5. 編成総当たり（CPU同士, ${comps.length}編成, 撃破コスト基準）`)
  const per = Math.max(2, Math.round(GAMES / 100))
  const score: Record<string, { w: number; d: number; n: number }> = {}
  for (const map of maps) {
    comps.forEach((ca, ia) =>
      comps.forEach((cb, ib) => {
        if (ia === ib) return
        const a = series(map, rules, 'cpu', ca, 'cpu', cb, per, SEED + ia * 1000 + ib)
        const l = compLabel(rules, ca)
        score[l] ??= { w: 0, d: 0, n: 0 }
        score[l].w += a.win.killCost
        score[l].d += a.draw.killCost
        score[l].n += a.n
      }),
    )
  }
  const ranked = Object.entries(score).sort((a, b) => (b[1].w + b[1].d / 2) / b[1].n - (a[1].w + a[1].d / 2) / a[1].n)
  const rate = (s: { w: number; d: number; n: number }) => (s.w + s.d / 2) / s.n
  out(`（各組 ${per}戦 × マップ数, 勝ち点=勝+分/2）`)
  out()
  out('| 順位 | 編成 | 勝ち点率 |')
  out('|---|---|---|')
  ranked.forEach(([l, s], i) => {
    if (i < 8 || i >= ranked.length - 5) out(`| ${i + 1} | ${l} | ${pct(rate(s))} |`)
    else if (i === 8) out('| … | | |')
  })
  const rates = ranked.map(([, s]) => rate(s))
  const mean = rates.reduce((a, b) => a + b, 0) / rates.length
  const sd = Math.sqrt(rates.reduce((a, b) => a + (b - mean) ** 2, 0) / rates.length)
  out()
  out(`- 勝ち点率の標準偏差: ${pct(sd)}（小さいほど編成間の格差が小さい）`)
  json.matrix = Object.fromEntries(ranked.map(([l, s]) => [l, rate(s)]))
  out()
}

out(`_所要 ${((Date.now() - t0) / 1000).toFixed(1)}s_`)
mkdirSync('sim/results', { recursive: true })
writeFileSync(`sim/results/${name}.md`, md.join('\n') + '\n')
writeFileSync(`sim/results/${name}.json`, JSON.stringify(json, null, 2))
console.log(`\n→ sim/results/${name}.md`)
