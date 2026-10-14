// CPU の重みの自動調整（交差エントロピー法）
//   node sim/tune.ts [--gens 25] [--pop 16] [--games 48] [--variant sim/variants/x.json] [--out tuned-ai]
//   対抗戦術の探索: --comp DAMJ --vs GSRD --opp-ai sim/variants/ai-tuned-v0101.json
//     その編成で、決めた相手（編成と CPU を固定）に一番勝てる重みを探す
//
// 1世代ごとに、今の平均のまわりから重みの候補を pop 個つくり、
// 「同じ編成どうし」（編成の差を消す）で標準 CPU と今の平均の両方と games 戦ずつ戦わせる。
// 勝ち点率の上位 1/4 から平均と広がりを更新する。同じ世代の候補は同じ編成・マップ・乱数で戦う（比較のぶれを減らす）。
// 最後に、できた重みを標準 CPU と大量に戦わせて確かめる。結果は sim/results/<out>.md と .json
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { basename } from 'node:path'
import { availableParallelism } from 'node:os'
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads'
import { AI_PRESETS, type AiParams } from '../src/engine/ai.ts'
import { CURRENT_MAP_IDS, getMap } from '../src/engine/maps.ts'
import { createRng } from '../src/engine/rng.ts'
import { DEFAULT_RULES, mergeRules, type RulesOverride } from '../src/engine/rules.ts'
import { allComps, playMatch } from './lib.ts'

type Variant = RulesOverride & { maps?: string[]; ai?: Record<string, Partial<AiParams>> }

/** 調整する重みと、その範囲 */
const KNOBS: { key: keyof AiParams; label: string; lo: number; hi: number; def: number }[] = [
  { key: 'aggression', label: '攻める', lo: 0.2, hi: 3, def: 1 },
  { key: 'caution', label: '慎重さ', lo: 0, hi: 5, def: 1 },
  { key: 'scouting', label: '索敵', lo: 0, hi: 2, def: 0.6 },
  { key: 'roofPref', label: '屋上', lo: 0, hi: 2, def: 0.6 },
  { key: 'rush', label: '射手への詰め寄り', lo: 0, hi: 2, def: 0 },
  { key: 'evade', label: '射手が近接を避ける', lo: 0, hi: 2, def: 0 },
  { key: 'fireWeight', label: '撃つ価値（対 支援）', lo: 0.3, hi: 3, def: 1.5 },
  { key: 'cohesion', label: '支援役が味方に寄る', lo: 0, hi: 1.5, def: 0.4 },
  { key: 'focus', label: '集中砲火', lo: 0, hi: 1.5, def: 0 },
  { key: 'jam', label: '屋上に登って妨害', lo: 0, hi: 3, def: 1 },
  { key: 'blob', label: '団塊（全員が味方の隣に）', lo: 0, hi: 2, def: 0 },
  { key: 'killWeight', label: '倒し切り（倒せる確率 × コスト）', lo: 0, hi: 6, def: 0 },
  { key: 'spread', label: '爆風を避けて散る', lo: 0, hi: 3, def: 1 },
  { key: 'radar', label: 'レーダー塔を取りに行く', lo: 0, hi: 3, def: 1 },
]

interface Job {
  a: Partial<AiParams>
  b: Partial<AiParams>
  comp: string[]
  /** 相手の編成（省略時は comp と同じ） */
  vsComp?: string[]
  map: string
  seed: number
  /** a が side0 なら 0 */
  side: 0 | 1
}

const toParams = (x: Partial<AiParams>): AiParams => ({ ...AI_PRESETS.cpu, name: 'tuned', ...x })

