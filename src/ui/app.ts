import { AI_PRESETS, CPU_COMPS, decideOrders } from '../engine/ai.ts'
import { attackRange, canFireAfterMove, canSee, canStrike, classOf, isMeleeClass, createGame, gameResult, observe, reachableFor, resolveTurn, strikeCheck } from '../engine/game.ts'
import { allPositions, key, samePos, shortestPath, terrainId } from '../engine/grid.ts'
import { MAPS } from '../engine/maps.ts'
import { RECORD_VERSION, type GameRecord } from '../engine/record.ts'
import { seedStreams, type Rng } from '../engine/rng.ts'
import { DEFAULT_RULES } from '../engine/rules.ts'
import type { GameEvent, GameState, Intel, MapDef, Order, Pos, StrikeBlock, Unit, UnitClass, VictoryMode } from '../engine/types.ts'
import { Board3D, type PieceSpec, type PlanSpec, type TileMark } from './board3d.ts'
import { damageRange, hitChance } from '../engine/combat.ts'

const rules = DEFAULT_RULES
const root = document.querySelector<HTMLDivElement>('#app')!
const MODE_LABEL: Record<VictoryMode, string> = { annihilation: '全滅', killCount: '撃破数', killCost: '撃破コスト' }
/** クラスのパッシブスキル説明 */
function skillText(c: UnitClass): string {
  const t: string[] = []
  if (c.pursuit) t.push('追撃: 狙った敵の移動先に詰める')
  if (c.markOnSight) t.push(`観測: ${rules.skills.markTrigger === 'climb' ? '地上から屋上に登った手、' : ''}見えている敵をマーク（次の手まで味方から見え、命中+${rules.skills.markAccBonus}）`)
  if (c.sonar) t.push(`透視: ${c.sonar}マス以内は建物越しに見える`)
  if (c.suppress) t.push('制圧射撃: 2発以上当てた敵の移動-1・命中-15')
  if (c.steadyAim) t.push('狙撃態勢: 動かなければ命中+15・遮蔽半減')
  if (c.heal) t.push(`応急手当: 狙わない手は周囲8マスの味方を${c.heal}回復`)
  if (c.jamOnClimb) t.push(`妨害: 地上から屋上に登った手、見えている敵の視界-${rules.skills.jamVision}・命中率-${rules.skills.jamAcc}${rules.skills.jamSilence ? '・スキル無効' : ''}（次の手まで）`)
  if (c.evac) t.push('後送: 狙わない手は、移動前に隣にいた一番傷の深い味方を交戦の後で自分の隣へ連れ戻す')
  if (c.stealth) t.push(`隠密: ${rules.skills.stealthTrigger === 'descend' ? '屋上から降りた手' : '狙わない手'}と次の手は、敵から見つかる距離-${c.stealth}`)
  if (c.arc) t.push('曲射: ビル越しに撃て、遮蔽を無視する（味方が見ている敵なら狙える）')
  if (c.blast) t.push(`爆風: 当たると、狙った敵の${rules.skills.blastShape === 'square' ? '周囲8マス' : '上下左右'}の敵にも${Math.round(c.blast * 100)}%のダメージ。防護兵は庇えない`)
  if (c.guardReduce) t.push(`カバーリング: 狙わない手は周囲8マスの味方の被弾を肩代わり（-${Math.round(c.guardReduce * 100)}%）`)
  if (c.closePenalty) t.push(`懐に弱い: 隣接した敵への命中-${c.closePenalty}`)
  return t.join(' ／ ')
}

const BLOCK_LABEL: Record<StrikeBlock, string> = {
  range: '射程外',
  blocked: '射線上にビル',
  cover: '真下（自分のビルに張り付き）',
  moved: '移動しすぎ',
  unseen: '見失った',
  gone: '既に撃破',
  down: '撃つ前に撃破された',
}

const h = (tag: string, attrs: Record<string, any> = {}, ...children: (Node | string | null | false)[]) => {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v)
    else if (k === 'class') el.className = v
    else if (k === 'style') el.setAttribute('style', v)
    else el.setAttribute(k, String(v))
  }
  for (const c of children) if (c !== null && c !== false) el.append(c)
  return el
}

// ---------------- 編成画面 ----------------
let lastComp: string[] = ['attacker', 'gunner', 'sniper', 'scout']
let lastMap = MAPS[0].id

