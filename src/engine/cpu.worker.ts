// 先読み CPU を別スレッドで考える（画面を止めない。プレイヤーが手を考えている間に計算しておく）
import { decideOrdersSearch, type SearchOpts } from './search.ts'
import { createRng } from './rng.ts'
import type { AiParams } from './ai.ts'
import type { Observation } from './types.ts'

self.onmessage = (e: MessageEvent<{ id: number; obs: Observation; params: AiParams; opts: SearchOpts; seed: number }>) => {
  const { id, obs, params, opts, seed } = e.data
  self.postMessage({ id, orders: decideOrdersSearch(obs, createRng(seed), params, opts) })
}
