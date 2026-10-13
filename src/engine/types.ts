export type Side = 0 | 1
export type TerrainId = 'plain' | 'wall' | 'forest' | 'high'
export type Stance = 'attack' | 'watch' | 'hide'
export type VictoryMode = 'annihilation' | 'killCount' | 'killCost'

export interface Pos {
  x: number
  y: number
}

export interface UnitClass {
  id: string
  name: string
  short: string
  hp: number
  move: number
  range: number
  damage: number
  vision: number
  /** 撃破されたときに相手に入るポイント */
  cost: number
  /** この距離以下しか移動していなければ攻撃できる（スナイパー用） */
  attackMaxMove: number
}

export interface TerrainRule {
  name: string
  passable: boolean
  moveCost: number
  blocksLos: boolean
  /** このマスにいるユニットは、この距離以内からしか見えない（null = 制限なし） */
  concealRange: number | null
  visionBonus: number
  rangeBonus: number
  /** このマスから見るとき、途中の視界遮断（森）を無視する */
  seesOverCover: boolean
}

export interface RulesConfig {
  classes: Record<string, UnitClass>
  teamSize: number
  turnLimit: number
  victory: VictoryMode
  terrain: Record<TerrainId, TerrainRule>
  /** 隠密ユニットはこの距離以内からしか見えない */
  hideRevealRange: number
  /** 隠密中の移動力補正 */
  hideMovePenalty: number
  /** 警戒（自動反撃）の射程ペナルティ。射程1は下回らない */
  watchRangePenalty: number
  /** 警戒の与ダメージペナルティ。1は下回らない */
  watchDamagePenalty: number
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
  /** '.' 平地, '#' 壁, 'f' 森, 'h' 高台 */
  tiles: string[]
  spawns: [Pos[], Pos[]]
}

export interface Unit {
  id: string
  side: Side
  cls: string
  pos: Pos
  hp: number
  hidden: boolean
  alive: boolean
}

export interface Order {
  unitId: string
  dest: Pos
  stance: Stance
  target?: Pos
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
  | { type: 'attack'; unitId: string; from: Pos; target: Pos; hitId: string | null; damage: number; watch: boolean }
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