export function showSetup() {
  const comp = [...lastComp]
  let mapId = lastMap
  const render = () => {
    root.replaceChildren(
      h(
        'div',
        { class: 'setup' },
        h('h1', {}, 'Border Tactics'),
        h('p', { class: 'sub' }, '情報戦 × 地形 の同時ターン制タクティクス'),
        h('h2', {}, 'フィールド'),
        h('div', { class: 'row' }, ...MAPS.map((m) => h('button', { class: `chip ${m.id === mapId ? 'on' : ''}`, onclick: () => ((mapId = m.id), render()) }, m.name))),
        miniMap(MAPS.find((m) => m.id === mapId)!),
        h('h2', {}, `編成（${comp.length}/${rules.teamSize}）`),
        h(
          'div',
          { class: 'slots' },
          ...Array.from({ length: rules.teamSize }, (_, i) =>
            h('button', { class: 'slot', onclick: () => (comp.splice(i, 1), render()) }, comp[i] ? h('span', { class: 'pico' }, rules.classes[comp[i]].short) : '＋'),
          ),
        ),
        h(
          'div',
          { class: 'classes' },
          ...Object.values(rules.classes).map((c) =>
            h(
              'button',
              {
                class: 'classcard',
                onclick: () => (comp.length < rules.teamSize && comp.filter((x) => x === c.id).length < rules.skills.maxPerClass && comp.push(c.id), render()),
              },
              h('span', { class: 'pico' }, c.short),
              h('b', {}, c.name),
              h('small', { class: 'skill' }, skillText(c)),
              h(
                'small',
                {},
                `HP${c.hp} 攻${c.atk} 守${c.def} 速${c.spd}${c.shots > 1 ? ` ${c.shots}連射` : ''} ／ 移${c.move} 射${c.range} 視${c.vision} 命中${c.accuracy}%${c.falloff ? `(-${c.falloff}/マス)` : ''} ／ コスト${c.cost}${c.attackMaxMove < 10 ? ` ※${c.attackMaxMove + 1}マス以上動くと撃てない` : ''}`,
              ),
            ),
          ),
        ),
        h('button', { class: 'primary', onclick: () => comp.length === rules.teamSize && start() }, comp.length === rules.teamSize ? '出撃' : `あと${rules.teamSize - comp.length}体選んでください`),
        h('button', { class: 'link', onclick: showHelp }, 'ルール説明'),
      ),
    )
  }
  const start = () => {
    lastComp = [...comp]
    lastMap = mapId
    const seed = Math.floor(Math.random() * 1e9)
    const cpuComp = seedStreams(seed).setup.pick(CPU_COMPS)
    new Battle(MAPS.find((m) => m.id === mapId)!, [comp, [...cpuComp]], seed)
  }
  render()
}

function miniMap(map: MapDef) {
  const el = h('div', { class: 'minimap', style: `grid-template-columns: repeat(${map.width}, 1fr)` })
  const spawn = (p: Pos, s: 0 | 1) => map.spawns[s].some((q) => samePos(p, q))
  for (const p of allPositions(map)) el.append(h('i', { class: `t-${terrainId(map, p)} ${spawn(p, 0) ? 's-me' : spawn(p, 1) ? 's-en' : ''}` }))
  return el
}

function showHelp() {
  const modal = h(
    'div',
    { class: 'modal', onclick: (e: Event) => e.target === modal && modal.remove() },
    h(
      'div',
      { class: 'sheet' },
      h('h2', {}, 'ルール'),
      h(
        'ul',
        {},
        h('li', {}, '両軍が同時に「移動先」と「狙う敵」を決め、一斉に動きます。'),
        h('li', {}, '狙う敵は、今見えている敵から選びます。移動後にその敵が射程内・射線が通っていて、味方の誰かに見えていれば命中します。偵察で見つけた敵を後衛が撃てます。'),
        h('li', {}, '遮蔽: 射線上にビルがあると撃てません（屋上からでも）。屋上から、こちら側の壁に張り付いている地上の敵は撃てません。'),
        h('li', {}, '交戦は「速」の高い順。先に撃破されたユニットは撃てません。撃ったユニットは位置が相手にバレます。'),
        h('li', {}, 'ダメージ = 攻² ÷ (攻 + 守) ± 15%。ガンナーは小さな弾を3連射。'),
        h('li', {}, '命中率は距離が遠いほど下がり、相手がこちら側のビルに張り付いていると（遮蔽:半）、斜め側にビルがあると（遮蔽:小）さらに下がります。屋上から撃つと上がります。'),
        h('li', {}, '同じマスに入ろうとすると弾かれて元の位置に戻ります。敵とぶつかると互いの位置がバレます。'),
        h('li', {}, 'ビル: 地上の視線を遮る。登ると（移動コスト2）視界+2・射程+1、ビル越しに「見る」ことはできる。'),
        ...(rules.radar ? [h('li', {}, '📡 レーダー塔（アンテナの立ったビル）: 手の終わりに上にいると、次の手は敵全員の位置が見えます（撃てる相手も増えます）。')] : []),
        h('li', {}, '盤面: ピンチ / ホイール / ＋－ボタンでズーム、ズーム中はドラッグで移動。'),
        h('li', {}, 'スナイパーは2マス以上動いたターンは撃てません（矢印が橙色になります）。'),
        h('li', {}, `勝敗: ${rules.turnLimit}手終了時の撃破コスト合計（全滅で即終了）。`),
        h('li', {}, '見えていない敵は「最後に見た位置」が半透明の駒で表示されます。'),
      ),
      h('button', { class: 'primary', onclick: () => modal.remove() }, '閉じる'),
    ),
  )
  document.body.append(modal)
}

// ---------------- 戦闘画面 ----------------
class Battle {
  map: MapDef
  comps: [string[], string[]]
  seed: number
  state: GameState
  orders = new Map<string, Order>()
  selected: string | null = null
  busy = false
  turns: [Order[], Order[]][] = []
  logLines: string[] = []
  board: Board3D
  panel: HTMLDivElement
  header: HTMLDivElement
  logEl: HTMLDivElement
  aiRng: Rng
  resolveRng: Rng
  /** 直前に表示した敵情報（演出中のHP表示に使う。プレイヤーが既に知っている情報のみ） */
  shownIntel: Record<string, Intel> = {}
  /** 移動の途中で見失った敵の、最後に見えたマス（エンジンの目撃情報より新しいときだけ使う） */
  lastSeen = new Map<string, { pos: Pos; turn: number }>()

