import type { MapDef, Pos, RulesConfig, TerrainId, TerrainRule } from './types.ts'

const TERRAIN_CHARS: Record<string, TerrainId> = { '.': 'plain', '#': 'building' }

export const key = (p: Pos) => `${p.x},${p.y}`
export const samePos = (a: Pos, b: Pos) => a.x === b.x && a.y === b.y
export const dist = (a: Pos, b: Pos) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y)

export function inBounds(map: MapDef, p: Pos): boolean {
  return p.x >= 0 && p.y >= 0 && p.x < map.width && p.y < map.height
}

export function terrainId(map: MapDef, p: Pos): TerrainId {
  return TERRAIN_CHARS[map.tiles[p.y][p.x]] ?? 'plain'
}

export function terrain(map: MapDef, rules: RulesConfig, p: Pos): TerrainRule {
  return rules.terrain[terrainId(map, p)]
}

/**
 * 視線判定。始点と終点を除く途中のマスが遮蔽物（ビル）なら遮られる。seeOver（屋上から）なら遮られない。
 * 線がマスの境界ちょうどを通る場合は「両側とも遮蔽なら遮る」とし、
 * 判定が向き・点対称の鏡像で変わらないようにしている。
 */
export function lineOfSight(map: MapDef, rules: RulesConfig, a: Pos, b: Pos, seeOver = false): boolean {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const steps = Math.max(Math.abs(dx), Math.abs(dy)) * 2
  if (steps === 0) return true
  const blocks = (x: number, y: number) => {
    if ((x === a.x && y === a.y) || (x === b.x && y === b.y)) return false
    const t = terrain(map, rules, { x, y })
    return t.blocksLos && !seeOver
  }
  const cands = (v: number) => {
    const f = Math.floor(v)
    return Math.abs(v - f - 0.5) < 1e-9 ? [f, f + 1] : [Math.round(v)]
  }
  for (let i = 1; i < steps; i++) {
    const t = i / steps
    const xs = cands(a.x + dx * t)
    const ys = cands(a.y + dy * t)
    let allBlock = true
    for (const x of xs) for (const y of ys) if (!blocks(x, y)) allBlock = false
    if (allBlock) return false
  }
  return true
}

const reachCache = new WeakMap<MapDef, WeakMap<RulesConfig, Map<string, ReadonlyMap<string, { pos: Pos; cost: number }>>>>()

/**
 * 地形コストのみを考慮した到達可能マス（ユニットは無視）。
 * 同じマップ・ルール・出発点・移動力なら結果は同じなのでキャッシュする（返す Map と中身は書き換えないこと）
 */
export function reachable(map: MapDef, rules: RulesConfig, from: Pos, move: number): ReadonlyMap<string, { pos: Pos; cost: number }> {
  let byRules = reachCache.get(map)
  if (!byRules) reachCache.set(map, (byRules = new WeakMap()))
  let cache = byRules.get(rules)
  if (!cache) byRules.set(rules, (cache = new Map()))
  const ck = `${from.x},${from.y},${move}`
  const hit = cache.get(ck)
  if (hit) return hit
  const result = computeReachable(map, rules, from, move)
  cache.set(ck, result)
  return result
}

function computeReachable(map: MapDef, rules: RulesConfig, from: Pos, move: number): Map<string, { pos: Pos; cost: number }> {
  const best = new Map<string, { pos: Pos; cost: number }>()
  best.set(key(from), { pos: { ...from }, cost: 0 })
  const queue: { pos: Pos; cost: number }[] = [{ pos: { ...from }, cost: 0 }]
  while (queue.length) {
    queue.sort((p, q) => p.cost - q.cost)
    const cur = queue.shift()!
    if (cur.cost > (best.get(key(cur.pos))?.cost ?? Infinity)) continue
    for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const np = { x: cur.pos.x + ox, y: cur.pos.y + oy }
      if (!inBounds(map, np)) continue
      const t = terrain(map, rules, np)
      if (!t.passable) continue
      const nc = cur.cost + t.moveCost
      if (nc > move) continue
      const prev = best.get(key(np))
      if (prev && prev.cost <= nc) continue
      best.set(key(np), { pos: np, cost: nc })
      queue.push({ pos: np, cost: nc })
    }
  }
  return best
}

export function allPositions(map: MapDef): Pos[] {
  const out: Pos[] = []
  for (let y = 0; y < map.height; y++) for (let x = 0; x < map.width; x++) out.push({ x, y })
  return out
}

/**
 * from → to の最短経路（地形コスト）。移動自体は瞬間移動だが、再生の演出で通り道を見せるのに使う。
 * 同じコストなら、向きを変えない経路を選ぶ（見た目が自然になる）
 */
export function shortestPath(map: MapDef, rules: RulesConfig, from: Pos, to: Pos): Pos[] {
  const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]]
  const best = new Map<string, { cost: number; turns: number; prev: Pos | null; dir: number }>()
  best.set(key(from), { cost: 0, turns: 0, prev: null, dir: -1 })
  const queue: Pos[] = [from]
  while (queue.length) {
    queue.sort((p, q) => {
      const a = best.get(key(p))!
      const b = best.get(key(q))!
      return a.cost - b.cost || a.turns - b.turns
    })
    const cur = queue.shift()!
    if (samePos(cur, to)) break
    const c = best.get(key(cur))!
    DIRS.forEach(([ox, oy], d) => {
      const np = { x: cur.x + ox, y: cur.y + oy }
      if (!inBounds(map, np)) return
      const t = terrain(map, rules, np)
      if (!t.passable) return
      const nc = c.cost + t.moveCost
      const nt = c.turns + (c.dir >= 0 && c.dir !== d ? 1 : 0)
      const prev = best.get(key(np))
      if (prev && (prev.cost < nc || (prev.cost === nc && prev.turns <= nt))) return
      best.set(key(np), { cost: nc, turns: nt, prev: cur, dir: d })
      queue.push(np)
    })
  }
  if (!best.has(key(to))) return [from, to]
  const path: Pos[] = []
  for (let p: Pos | null = to; p; p = best.get(key(p))!.prev) path.unshift(p)
  return path
}
