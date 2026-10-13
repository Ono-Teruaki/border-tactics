// 棋譜の再生: node sim/replay.ts record.json
import { readFileSync } from 'node:fs'
import { gameResult } from '../src/engine/game.ts'
import { replayRecord, type GameRecord } from '../src/engine/record.ts'

const rec: GameRecord = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const name = (s: ReturnType<typeof replayRecord>, id: string) => {
  const u = s.units.find((x) => x.id === id)!
  return `${u.side === 0 ? 'P' : 'C'}:${s.rules.classes[u.cls].short}(${id})`
}
console.log(`map=${rec.map} seed=${rec.seed} P=${rec.comps[0].join(',')} C=${rec.comps[1].join(',')}`)
const final = replayRecord(rec, (s, turn, events) => {
  const lines = events.map((e) => {
    if (e.type === 'move') return `${name(s, e.unitId)} 移動 ${e.from.x},${e.from.y}→${e.to.x},${e.to.y}`
    if (e.type === 'bounce') return `${name(s, e.unitId)} 弾かれ ${e.contact ? '(接触)' : ''}`
    if (e.type === 'attack') return `${name(s, e.unitId)} 射撃 → ${name(s, e.hitId)} -${e.damage}${e.spotted ? '（味方の索敵）' : ''}`
    return `${name(s, e.unitId)} ベイルアウト`
  })
  console.log(`--- T${turn}\n  ${lines.join('\n  ') || '(なし)'}`)
})
console.log(JSON.stringify(gameResult(final)))
