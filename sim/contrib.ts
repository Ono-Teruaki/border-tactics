// 支援役の貢献の分析。勝ち点率だけでは見えない「交戦への寄与」を測る
//   node sim/contrib.ts [--opp 24] [--out contrib]
//
// A. 4体目の入れ替え: 同じ3体に、4体目として何を足すと一番勝てるか（meta-default.json の勝ち点率から）
// B. 貢献度の内訳: 試合中の行動を「HP換算」で集計する（与ダメージ・索敵で撃たせたダメージ・マークの上乗せ・回復・肩代わりで守ったHP）
// C. スキルを止めた比較: 同じ編成・同じ相手・同じ乱数で、支援役のスキルだけを止めて、交戦の結果がどれだけ変わるか
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { AI_PRESETS, decideOrders } from '../src/engine/ai.ts'
import { baseDamage } from '../src/engine/combat.ts'
import { canSee, createGame, gameResult, observe, resolveTurn } from '../src/engine/game.ts'
import { CURRENT_MAP_IDS, getMap } from '../src/engine/maps.ts'
import { createRng } from '../src/engine/rng.ts'
import { DEFAULT_RULES, mergeRules, type RulesOverride } from '../src/engine/rules.ts'
import type { MapDef, RulesConfig, Side } from '../src/engine/types.ts'
import { allComps } from './lib.ts'

const args = process.argv.slice(2)
const arg = (n: string, d: string) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d)
const OPP = Number(arg('opp', '24'))
const OUT = arg('out', 'contrib')
const rules = DEFAULT_RULES
const classIds = Object.keys(rules.classes)
const comps = allComps(classIds, rules.teamSize).filter((c) => classIds.every((k) => c.filter((x) => x === k).length <= rules.skills.maxPerClass))
const maps = CURRENT_MAP_IDS.map(getMap)
const name = (cls: string) => rules.classes[cls].name
const pct = (x: number) => `${(x * 100).toFixed(1)}%`
const f1 = (x: number) => x.toFixed(1)
const md: string[] = []
const out = (s = '') => (md.push(s), console.log(s))

// ---------------------------------------------------------------- A. 4体目の入れ替え
out('# 支援役の貢献')
out()
out('## A. 4体目の入れ替え（同じ3体に何を足すと勝てるか）')
out('上限ルール内の全編成の勝ち点率（`meta-default.json`）から、3体が同じで4体目だけ違う編成を比べる。')
out('「平均差」は、その3体に足せる全クラスの平均と比べて何ポイント上か。「1位の回数」は、その3体に足すクラスの中で一番勝てた回数。')
out()
{
  const meta = JSON.parse(readFileSync('sim/results/meta-default.json', 'utf8')) as { legal: { comp: string; score: number }[] }
  const score = new Map(meta.legal.map((r) => [r.comp, r.score]))
  const shorts = classIds.map((c) => rules.classes[c].short)
  const sortLabel = (s: string) => [...s].sort((a, b) => shorts.indexOf(a) - shorts.indexOf(b)).join('')
  const cores = new Set(meta.legal.flatMap((r) => [...r.comp].map((_, i) => r.comp.slice(0, i) + r.comp.slice(i + 1))))
  const stat = new Map(shorts.map((s) => [s, { diff: 0, n: 0, best: 0 }]))
  for (const core of cores) {
    const opts = shorts.map((s) => ({ s, v: score.get(sortLabel(core + s)) })).filter((o): o is { s: string; v: number } => o.v !== undefined)
    if (opts.length < 2) continue
    const mean = opts.reduce((a, o) => a + o.v, 0) / opts.length
    const top = opts.reduce((a, o) => (o.v > a.v ? o : a))
    for (const o of opts) {
      const st = stat.get(o.s)!
      st.diff += o.v - mean
      st.n++
      if (o === top) st.best++
    }
  }
  out('| 4体目 | 平均差 | 1位の回数 / 比べた3体の数 |')
  out('|---|---|---|')
  for (const c of classIds) {
    const st = stat.get(rules.classes[c].short)!
    out(`| ${name(c)} | ${st.diff >= 0 ? '+' : ''}${((st.diff / st.n) * 100).toFixed(1)}pt | ${st.best} / ${st.n} |`)
  }
  out()
}

