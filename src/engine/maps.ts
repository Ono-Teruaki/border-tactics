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

/**
 * ASCII で全体を書く版（点対称は自分で守る。テストで検査している）。
 * 設計の目安（`node sim/sightlines.ts` で測る）:
 * - 地上の長い直線を切る。スナイパーが地上から撃てるマスは平均で盤面の3割前後まで
 * - 強い屋上（広く撃てる）は中央寄り。自陣のそばの屋上は地上並みに視野を絞る
 */
function asciiMap(id: string, name: string, rows: string[], radars?: [number, number][]): MapDef {
  const size = rows.length
  const tiles = rows.map((r) => r.replace(/\s/g, ''))
  const buildings: [number, number][] = []
  tiles.forEach((r, y) => [...r].forEach((ch, x) => ch === '#' && buildings.push([x, y])))
  const m = defineMap(id, name, size, buildings)
  if (m.tiles.join() !== tiles.join()) throw new Error(`${id}: not point-symmetric`)
  if (radars) {
    // 点対称に補完する。どちらの出撃地点からも同じ距離になる
    m.radars = radars.flatMap(([x, y]) => [{ x, y }, { x: size - 1 - x, y: size - 1 - y }])
    for (const p of m.radars) if (m.tiles[p.y][p.x] !== '#') throw new Error(`${id}: radar must be on a building ${p.x},${p.y}`)
  }
  return m
}

/** 今のマップ（v0.8）。上から 9×9 → 11×11 → 7×7 */
export const CURRENT_MAP_IDS = ['block9', 'alley11', 'plaza7']

export const MAPS: MapDef[] = [
  // 街区: 中央の四つ角のビルが一番強い屋上。自陣そばの屋上は撃てる範囲が狭い。左上・右下の角にレーダー塔
  asciiMap('block9', '街区 9×9', [
    '. . . # . . . . .',
    '. # . # . # # . .',
    '. # . . . . . . .',
    '. . . # . # . # .',
    '. # . . # . . # .',
    '. # . # . # . . .',
    '. . . . . . . # .',
    '. . # # . # . # .',
    '. . . . . # . . .',
  ], [[1, 1]]),
  // 路地: 短い壁で通りを細かく区切る。中央が一番強い屋上で、自陣から5手
  asciiMap('alley11', '路地 11×11', [
    '. . . . # . . . . . .',
    '. # # . # . . # . . .',
    '. # . . . . . # . . .',
    '. . . # # . # . . # .',
    '# . . . . . # . . # .',
    '. . # . . # . . # . .',
    '. # . . # . . . . . #',
    '. # . . # . # # . . .',
    '. . . # . . . . . # .',
    '. . . # . . # . # # .',
    '. . . . . . # . . . .',
  ], [[1, 1]]),
  // 広場: 狭い盤。中央のビルを囲む壁で左右を分ける
  asciiMap('plaza7', '広場 7×7', [
    '. . . . . . .',
    '. # # . # . .',
    '. . . . # . .',
    '. # . # . # .',
    '. . # . . . .',
    '. . # . # # .',
    '. . . . . . .',
  ], [[1, 1]]),
  // ---- 旧マップ（v0.7 まで。比較用） ----
  defineMap('city9', '旧 市街地 9×9', 9, [
    [5, 1],
    [2, 2],
    [6, 3],
    [1, 4],
    [4, 4],
  ]),
  defineMap('city11', '旧 市街地 11×11', 11, [
    [7, 1],
    [3, 2],
    [8, 3],
    [5, 3],
    [2, 5],
    [5, 5],
    [9, 2],
  ]),
  defineMap('city7', '旧 市街地 7×7', 7, [
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
