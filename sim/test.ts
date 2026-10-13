// 同時解決ルールの仕様テスト: node sim/test.ts
import assert from 'node:assert/strict'
import { createGame, resolveTurn, visibleEnemyIds, gameResult } from '../src/engine/game.ts'
import { DEFAULT_RULES, mergeRules } from '../src/engine/rules.ts'
import { createRng } from '../src/engine/rng.ts'
import { MAPS } from '../src/engine/maps.ts'
import { AI_PRESETS, decideOrders } from '../src/engine/ai.ts'
import { observe } from '../src/engine/game.ts'
import type { MapDef, Order, Pos } from '../src/engine/types.ts'

const rules2 = mergeRules(DEFAULT_RULES, { teamSize: 2 })
const rules1 = mergeRules(DEFAULT_RULES, { teamSize: 1 })

function mapOf(tiles: string[], s0: Pos[], s1: Pos[]): MapDef {
  return { id: 't', name: 't', width: tiles[0].length, height: tiles.length, tiles, spawns: [s0, s1] }
}
const open = ['.......', '.......', '.......', '.......', '.......']
const mv = (unitId: string, x: number, y: number, stance: Order['stance'] = 'watch', target?: Pos): Order => ({ unitId, dest: { x, y }, stance, target })
const pos = (g: ReturnType<typeof createGame>, id: string) => g.units.find((u) => u.id === id)!.pos
const hp = (g: ReturnType<typeof createGame>, id: string) => g.units.find((u) => u.id === id)!.hp