  constructor(map: MapDef, comps: [string[], string[]], seed: number) {
    this.map = map
    this.comps = comps
    this.seed = seed
    const streams = seedStreams(seed)
    this.aiRng = streams.ai
    this.resolveRng = streams.resolve
    this.state = createGame(map, rules, comps)

    this.header = h('div', { class: 'hud' }) as HTMLDivElement
    const stage = h('div', { class: 'stage' }) as HTMLDivElement
    this.panel = h('div', { class: 'panel' }) as HTMLDivElement
    this.logEl = h('div', { class: 'log' }) as HTMLDivElement
    root.replaceChildren(h('div', { class: 'battle' }, this.header, stage, this.panel, this.logEl))
    // レーダー塔を使わないルールなら、塔のアンテナも出さない
    this.board = new Board3D(stage, rules.radar ? map : { ...map, radars: undefined })
    this.captionEl = h('div', { class: 'caption' }) as HTMLDivElement
    this.captionEl.hidden = true
    stage.append(this.captionEl)
    this.board.onTap = (p) => this.tap(p)
    // デバッグ用（自動テストから使う）
    ;(window as any).__bt = {
      tileToScreen: (x: number, y: number) => this.board.tileToScreen({ x, y }),
      battle: this,
      autoPlan: () => {
        for (const o of decideOrders(observe(this.state, 0), seedStreams(this.state.turn).ai, AI_PRESETS.cpu)) this.orders.set(o.unitId, o)
        this.render()
      },
    }

    this.log(`敵編成: ${comps[1].map((c) => rules.classes[c].name).join('・')}`)
    this.render()
  }

  me() {
    return this.state.units.filter((u) => u.alive && u.side === 0)
  }
  destOf(u: Unit): Pos {
    return this.orders.get(u.id)?.dest ?? u.pos
  }

  targetIntel(u: Unit): Intel | undefined {
    const id = this.orders.get(u.id)?.target
    return id ? this.shownIntel[id] : undefined
  }

  /** 敵がその場に留まった場合に、移動先から撃てるかの予測 */
  predictBlock(u: Unit): StrikeBlock | null {
    const t = this.targetIntel(u)
    if (!t) return null
    const d = this.destOf(u)
    if (!canFireAfterMove(rules, u, d)) return 'moved'
    return strikeCheck(this.map, rules, d, t.pos, attackRange(this.map, rules, u.cls, d), isMeleeClass(rules, u.cls), classOf(rules, u).arc)
  }

  /** 敵が留まった場合の命中率・ダメージ予測 */
  predictText(u: Unit, t: Intel): string {
    const c = classOf(rules, u)
    const tc = rules.classes[t.cls]
    const { chance, coverPenalty } = hitChance(this.map, rules, c, this.destOf(u), t.pos)
    const [lo, hi] = damageRange(rules, c.atk, tc.def, c.pen)
    const coverText = coverPenalty > 0 ? `（ビルに隠れて −${coverPenalty}）` : ''
    return `狙い: 敵${tc.name} — 命中率${chance}%${coverText} × ${c.shots}発、1発${lo === hi ? lo : `${lo}〜${hi}`}ダメージ（速${c.spd} vs ${tc.spd}）`
  }

  log(s: string) {
    this.logLines.unshift(s)
    this.logEl.replaceChildren(...this.logLines.slice(0, 40).map((l) => h('div', {}, l)))
  }

  tap(p: Pos) {
    if (this.busy || this.state.over) return
    const mine = this.me()
    const sel = mine.find((u) => u.id === this.selected)
    const here = mine.find((u) => samePos(u.pos, p))
    if (sel) {
      // 選択中の駒をもう一度タップ → 命令取り消し（2回目で選択解除）
      if (here?.id === sel.id) {
        if (!samePos(this.destOf(sel), sel.pos)) this.orders.delete(sel.id)
        else this.selected = null
        return this.render()
      }
      // 見えている敵をタップ → 狙う（もう一度で解除）
      const enemy = Object.values(this.shownIntel).find((i) => i.visible && samePos(i.pos, p))
      if (enemy) {
        const cur = this.orders.get(sel.id)
        this.orders.set(sel.id, { unitId: sel.id, dest: this.destOf(sel), target: cur?.target === enemy.unitId ? undefined : enemy.unitId })
        return this.render()
      }
      const reach = reachableFor(this.map, rules, sel, this.state.turn)
      const plannedHere = mine.some((u) => u.id !== sel.id && samePos(this.destOf(u), p))
      if (reach.has(key(p)) && !plannedHere) {
        this.orders.set(sel.id, { unitId: sel.id, dest: p, target: this.orders.get(sel.id)?.target })
        return this.render()
      }
    }
    this.selected = here ? here.id : null
    this.render()
  }

