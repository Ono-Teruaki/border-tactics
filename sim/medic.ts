// 衛生兵の位置取りの分析。回復が少ないのは CPU の動かし方のせいか、ルールのせいかを切り分ける
//   node sim/medic.ts [--opp 24] [--variant sim/variants/x.json] [--out medic]
//
// 衛生兵が生きている手を1つずつ、次のどれに当たるかで分類する（上から順に判定）
// - 撃破された: その手の交戦で衛生兵が撃破され、回復まで行けなかった
// - けが人なし: 回復の時点で、HPが減っている味方がいない
// - 回復した
// - 撃つ手にした: 狙いを指定した（支援ターンではない）ので回復しない
// - 届いたのに外れた: 移動できるマスの中に、けがをした味方（移動後）の隣があったのに、そこへ行かなかった
//   （うち「味方が動いて離れた」: 衛生兵は味方の移動前の位置の隣に行っていた）
// - 届かない: どこへ動いてもけがをした味方の隣に入れなかった
// あわせて「最善の位置なら回復できた量」（移動後の味方の位置が分かっている前提の上限）と、実際の回復量を比べる
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { basename } from 'node:path'
import { AI_PRESETS, decideOrders, type AiParams } from '../src/engine/ai.ts'
import { chebyshev, createGame, gameResult, observe, reachableFor, resolveTurn } from '../src/engine/game.ts'
import { key } from '../src/engine/grid.ts'
import { CURRENT_MAP_IDS, getMap } from '../src/engine/maps.ts'
import { createRng } from '../src/engine/rng.ts'
import { DEFAULT_RULES, mergeRules } from '../src/engine/rules.ts'
import type { MapDef, Pos, Side, Unit } from '../src/engine/types.ts'
import { allComps } from './lib.ts'

const args = process.argv.slice(2)
const arg = (n: string, d: string) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d)
const OPP = Number(arg('opp', '24'))
const VARIANT = arg('variant', '')
const OUT = arg('out', VARIANT ? `medic-${basename(VARIANT, '.json')}` : 'medic')
const rules = VARIANT ? mergeRules(DEFAULT_RULES, JSON.parse(readFileSync(VARIANT, 'utf8'))) : DEFAULT_RULES
const classIds = Object.keys(rules.classes)
const legal = allComps(classIds, rules.teamSize).filter((c) => classIds.every((k) => c.filter((x) => x === k).length <= rules.skills.maxPerClass))
const withMedic = legal.map((c, i) => ({ c, i })).filter(({ c }) => c.includes('medic'))
const maps = CURRENT_MAP_IDS.map(getMap)
const mc = rules.classes.medic
const pct = (x: number) => `${(x * 100).toFixed(1)}%`

const CATS = ['died', 'nobodyHurt', 'healed', 'shot', 'missed', 'unreachable'] as const
type Cat = (typeof CATS)[number]
const CAT_LABEL: Record<Cat, string> = {
  died: '撃破された',
  nobodyHurt: 'けが人なし',
  healed: '回復した',
  shot: '撃つ手にした',
  missed: '届いたのに外れた',
  unreachable: '届かない',
}

interface Stats {
  turns: Record<Cat, number>
  movedAway: number
  healed: number
  potential: number
  potentialBy: Record<Cat, number>
  medicTurns: number
  games: number
  points: number
  medicSurvived: number
  medicUnits: number
}
const zero = (): Stats => ({ turns: Object.fromEntries(CATS.map((c) => [c, 0])) as Record<Cat, number>, movedAway: 0, healed: 0, potential: 0, potentialBy: Object.fromEntries(CATS.map((c) => [c, 0])) as Record<Cat, number>, medicTurns: 0, games: 0, points: 0, medicSurvived: 0, medicUnits: 0 })

/** 移動後の味方の位置が分かっている前提で、pos から回復できる量 */
function healAt(pos: Pos, hurt: { pos: Pos; missing: number }[]) {
  return hurt.filter((h) => chebyshev(h.pos, pos) <= mc.healRange).reduce((a, h) => a + Math.min(mc.heal, h.missing), 0)
}

