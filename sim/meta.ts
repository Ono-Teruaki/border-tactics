// 編成メタの網羅シミュレーション（全編成 × 全編成 × マップ、先後入れ替え）
//   node sim/meta.ts [--variant sim/variants/x.json] [--maps block9,alley11] [--out name]
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'
import { availableParallelism } from 'node:os'
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads'
import { AI_PRESETS, type AiParams } from '../src/engine/ai.ts'
import { CURRENT_MAP_IDS, MAPS } from '../src/engine/maps.ts'
import { DEFAULT_RULES, mergeRules, type RulesOverride } from '../src/engine/rules.ts'
import type { RulesConfig } from '../src/engine/types.ts'
import { allComps, compLabel, playMatch } from './lib.ts'

type Variant = RulesOverride & { maps?: string[]; ai?: Record<string, Partial<AiParams>> }

function setup(variant: Variant) {
  const { maps: _m, ai, ...override } = variant
  for (const [k, v] of Object.entries(ai ?? {})) Object.assign(AI_PRESETS[k], v)
  return mergeRules(DEFAULT_RULES, override)
}

/** [i][j] = 編成 i が j と戦った結果（i 視点）: 勝・分・負・ターン合計 */
type Cell = [number, number, number, number]

if (!isMainThread) {
  const { variant, mapIds, rows, seed, reps } = workerData as { variant: Variant; mapIds: string[]; rows: number[]; seed: number; reps: number }
  const rules = setup(variant)
  const comps = allComps(Object.keys(rules.classes), rules.teamSize)
  const out: Record<number, Cell[]> = {}
  for (const i of rows) {
    out[i] = comps.map(() => [0, 0, 0, 0] as Cell)
    for (let j = 0; j < comps.length; j++) {
      if (i === j) continue
      for (const [mi, mapId] of mapIds.entries()) for (let rep = 0; rep < reps; rep++) {
        const map = MAPS.find((m) => m.id === mapId)!
        // i を下側(side0)に固定。j 行で上側の対戦が回るので先後は対称になる
        const r = playMatch(map, rules, [comps[i], comps[j]], [AI_PRESETS.cpu, AI_PRESETS.cpu], seed + i * 100003 + j * 101 + mi * 7 + rep * 1000003)
        const w = r.winner.killCost
        const c = out[i][j]
        if (w === 0) c[0]++
        else if (w === null) c[1]++
        else c[2]++
        c[3] += r.turns
      }
    }
    parentPort!.postMessage({ progress: 1 })
  }
  parentPort!.postMessage({ done: out })
} else {
  const args = process.argv.slice(2)
  const arg = (n: string, d?: string) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d)
  const variantPath = arg('variant')
  const variant: Variant = variantPath ? JSON.parse(readFileSync(variantPath, 'utf8')) : {}
  const mapIds = (arg('maps') ?? variant.maps?.join(',') ?? CURRENT_MAP_IDS.join(',')).split(',')
  const reps = Number(arg('reps', '2'))
  const name = arg('out', `meta-${variantPath ? basename(variantPath, '.json') : 'default'}`)!
  const rules: RulesConfig = setup(variant)
  const classIds = Object.keys(rules.classes)
  const comps = allComps(classIds, rules.teamSize)
  const n = comps.length
  const t0 = Date.now()

  const threads = Math.max(1, availableParallelism() - 1)
  const result: Cell[][] = Array.from({ length: n }, () => [])
  let doneRows = 0
  await Promise.all(
    Array.from({ length: threads }, (_, w) => {
      const rows = Array.from({ length: n }, (_, i) => i).filter((i) => i % threads === w)
      return new Promise<void>((resolve, reject) => {
        const worker = new Worker(new URL(import.meta.url), { workerData: { variant, mapIds, rows, seed: 7, reps } })
        worker.on('message', (m) => {
          if (m.progress) {
            doneRows++
            if (doneRows % 10 === 0) process.stderr.write(`  ${doneRows}/${n}\n`)
          }
          if (m.done) {
            for (const [i, row] of Object.entries(m.done as Record<string, Cell[]>)) result[Number(i)] = row
            resolve()
          }
        })
        worker.on('error', reject)
      })
    }),
  )

  // i 視点の合計（i が下側の試合 + j 行で i が上側の試合）
  const vs = (i: number, j: number): Cell => {
    const a = result[i][j]
    const b = result[j][i]
    return [a[0] + b[2], a[1] + b[1], a[2] + b[0], a[3] + b[3]]
  }
  const score = (c: Cell) => (c[0] + c[1] / 2) / Math.max(1, c[0] + c[1] + c[2])
  const L = (i: number) => compLabel(rules, comps[i])
  const count = (i: number, cls: string) => comps[i].filter((c) => c === cls).length
  const legal = (i: number) => classIds.every((c) => count(i, c) <= rules.skills.maxPerClass)

  const agg = (i: number, pool: number[]): Cell => {
    const s: Cell = [0, 0, 0, 0]
    for (const j of pool) {
      if (j === i) continue
      const c = vs(i, j)
      for (let k = 0; k < 4; k++) s[k] += c[k]
    }
    return s
  }
  const all = Array.from({ length: n }, (_, i) => i)
  const legalPool = all.filter(legal)
  const rankAll = all.map((i) => ({ i, c: agg(i, all) })).sort((a, b) => score(b.c) - score(a.c))
  const rankLegal = legalPool.map((i) => ({ i, c: agg(i, legalPool) })).sort((a, b) => score(b.c) - score(a.c))

  const pct = (x: number) => `${(x * 100).toFixed(1)}%`
  const md: string[] = []
  const out = (s = '') => md.push(s)
  const legend = classIds.map((c) => `${rules.classes[c].short}=${rules.classes[c].name}`).join(' / ')
  out(`# 編成メタ: ${name}`)
  out()
  out(`- ${n}編成の総当たり（先後入れ替え）× マップ ${mapIds.join(', ')}、CPU同士、撃破コストで勝敗判定`)
  out(`- 1編成あたり ${(n - 1) * 2 * mapIds.length * reps} 戦、合計 ${n * (n - 1) * mapIds.length * reps} 戦`)
  out(`- ${legend}`)
  if (variantPath) out(`- 差分: \`${JSON.stringify(variant)}\``)
  out()

  const table = (rows: { i: number; c: Cell }[], top: number, bottom: number) => {
    out('| 順位 | 編成 | 勝ち点率 | 勝 | 分 | 負 | 平均ターン |')
    out('|---|---|---|---|---|---|---|')
    rows.forEach((r, k) => {
      if (k < top || k >= rows.length - bottom) {
        const g = r.c[0] + r.c[1] + r.c[2]
        out(`| ${k + 1} | ${L(r.i)} | ${pct(score(r.c))} | ${r.c[0]} | ${r.c[1]} | ${r.c[2]} | ${(r.c[3] / g).toFixed(1)} |`)
      } else if (k === top) out('| … | | | | | | |')
    })
    out()
  }
  out(`## 1. 上限${rules.skills.maxPerClass}体ルールでの順位（${legalPool.length}編成同士）`)
  table(rankLegal, 20, 8)
  out('## 2. 制限なしの順位（参考）')
  table(rankAll, 10, 5)

  out('## 3. クラスの枚数と強さ（上限ルール内の平均勝ち点率）')
  out(`| クラス | ${[0, 1, 2].map((k) => `${k}体`).join(' | ')} | 上位20編成での採用数 |`)
  out('|---|---|---|---|---|')
  const top20 = rankLegal.slice(0, 20).map((r) => r.i)
  for (const c of classIds) {
    const cells = [0, 1, 2].map((k) => {
      const xs = rankLegal.filter((r) => count(r.i, c) === k)
      return xs.length ? pct(xs.reduce((a, r) => a + score(r.c), 0) / xs.length) : '-'
    })
    out(`| ${rules.classes[c].name} | ${cells.join(' | ')} | ${top20.reduce((a, i) => a + count(i, c), 0)} |`)
  }
  out()

  out('## 4. 組み合わせの相性（両方を含む編成の平均勝ち点率、上限ルール内）')
  const avgWhere = (f: (i: number) => boolean) => {
    const xs = rankLegal.filter((r) => f(r.i))
    return xs.length ? xs.reduce((a, r) => a + score(r.c), 0) / xs.length : NaN
  }
  out(`| | ${classIds.map((c) => rules.classes[c].short).join(' | ')} |`)
  out(`|---|${classIds.map(() => '---').join('|')}|`)
  for (const a of classIds) {
    out(`| ${rules.classes[a].short} | ${classIds.map((b) => {
      const v = avgWhere((i) => (a === b ? count(i, a) >= 2 : count(i, a) >= 1 && count(i, b) >= 1))
      return Number.isNaN(v) ? '-' : pct(v)
    }).join(' | ')} |`)
  }
  out()

  if (rules.classes.guardian && rules.classes.medic) {
    out('## 5. 仮説チェック: 防護兵＋衛生兵＋（ガンナー or アタッカー）の固め')
    const hyp = rankLegal.map((r, k) => ({ ...r, k })).filter((r) => count(r.i, 'guardian') >= 1 && count(r.i, 'medic') >= 1 && (count(r.i, 'gunner') >= 1 || count(r.i, 'attacker') >= 1))
    out(`- 該当 ${hyp.length} 編成 / 平均勝ち点率 ${pct(hyp.reduce((a, r) => a + score(r.c), 0) / Math.max(1, hyp.length))}（全体平均 50%）`)
    out(`- 順位: ${hyp.slice(0, 12).map((r) => `${L(r.i)} ${r.k + 1}位`).join(', ')}`)
    out()
  }

  out('## 6. 上位編成の天敵（上限ルール内で、その編成が最も負け越す相手）')
  out('| 編成 | 苦手な相手（勝ち点率） |')
  out('|---|---|')
  for (const r of rankLegal.slice(0, 8)) {
    const worst = legalPool
      .filter((j) => j !== r.i)
      .map((j) => ({ j, s: score(vs(r.i, j)) }))
      .sort((a, b) => a.s - b.s)
      .slice(0, 3)
    out(`| ${L(r.i)} | ${worst.map((w) => `${L(w.j)} ${pct(w.s)}`).join(', ')} |`)
  }
  out()
  const sd = Math.sqrt(rankLegal.reduce((a, r) => a + (score(r.c) - 0.5) ** 2, 0) / rankLegal.length)
  out(`- 勝ち点率の標準偏差（上限ルール内）: ${pct(sd)}`)
  out(`- 1位の勝ち点率: ${pct(score(rankLegal[0].c))}（70%を超えると一強気味）`)
  out()
  out(`_所要 ${((Date.now() - t0) / 1000).toFixed(0)}s, ${threads} threads_`)

  mkdirSync('sim/results', { recursive: true })
  writeFileSync(`sim/results/${name}.md`, md.join('\n') + '\n')
  writeFileSync(
    `sim/results/${name}.json`,
    JSON.stringify({ variant, mapIds, legal: rankLegal.map((r) => ({ comp: L(r.i), score: score(r.c), w: r.c[0], d: r.c[1], l: r.c[2] })) }, null, 2),
  )
  console.log(md.join('\n'))
  console.log(`\n→ sim/results/${name}.md`)
}
