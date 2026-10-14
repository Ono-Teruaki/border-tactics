// ルール仕様テスト: node sim/test.ts
import assert from 'node:assert/strict'
import { chebyshev, createGame, strikeCheck, gameResult, moveOf, observe, resolveTurn, visibleEnemyIds } from '../src/engine/game.ts'
import { DEFAULT_RULES, mergeRules } from '../src/engine/rules.ts'
import { createRng, seedStreams } from '../src/engine/rng.ts'
import { replayRecord, type GameRecord } from '../src/engine/record.ts'
import { getMap, MAPS } from '../src/engine/maps.ts'
import { coverFrom, hiddenFraction, hitChance } from '../src/engine/combat.ts'
import { AI_PRESETS, decideOrders } from '../src/engine/ai.ts'
import type { GameState, MapDef, Order, Pos } from '../src/engine/types.ts'

// 命中100%・乱数なしの決定的な戦闘ルール（ダメージ = round(攻²/(攻+守))）
const DET = mergeRules(DEFAULT_RULES, { combat: { variance: 0, minHit: 100, maxHit: 100 } })
const rules1 = mergeRules(DET, { teamSize: 1 })
const rules2 = mergeRules(DET, { teamSize: 2 })

function mapOf(tiles: string[], s0: Pos[], s1: Pos[]): MapDef {
  return { id: 't', name: 't', width: tiles[0].length, height: tiles.length, tiles, spawns: [s0, s1] }
}
const open = ['.......', '.......', '.......', '.......', '.......']
const mv = (unitId: string, x: number, y: number, target?: string): Order => ({ unitId, dest: { x, y }, target })
const unit = (g: GameState, id: string) => g.units.find((u) => u.id === id)!
const stay = (g: GameState, side: 0 | 1, target?: string): Order[] => g.units.filter((u) => u.side === side && u.alive).map((u) => mv(u.id, u.pos.x, u.pos.y, target))

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
  '狙った敵が移動後に射程内なら撃つ／先に倒されたら撃てない'() {
    const g = createGame(mapOf(open, [{ x: 0, y: 2 }], [{ x: 6, y: 2 }]), rules1, [['scout'], ['scout']])
    g.units[0].hp = 1
    g.units[1].hp = 1
    const ev = resolveTurn(g, [[mv('0-0', 3, 2, '1-0')], [mv('1-0', 4, 2, '0-0')]], createRng(1))
    assert.equal(g.units.filter((u) => u.alive).length, 1)
    assert.ok(ev.some((e) => e.type === 'noshot' && e.reason === 'down'))
  },
  '速が高い方が先に撃つ'() {
    for (const seed of [1, 2, 3, 4, 5]) {
      const g = createGame(mapOf(open, [{ x: 2, y: 2 }], [{ x: 3, y: 2 }]), rules1, [['attacker'], ['gunner']])
      g.units[0].hp = 1
      g.units[1].hp = 1
      resolveTurn(g, [stay(g, 0, '1-0'), stay(g, 1, '0-0')], createRng(seed))
      assert.equal(unit(g, '0-0').alive, true)
      assert.equal(unit(g, '1-0').alive, false)
    }
  },
  'ダメージ = 攻²/(攻+守)、ガンナーは3発'() {
    const g = createGame(mapOf(open, [{ x: 0, y: 2 }], [{ x: 3, y: 2 }]), rules1, [['gunner'], ['attacker']])
    const ev = resolveTurn(g, [stay(g, 0, '1-0'), stay(g, 1)], createRng(1))
    const a = ev.find((e) => e.type === 'attack')!
    assert.ok(a.type === 'attack' && a.shots.length === 3 && a.shots.every((x) => x.damage === 4))
    assert.equal(unit(g, '1-0').hp, 28 - 12)
  },
  '命中率: 距離で下がり、撃ち手から見て体が隠れている割合でさらに下がる'() {
    // (4,3) はビル (3,3) の東に張り付いている
    const m = mapOf(['.......', '.......', '.......', '...#...', '.......', '.......', '.......'], [{ x: 0, y: 0 }], [{ x: 6, y: 6 }])
    const G = DEFAULT_RULES.classes.gunner
    const S = DEFAULT_RULES.classes.sniper
    const T = { x: 4, y: 3 }
    assert.equal(hitChance(m, DEFAULT_RULES, G, { x: 4, y: 2 }, T).chance, 60) // 隣接は懐デバフ -20
    // 真北から: ビルは横にあるだけで全身見える → 隠れペナルティなし（80 - 10×2）
    assert.equal(hiddenFraction(m, { x: 4, y: 0 }, T), 0)
    assert.deepEqual(hitChance(m, DEFAULT_RULES, G, { x: 4, y: 0 }, T), { chance: 60, cover: 'none', coverPenalty: 0 })
    // 北西から: ビルの角に体の一部が隠れる（0.4 → −16）。距離6 → 90 − 25 = 65
    assert.equal(hiddenFraction(m, { x: 1, y: 0 }, T), 0.4)
    assert.equal(hitChance(m, DEFAULT_RULES, S, { x: 1, y: 0 }, T).chance, 65 - 16)
    // 西寄りからはもっと隠れる
    assert.ok(hiddenFraction(m, { x: 0, y: 1 }, T) > hiddenFraction(m, { x: 1, y: 0 }, T))
    // 旧方式（隣のビルの向き）なら、北西からは half（−25）
    const old = mergeRules(DEFAULT_RULES, { combat: { coverModel: 'adjacent' } })
    assert.equal(hitChance(m, old, S, { x: 1, y: 0 }, T).chance, 65 - 25)
  },
  'ビルは地上同士の視線を遮る'() {
    const m = mapOf(['.......', '...#...', '.......'], [{ x: 0, y: 1 }], [{ x: 5, y: 1 }])
    const g = createGame(m, rules1, [['scout'], ['scout']])
    assert.equal(visibleEnemyIds(g, 0).size, 0)
    g.units[0].pos = { x: 2, y: 0 }
    assert.equal(visibleEnemyIds(g, 0).size, 1)
  },
  '屋上は視界+2・射程+1、ビル越しに見通せる（が撃てない）'() {
    const m = mapOf(['.........', '.#..#....', '.........'], [{ x: 1, y: 1 }], [{ x: 8, y: 1 }])
    const r = mergeRules(rules1, { classes: { gunner: { range: 5 } } })
    const g = createGame(m, r, [['gunner'], ['scout']])
    // ガンナー視界4 + 2 = 6 だが距離7 → 見えない
    assert.equal(visibleEnemyIds(g, 0).size, 0)
    g.units[1].pos = { x: 6, y: 1 }
    assert.equal(visibleEnemyIds(g, 0).size, 1) // 途中のビル(4,1)越しに見える
    const ev = resolveTurn(g, [stay(g, 0, '1-0'), stay(g, 1)], createRng(1))
    assert.deepEqual(ev.find((e) => e.type === 'noshot'), { type: 'noshot', unitId: '0-0', targetId: '1-0', reason: 'blocked' })
    // 射線が通れば撃てる（射程 5 + 1）
    g.units[1].pos = { x: 4, y: 2 }
    resolveTurn(g, [stay(g, 0, '1-0'), stay(g, 1)], createRng(1))
    assert.equal(unit(g, '1-0').hp, 1) // 16 - 5×3
    // fireOverBuildings ならビル越しに撃てる
    const g2 = createGame(m, mergeRules(r, { cover: { fireOverBuildings: true } }), [['gunner'], ['scout']])
    g2.units[1].pos = { x: 6, y: 1 }
    resolveTurn(g2, [stay(g2, 0, '1-0'), stay(g2, 1)], createRng(1))
    assert.equal(unit(g2, '1-0').hp, 1)
  },
  '死角: 屋上からでもビルの裏に張り付いた敵は見えない（透視なら見える）'() {
    const m = mapOf(['.........', '.#..#....', '.........'], [{ x: 1, y: 1 }], [{ x: 5, y: 1 }])
    const g = createGame(m, rules1, [['gunner'], ['gunner']])
    assert.equal(visibleEnemyIds(g, 0).size, 0)
    const g2 = createGame(m, mergeRules(rules1, { vision: { deadZone: false } }), [['gunner'], ['gunner']])
    assert.equal(visibleEnemyIds(g2, 0).size, 1)
    const g3 = createGame(m, mergeRules(rules1, { classes: { gunner: { sonar: 4 } } }), [['gunner'], ['gunner']])
    assert.equal(visibleEnemyIds(g3, 0).size, 1)
  },
  '観測: スカウトが見た敵はマークされ、次の手もビルの裏から見え続ける（毎手発動の設定）'() {
    const m = mapOf(['.......', '...#...', '.......'], [{ x: 0, y: 1 }], [{ x: 4, y: 0 }])
    const rules1 = mergeRules(DET, { teamSize: 1, skills: { markTrigger: 'always' } })
    const g = createGame(m, rules1, [['scout'], ['gunner']])
    // スカウト(0,1)から(4,0)は見える → マーク
    const ev = resolveTurn(g, [stay(g, 0), stay(g, 1)], createRng(1))
    assert.ok(ev.some((e) => e.type === 'mark'))
    // 敵がビルの裏(4,1)へ。ビルが視線を遮るが、マーク中なので見える
    resolveTurn(g, [stay(g, 0), [mv('1-0', 4, 1)]], createRng(1))
    assert.equal(g.intel[0]['1-0'].visible, false) // 次の手（3手目）にはマーク切れ
    const g2 = createGame(m, rules1, [['scout'], ['gunner']])
    resolveTurn(g2, [stay(g2, 0), stay(g2, 1)], createRng(1))
    g2.units[1].pos = { x: 4, y: 1 }
    assert.equal(visibleEnemyIds(g2, 0).size, 1) // 2手目の途中はマークで見える
  },
  '観測（既定）: 地上から屋上に登った手だけマークする'() {
    const m = mapOf(['.......', '.#.....', '.......'], [{ x: 1, y: 0 }], [{ x: 5, y: 1 }])
    const g = createGame(m, rules1, [['scout'], ['gunner']])
    // 地上に居続ける手はマークしない
    assert.ok(!resolveTurn(g, [stay(g, 0), stay(g, 1)], createRng(1)).some((e) => e.type === 'mark'))
    // 屋上に登った手はマークする
    assert.ok(resolveTurn(g, [[mv('0-0', 1, 1)], stay(g, 1)], createRng(1)).some((e) => e.type === 'mark'))
    // 屋上に居続ける手はマークしない
    assert.ok(!resolveTurn(g, [[mv('0-0', 1, 1)], stay(g, 1)], createRng(1)).some((e) => e.type === 'mark'))
  },
  '制圧: ガンナーが2発以上当てると次の手の移動力-1'() {
    const g = createGame(mapOf(open, [{ x: 0, y: 2 }], [{ x: 3, y: 2 }]), rules1, [['gunner'], ['attacker']])
    const ev = resolveTurn(g, [stay(g, 0, '1-0'), stay(g, 1)], createRng(1))
    assert.ok(ev.some((e) => e.type === 'suppress'))
    assert.equal(moveOf(g.rules, unit(g, '1-0'), g.turn), 2)
    assert.equal(moveOf(g.rules, unit(g, '1-0'), g.turn + 1), 3)
  },
  '狙撃態勢: 動かなければ命中率+15・遮蔽半減'() {
    const m = mapOf(['.......', '.......', '.......', '...#...', '.......', '.......', '.......'], [{ x: 0, y: 0 }], [{ x: 6, y: 6 }])
    const S = DEFAULT_RULES.classes.sniper
    // 北西から (4,3) を狙う: 90 − 25 = 65、隠れ 0.4 → −16（態勢なら −8）
    assert.equal(hitChance(m, DEFAULT_RULES, S, { x: 1, y: 0 }, { x: 4, y: 3 }).chance, 49)
    assert.equal(hitChance(m, DEFAULT_RULES, S, { x: 1, y: 0 }, { x: 4, y: 3 }, { stationary: true }).chance, 65 + 15 - 8)
  },
  'カバーリング: 支援中の防護兵が隣の味方への命中弾を肩代わり'() {
    const g = createGame(mapOf(open, [{ x: 0, y: 2 }], [{ x: 3, y: 2 }, { x: 4, y: 2 }]), mergeRules(rules2, { teamSize: 2 }), [['sniper', 'sniper'], ['gunner', 'guardian']])
    g.units[1].pos = { x: 0, y: 3 }
    const ev = resolveTurn(g, [stay(g, 0, '1-0'), [mv('1-0', 3, 2), mv('1-1', 4, 2)]], createRng(1))
    const a = ev.find((e) => e.type === 'attack' && e.hitId === '1-0')!
    assert.ok(a.type === 'attack' && a.shots.every((x) => x.guardedBy === '1-1'))
    assert.equal(unit(g, '1-0').hp, 22)
    // round(20²/(20+18)) = 11 → ×0.7 = 7.7 → 8 を2発
    assert.equal(unit(g, '1-1').hp, 30 - 16)
  },
  'カバーリング: 高さが違う味方（屋上と地上）は庇えない'() {
    const m = mapOf(['.......', '....#..', '.......'], [{ x: 0, y: 1 }, { x: 0, y: 2 }], [{ x: 3, y: 1 }, { x: 4, y: 1 }])
    const g = createGame(m, rules2, [['sniper', 'sniper'], ['gunner', 'guardian']])
    const ev = resolveTurn(g, [stay(g, 0, '1-0'), [mv('1-0', 3, 1), mv('1-1', 4, 1)]], createRng(1))
    const a = ev.find((e) => e.type === 'attack' && e.hitId === '1-0')!
    assert.ok(a.type === 'attack' && a.shots.every((x) => !x.guardedBy))
  },
  '応急手当: 回復範囲は healRange'() {
    const g = createGame(mapOf(open, [{ x: 1, y: 1 }, { x: 3, y: 3 }], [{ x: 6, y: 4 }, { x: 6, y: 0 }]), mergeRules(rules2, { classes: { medic: { healRange: 2 } } }), [['medic', 'attacker'], ['gunner', 'gunner']])
    g.units[1].hp = 10
    resolveTurn(g, [stay(g, 0), stay(g, 1)], createRng(1))
    assert.equal(unit(g, '0-1').hp, 16)
  },
  '応急手当: 支援中の衛生兵が周囲8マスの味方を回復'() {
    const g = createGame(mapOf(open, [{ x: 1, y: 1 }, { x: 2, y: 2 }], [{ x: 6, y: 4 }, { x: 6, y: 0 }]), rules2, [['medic', 'attacker'], ['gunner', 'gunner']])
    g.units[1].hp = 10
    const ev = resolveTurn(g, [stay(g, 0), stay(g, 1)], createRng(1))
    assert.ok(ev.some((e) => e.type === 'heal'))
    assert.equal(unit(g, '0-1').hp, 16)
    // 狙いを付けると回復しない
    g.units[1].hp = 10
    resolveTurn(g, [[mv('0-0', 1, 1, '1-0'), mv('0-1', 2, 2)], stay(g, 1)], createRng(1))
    assert.equal(unit(g, '0-1').hp, 10)
  },
  'ビルに張り付いた地上の敵は屋上から撃てない'() {
    const m = mapOf(['.#.....', '.......'], [{ x: 1, y: 0 }], [{ x: 2, y: 0 }])
    const g = createGame(m, rules1, [['gunner'], ['attacker']])
    let ev = resolveTurn(g, [stay(g, 0, '1-0'), stay(g, 1)], createRng(1))
    assert.equal(ev.find((e) => e.type === 'noshot')?.type === 'noshot' && (ev.find((e) => e.type === 'noshot') as any).reason, 'cover')
    g.units[1].pos = { x: 3, y: 0 } // 1マス離れれば撃てる
    ev = resolveTurn(g, [stay(g, 0, '1-0'), stay(g, 1)], createRng(1))
    assert.equal(unit(g, '1-0').hp, 16)
    // 地上からなら張り付いていても撃てる
    const g2 = createGame(m, rules1, [['gunner'], ['attacker']])
    g2.units[0].pos = { x: 4, y: 0 }
    resolveTurn(g2, [stay(g2, 0, '1-0'), stay(g2, 1)], createRng(1))
    assert.equal(unit(g2, '1-0').hp, 16)
    // ルールで無効化
    const g3 = createGame(m, mergeRules(rules1, { cover: { wallHug: false } }), [['gunner'], ['attacker']])
    resolveTurn(g3, [stay(g3, 0, '1-0'), stay(g3, 1)], createRng(1))
    assert.equal(unit(g3, '1-0').hp, 16)
  },
  '屋上から撃てないのは自分のビルの真下だけ。他のビルに張り付いた敵は遮蔽つきで撃てる'() {
    // (0,0) の屋上から、(3,2) のビルに張り付いた (4,2) の敵を撃つ。射線はビルの角をかすめるだけ
    const m = mapOf(['#.....', '......', '...#..'], [{ x: 0, y: 0 }], [{ x: 4, y: 2 }])
    assert.equal(strikeCheck(m, DEFAULT_RULES, { x: 0, y: 0 }, { x: 4, y: 2 }, 8), null)
    assert.equal(coverFrom(m, { x: 0, y: 0 }, { x: 4, y: 2 }), 'half')
    // 自分のビルの真下は撃てない
    assert.equal(strikeCheck(m, DEFAULT_RULES, { x: 0, y: 0 }, { x: 1, y: 0 }, 8), 'cover')
  },
  '擲弾兵の曲射はビル越しに届き、爆風で上下左右の敵も巻き込む'() {
    const m = mapOf(['...#...', '.......', '.......'], [{ x: 1, y: 0 }], [{ x: 5, y: 0 }])
    assert.equal(strikeCheck(m, DEFAULT_RULES, { x: 1, y: 0 }, { x: 5, y: 0 }, 4), 'blocked')
    assert.equal(strikeCheck(m, DEFAULT_RULES, { x: 1, y: 0 }, { x: 5, y: 0 }, 4, false, true), null)
    // 爆風: 狙った敵(4,1)の上(4,0)の敵にも 60%。斜め(5,2)は巻き込まない
    const g = createGame(mapOf(open, [{ x: 0, y: 1 }, { x: 0, y: 2 }, { x: 0, y: 3 }], [{ x: 6, y: 1 }, { x: 6, y: 2 }, { x: 6, y: 3 }]), mergeRules(DET, { teamSize: 3, skills: { arcGround: false }, classes: { grenadier: { atk: 12 } } as any }), [['grenadier', 'scout', 'scout'], ['scout', 'gunner', 'gunner']])
    unit(g, '0-0').pos = { x: 1, y: 1 }
    unit(g, '1-0').pos = { x: 4, y: 1 }
    unit(g, '1-1').pos = { x: 4, y: 0 }
    unit(g, '1-2').pos = { x: 5, y: 2 }
    const ev = resolveTurn(g, [[mv('0-0', 1, 1, '1-0'), mv('0-1', 0, 2), mv('0-2', 0, 3)], stay(g, 1)], createRng(1))
    const a = ev.find((e) => e.type === 'attack' && e.unitId === '0-0')
    assert.ok(a && a.type === 'attack')
    assert.equal(unit(g, '1-0').hp, 16 - 8) // round(12²/(12+6)) = 8
    assert.equal(unit(g, '1-1').hp, 22 - 4) // round(round(12²/(12+8)) × 0.6) = round(7 × 0.6) = 4
    assert.equal(unit(g, '1-2').hp, 22)
    assert.deepEqual(a.splash?.map((x) => x.id), ['1-1'])
  },
  'ジャマーが登って妨害した敵は、その手からスキルが使えない（防護兵が庇えない）'() {
    const m = mapOf(['.#.....', '.......', '.......'], [{ x: 0, y: 0 }, { x: 2, y: 1 }], [{ x: 4, y: 0 }, { x: 4, y: 1 }])
    const play = (silence: boolean) => {
      const g = createGame(m, mergeRules(rules2, { skills: { jamSilence: silence } }), [['jammer', 'gunner'], ['guardian', 'scout']])
      const ev = resolveTurn(g, [[mv('0-0', 1, 0), mv('0-1', 2, 1, '1-1')], stay(g, 1)], createRng(1))
      assert.ok(ev.some((e) => e.type === 'jam'))
      const a = ev.find((e) => e.type === 'attack' && e.unitId === '0-1')
      return a && a.type === 'attack' ? a.shots.filter((x) => x.guardedBy).length : -1
    }
    assert.ok(play(false) > 0)
    assert.equal(play(true), 0)
  },
  'レーダー塔の上で手を終えると、次の手は敵全員が見える'() {
    const m: MapDef = { ...mapOf(['.......', '.#.....', '.......', '...#...', '.......', '.....#.', '.......'], [{ x: 0, y: 6 }], [{ x: 6, y: 0 }]), radars: [{ x: 1, y: 1 }, { x: 5, y: 5 }] }
    const g = createGame(m, mergeRules(rules1, { radar: true }), [['gunner'], ['sniper']])
    unit(g, '0-0').pos = { x: 1, y: 2 }
    unit(g, '1-0').pos = { x: 6, y: 6 }
    resolveTurn(g, [stay(g, 0), stay(g, 1)], createRng(1))
    assert.ok(!visibleEnemyIds(g, 0).has('1-0'))
    const ev = resolveTurn(g, [[mv('0-0', 1, 1)], stay(g, 1)], createRng(1))
    assert.ok(ev.some((e) => e.type === 'radar' && e.unitId === '0-0'))
    assert.ok(visibleEnemyIds(g, 0).has('1-0'))
    assert.equal(observe(g, 0).enemies.find((e) => e.unitId === '1-0')?.visible, true)
    // 降りれば次の手の終わりで切れる
    resolveTurn(g, [[mv('0-0', 1, 2)], stay(g, 1)], createRng(1))
    assert.ok(!visibleEnemyIds(g, 0).has('1-0'))
    // ルールで無効化
    const g2 = createGame(m, mergeRules(rules1, { radar: false }), [['gunner'], ['sniper']])
    unit(g2, '0-0').pos = { x: 1, y: 2 }
    unit(g2, '1-0').pos = { x: 6, y: 6 }
    resolveTurn(g2, [[mv('0-0', 1, 1)], stay(g2, 1)], createRng(1))
    assert.ok(!visibleEnemyIds(g2, 0).has('1-0'))
  },
  '擲弾兵はマスを狙う。命中判定なしでそのマスに落ち、敵が動けば外れる'() {
    const m = mapOf(['...#...', '.......', '.......'], [{ x: 1, y: 0 }, { x: 0, y: 2 }], [{ x: 5, y: 0 }, { x: 6, y: 2 }])
    // 命中率の上下限を外しても（minHit 0）当たる＝命中判定がない
    const R2 = mergeRules(rules2, { combat: { minHit: 0, maxHit: 0 }, classes: { grenadier: { atk: 12 } } as any })
    const g = createGame(m, R2, [['grenadier', 'scout'], ['gunner', 'gunner']])
    unit(g, '1-1').pos = { x: 5, y: 1 }
    // ビル越しに (5,0) へ撃ち込む。(5,0) に直撃、真下の (5,1) に爆風
    let ev = resolveTurn(g, [[{ unitId: '0-0', dest: { x: 1, y: 0 }, targetPos: { x: 5, y: 0 } }, mv('0-1', 0, 2)], stay(g, 1)], createRng(1))
    const b = ev.find((e) => e.type === 'bombard')
    assert.ok(b && b.type === 'bombard')
    assert.deepEqual(b.hits.map((x) => [x.id, x.direct]), [['1-0', true], ['1-1', false]])
    assert.equal(unit(g, '1-0').hp, 22 - 7) // round(12²/(12+8)) = 7
    // 敵が動けば外れる
    const hp = unit(g, '1-0').hp
    ev = resolveTurn(g, [[{ unitId: '0-0', dest: { x: 1, y: 0 }, targetPos: { x: 5, y: 0 } }, mv('0-1', 0, 2)], [mv('1-0', 6, 1), mv('1-1', 6, 2)]], createRng(1))
    const b2 = ev.find((e) => e.type === 'bombard')
    assert.ok(b2 && b2.type === 'bombard' && b2.hits.length === 0)
    assert.equal(unit(g, '1-0').hp, hp)
    // 射程外のマスは撃てない
    ev = resolveTurn(g, [[{ unitId: '0-0', dest: { x: 0, y: 0 }, targetPos: { x: 6, y: 2 } }, mv('0-1', 0, 2)], stay(g, 1)], createRng(1))
    assert.ok(ev.some((e) => e.type === 'noshot' && e.unitId === '0-0' && e.reason === 'range'))
  },
  '捕縛師は狙った敵を、自分が移動前にいたマスへ放り投げる（攻撃の順番で）'() {
    const g = createGame(mapOf(open, [{ x: 0, y: 2 }], [{ x: 6, y: 2 }]), rules1, [['binder'], ['gunner']])
    unit(g, '0-0').pos = { x: 1, y: 2 }
    unit(g, '1-0').pos = { x: 5, y: 2 }
    // (1,2) → (3,2) に動いて、射程2の (5,2) の敵を (1,2) へ
    const ev = resolveTurn(g, [[mv('0-0', 3, 2, '1-0')], stay(g, 1)], createRng(1))
    assert.ok(ev.some((e) => e.type === 'bind' && e.targetId === '1-0'))
    assert.deepEqual(unit(g, '1-0').pos, { x: 1, y: 2 })
    assert.equal(unit(g, '1-0').hp, 22)
    // 動かなければ使えない
    const ev2 = resolveTurn(g, [[mv('0-0', 3, 2, '1-0')], stay(g, 1)], createRng(1))
    assert.ok(ev2.some((e) => e.type === 'noshot' && e.reason === 'stayed'))
  },
  '遮蔽兵のフィールドは、通る視線と射線を遮る（屋上からでも）。中の駒は隣からしか見えない'() {
    const g = createGame(mapOf(open, [{ x: 0, y: 2 }, { x: 0, y: 3 }], [{ x: 6, y: 2 }, { x: 6, y: 3 }]), rules2, [['screener', 'gunner'], ['gunner', 'scout']])
    unit(g, '0-1').pos = { x: 2, y: 2 }
    unit(g, '1-0').pos = { x: 5, y: 2 }
    unit(g, '1-1').pos = { x: 3, y: 4 }
    // 遮蔽兵が (3,2) を中心に張る → (2..4, 1..3) が遮蔽。敵ガンナー (5,2) は味方ガンナー (2,2) を撃てない
    const ev = resolveTurn(g, [[{ unitId: '0-0', dest: { x: 0, y: 2 }, targetPos: { x: 3, y: 2 } }, mv('0-1', 2, 2)], [mv('1-0', 5, 2, '0-1'), mv('1-1', 3, 4)]], createRng(1))
    assert.ok(ev.some((e) => e.type === 'veil'))
    assert.ok(ev.some((e) => e.type === 'noshot' && e.unitId === '1-0'))
    assert.equal(unit(g, '0-1').hp, 22)
    assert.ok(!visibleEnemyIds(g, 1).has('0-1'))
    // 期限（張った手と次の手）が過ぎれば消える
    resolveTurn(g, [stay(g, 0), stay(g, 1)], createRng(1))
    assert.equal(g.veils?.length, 0)
    assert.ok(!g.map.veil)
  },
  '張り付きの制限は射撃だけ。近接クラスは屋上から真下の敵を攻撃できる'() {
    const m = mapOf(['.#.....', '.......'], [{ x: 1, y: 0 }], [{ x: 2, y: 0 }])
    const g = createGame(m, rules1, [['attacker'], ['gunner']])
    const hp0 = unit(g, '1-0').hp
    const ev = resolveTurn(g, [stay(g, 0, '1-0'), stay(g, 1)], createRng(1))
    assert.ok(!ev.some((e) => e.type === 'noshot'))
    assert.ok(unit(g, '1-0').hp < hp0)
  },
  '後送: 衛生兵は移動前に隣にいた傷ついた味方を、交戦の後で自分の隣へ連れ戻す'() {
    const r = mergeRules(rules2, { classes: { medic: { evac: true } } })
    const g = createGame(mapOf(open, [{ x: 2, y: 2 }, { x: 3, y: 2 }], [{ x: 6, y: 0 }, { x: 6, y: 4 }]), r, [['medic', 'attacker'], ['gunner', 'gunner']])
    unit(g, '0-1').hp = 10
    const ev = resolveTurn(g, [[mv('0-0', 0, 2), mv('0-1', 3, 2)], stay(g, 1)], createRng(1))
    const e = ev.find((x) => x.type === 'evac')
    assert.ok(e && e.type === 'evac' && e.allyId === '0-1')
    assert.ok(chebyshev(unit(g, '0-1').pos, unit(g, '0-0').pos) <= 1)
    assert.ok(unit(g, '0-1').hp > 10)
  },
  '隠密: 屋上から降りた手は、敵から見つかる距離が下がる'() {
    const m = mapOf(['.#.....', '.......'], [{ x: 1, y: 0 }], [{ x: 6, y: 1 }])
    const base = mergeRules(rules1, { classes: { scout: { sonar: 0 }, gunner: { vision: 5 } } })
    const seen = (r: typeof base) => {
      const g = createGame(m, r, [['scout'], ['gunner']])
      resolveTurn(g, [[mv('0-0', 1, 1)], stay(g, 1)], createRng(1))
      return visibleEnemyIds(g, 1).has('0-0')
    }
    assert.equal(seen(base), true)
    assert.equal(seen(mergeRules(base, { classes: { scout: { stealth: 3 } } })), false)
  },
  '妨害: ジャマーが地上から屋上に登った手、見えている敵の視界と命中率が下がる'() {
    const m = mapOf(['.......', '.#.....', '.......'], [{ x: 1, y: 0 }], [{ x: 5, y: 1 }])
    const g = createGame(m, rules1, [['jammer'], ['sniper']])
    const ev = resolveTurn(g, [[mv('0-0', 1, 1)], stay(g, 1)], createRng(1))
    assert.ok(ev.some((e) => e.type === 'jam' && e.targets.includes('1-0')))
    const S = unit(g, '1-0')
    assert.ok(S.jammedUntil >= g.turn)
    // 命中率が jamAcc だけ下がる
    const c = DEFAULT_RULES.classes.sniper
    const a = hitChance(m, DEFAULT_RULES, c, { x: 5, y: 1 }, { x: 2, y: 1 }).chance
    const b = hitChance(m, DEFAULT_RULES, c, { x: 5, y: 1 }, { x: 2, y: 1 }, { jammed: true }).chance
    assert.equal(a - b, DEFAULT_RULES.skills.jamAcc)
    // 屋上に居続けた手は発動しない
    const ev2 = resolveTurn(g, [[mv('0-0', 1, 1)], stay(g, 1)], createRng(1))
    assert.ok(!ev2.some((e) => e.type === 'jam'))
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
      const ev = resolveTurn(g, [stay(g, 0, '1-0'), stay(g, 1)], createRng(1))
      return ev.find((e) => e.type === 'attack' && e.unitId === '0-0')
    }
    const hit = run(true)
    assert.ok(hit && hit.type === 'attack' && hit.spotted)
    assert.equal(run(false), undefined)
  },
  'スナイパーは2マス以上動くと撃てない'() {
    const g = createGame(mapOf(open, [{ x: 0, y: 2 }], [{ x: 6, y: 2 }]), rules1, [['sniper'], ['attacker']])
    resolveTurn(g, [[mv('0-0', 2, 2, '1-0')], stay(g, 1)], createRng(1))
    assert.equal(unit(g, '1-0').hp, 28)
    resolveTurn(g, [[mv('0-0', 2, 2, '1-0')], stay(g, 1)], createRng(1))
    assert.equal(unit(g, '1-0').hp, 15)
  },
  '狙っていなければ撃たない'() {
    const g = createGame(mapOf(open, [{ x: 2, y: 2 }], [{ x: 3, y: 2 }]), rules1, [['gunner'], ['scout']])
    resolveTurn(g, [stay(g, 0), stay(g, 1)], createRng(1))
    assert.equal(unit(g, '1-0').hp, 16)
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
    const rec: GameRecord = { version: 4, seed, map: 'city9', comps: [['attacker', 'gunner', 'sniper', 'scout'], ['attacker', 'attacker', 'gunner', 'scout']], rules: DEFAULT_RULES, turns: [] }
    const g = createGame(getMap(rec.map), DEFAULT_RULES, rec.comps)
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
