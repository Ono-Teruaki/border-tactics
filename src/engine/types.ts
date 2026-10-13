export type Side = 0 | 1
export type TerrainId = 'plain' | 'building'
export type VictoryMode = 'annihilation' | 'killCount' | 'killCost'

export interface Pos {
  x: number
  y: number
}

export interface UnitClass {
  id: string
  name: string
  /** 駒に書く一文字 */
  kanji: string
  short: string
  hp: number
  move: number
  range: number
  damage: number
  vision: number
  /** 撃破されたときに相手に入るポイント */
  cost: number
  /** このマス数以下しか移動していなければ攻撃できる（スナイパー用） */
  attackMaxMove: number
}

export interface TerrainRule {
  name: string
  passable: boolean
  moveCost: number
  /** 地上同士の視線を遮る */
  blocksLos: boolean
  visionBonus: number
  rangeBonus: number
  /** ここ（屋上）から見るとき、途中の建物を無視して見通せる */
  seesOverBlockers: boolean
}

export interface RulesConfig {
  classes: Record<string, UnitClass>
  teamSize: number
  turnLimit: number
  victory: VictoryMode
  terrain: Record<TerrainId, TerrainRule>
  /** true: 味方の誰かが見ている敵を撃てる（索敵が射撃に直結） / false: 自分の目で見えている敵のみ */
  sharedTargeting: boolean
  /** 攻撃したユニットの位置は相手に露見する */
  attackReveals: boolean
  /** 敵と同じマスに移動しようとして弾かれたとき、互いの位置が露見する */
  bumpReveals: boolean
}

export interface MapDef {
  id: string
  name: string
  width: number
  height: number
  /** '.' 平地, '#' ビル */
  tiles: string[]
  spawns: [Pos[], Pos[]]
}

export interface Unit {
  id: string
  side: Side
  cls: string
  pos: Pos
  hp: number
  alive: boolean
}

/** 命令は移動先のみ。攻撃は移動後に自動で行う */
export interface Order {
  unitId: string
  dest: Pos
}

export interface Intel {
  unitId: string
  cls: string
  pos: Pos
  hp: number | null
  turn: number
  /** 今まさに見えているか */
  visible: boolean
}

export type GameEvent =
  | { type: 'move'; unitId: string; from: Pos; to: Pos }
  | { type: 'bounce'; unitId: string; at: Pos; contact: boolean }
  /** spotted: 撃った本人には見えておらず、味方の索敵で撃てた */
  | { type: 'attack'; unitId: string; from: Pos; target: Pos; hitId: string; damage: number; spotted: boolean }
  | { type: 'bailout'; unitId: string; at: Pos }

export interface GameState {
  map: MapDef
  rules: RulesConfig
  units: Unit[]
  turn: number
  kills: [number, number]
  killCost: [number, number]
  /** intel[side] = side から見た敵の最新情報 */
  intel: [Record<string, Intel>, Record<string, Intel>]
  over: boolean
  history: GameEvent[][]
}

export interface Observation {
  side: Side
  turn: number
  map: MapDef
  rules: RulesConfig
  mine: Unit[]
  enemies: Intel[]
  enemyAlive: number
  kills: [number, number]
  killCost: [number, number]
}

export interface GameResult {
  turns: number
  kills: [number, number]
  killCost: [number, number]
  alive: [number, number]
  winner: Record<VictoryMode, Side | null>
}