function play(map: MapDef, ai: AiParams, cs: [string[], string[]], seed: number, st: Stats) {
  const g = createGame(map, rules, cs)
  const rng = createRng(seed)
  while (!g.over) {
    const T = g.turn
    const before = new Map(g.units.map((u) => [u.id, structuredClone(u) as Unit]))
    const orders = ([0, 1] as Side[]).map((s) => decideOrders(observe(g, s), rng, ai)) as [any, any]
    const events = resolveTurn(g, orders, rng)
    const healedBy = new Map<string, Map<string, number>>()
    for (const e of events) if (e.type === 'heal') healedBy.set(e.unitId, new Map(e.targets.map((t) => [t.id, t.amount])))
    const allHealed = new Map<string, number>()
    for (const m of healedBy.values()) for (const [id, a] of m) allHealed.set(id, (allHealed.get(id) ?? 0) + a)
    for (const m0 of before.values()) {
      if (m0.side !== 0 || m0.cls !== 'medic' || !m0.alive) continue
      st.medicTurns++
      const m = g.units.find((u) => u.id === m0.id)!
      const order = orders[0].find((o: { unitId: string }) => o.unitId === m.id)
      // 回復の時点のけが人（移動後の位置、回復前のHP）
      const hurt = g.units
        .filter((a) => a.side === 0 && a.id !== m.id && a.alive)
        .map((a) => ({ id: a.id, pos: a.pos, start: before.get(a.id)!.pos, missing: rules.classes[a.cls].hp - (a.hp - (allHealed.get(a.id) ?? 0)) }))
        .filter((a) => a.missing > 0)
      const occupied = new Set(g.units.filter((u) => u.id !== m.id && u.alive).map((u) => key(u.pos)))
      const cells = [...reachableFor(map, rules, m0, T).values()].map((r) => r.pos).filter((p) => !occupied.has(key(p)))
      const best = Math.max(0, ...cells.map((p) => healAt(p, hurt)))
      let cat: Cat
      if (!m.alive) cat = 'died'
      else if (!hurt.length) cat = 'nobodyHurt'
      else if (healedBy.has(m.id)) cat = 'healed'
      else if (order?.target) cat = 'shot'
      else if (best > 0) {
        cat = 'missed'
        if (hurt.some((h) => chebyshev(h.start, m.pos) <= mc.healRange)) st.movedAway++
      } else cat = 'unreachable'
      st.turns[cat]++
      if (m.alive) (st.potential += best), (st.potentialBy[cat] += best)
      st.healed += [...(healedBy.get(m.id)?.values() ?? [])].reduce((a, b) => a + b, 0)
    }
  }
  const res = gameResult(g)
  st.games++
  st.points += res.winner.killCost === 0 ? 1 : res.winner.killCost === null ? 0.5 : 0
  for (const u of g.units) if (u.side === 0 && u.cls === 'medic') (st.medicUnits++, (st.medicSurvived += u.alive ? 1 : 0))
}

const pick = createRng(23)
const schedule = withMedic.flatMap(({ c }) =>
  Array.from({ length: OPP }, (_, k) => maps.map((map, mi) => ({ c, opp: legal[Math.floor(pick.next() * legal.length)], map, seed: 5000 + k * 131 + mi * 17 + legal.indexOf(c) * 7919 }))).flat(),
)

const md: string[] = []
const out = (s = '') => (md.push(s), console.log(s))
out('# 衛生兵の位置取り')
out()
out(`衛生兵を入れた上限ルール内の${withMedic.length}編成 × 相手${OPP}個 × 3マップ（${schedule.length}戦）。衛生兵の側を左下に固定し、衛生兵が生きている手を1つずつ分類した。`)
out()
const variants: { label: string; ai: AiParams }[] = [
  { label: '今のCPU', ai: AI_PRESETS.cpu },
  { label: '衛生兵が後で決める', ai: { ...AI_PRESETS.cpu, healerLast: true } },
  { label: '撃たずに支援', ai: { ...AI_PRESETS.cpu, healerNoFire: true } },
  { label: '後で決める＋撃たずに支援', ai: { ...AI_PRESETS.cpu, healerLast: true, healerNoFire: true } },
]
const results = variants.map((v) => {
  const st = zero()
  const t0 = Date.now()
  for (const s of schedule) play(s.map, v.ai, [s.c, s.opp], s.seed, st)
  console.error(`${v.label}: ${((Date.now() - t0) / 1000).toFixed(0)}s`)
  return { ...v, st }
})

out('## 手の分類（衛生兵が生きている手に対する割合）')
out(`| 分類 | ${results.map((r) => r.label).join(' | ')} |`)
out(`|---|${results.map(() => '---').join('|')}|`)
for (const c of CATS) out(`| ${CAT_LABEL[c]} | ${results.map((r) => pct(r.st.turns[c] / r.st.medicTurns)).join(' | ')} |`)
out(`| 　うち「届いたのに外れた」で、味方が動いて離れた | ${results.map((r) => pct(r.st.movedAway / r.st.medicTurns)).join(' | ')} |`)
out()
out('## 回復量と勝ち点率')
out(`| | ${results.map((r) => r.label).join(' | ')} |`)
out(`|---|${results.map(() => '---').join('|')}|`)
out(`| 1体・1試合の回復量 | ${results.map((r) => (r.st.healed / r.st.medicUnits).toFixed(1)).join(' | ')} |`)
out(`| 最善の位置なら回復できた量（上限） | ${results.map((r) => (r.st.potential / r.st.medicUnits).toFixed(1)).join(' | ')} |`)
for (const c of ['shot', 'missed', 'unreachable', 'healed'] as Cat[]) out(`| 　上限のうち「${CAT_LABEL[c]}」の手の分 | ${results.map((r) => (r.st.potentialBy[c] / r.st.medicUnits).toFixed(1)).join(' | ')} |`)
out(`| 上限に対する実際の割合 | ${results.map((r) => pct(r.st.healed / Math.max(1, r.st.potential))).join(' | ')} |`)
out(`| 衛生兵の生存率 | ${results.map((r) => pct(r.st.medicSurvived / r.st.medicUnits)).join(' | ')} |`)
out(`| 衛生兵入り編成の勝ち点率 | ${results.map((r) => pct(r.st.points / r.st.games)).join(' | ')} |`)
out()
mkdirSync('sim/results', { recursive: true })
writeFileSync(`sim/results/${OUT}.md`, md.join('\n') + '\n')
console.log(`\n→ sim/results/${OUT}.md`)