// ---------------------------------------------------------------- B / C. 試合を回して貢献を数える
interface Contrib {
  games: number
  /** 自分の攻撃で実際に削ったHP（撃破時のオーバーキルは除く） */
  dealt: number
  /** 味方が自分の索敵（視界・マーク）のおかげで撃てたダメージ */
  spotted: number
  /** マークの命中+10%で増えたダメージの期待値 */
  markBonus: number
  healed: number
  /** 肩代わりで守ったHP（元の対象が受けるはずだった期待ダメージ − 自分が受けたダメージ） */
  guarded: number
  taken: number
  survived: number
}
const zero = (): Contrib => ({ games: 0, dealt: 0, spotted: 0, markBonus: 0, healed: 0, guarded: 0, taken: 0, survived: 0 })

interface SideResult {
  /** 勝ち=1 / 分け=0.5 / 負け=0（撃破コスト判定） */
  point: number
  /** 削ったHP − 削られたHP */
  hpSwing: number
  killCostDiff: number
}

function play(map: MapDef, r: RulesConfig, cs: [string[], string[]], seed: number, perClass?: Map<string, Contrib>) {
  const g = createGame(map, r, cs)
  const rng = createRng(seed)
  const hp = new Map(g.units.map((u) => [u.id, u.hp]))
  const byId = new Map(g.units.map((u) => [u.id, u]))
  const per = new Map(g.units.map((u) => [u.id, zero()]))
  const marker = new Map<string, { by: string; until: number }>()
  const sideDealt: [number, number] = [0, 0]
  while (!g.over) {
    const T = g.turn
    const aliveAtStart = new Set(g.units.filter((u) => u.alive).map((u) => u.id))
    const orders = ([0, 1] as Side[]).map((s) => decideOrders(observe(g, s), rng, AI_PRESETS.cpu)) as [any, any]
    const events = resolveTurn(g, orders, rng)
    for (const e of events) {
      if (e.type === 'mark') for (const t of e.targets) marker.set(t, { by: e.unitId, until: T + r.skills.markDuration })
      if (e.type === 'heal') {
        for (const t of e.targets) {
          hp.set(t.id, hp.get(t.id)! + t.amount)
          per.get(e.unitId)!.healed += t.amount
        }
      }
      if (e.type !== 'attack') continue
      const shooter = byId.get(e.unitId)!
      const target = byId.get(e.hitId)!
      const sc = r.classes[shooter.cls]
      let eff = 0
      for (const s of e.shots) {
        if (!s.hit) continue
        const victim = s.guardedBy ?? e.hitId
        const d = Math.min(s.damage, Math.max(0, hp.get(victim)!))
        hp.set(victim, hp.get(victim)! - d)
        per.get(victim)!.taken += d
        eff += d
        if (s.guardedBy) per.get(s.guardedBy)!.guarded += Math.max(1, baseDamage(sc.atk, r.classes[target.cls].def)) - d
      }
      per.get(e.unitId)!.dealt += eff
      sideDealt[shooter.side] += eff
      const mk = marker.get(e.hitId)
      const marked = !!mk && mk.until >= T
      if (marked && e.chance > 0) per.get(mk.by)!.markBonus += (eff * r.skills.markAccBonus) / e.chance
      if (e.spotted) {
        // 撃った本人には見えていない。見えていた味方（いなければマークした味方）の手柄
        const seers = g.units.filter((a) => a.side === shooter.side && a.id !== shooter.id && aliveAtStart.has(a.id) && canSee(map, r, a.cls, a.pos, target.pos))
        const credit = seers.length ? seers.map((a) => a.id) : marked ? [mk.by] : []
        for (const id of credit) per.get(id)!.spotted += eff / credit.length
      }
    }
  }
  const res = gameResult(g)
  const sides = ([0, 1] as Side[]).map((s): SideResult => {
    const w = res.winner.killCost
    return { point: w === s ? 1 : w === null ? 0.5 : 0, hpSwing: sideDealt[s] - sideDealt[1 - s], killCostDiff: res.killCost[s] - res.killCost[1 - s] }
  })
  if (perClass) {
    for (const u of g.units) {
      const c = per.get(u.id)!
      c.games = 1
      c.survived = u.alive ? 1 : 0
      const acc = perClass.get(u.cls)!
      for (const k of Object.keys(c) as (keyof Contrib)[]) acc[k] += c[k]
    }
  }
  return sides
}