const tests: Record<string, () => void> = {
  '同じマスへの同時移動は両者とも弾かれる'() {
    const g = createGame(mapOf(open, [{ x: 1, y: 2 }], [{ x: 5, y: 2 }]), rules1, [['attacker'], ['attacker']])
    resolveTurn(g, [[mv('0-0', 3, 2, 'hide')], [mv('1-0', 3, 2, 'hide')]], createRng(1))
    assert.deepEqual(pos(g, '0-0'), { x: 1, y: 2 })
    assert.deepEqual(pos(g, '1-0'), { x: 5, y: 2 })
  },
  '静止している敵のマスへ移動すると弾かれ、互いに位置が露見する'() {
    const g = createGame(mapOf(open, [{ x: 0, y: 0 }], [{ x: 6, y: 4 }]), rules1, [['scout'], ['attacker']])
    g.units[1].pos = { x: 3, y: 0 }
    resolveTurn(g, [[mv('0-0', 3, 0, 'hide')], [mv('1-0', 3, 0, 'hide')]], createRng(1))
    assert.deepEqual(pos(g, '0-0'), { x: 0, y: 0 })
    assert.equal(g.intel[1]['0-0'].pos.x, 0)
    assert.equal(g.intel[1]['0-0'].turn, 1)
  },
  '入れ替わり（すれ違い）は許可'() {
    const g = createGame(mapOf(open, [{ x: 2, y: 2 }], [{ x: 3, y: 2 }]), rules1, [['attacker'], ['attacker']])
    resolveTurn(g, [[mv('0-0', 3, 2, 'hide')], [mv('1-0', 2, 2, 'hide')]], createRng(1))
    assert.deepEqual(pos(g, '0-0'), { x: 3, y: 2 })
    assert.deepEqual(pos(g, '1-0'), { x: 2, y: 2 })
  },
  '弾かれの連鎖'() {
    // A(0,2)->B(1,2)の元位置, B->(2,2)に静止中のCがいる => B弾かれ => A弾かれ
    const g = createGame(mapOf(open, [{ x: 0, y: 2 }, { x: 1, y: 2 }], [{ x: 2, y: 2 }, { x: 6, y: 0 }]), rules2, [
      ['attacker', 'attacker'],
      ['attacker', 'attacker'],
    ])
    resolveTurn(g, [[mv('0-0', 1, 2, 'hide'), mv('0-1', 2, 2, 'hide')], [mv('1-0', 2, 2, 'hide'), mv('1-1', 6, 0, 'hide')]], createRng(1))
    assert.deepEqual(pos(g, '0-0'), { x: 0, y: 2 })
    assert.deepEqual(pos(g, '0-1'), { x: 1, y: 2 })
  },
  'ダメージは同時適用（相打ち）'() {
    const g = createGame(mapOf(open, [{ x: 2, y: 2 }], [{ x: 3, y: 2 }]), rules1, [['scout'], ['scout']])
    g.units[0].hp = 1
    g.units[1].hp = 1
    resolveTurn(g, [[mv('0-0', 2, 2, 'attack', { x: 3, y: 2 })], [mv('1-0', 3, 2, 'attack', { x: 2, y: 2 })]], createRng(1))
    assert.equal(g.units.filter((u) => u.alive).length, 0)
    assert.equal(g.over, true)
    const r = gameResult(g)
    assert.equal(r.winner.killCost, null)
  },
  '置き撃ち：移動先を読めば当たる／外せば外れる'() {
    const g = createGame(mapOf(open, [{ x: 0, y: 2 }], [{ x: 6, y: 2 }]), rules1, [['gunner'], ['scout']])
    resolveTurn(g, [[mv('0-0', 1, 2, 'attack', { x: 4, y: 2 })], [mv('1-0', 4, 2, 'hide')]], createRng(1))
    assert.equal(hp(g, '1-0'), 1)
    resolveTurn(g, [[mv('0-0', 1, 2, 'attack', { x: 4, y: 2 })], [mv('1-0', 4, 1, 'hide')]], createRng(1))
    assert.equal(hp(g, '1-0'), 1)
  },
  '隠密は隣接しないと見えない'() {
    const g = createGame(mapOf(open, [{ x: 0, y: 2 }], [{ x: 2, y: 2 }]), rules1, [['scout'], ['scout']])
    resolveTurn(g, [[mv('0-0', 0, 2, 'hide')], [mv('1-0', 2, 2, 'hide')]], createRng(1))
    assert.equal(visibleEnemyIds(g, 0).size, 0)
    resolveTurn(g, [[mv('0-0', 1, 2, 'watch')], [mv('1-0', 2, 2, 'hide')]], createRng(1))
    assert.equal(visibleEnemyIds(g, 0).size, 1)
  },
  '森は視線を遮り、森の中は隣接しないと見えない'() {
    const m = mapOf(['.......', '...f...', '.......'], [{ x: 0, y: 1 }], [{ x: 6, y: 1 }])
    const g = createGame(m, mergeRules(rules1, { classes: { scout: { vision: 10 } } }), [['scout'], ['scout']])
    assert.equal(visibleEnemyIds(g, 0).size, 0)
    g.units[1].pos = { x: 3, y: 1 }
    assert.equal(visibleEnemyIds(g, 0).size, 0)
    g.units[0].pos = { x: 2, y: 1 }
    assert.equal(visibleEnemyIds(g, 0).size, 1)
  },
  'スナイパーは2マス動くと撃てない'() {
    const g = createGame(mapOf(open, [{ x: 0, y: 2 }], [{ x: 6, y: 2 }]), rules1, [['sniper'], ['attacker']])
    resolveTurn(g, [[mv('0-0', 2, 2, 'attack', { x: 6, y: 2 })], [mv('1-0', 6, 2, 'hide')]], createRng(1))
    assert.equal(hp(g, '1-0'), 4)
    resolveTurn(g, [[mv('0-0', 2, 2, 'attack', { x: 6, y: 2 })], [mv('1-0', 6, 2, 'hide')]], createRng(1))
    assert.equal(hp(g, '1-0'), 2)
  },
  '同じシードなら同じ結果（再現性）'() {
    const run = () => {
      const g = createGame(MAPS[0], DEFAULT_RULES, [['attacker', 'gunner', 'sniper', 'scout'], ['attacker', 'gunner', 'sniper', 'scout']])
      const rng = createRng(42)
      while (!g.over) resolveTurn(g, [decideOrders(observe(g, 0), rng, AI_PRESETS.cpu), decideOrders(observe(g, 1), rng, AI_PRESETS.cpu)], rng)
      return JSON.stringify(gameResult(g)) + JSON.stringify(g.units)
    }
    assert.equal(run(), run())
  },
}

let fail = 0
for (const [name, fn] of Object.entries(tests)) {
  try {
    fn()
    console.log(`✓ ${name}`)
  } catch (e) {
    fail++
    console.log(`✗ ${name}\n  ${(e as Error).message}`)
  }
}
if (fail) process.exit(1)
