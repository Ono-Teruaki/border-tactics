// ルール仕様テスト: node sim/test.ts
import assert from 'node:assert/strict'
import { createGame, gameResult, observe, resolveTurn, visibleEnemyIds } from '../src/engine/game.ts'
import { DEFAULT_RULES, mergeRules } from '../src/engine/rules.ts'
import { createRng, seedStreams } from '../src/engine/rng.ts'
import { replayRecord, type GameRecord } from '../src/engine/record.ts'
import { MAPS } from '../src/engine/maps.ts'
import { AI_PRESETS, decideOrders } from '../src/engine/ai.ts'
import type { GameState, MapDef, Order, Pos } from '../src/engine/types.ts'

const rules1 = mergeRules(DEFAULT_RULES, { teamSize: 1 })
const rules2 = mergeRules(DEFAULT_RULES, { teamSize: 2 })

function mapOf(tiles: string[], s0: Pos[], s1: Pos[]): MapDef {
  return { id: 't', name: 't', width: tiles[0].length, height: tiles.length, tiles, spawns: [s0, s1] }
}
const open = ['.......', '.......', '.......', '.......', '.......']
const mv = (unitId: string, x: number, y: number): Order => ({ unitId, dest: { x, y } })
const unit = (g: GameState, id: string) => g.units.find((u) => u.id === id)!
const stay = (g: GameState, side: 0 | 1): Order[] => g.units.filter((u) => u.side === side && u.alive).map((u) => mv(u.id, u.pos.x, u.pos.y))

