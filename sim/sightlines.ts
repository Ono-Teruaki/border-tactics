/**
 * マップの射線分析: 各マスから、あるクラスが「撃てるマス」「見えるマス」がいくつあるか。
 * 屋上を取ったときに盤面のどれだけが的になるかを、マップ設計の目安にする。
 *
 *   node sim/sightlines.ts [--cls sniper] [--map city9]
 */
import { attackRange, canSee, canStrike, isMeleeClass } from '../src/engine/game.ts'
import { allPositions, key, terrainId } from '../src/engine/grid.ts'
import { MAPS } from '../src/engine/maps.ts'
import { DEFAULT_RULES } from '../src/engine/rules.ts'
import type { MapDef, Pos } from '../src/engine/types.ts'

const args = process.argv.slice(2)
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}
const cls = opt('cls') ?? 'sniper'
const maps = opt('map') ? MAPS.filter((m) => m.id === opt('map')) : MAPS
const rules = DEFAULT_RULES

/** 出撃位置（side0）から何手で着けるか（地形の移動コストのみ） */
function turnsFrom(map: MapDef, starts: Pos[], move: number): Map<string, number> {
  const cost = new Map<string, number>()
  const queue = starts.map((p) => ({ p, c: 0 }))
  for (const s of queue) cost.set(key(s.p), 0)
  while (queue.length) {
    queue.sort((a, b) => a.c - b.c)
    const { p, c } = queue.shift()!
    if (c > (cost.get(key(p)) ?? Infinity)) continue
    for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const n = { x: p.x + ox, y: p.y + oy }
      if (n.x < 0 || n.y < 0 || n.x >= map.width || n.y >= map.height) continue
      const nc = c + rules.terrain[terrainId(map, n)].moveCost
      if (nc < (cost.get(key(n)) ?? Infinity)) {
        cost.set(key(n), nc)
        queue.push({ p: n, c: nc })
      }
    }
  }
  const turns = new Map<string, number>()
  for (const [k, c] of cost) turns.set(k, Math.ceil(c / move))
  return turns
}

for (const map of maps) {
  const cells = allPositions(map)
  const total = cells.length
  const turns = turnsFrom(map, map.spawns[0], rules.classes[cls].move)
  const rows = cells.map((at) => {
    const range = attackRange(map, rules, cls, at)
    const strike = cells.filter((t) => (t.x !== at.x || t.y !== at.y) && canStrike(map, rules, at, t, range, isMeleeClass(rules, cls))).length
    const see = cells.filter((t) => (t.x !== at.x || t.y !== at.y) && canSee(map, rules, cls, at, t)).length
    return { at, roof: terrainId(map, at) === 'building', strike, see, turns: turns.get(key(at))! }
  })
  const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length
  const ground = rows.filter((r) => !r.roof)
  const roofs = rows.filter((r) => r.roof).sort((a, b) => b.strike - a.strike)
  const pct = (n: number) => `${Math.round((n / total) * 100)}%`
  console.log(`\n## ${map.name}（${cls}、全${total}マス）`)
  console.log(`- 地上の平均: 撃てる ${avg(ground.map((r) => r.strike)).toFixed(1)}マス（${pct(avg(ground.map((r) => r.strike)))}）／ 見える ${avg(ground.map((r) => r.see)).toFixed(1)}マス`)
  console.log(`- 地上の最大: 撃てる ${Math.max(...ground.map((r) => r.strike))}マス`)
  console.log('\n| 屋上 | 撃てる | 見える | 自陣から何手 |')
  console.log('|---|---|---|---|')
  for (const r of roofs) console.log(`| (${r.at.x},${r.at.y}) | ${r.strike}（${pct(r.strike)}） | ${r.see}（${pct(r.see)}） | ${r.turns} |`)
}