  pieceSpecs(intel: Record<string, Intel>, hpOverride?: Map<string, number>): PieceSpec[] {
    const s = this.state
    const specs: PieceSpec[] = []
    for (const u of s.units) {
      if (u.side !== 0 || (!u.alive && !hpOverride?.has(u.id))) continue
      const c = classOf(rules, u)
      specs.push({ id: u.id, side: 0, cls: u.cls, letter: c.short, kanji: c.kanji, hp: hpOverride?.get(u.id) ?? u.hp, maxHp: c.hp, pos: u.pos, selected: u.id === this.selected })
    }
    // 敵は intel（自軍から分かっている情報）だけから描く
    const selTarget = this.selected ? this.orders.get(this.selected)?.target : undefined
    for (const i of Object.values(intel)) {
      const c = rules.classes[i.cls]
      const lost = this.lastSeen.get(i.unitId)
      const seenTurn = !i.visible && lost && lost.turn >= i.turn ? lost.turn : i.turn
      const age = s.turn - 1 - seenTurn
      specs.push({
        id: i.unitId,
        side: 1,
        cls: i.cls,
        letter: c.short,
        kanji: c.kanji,
        targeted: !hpOverride && i.unitId === selTarget,
        hp: i.visible ? i.hp : null,
        maxHp: c.hp,
        pos: !i.visible && lost && lost.turn >= i.turn ? lost.pos : i.pos,
        ghost: !i.visible,
        marked: !!i.marked,
        label: i.visible ? undefined : seenTurn === 0 ? '初期位置' : age <= 0 ? '直前' : `${age}手前`,
      })
    }
    return hideCoveredGhosts(specs)
  }

  /** 自軍の駒の位置から見えないマスを霧にする */
  fogMarks(mine: { cls: string; pos: Pos }[], marks = new Map<string, Set<TileMark>>()) {
    for (const p of allPositions(this.map)) {
      if (mine.some((u) => samePos(u.pos, p) || canSee(this.map, rules, u.cls, u.pos, p))) continue
      if (!marks.has(key(p))) marks.set(key(p), new Set())
      marks.get(key(p))!.add('fog')
    }
    return marks
  }

  intelMap(): Record<string, Intel> {
    return observe(this.state, 0).enemies.reduce<Record<string, Intel>>((a, i) => ((a[i.unitId] = i), a), {})
  }

  render() {
    const s = this.state
    this.header.replaceChildren(
      h('span', {}, `${Math.min(s.turn, rules.turnLimit)}手目 / ${rules.turnLimit}`),
      h('span', { class: 'score' }, h('b', { class: 'c-me' }, String(s.killCost[0])), ' - ', h('b', { class: 'c-en' }, String(s.killCost[1]))),
      h('span', {}, `敵残 ${s.units.filter((u) => u.alive && u.side === 1).length}`),
      ...((s.radarUntil?.[0] ?? 0) >= s.turn ? [h('span', { class: 'c-me' }, '📡 敵全員が見える')] : []),
      ...((s.radarUntil?.[1] ?? 0) >= s.turn ? [h('span', { class: 'c-en' }, '📡 敵に見られている')] : []),
      h(
        'span',
        { class: 'zoom' },
        h('button', { class: 'mini', onclick: () => this.board.zoomBy(1 / 1.3) }, '－'),
        h('button', { class: 'mini', onclick: () => this.board.zoomBy(1.3) }, '＋'),
        h('button', { class: 'mini', onclick: (e: Event) => ((e.target as HTMLElement).textContent = this.board.cycleView()) }, '視点'),
      ),
      h('button', { class: 'mini', onclick: showHelp }, '?'),
    )

    const intel = this.intelMap()
    this.shownIntel = intel
    this.board.syncPieces(this.pieceSpecs(intel))

    // マーク：霧・移動範囲・射程
    const marks = new Map<string, Set<TileMark>>()
    const mark = (p: Pos, m: TileMark) => {
      const k = key(p)
      if (!marks.has(k)) marks.set(k, new Set())
      marks.get(k)!.add(m)
    }
    const mine = this.me()
    this.fogMarks(mine, marks)
    const sel = mine.find((u) => u.id === this.selected)
    if (sel) {
      for (const { pos } of reachableFor(this.map, rules, sel, this.state.turn).values()) mark(pos, 'reach')
      const dest = this.destOf(sel)
      if (canFireAfterMove(rules, sel, dest)) {
        const ar = attackRange(this.map, rules, sel.cls, dest)
        for (const p of allPositions(this.map)) {
          if (!samePos(p, dest) && canStrike(this.map, rules, dest, p, ar, isMeleeClass(rules, sel.cls), classOf(rules, sel).arc)) mark(p, marks.get(key(p))?.has('reach') ? 'reachRange' : 'range')
        }
      }
      mark(dest, 'dest')
    }
    this.board.setMarks(marks)

    const plans: PlanSpec[] = []
    for (const u of mine) {
      const d = this.destOf(u)
      const t = this.targetIntel(u)
      plans.push({
        id: u.id,
        cls: u.cls,
        from: u.pos,
        to: d,
        warn: !!t && !canFireAfterMove(rules, u, d),
        target: t?.pos,
        targetOk: !!t && this.predictBlock(u) === null,
      })
    }
    this.board.setPlans(plans)
    this.renderPanel()
  }

