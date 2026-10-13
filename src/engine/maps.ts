import type { MapDef, Pos } from './types.ts'

/**
 * 正方形フィールド。ビル位置を半分だけ書けば点対称に補完する。
 * 出撃は対角の角に 2x2（side0 = 左下, side1 = 右上）。
 */
function defineMap(id: string, name: string, size: number, buildings: [number, number][]): MapDef {
  const grid = Array.from({ length: size }, () => Array(size).fill('.'))
  for (const [x, y] of buildings) {
    grid[y][x] = '#'
    grid[size - 1 - y][size - 1 - x] = '#'
  }
  const bottomLeft: Pos[] = [
    { x: 0, y: size - 1 },
    { x: 1, y: size - 1 },
    { x: 0, y: size - 2 },
    { x: 1, y: size - 2 },
  ]
  const spawns: [Pos[], Pos[]] = [bottomLeft, bottomLeft.map((p) => ({ x: size - 1 - p.x, y: size - 1 - p.y }))]
  for (const p of [...spawns[0], ...spawns[1]]) {
    if (grid[p.y][p.x] !== '.') throw new Error(`${id}: building on spawn ${p.x},${p.y}`)
  }
  return { id, name, width: size, height: size, tiles: grid.map((r) => r.join('')), spawns }
}

export const MAPS: MapDef[] = [
  defineMap('city9', '市街地 9×9', 9, [
    [5, 1],
    [2, 2],
    [6, 3],
    [1, 4],
    [4, 4],
  ]),
  defineMap('city11', '市街地 11×11', 11, [
    [7, 1],
    [3, 2],
    [8, 3],
    [5, 3],
    [2, 5],
    [5, 5],
    [9, 2],
  ]),
  defineMap('city7', '市街地 7×7', 7, [
    [4, 1],
    [2, 2],
    [3, 3],
  ]),
]

export function getMap(id: string): MapDef {
  const m = MAPS.find((m) => m.id === id)
  if (!m) throw new Error(`unknown map ${id}`)
  return m
}