// 対戦表: 各編成に OPP 個の相手を割り当て、3マップで1戦ずつ（左下＝調べる編成）
const pick = createRng(11)
const schedule = comps.flatMap((_, i) =>
  Array.from({ length: OPP }, (_, k) => {
    let j = Math.floor(pick.next() * comps.length)
    if (j === i) j = (j + 1) % comps.length
    return maps.map((m, mi) => ({ i, j, map: m, seed: 1000 + i * 7919 + k * 131 + mi * 17 }))
  }).flat(),
)

const t0 = Date.now()
const perClass = new Map(classIds.map((c) => [c, zero()]))
const base = schedule.map((s) => play(s.map, rules, [comps[s.i], comps[s.j]], s.seed, perClass)[0])
console.error(`B: ${schedule.length}戦 ${((Date.now() - t0) / 1000).toFixed(0)}s`)

out('## B. 貢献度の内訳（1体・1試合あたりのHP換算）')
out(`各編成に相手を${OPP}個ずつ割り当て、3マップで1戦ずつ（${schedule.length}戦）。両軍の全ユニットを集計。`)
out('- 与ダメ: 自分の攻撃で削ったHP（オーバーキルは除く）')
out('- 索敵: 撃った本人には見えていない敵を、自分の視界（いなければマーク）のおかげで味方が撃てたダメージ')
out('- マーク上乗せ: マークの命中+10%で増えたダメージの期待値')
out('- 守ったHP: 肩代わりで、元の対象が受けるはずだった期待ダメージ − 自分が受けたダメージ')
out('- 合計: 与ダメ＋索敵＋マーク上乗せ＋回復＋守ったHP。味方のHPと敵のHPの差をどれだけ動かしたか')
out()
out('| クラス | 与ダメ | 索敵 | マーク上乗せ | 回復 | 守ったHP | **合計** | 被ダメ | 生存率 |')
out('|---|---|---|---|---|---|---|---|---|')
for (const c of classIds) {
  const a = perClass.get(c)!
  const n = Math.max(1, a.games)
  const total = (a.dealt + a.spotted + a.markBonus + a.healed + a.guarded) / n
  out(`| ${name(c)} | ${f1(a.dealt / n)} | ${f1(a.spotted / n)} | ${f1(a.markBonus / n)} | ${f1(a.healed / n)} | ${f1(a.guarded / n)} | **${f1(total)}** | ${f1(a.taken / n)} | ${pct(a.survived / n)} |`)
}
out()

const ABLATE: { cls: string; label: string; override: RulesOverride }[] = [
  { cls: 'medic', label: '回復を止める', override: { classes: { medic: { healRange: 0 } } } },
  { cls: 'guardian', label: '肩代わりを止める', override: { skills: { guardHitsPerTurn: 0 } } },
  { cls: 'scout', label: 'マークと透視を止める', override: { skills: { markPerTurn: 0 }, classes: { scout: { sonar: 0 } } } },
]
out('## C. スキルを止めた比較（同じ編成・同じ相手・同じ乱数）')
out('その支援役を1体以上入れた編成だけで比べる。CPUの動き方（支援役として振る舞う）は変えず、効果だけを止める。')
out('- 交戦差: 1試合で削ったHP − 削られたHP（味方側から見て）')
out()
out('| 支援役 | 止めたもの | 対象の試合 | 勝ち点率 あり → なし | 交戦差 あり → なし | 撃破コスト差 あり → なし |')
out('|---|---|---|---|---|---|')
for (const ab of ABLATE) {
  const r = mergeRules(rules, ab.override)
  const idx = schedule.map((s, k) => ({ s, k })).filter(({ s }) => comps[s.i].includes(ab.cls))
  const off = idx.map(({ s }) => play(s.map, r, [comps[s.i], comps[s.j]], s.seed)[0])
  const on = idx.map(({ k }) => base[k])
  const avg = (xs: SideResult[], key: keyof SideResult) => xs.reduce((a, x) => a + x[key], 0) / xs.length
  out(
    `| ${name(ab.cls)} | ${ab.label} | ${idx.length} | ${pct(avg(on, 'point'))} → ${pct(avg(off, 'point'))} | ${f1(avg(on, 'hpSwing'))} → ${f1(avg(off, 'hpSwing'))} | ${f1(avg(on, 'killCostDiff'))} → ${f1(avg(off, 'killCostDiff'))} |`,
  )
}
out()
out(`_所要 ${((Date.now() - t0) / 1000).toFixed(0)}s_`)

mkdirSync('sim/results', { recursive: true })
writeFileSync(`sim/results/${OUT}.md`, md.join('\n') + '\n')
console.log(`\n→ sim/results/${OUT}.md`)