  renderPanel() {
    if (this.state.over) return void this.panel.replaceChildren()
    const sel = this.me().find((u) => u.id === this.selected)
    const children: (Node | string)[] = []
    if (sel) {
      const c = classOf(rules, sel)
      const dest = this.destOf(sel)
      const onRoof = terrainId(this.map, dest) === 'building'
      const t = this.targetIntel(sel)
      const block = this.predictBlock(sel)
      const visibleEnemies = Object.values(this.shownIntel).some((i) => i.visible)
      children.push(
        h('div', { class: 'info' }, h('span', { class: 'pico small' }, c.short), h('b', {}, ` ${c.name}`), ` HP${sel.hp}/${c.hp} 攻${c.atk} 守${c.def} 速${c.spd} 移${c.move} 射${c.range}${onRoof ? '+1' : ''} 視${c.vision}${onRoof ? '+2' : ''}`),
        h(
          'div',
          { class: `hint ${t && block ? 'warn' : ''}` },
          t
            ? block
              ? `狙い: 敵${rules.classes[t.cls].name} — 今の位置のままだと「${BLOCK_LABEL[block]}」`
              : this.predictText(sel, t)
            : visibleEnemies
              ? '移動先（青）をタップ → 狙う敵（赤い駒）をタップ。狙わなければ撃ちません'
              : '移動先（青）をタップ。敵が見えていないので狙えません',
        ),
      )
    } else {
      children.push(h('div', { class: 'hint' }, '自分の駒をタップ → 移動先 → 狙う敵 を選んで「実行」。命令しない駒はその場に留まります。'))
    }
    children.push(
      h(
        'div',
        { class: 'row' },
        h('button', { class: 'chip', onclick: () => (this.orders.clear(), this.render()) }, 'リセット'),
        h('button', { class: 'primary grow', onclick: () => this.execute() }, '実行 ▶'),
      ),
    )
    this.panel.replaceChildren(...children)
  }

