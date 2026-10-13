import type { MapDef, Pos, RulesConfig, TerrainId, TerrainRule } from './types.ts'

const TERRAIN_CHARS: Record<string, TerrainId> = { '.': 'plain', '#': 'wall', f: 'forest', h: 'high' }

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
 * 視線判定。始点と終点を除く途中のマスが遮蔽物なら遮られる。
 * 線がマスの境界ちょうどを通る場合は「両側とも遮蔽なら遮る」とし、
 * 判定が向き・点対称の鏡像で変わらないようにしている。
 */
export function lineOfSight(map: MapDef, rules: RulesConfig, a: Pos, b: Pos, ignoreCover = false): boolean {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const steps = Math.max(Math.abs(dx), Math.abs(dy)) * 2
  if (steps === 0) return true
  const blocks = (x: number, y: number) => {
    if ((x === a.x && y === a.y) || (x === b.x && y === b.y)) return false
    const t = terrain(map, rules, { x, y })
    if (!t.blocksLos) return false
    if (ignoreCover && t.passable) return false
    return true
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

/** 地形コストのみを考慮した到達可能マス（ユニットは無視） */
export function reachable(map: MapDef, rules: RulesConfig, from: Pos, move: number): Map<string, { pos: Pos; cost: number }> {
  const best = new Map<string, { pos: Pos; cost: number }>()
  best.set(key(from), { pos: from, cost: 0 })
  const queue: { pos: Pos; cost: number }[] = [{ pos: from, cost: 0 }]
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
