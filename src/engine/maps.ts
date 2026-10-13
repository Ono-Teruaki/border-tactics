import type { MapDef, Pos } from './types.ts'

/** 下側(side0)の出撃位置から、点対称で上側(side1)の出撃位置を作る */
function mirrorSpawns(w: number, h: number, bottom: Pos[]): [Pos[], Pos[]] {
  return [bottom, bottom.map((p) => ({ x: w - 1 - p.x, y: h - 1 - p.y }))]
}

function defineMap(id: string, name: string, tiles: string[], bottomSpawns: Pos[]): MapDef {
  const height = tiles.length
  const width = tiles[0].length
  for (let y = 0; y < height; y++) {
    if (tiles[y].length !== width) throw new Error(`${id}: row ${y} width mismatch`)
    for (let x = 0; x < width; x++) {
      if (tiles[y][x] !== tiles[height - 1 - y][width - 1 - x]) throw new Error(`${id}: not point-symmetric at ${x},${y}`)
    }
  }
  return { id, name, width, height, tiles, spawns: mirrorSpawns(width, height, bottomSpawns) }
}

export const MAPS: MapDef[] = [
  defineMap(
    'city',
    '市街地',
    [
      '..f...f..',
      '.##.h.##.',
      '.........',
      'f..#.#..f',
      '.h.#...ff',
      '...ff.#..',
      '#..f.f..#',
      '..#.ff...',
      'ff...#.h.',
      'f..#.#..f',
      '.........',
      '.##.h.##.',
      '..f...f..',
    ],
    [{ x: 1, y: 12 }, { x: 3, y: 12 }, { x: 5, y: 12 }, { x: 7, y: 12 }],
  ),
  defineMap(
    'hill',
    '中央高地',
    [
      '...f.f...',
      '.f.....f.',
      '..##.##..',
      'f.......f',
      '..f.h.f..',
      '.#..h..#.',
      'ff.hhh.ff',
      '.#..h..#.',
      '..f.h.f..',
      'f.......f',
      '..##.##..',
      '.f.....f.',
      '...f.f...',
    ],
    [{ x: 1, y: 12 }, { x: 3, y: 12 }, { x: 5, y: 12 }, { x: 7, y: 12 }],
  ),
]

export function getMap(id: string): MapDef {
  const m = MAPS.find((m) => m.id === id)
  if (!m) throw new Error(`unknown map ${id}`)
  return m
}