  async execute() {
    if (this.busy || this.state.over) return
    this.busy = true
    this.selected = null
    const myOrders: Order[] = this.me().map((u) => ({ unitId: u.id, dest: { ...this.destOf(u) }, target: this.orders.get(u.id)?.target }))
    const cpuOrders = decideOrders(observe(this.state, 1), this.aiRng, AI_PRESETS.strong)
    this.turns.push([structuredClone(myOrders), structuredClone(cpuOrders)])
    // 解決前の表示状態（プレイヤーが知っている情報だけ）
    const disp = new Map<string, PieceSpec>(this.pieceSpecs(this.shownIntel).map((p) => [p.id, { ...p, selected: false, targeted: false }]))
    const turn = this.state.turn
    const events = resolveTurn(this.state, [myOrders, cpuOrders], this.resolveRng)
    const finalIntel = this.intelMap()
    this.orders.clear()
    this.board.setPlans([])
    this.board.setMarks(this.fogMarks(this.state.units.filter((u) => u.side === 0 && disp.has(u.id)).map((u) => ({ cls: u.cls, pos: disp.get(u.id)!.pos }))))
    this.board.speed = this.playSpeed
    this.renderPlaybackPanel()
    const show = () => this.board.syncPieces(hideCoveredGhosts([...disp.values()]))
    show()

    const unitOf = (id: string) => this.state.units.find((x) => x.id === id)!
    const isMine = (id: string) => id.startsWith('0-')
    /** 敵の動きは、この手で見えた／露見したものだけ見せる */
    const enemySeen = (id: string) => events.some((e) => e.type === 'bailout' && e.unitId === id) || finalIntel[id]?.turn === turn
    const reveal = (id: string, pos: Pos) => {
      const u = unitOf(id)
      const c = classOf(rules, u)
      const cur = disp.get(id)
      disp.set(id, { id, side: 1, cls: u.cls, letter: c.short, kanji: c.kanji, hp: cur?.hp ?? null, maxHp: c.hp, pos: cur?.pos ?? pos, ghost: false })
    }

    // ① 移動：味方 → 見えた敵 の順に1体ずつ。行き先に別の駒がまだいるときは、そちらを先に動かす（駒を重ねない）。
    // 敵は視界の中を通る部分だけ見せる：視界から出る瞬間に消え、視界に入る瞬間に現れる。
    // 干渉（弾かれ）は最後にまとめて同時に見せる
    const moves = events.filter((e): e is Extract<GameEvent, { type: 'move' | 'pursuit' }> => e.type === 'move' || e.type === 'pursuit')
    const downNow = new Set(events.filter((e) => e.type === 'bailout').map((e) => e.unitId))
    // 移動の時点の自軍の視界（この手で撃破される味方も、移動の時点では生きている）
    const myAfter = this.state.units.filter((u) => u.side === 0 && (u.alive || downNow.has(u.id)))
    const seenAfter = (p: Pos) => myAfter.some((u) => samePos(u.pos, p) || canSee(this.map, rules, u.cls, u.pos, p))
    interface MoveAnim {
      id: string
      mine: boolean
      path: Pos[]
      pursuit: boolean
      fadeIn?: boolean
      /** 視界から出たときの、最後に見えたマス */
      lostAt?: Pos
    }
    const anims: MoveAnim[] = []
    for (const e of moves) {
      const path = shortestPath(this.map, rules, e.from, e.to)
      const base = { id: e.unitId, mine: isMine(e.unitId), path, pursuit: e.type === 'pursuit' }
      if (base.mine) {
        anims.push(base)
        continue
      }
      const marked = !!this.shownIntel[e.unitId]?.marked
      const vis = path.map((p, i) => (i === 0 ? !!this.shownIntel[e.unitId]?.visible : marked || seenAfter(p)))
      const n = path.length - 1
      if (vis[0]) {
        let k = 0
        while (k < n && vis[k + 1]) k++
        anims.push(k === n ? base : { ...base, path: path.slice(0, k + 2), lostAt: path[k] })
      } else if (vis[n]) {
        let j = n
        while (j > 1 && vis[j - 1]) j--
        anims.push({ ...base, path: path.slice(j - 1), fadeIn: true })
      }
    }
    // 移動前に見えている駒が占めているマス
    const occupied = (a: MoveAnim) => (a.fadeIn ? null : a.path[0])
    let pending = anims
    while (pending.length) {
      const blocker = (a: MoveAnim) => pending.find((b) => b !== a && occupied(b) && samePos(occupied(b)!, a.path[a.path.length - 1]))
      const ready = pending.find((a) => !blocker(a))
      let batch: MoveAnim[]
      if (ready) batch = [ready]
      else {
        // 入れ替わり（循環）は同時に動かす
        batch = []
        for (let cur: MoveAnim | undefined = pending[0]; cur && !batch.includes(cur); cur = blocker(cur)) batch.push(cur)
      }
      pending = pending.filter((a) => !batch.includes(a))
      for (const a of batch) {
        if (a.mine) continue
        const u = unitOf(a.id)
        const c = classOf(rules, u)
        const cur = disp.get(a.id)
        disp.set(a.id, { id: a.id, side: 1, cls: u.cls, letter: c.short, kanji: c.kanji, hp: cur?.ghost ? (this.shownIntel[a.id]?.hp ?? null) : (cur?.hp ?? null), maxHp: c.hp, pos: a.path[0], ghost: false, marked: cur?.marked })
      }
      show()
      for (const a of batch) if (a.fadeIn) this.board.setPieceOpacity(a.id, 0)
      this.caption(
        batch.map((a) => `${this.name(a.id)} ${a.fadeIn ? '発見' : a.lostAt ? '視界の外へ' : a.pursuit ? '追撃！' : '移動'}`).join('・'),
      )
      await this.board.focus(batch.flatMap((a) => (a.fadeIn ? a.path.slice(1) : a.lostAt ? a.path.slice(0, -1) : a.path)), 380)
      await Promise.all(batch.map((a) => this.board.movePath(a.id, a.path, { fadeIn: a.fadeIn, fadeOut: !!a.lostAt })))
      for (const a of batch) {
        const d = disp.get(a.id)!
        if (a.lostAt) {
          // 見失った：最後に見えたマスに「直前」の印を残す
          disp.set(a.id, { ...d, pos: a.lostAt, ghost: true, hp: null, label: '直前', marked: false })
          this.lastSeen.set(a.id, { pos: a.lostAt, turn: turn + 1 })
        } else d.pos = a.path[a.path.length - 1]
      }
      show()
      if (batch.some((a) => a.mine)) {
        this.board.setMarks(this.fogMarks(this.state.units.filter((u) => u.side === 0 && disp.has(u.id)).map((u) => ({ cls: u.cls, pos: disp.get(u.id)!.pos }))))
      }
    }
    const bounces = events.filter(
      (e): e is Extract<GameEvent, { type: 'bounce' }> => e.type === 'bounce' && (isMine(e.unitId) || e.contact || enemySeen(e.unitId)),
    )
    if (bounces.length) {
      const tried = (e: { unitId: string }) => (isMine(e.unitId) ? myOrders : cpuOrders).find((o) => o.unitId === e.unitId)!.dest
      for (const e of bounces) if (!isMine(e.unitId)) reveal(e.unitId, e.at)
      show()
      this.caption(`干渉：${bounces.map((e) => this.name(e.unitId)).join('・')} が同じマスに入ろうとして弾かれた`)
      await this.board.focus(bounces.flatMap((e) => [e.at, tried(e)]), 420)
      const spots = new Map(bounces.map((e) => [`${tried(e).x},${tried(e).y}`, tried(e)]))
      const go = Promise.all(bounces.map((e) => this.board.bouncePiece(e.unitId, tried(e))))
      await this.board.wait(300)
      for (const p of spots.values()) this.board.clash(p)
      await this.board.shake(240, 0.6)
      await go
      await this.board.wait(250)
    }

    // ② 交戦：速の高い順（イベント順）
    for (const e of events) {
      if (e.type === 'attack') {
        if (!isMine(e.unitId)) {
          reveal(e.unitId, e.from)
          disp.get(e.unitId)!.pos = e.from
        }
        if (!isMine(e.hitId) && !disp.get(e.hitId)) reveal(e.hitId, e.target)
        show()
        const a = classOf(rules, unitOf(e.unitId))
        const hits = e.shots.filter((x) => x.hit).length
        const guarded = e.shots.find((x) => x.guardedBy)?.guardedBy
        const guardDmg = e.shots.filter((x) => x.guardedBy).reduce((a, x) => a + x.damage, 0)
        // 防護兵の残りHP（この攻撃の後）。庇って撃破されることがある
        let guardHp: number | null = null
        if (guarded) {
          if (!isMine(guarded) && !disp.get(guarded)) reveal(guarded, unitOf(guarded).pos)
          const g = disp.get(guarded)
          if (g) g.hp = guardHp = Math.max(0, (g.hp ?? unitOf(guarded).hp) - guardDmg)
          show()
        }
        this.caption(
          `${this.name(e.unitId)}（速${a.spd}）→ ${this.name(e.hitId)}　命中率${e.chance}%${e.cover !== 'none' ? `（ビルに隠れて${e.cover === 'half' ? '大' : '小'}）` : ''}${e.shots.length > 1 ? `　${hits}/${e.shots.length}発` : ''}${guarded ? `　／ ${this.name(guarded)}が庇った -${guardDmg}${guardHp === 0 ? '（撃破）' : ''}` : ''}`,
        )
        const side = isMine(e.unitId) ? 0 : 1
        const arc = a.arc
        // 防護兵: 被弾の前に、庇う駒が味方と撃ち手の間へ割り込む
        const allGuarded = !!guarded && e.shots.every((x) => !x.hit || x.guardedBy)
        if (guarded) {
          await this.board.focus([e.from, e.target], 380)
          await this.board.interpose(guarded, unitOf(guarded).pos, e.target, e.from)
        }
        const lethal = allGuarded ? guardHp === 0 : e.targetHp <= 0
        const hitId = allGuarded ? guarded! : e.hitId
        if (Math.abs(e.from.x - e.target.x) + Math.abs(e.from.y - e.target.y) <= 1) {
          await this.board.meleeStrike(e.unitId, e.from, e.target, side, e.shots, hitId, lethal)
        } else if (lethal) {
          await this.board.killShot(e.from, e.target, side, e.shots, e.spotted && isMine(e.unitId), hitId, arc)
        } else {
          if (!guarded) await this.board.focus([e.from, e.target], 420)
          await this.board.volley(e.from, e.target, side, e.shots, e.spotted && isMine(e.unitId), hitId, arc)
        }
        if (guarded) await this.board.endInterpose(guardHp !== 0)
        const t = disp.get(e.hitId)
        if (t) t.hp = e.targetHp
        // 爆風で巻き込んだ敵
        for (const s of e.splash ?? []) {
          if (!isMine(s.id) && !disp.get(s.id)) reveal(s.id, unitOf(s.id).pos)
          const d = disp.get(s.id)
          if (!d) continue
          d.hp = s.hp
          this.board.popup(d.pos, `爆風 -${s.damage}`, '#ffb347', 900)
        }
        if (e.splash?.length) await this.board.shake(260, 0.8)
        show()
      } else if (e.type === 'mark' && isMine(e.unitId)) {
        this.caption(`${this.name(e.unitId)} 観測：${e.targets.map((t) => this.name(t)).join('・')} をマーク`)
        for (const t of e.targets) {
          if (!disp.get(t)) reveal(t, unitOf(t).pos)
          this.board.popup(disp.get(t)?.pos ?? unitOf(t).pos, 'MARK', '#3ddc84', 900)
        }
        show()
        await this.board.wait(500)
      } else if (e.type === 'jam') {
        const shown = e.targets.filter((t) => isMine(t) || disp.get(t))
        if (isMine(e.unitId) || shown.length) {
          this.caption(`${this.name(e.unitId)} 妨害：${e.targets.map((t) => this.name(t)).join('・')} の視界と命中率が下がる${rules.skills.jamSilence ? '。スキルも使えない' : ''}`)
          for (const t of shown) this.board.popup(disp.get(t)?.pos ?? unitOf(t).pos, '妨害', '#c58cff', 900)
          await this.board.wait(500)
        }
      } else if (e.type === 'evac') {
        const d = disp.get(e.allyId)
        if (d && !d.ghost) {
          this.caption(`${this.name(e.unitId)} 後送：${this.name(e.allyId)} を連れ戻す`)
          await this.board.focus([e.from, e.to], 380)
          await this.board.movePath(e.allyId, shortestPath(this.map, rules, e.from, e.to))
          d.pos = e.to
          show()
        }
      } else if (e.type === 'suppress') {
        const t = disp.get(e.targetId)
        if (t) await this.board.popup(t.pos, '制圧', '#ffc247', 700)
      } else if (e.type === 'heal' && isMine(e.unitId)) {
        this.caption(`${this.name(e.unitId)} 応急手当`)
        for (const t of e.targets) {
          const d = disp.get(t.id)
          if (d) {
            d.hp = (d.hp ?? 0) + t.amount
            this.board.popup(d.pos, `+${t.amount}`, '#3ddc84', 900)
          }
        }
        show()
        await this.board.wait(600)
      } else if (e.type === 'noshot' && isMine(e.unitId)) {
        const u = unitOf(e.unitId)
        this.caption(`${this.name(e.unitId)} 撃てず：${BLOCK_LABEL[e.reason]}`)
        await this.board.focus([disp.get(e.unitId)?.pos ?? u.pos], 350)
        await this.board.popup(disp.get(e.unitId)?.pos ?? u.pos, `× ${BLOCK_LABEL[e.reason]}`, '#ffc247', 800)
      } else if (e.type === 'radar') {
        const mine = isMine(e.unitId)
        this.caption(mine ? `${this.name(e.unitId)} レーダー塔を確保：次の手は敵全員が見える` : '敵がレーダー塔を確保：次の手はこちらの位置が全て見られる')
        const at = disp.get(e.unitId)?.pos
        if (at) this.board.popup(at, '📡 レーダー', mine ? '#37c3ff' : '#ff5b47', 1000)
        await this.board.wait(600)
      } else if (e.type === 'bailout') {
        const killer = [...events].reverse().find((x) => x.type === 'attack' && (x.hitId === e.unitId || x.shots.some((s) => s.guardedBy === e.unitId)))
        const shielded = killer?.type === 'attack' && killer.hitId !== e.unitId
        this.caption(`💥 ${this.name(e.unitId)} 撃破${shielded ? `（${this.name(killer.hitId)}を庇って）` : ''}`)
        await this.board.defeat(e.unitId, e.at, isMine(e.unitId) ? 0 : 1, killer?.type === 'attack' ? killer.from : undefined)
        disp.delete(e.unitId)
        show()
      }
    }

    this.caption('')
    await this.board.overview(450)
    this.board.speed = 1
    this.busy = false
    this.render()
    this.logTurn(turn, events)
    if (this.state.over) this.showEnd()
  }