const tests: Record<string, () => void> = {
  '同じマスへの同時移動は両者とも弾かれる'() {
    const g = createGame(mapOf(open, [{ x: 0, y: 2 }], [{ x: 6, y: 2 }]), rules1, [['scout'], ['scout']])
    g.units[0].pos = { x: 1, y: 0 }
    g.units[1].pos = { x: 5, y: 0 }
    resolveTurn(g, [[mv('0-0', 3, 0)], [mv('1-0', 3, 0)]], createRng(1))
    assert.deepEqual(unit(g, '0-0').pos, { x: 1, y: 0 })
    assert.deepEqual(unit(g, '1-0').pos, { x: 5, y: 0 })
  },
  '入れ替わり（すれ違い）は許可'() {
    const g = createGame(mapOf(open, [{ x: 2, y: 2 }], [{ x: 3, y: 2 }]), rules1, [['attacker'], ['attacker']])
    resolveTurn(g, [[mv('0-0', 3, 2)], [mv('1-0', 2, 2)]], createRng(1))
    assert.deepEqual(unit(g, '0-0').pos, { x: 3, y: 2 })
  },
  '弾かれの連鎖'() {
    const g = createGame(mapOf(open, [{ x: 0, y: 0 }, { x: 1, y: 0 }], [{ x: 2, y: 0 }, { x: 6, y: 4 }]), mergeRules(rules2, { attackReveals: false }), [
      ['scout', 'scout'],
      ['scout', 'scout'],
    ])
    resolveTurn(g, [[mv('0-0', 1, 0), mv('0-1', 2, 0)], [mv('1-0', 2, 0), mv('1-1', 6, 4)]], createRng(1))
    assert.deepEqual(unit(g, '0-0').pos, { x: 0, y: 0 })
    assert.deepEqual(unit(g, '0-1').pos, { x: 1, y: 0 })
  },
  '移動後に射程内の見えている敵を自動で撃つ（相打ちあり）'() {
    const g = createGame(mapOf(open, [{ x: 0, y: 2 }], [{ x: 6, y: 2 }]), rules1, [['scout'], ['scout']])
    g.units[0].hp = 1
    g.units[1].hp = 1
    resolveTurn(g, [[mv('0-0', 3, 2)], [mv('1-0', 4, 2)]], createRng(1))
    assert.equal(g.units.filter((u) => u.alive).length, 0)
    assert.equal(gameResult(g).winner.killCost, null)
  },
  'ビルは地上同士の視線を遮る'() {
    const m = mapOf(['.......', '...#...', '.......'], [{ x: 0, y: 1 }], [{ x: 5, y: 1 }])
    const g = createGame(m, rules1, [['scout'], ['scout']])
    assert.equal(visibleEnemyIds(g, 0).size, 0)
    g.units[0].pos = { x: 2, y: 0 }
    assert.equal(visibleEnemyIds(g, 0).size, 1)
  },
  '屋上は視界+2・射程+1、ビル越しに見通せる'() {
    const m = mapOf(['.........', '.#..#....', '.........'], [{ x: 1, y: 1 }], [{ x: 8, y: 1 }])
    const g = createGame(m, rules1, [['gunner'], ['scout']])
    // ガンナー視界4 + 2 = 6 だが距離7 → 見えない
    assert.equal(visibleEnemyIds(g, 0).size, 0)
    g.units[1].pos = { x: 7, y: 1 }
    assert.equal(visibleEnemyIds(g, 0).size, 1) // 距離6, 途中のビル(4,1)越し
    // 射程: 3 + 1 = 4
    g.units[1].pos = { x: 5, y: 1 }
    resolveTurn(g, [stay(g, 0), stay(g, 1)], createRng(1))
    assert.equal(unit(g, '1-0').hp, 1)
  },
  '屋上の見通しはルールで切れる'() {
    const m = mapOf(['.........', '.#..#....', '.........'], [{ x: 1, y: 1 }], [{ x: 7, y: 1 }])
    const g = createGame(m, mergeRules(rules1, { terrain: { building: { seesOverBlockers: false } } }), [['gunner'], ['scout']])
    assert.equal(visibleEnemyIds(g, 0).size, 0)
  },
  '味方の索敵で見えている敵を撃てる（sharedTargeting）'() {
    // スナイパー(0,2)の視界外だが、スカウトが見ている敵を撃つ
    const m = mapOf(open, [{ x: 0, y: 2 }, { x: 4, y: 0 }], [{ x: 4, y: 2 }, { x: 6, y: 4 }])
    const run = (shared: boolean) => {
      const g = createGame(m, mergeRules(rules2, { sharedTargeting: shared, classes: { sniper: { vision: 2 } } }), [
        ['sniper', 'scout'],
        ['gunner', 'gunner'],
      ])
      g.units[2].hp = 10
      const ev = resolveTurn(g, [stay(g, 0), stay(g, 1)], createRng(1))
      return ev.find((e) => e.type === 'attack' && e.unitId === '0-0')
    }
    const hit = run(true)
    assert.ok(hit && hit.type === 'attack' && hit.spotted)
    assert.equal(run(false), undefined)
  },
  'スナイパーは2マス以上動くと撃てない'() {
    const g = createGame(mapOf(open, [{ x: 0, y: 2 }], [{ x: 6, y: 2 }]), rules1, [['sniper'], ['attacker']])
    resolveTurn(g, [[mv('0-0', 2, 2)], stay(g, 1)], createRng(1))
    assert.equal(unit(g, '1-0').hp, 4)
    resolveTurn(g, [[mv('0-0', 2, 2)], stay(g, 1)], createRng(1))
    assert.equal(unit(g, '1-0').hp, 2)
  },
  '倒しきれる敵に重ねて撃たない'() {
    const g = createGame(mapOf(open, [{ x: 2, y: 2 }, { x: 2, y: 1 }], [{ x: 3, y: 2 }, { x: 3, y: 1 }]), rules2, [
      ['gunner', 'gunner'],
      ['scout', 'attacker'],
    ])
    g.units[2].hp = 1
    const ev = resolveTurn(g, [stay(g, 0), stay(g, 1)], createRng(1))
    const mine = ev.filter((e) => e.type === 'attack' && e.unitId.startsWith('0-'))
    assert.equal(new Set(mine.map((e) => (e.type === 'attack' ? e.hitId : ''))).size, 2)
  },
  'マップは点対称・出撃は対角'() {
    for (const m of MAPS) {
      for (let y = 0; y < m.height; y++) for (let x = 0; x < m.width; x++) assert.equal(m.tiles[y][x], m.tiles[m.height - 1 - y][m.width - 1 - x])
      assert.deepEqual(m.spawns[0][0], { x: 0, y: m.height - 1 })
      assert.deepEqual(m.spawns[1][0], { x: m.width - 1, y: 0 })
    }
  },
  '棋譜から同じ試合を再生できる'() {
    const seed = 12345
    const st = seedStreams(seed)
    const rec: GameRecord = { version: 2, seed, map: 'city9', comps: [['attacker', 'gunner', 'sniper', 'scout'], ['attacker', 'attacker', 'gunner', 'scout']], rules: DEFAULT_RULES, turns: [] }
    const g = createGame(MAPS[0], DEFAULT_RULES, rec.comps)
    while (!g.over) {
      const orders: [Order[], Order[]] = [decideOrders(observe(g, 0), st.ai, AI_PRESETS.aggressive), decideOrders(observe(g, 1), st.ai, AI_PRESETS.cpu)]
      rec.turns.push(structuredClone(orders))
      resolveTurn(g, orders, st.resolve)
    }
    const r = replayRecord(JSON.parse(JSON.stringify(rec)))
    assert.deepEqual(gameResult(r), gameResult(g))
    assert.deepEqual(r.units, g.units)
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
