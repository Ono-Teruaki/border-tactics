import { createGame, resolveTurn } from './game.ts'
import { getMap } from './maps.ts'
import { seedStreams } from './rng.ts'
import type { GameState, Order, RulesConfig } from './types.ts'

/** 棋譜：シード・ルール・両軍の命令があれば同じ試合を再現できる */
export interface GameRecord {
  version: 1
  seed: number
  map: string
  comps: [string[], string[]]
  rules: RulesConfig
  turns: [Order[], Order[]][]
}

export function replayRecord(rec: GameRecord, onTurn?: (state: GameState, turn: number, events: ReturnType<typeof resolveTurn>) => void): GameState {
  const state = createGame(getMap(rec.map), rec.rules, rec.comps)
  const rng = seedStreams(rec.seed).resolve
  for (const orders of rec.turns) {
    const turn = state.turn
    const events = resolveTurn(state, orders, rng)
    onTurn?.(state, turn, events)
  }
  return state
}