  playSpeed = 1
  captionEl: HTMLDivElement | null = null

  caption(text: string) {
    if (!this.captionEl) return
    this.captionEl.textContent = text
    this.captionEl.hidden = !text
  }

  renderPlaybackPanel() {
    const speedBtn = h('button', { class: 'chip' }, `速度 ×${this.playSpeed}`)
    speedBtn.addEventListener('click', () => {
      this.playSpeed = this.playSpeed === 1 ? 2 : this.playSpeed === 2 ? 3 : 1
      this.board.speed = this.playSpeed
      speedBtn.textContent = `速度 ×${this.playSpeed}`
    })
    this.panel.replaceChildren(
      h('div', { class: 'hint' }, '再生中… 移動 → 交戦（速の高い順）'),
      h('div', { class: 'row' }, speedBtn, h('button', { class: 'chip grow', onclick: () => (this.board.speed = 40) }, 'スキップ ▶▶')),
    )
  }

  name(id: string) {
    const u = this.state.units.find((x) => x.id === id)!
    return `${u.side === 0 ? '味方' : '敵'}${rules.classes[u.cls].name}`
  }

  logTurn(turn: number, events: GameEvent[]) {
    const lines: string[] = []
    for (const e of events) {
      const u = this.state.units.find((x) => x.id === e.unitId)!
      if (e.type === 'bounce' && (u.side === 0 || e.contact)) lines.push(`${this.name(e.unitId)}: 移動を阻まれた${e.contact ? '（敵と接触！）' : ''}`)
      if (e.type === 'noshot' && u.side === 0) lines.push(`${this.name(e.unitId)}: 撃てず（${BLOCK_LABEL[e.reason]}）`)
      if (e.type === 'attack') {
        const hits = e.shots.filter((x) => x.hit).length
        const g = e.shots.find((x) => x.guardedBy)?.guardedBy
        const gd = e.shots.filter((x) => x.guardedBy).reduce((a, x) => a + x.damage, 0)
        lines.push(`${this.name(e.unitId)} → ${this.name(e.hitId)}: ${hits}/${e.shots.length}発命中 -${e.damage}（命中率${e.chance}%）${g ? `［${this.name(g)}が庇って -${gd}］` : ''}${e.spotted && u.side === 0 ? '［索敵連携］' : ''}`)
        for (const s of e.splash ?? []) lines.push(`　爆風: ${this.name(s.id)} -${s.damage}`)
      }
      if (e.type === 'bailout') lines.push(`💥 ${this.name(e.unitId)} 撃破`)
      if (e.type === 'radar') lines.push(u.side === 0 ? `📡 ${this.name(e.unitId)}: レーダー塔を確保（次の手は敵全員が見える）` : '📡 敵がレーダー塔を確保（次の手は位置が見られる）')
      if (e.type === 'jam' && u.side === 0) lines.push(`${this.name(e.unitId)}: ${e.targets.map((t) => this.name(t)).join('・')} を妨害`)
      if (e.type === 'jam' && u.side === 1 && e.targets.length) lines.push(`${this.name(e.unitId)} に妨害された`)
      if (e.type === 'evac' && u.side === 0) lines.push(`${this.name(e.unitId)}: ${this.name(e.allyId)} を後送`)
    }
    if (!lines.length) lines.push('交戦なし')
    for (const l of lines.reverse()) this.log(`${turn}手目 ${l}`)
  }

