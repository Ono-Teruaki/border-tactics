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
  /** 以下の能力値は 30 以下で設定する */
  hp: number
  atk: number
  def: number
  /** 速: 交戦時に高い順に攻撃する */
  spd: number
  /** 1手で撃つ弾数 */
  shots: number
  /** 基本命中率（%） */
  accuracy: number
  /** 距離1マスごとの命中率低下（%） */
  falloff: number
  /** 隣接（距離1）の敵を撃つときの命中率低下（%）。懐に入られると弱い */
  closePenalty: number
  /** 追撃: 狙った敵の移動先に合わせて、移動力の範囲で隣接マスへ詰める */
  pursuit: boolean
  move: number
  range: number
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
  cover: {
    /** 屋上からならビル越しに撃てる（false: 射線上にビルがあれば撃てない。視界は通る） */
    fireOverBuildings: boolean
    /** 屋上から、撃ち手側のビルに張り付いている地上の敵は撃てない */
    wallHug: boolean
  }
  combat: {
    /** ダメージの乱数幅（±割合） */
    variance: number
    /** 遮蔽による命中率低下（%） */
    coverHalf: number
    coverLight: number
    /** 屋上から地上へ撃つときの命中率ボーナス / 地上から屋上へのペナルティ */
    highGround: number
    lowGround: number
    minHit: number
    maxHit: number
    /** 同じ速のときの順番決めに使う乱数幅 */
    initiativeJitter: number
  }
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

/** 命令: 移動先と、狙う敵（任意）。移動後に射程・射線が通り、見えていれば撃つ */
export interface Order {
  unitId: string
  dest: Pos
  target?: string
}

export type StrikeBlock = 'range' | 'blocked' | 'cover' | 'moved' | 'unseen' | 'gone' | 'down'

export interface ShotResult {
  hit: boolean
  damage: number
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
  | {
      type: 'attack'
      unitId: string
      from: Pos
      target: Pos
      hitId: string
      /** 命中率（%） */
      chance: number
      cover: 'none' | 'light' | 'half'
      shots: ShotResult[]
      /** 合計ダメージ */
      damage: number
      /** 攻撃後の対象HP */
      targetHp: number
      spotted: boolean
    }
  /** 狙ったが撃てなかった */
  | { type: 'noshot'; unitId: string; targetId: string; reason: StrikeBlock }
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
