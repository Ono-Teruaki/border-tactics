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
  /** 観測: 自分の視界に入った敵にマークを付ける */
  markOnSight: boolean
  /** 透視: この距離以内の敵は建物越しでも見える（0 = なし） */
  sonar: number
  /** 制圧射撃: 1回の攻撃で2発以上当てた敵を制圧する */
  suppress: boolean
  /** 狙撃態勢: 移動しなかった手は命中率アップ・遮蔽の影響半減 */
  steadyAim: boolean
  /** 応急手当: 支援（狙いなし）の手の終わりに、周囲 healRange マス（8方向）の味方を回復する量（0 = なし） */
  heal: number
  healRange: number
  /** カバーリング: 支援の手、周囲8マスの味方への命中弾を肩代わりし、この割合だけ軽減（0 = なし） */
  guardReduce: number
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
  skills: {
    /** マークの持続（手）。1 = 次の手の終わりまで */
    markDuration: number
    /** マークした敵への味方の命中率ボーナス */
    markAccBonus: number
    /** 1手でマークできる最大数（スカウト1体あたり） */
    markPerTurn: number
    /** マークを使った後、次に使えるまでの手数（0 = 毎手） */
    markCooldown: number
    suppressMove: number
    suppressAcc: number
    steadyAcc: number
    /** 防護兵1体が1手で肩代わりできる命中弾の数 */
    guardHitsPerTurn: number
    /** 防護兵は高さ（屋上/地上）が同じ味方だけを庇える */
    guardSameHeight: boolean
    /** 同じクラスを編成できる上限 */
    maxPerClass: number
  }
  vision: {
    /** 屋上から見ても、ビルの裏側に張り付いた地上のマスは見えない */
    deadZone: boolean
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
  /** この手まで「マーク」（相手から見え続け、被命中率アップ） */
  markedUntil: number
  /** この手まで「制圧」（移動力・命中率ダウン） */
  suppressedUntil: number
  /** この手まで観測スキルが使えない */
  markCooldownUntil: number
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
  /** 防護兵が肩代わりした */
  guardedBy?: string
}

export interface Intel {
  unitId: string
  cls: string
  pos: Pos
  hp: number | null
  turn: number
  /** 今まさに見えているか */
  visible: boolean
  /** 自軍がマークしている（次の手も見え続け、命中+） */
  marked?: boolean
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
  | { type: 'mark'; unitId: string; targets: string[] }
  | { type: 'suppress'; unitId: string; targetId: string }
  | { type: 'heal'; unitId: string; targets: { id: string; amount: number }[] }
  | { type: 'pursuit'; unitId: string; from: Pos; to: Pos }

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