  showEnd() {
    const r = gameResult(this.state)
    const w = r.winner[rules.victory]
    const title = w === 0 ? '勝利' : w === 1 ? '敗北' : '引き分け'
    const rec: GameRecord = { version: RECORD_VERSION, seed: this.seed, map: this.map.id, comps: this.comps, rules, turns: this.turns }
    const modal = h(
      'div',
      { class: 'modal' },
      h(
        'div',
        { class: 'sheet' },
        h('h2', { class: w === 0 ? 'c-me' : w === 1 ? 'c-en' : '' }, title),
        h('p', {}, `撃破コスト ${r.killCost[0]} - ${r.killCost[1]} ／ 撃破数 ${r.kills[0]} - ${r.kills[1]} ／ ${r.turns}手`),
        h(
          'p',
          { class: 'sub' },
          '他の勝利条件だと: ',
          (Object.keys(MODE_LABEL) as VictoryMode[]).map((m) => `${MODE_LABEL[m]}=${r.winner[m] === 0 ? '勝' : r.winner[m] === 1 ? '負' : '分'}`).join(' / '),
        ),
        h('button', { class: 'primary', onclick: () => (modal.remove(), this.board.dispose(), showSetup()) }, 'もう一度'),
        h(
          'button',
          {
            class: 'link',
            onclick: async (e: Event) => {
              try {
                await navigator.clipboard.writeText(JSON.stringify(rec))
                ;(e.target as HTMLElement).textContent = 'コピーしました'
              } catch {
                ;(e.target as HTMLElement).textContent = 'コピー失敗'
              }
            },
          },
          '棋譜をコピー（フィードバック用）',
        ),
        h('button', { class: 'link', onclick: () => modal.remove() }, '盤面を見る'),
      ),
    )
    document.body.append(modal)
  }
}

/** 自軍・見えている敵がいるマスの「最後に見た位置」の印は描かない（駒を重ねない。その情報はもう古い） */
function hideCoveredGhosts(specs: PieceSpec[]): PieceSpec[] {
  return specs.filter((p) => !p.ghost || !specs.some((q) => !q.ghost && samePos(q.pos, p.pos)))
}