if (!isMainThread) {
  const { jobs, variant } = workerData as { jobs: Job[]; variant: Variant }
  const { maps: _m, ai: _a, ...override } = variant
  const rules = mergeRules(DEFAULT_RULES, override)
  const out = jobs.map((j) => {
    const ais = (j.side === 0 ? [toParams(j.a), toParams(j.b)] : [toParams(j.b), toParams(j.a)]) as [AiParams, AiParams]
    const vs = j.vsComp ?? j.comp
    const r = playMatch(getMap(j.map), rules, j.side === 0 ? [j.comp, vs] : [vs, j.comp], ais, j.seed)
    const w = r.winner.killCost
    return w === j.side ? 1 : w === null ? 0.5 : 0
  })
  parentPort!.postMessage(out)
} else {
  const args = process.argv.slice(2)
  const arg = (n: string, d: string) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d)
  const GENS = Number(arg('gens', '25'))
  const POP = Number(arg('pop', '16'))
  const GAMES = Number(arg('games', '48'))
  const variantPath = arg('variant', '')
  const variant: Variant = variantPath ? JSON.parse(readFileSync(variantPath, 'utf8')) : {}
  const CODE: Record<string, string> = { A: 'attacker', G: 'gunner', S: 'sniper', R: 'scout', M: 'medic', J: 'jammer', D: 'guardian' }
  const decode = (s: string) => s.split('').map((x) => CODE[x])
  const COMP = arg('comp', '')
  const VS = arg('vs', '')
  const oppAiPath = arg('opp-ai', '')
  const fixedOpp: Partial<AiParams> | null = oppAiPath ? JSON.parse(readFileSync(oppAiPath, 'utf8')).ai.cpu : COMP ? {} : null
  const OUT = arg('out', COMP ? `counter-${COMP}-vs-${VS}` : variantPath ? `tuned-ai-${basename(variantPath, '.json')}` : 'tuned-ai')
  const rules = mergeRules(DEFAULT_RULES, (({ maps: _m, ai: _a, ...o }) => o)(variant))
  const ids = Object.keys(rules.classes)
  const legal = allComps(ids, rules.teamSize).filter((c) => ids.every((k) => c.filter((x) => x === k).length <= rules.skills.maxPerClass))
  const maps = variant.maps ?? CURRENT_MAP_IDS
  const threads = Math.max(1, availableParallelism() - 1)

  const run = (jobs: Job[]): Promise<number[]> =>
    Promise.all(
      Array.from({ length: threads }, (_, w) => {
        const mine = jobs.filter((_, i) => i % threads === w)
        return new Promise<number[]>((res, rej) => {
          const wk = new Worker(new URL(import.meta.url), { workerData: { jobs: mine, variant } })
          wk.on('message', res)
          wk.on('error', rej)
        })
      }),
    ).then((parts) => {
      const out: number[] = new Array(jobs.length)
      parts.forEach((p, w) => p.forEach((v, k) => (out[k * threads + w] = v)))
      return out
    })

  /** 対戦の組（同じ世代の候補は全員同じ組で戦う） */
  const matchups = (rng: ReturnType<typeof createRng>, n: number) =>
    Array.from({ length: n }, (_, k) => ({
      comp: COMP ? decode(COMP) : legal[Math.floor(rng.next() * legal.length)],
      ...(VS ? { vsComp: decode(VS) } : {}),
      map: maps[k % maps.length],
      seed: Math.floor(rng.next() * 1e9),
      side: (k % 2) as 0 | 1,
    }))

  const clip = (k: (typeof KNOBS)[number], v: number) => Math.max(k.lo, Math.min(k.hi, v))
  // 対抗戦術の探索は、相手と同じ CPU の重みから始める
  let mean = KNOBS.map((k) => clip(k, ((fixedOpp ?? {}) as Record<string, number>)[k.key] ?? k.def))
  let sd = KNOBS.map((k) => (k.hi - k.lo) * 0.25)
  const rng = createRng(2024)
  const gauss = () => Math.sqrt(-2 * Math.log(1 - rng.next())) * Math.cos(2 * Math.PI * rng.next())
  const vec = (x: number[]) => Object.fromEntries(KNOBS.map((k, i) => [k.key, Number(x[i].toFixed(3))])) as Partial<AiParams>
  const base: Partial<AiParams> = {}
  const history: { gen: number; vsBase: number; vsMean: number; mean: number[] }[] = []
  const t0 = Date.now()

  for (let gen = 0; gen < GENS; gen++) {
    const cands = [mean, ...Array.from({ length: POP - 1 }, () => KNOBS.map((k, i) => clip(k, mean[i] + sd[i] * gauss())))]
    const mus = matchups(rng, GAMES)
    const opps = fixedOpp ? [fixedOpp, fixedOpp] : [base, vec(mean)]
    const jobs: Job[] = []
    for (const c of cands) for (const o of opps) for (const m of mus) jobs.push({ a: vec(c), b: o, ...m })
    const pts = await run(jobs)
    const per = cands.map((_, ci) => {
      const s = pts.slice(ci * opps.length * GAMES, (ci + 1) * opps.length * GAMES)
      const vsBase = s.slice(0, GAMES).reduce((a, b) => a + b, 0) / GAMES
      const vsMean = s.slice(GAMES).reduce((a, b) => a + b, 0) / GAMES
      return { ci, vsBase, vsMean, fit: (vsBase + vsMean) / 2 }
    })
    per.sort((a, b) => b.fit - a.fit)
    const elite = per.slice(0, Math.max(2, Math.floor(POP / 4))).map((p) => cands[p.ci])
    const meanRow = per.find((p) => p.ci === 0)!
    history.push({ gen, vsBase: meanRow.vsBase, vsMean: meanRow.vsMean, mean: [...mean] })
    // 平均と広がりを上位から更新（広がりは急に縮みすぎないよう混ぜる）
    mean = KNOBS.map((k, i) => clip(k, elite.reduce((a, e) => a + e[i], 0) / elite.length))
    sd = KNOBS.map((k, i) => {
      const v = Math.sqrt(elite.reduce((a, e) => a + (e[i] - mean[i]) ** 2, 0) / elite.length)
      return Math.max((k.hi - k.lo) * 0.03, 0.6 * v + 0.4 * sd[i])
    })
    console.error(`gen ${gen + 1}/${GENS}: 平均の重みが標準CPUに ${(meanRow.vsBase * 100).toFixed(0)}%  上位 ${(per[0].fit * 100).toFixed(0)}%  ${((Date.now() - t0) / 1000).toFixed(0)}s`)
  }

  // 確かめ: できた重み vs 標準 CPU（同じ編成どうし / ランダムな編成どうし）
  const vrng = createRng(99)
  const VAL = 1200
  const mirror = matchups(vrng, VAL)
  const final = vec(mean)
  const vm = await run(mirror.map((m) => ({ a: final, b: fixedOpp ?? base, ...m })))
  const v0 = fixedOpp ? await run(mirror.map((m) => ({ a: fixedOpp, b: fixedOpp, ...m }))) : []
  const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`

  const md: string[] = []
  const o = (s = '') => (md.push(s), console.log(s))
  o(`# CPU の重みの自動調整: ${OUT}`)
  o()
  o(`- 交差エントロピー法、${GENS}世代 × 候補${POP} × 相手2（標準CPU・今の平均）× ${GAMES}戦。同じ編成どうしで戦わせる`)
  if (variantPath) o(`- ルールの差分: \`${JSON.stringify(variant)}\``)
  o(`- 所要 ${((Date.now() - t0) / 1000).toFixed(0)}s`)
  o()
  o('## できた重み')
  o('| 重み | 標準CPU | 調整後 |')
  o('|---|---|---|')
  KNOBS.forEach((k, i) => o(`| ${k.label}（${k.key}） | ${k.def} | ${mean[i].toFixed(2)} |`))
  o()
  o('## 標準CPUとの対戦（確かめ）')
  o(`| 対戦 | 試合数 | 調整後の勝ち点率 |`)
  o('|---|---|---|')
  if (fixedOpp) {
    o(`| ${COMP} 対 ${VS}、相手と同じCPUで動かした場合（比較） | ${VAL} | ${pct(avg(v0))} |`)
    o(`| ${COMP} 対 ${VS}、探索した重みで動かした場合 | ${VAL} | ${pct(avg(vm))} |`)
  } else o(`| 同じ編成どうし（調整に使っていない対戦） | ${VAL} | ${pct(avg(vm))} |`)
  o()
  o('## 世代ごとの推移（その世代の平均の重みが、標準CPUと今の平均に対して）')
  o('| 世代 | 標準CPUに | 今の平均に |')
  o('|---|---|---|')
  for (const h of history) o(`| ${h.gen + 1} | ${pct(h.vsBase)} | ${pct(h.vsMean)} |`)
  mkdirSync('sim/results', { recursive: true })
  writeFileSync(`sim/results/${OUT}.md`, md.join('\n') + '\n')
  writeFileSync(`sim/results/${OUT}.json`, JSON.stringify({ params: final, validate: { mirror: avg(vm) }, history }, null, 2))
  console.log(`\n→ sim/results/${OUT}.md`)
}
