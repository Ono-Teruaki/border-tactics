import { AI_PRESETS, CPU_COMPS, decideOrders } from '../engine/ai.ts'
import { attackRange, canFireAfterMove, canSee, canStrike, classOf, createGame, gameResult, observe, reachableFor, resolveTurn } from '../engine/game.ts'
import { allPositions, key, samePos, terrainId } from '../engine/grid.ts'
import { MAPS } from '../engine/maps.ts'
import { RECORD_VERSION, type GameRecord } from '../engine/record.ts'
import { seedStreams, type Rng } from '../engine/rng.ts'
import { DEFAULT_RULES } from '../engine/rules.ts'
import type { GameEvent, GameState, Intel, MapDef, Order, Pos, Unit, VictoryMode } from '../engine/types.ts'
import { Board3D, type PieceSpec, type PlanSpec, type TileMark } from './board3d.ts'

const rules = DEFAULT_RULES
const root = document.querySelector<HTMLDivElement>('#app')!
const MODE_LABEL: Record<VictoryMode, string> = { annihilation: '全滅', killCount: '撃破数', killCost: '撃破コスト' }

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
            h('button', { class: 'slot', onclick: () => (comp.splice(i, 1), render()) }, comp[i] ? h('span', { class: 'koma' }, rules.classes[comp[i]].kanji) : '＋'),
          ),
        ),
        h(
          'div',
          { class: 'classes' },
          ...Object.values(rules.classes).map((c) =>
            h(
              'button',
              { class: 'classcard', onclick: () => (comp.length < rules.teamSize && comp.push(c.id), render()) },
              h('span', { class: 'koma' }, c.kanji),
              h('b', {}, c.name),
              h('small', {}, `HP${c.hp} 移${c.move} 射${c.range} 攻${c.damage} 視${c.vision} コスト${c.cost}${c.attackMaxMove < 10 ? ` ※${c.attackMaxMove + 1}マス以上動くと撃てない` : ''}`),
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
        h('li', {}, '両軍が同時に「移動先」を決め、一斉に動きます。'),
        h('li', {}, '移動後、射程内で「味方の誰かに見えている」敵を自動で撃ちます。偵察で見つけた敵を後衛が撃てます。'),
        h('li', {}, 'ダメージは同時に入ります（相打ちあり）。撃ったユニットは位置が相手にバレます。'),
        h('li', {}, '同じマスに入ろうとすると弾かれて元の位置に戻ります。敵とぶつかると互いの位置がバレます。'),
        h('li', {}, 'ビル: 地上の視線を遮る。登ると（移動コスト2）視界+2・射程+1、ビル越しに見通せる。'),
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
    this.board = new Board3D(stage, map)
    this.board.onTap = (p) => this.tap(p)
    ;(window as any).__bt = { tileToScreen: (x: number, y: number) => this.board.tileToScreen({ x, y }), battle: this }

    this.log(`敵編成: ${comps[1].map((c) => rules.classes[c].name).join('・')}`)
    this.render()
  }

  me() {
    return this.state.units.filter((u) => u.alive && u.side === 0)
  }
  destOf(u: Unit): Pos {
    return this.orders.get(u.id)?.dest ?? u.pos
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
      const reach = reachableFor(this.map, rules, sel)
      const plannedHere = mine.some((u) => u.id !== sel.id && samePos(this.destOf(u), p))
      if (reach.has(key(p)) && !plannedHere) {
        this.orders.set(sel.id, { unitId: sel.id, dest: p })
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
      specs.push({ id: u.id, side: 0, kanji: c.kanji, hp: hpOverride?.get(u.id) ?? u.hp, maxHp: c.hp, pos: u.pos, selected: u.id === this.selected })
    }
    // 敵は intel（自軍から分かっている情報）だけから描く
    for (const i of Object.values(intel)) {
      const c = rules.classes[i.cls]
      const age = s.turn - 1 - i.turn
      specs.push({
        id: i.unitId,
        side: 1,
        kanji: c.kanji,
        hp: i.visible ? i.hp : null,
        maxHp: c.hp,
        pos: i.pos,
        ghost: !i.visible,
        label: i.visible ? undefined : i.turn === 0 ? '初期位置' : age <= 0 ? '直前' : `${age}手前`,
      })
    }
    return specs
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
      h('button', { class: 'mini', onclick: (e: Event) => ((e.target as HTMLElement).textContent = this.board.cycleView()) }, '視点'),
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
    for (const p of allPositions(this.map)) {
      if (!mine.some((u) => samePos(u.pos, p) || canSee(this.map, rules, u.cls, u.pos, p))) mark(p, 'fog')
    }
    const sel = mine.find((u) => u.id === this.selected)
    if (sel) {
      for (const { pos } of reachableFor(this.map, rules, sel).values()) mark(pos, 'reach')
      const dest = this.destOf(sel)
      if (canFireAfterMove(rules, sel, dest)) {
        const ar = attackRange(this.map, rules, sel.cls, dest)
        for (const p of allPositions(this.map)) {
          if (!samePos(p, dest) && canStrike(this.map, rules, dest, p, ar)) mark(p, marks.get(key(p))?.has('reach') ? 'reachRange' : 'range')
        }
      }
      mark(dest, 'dest')
    }
    this.board.setMarks(marks)

    const plans: PlanSpec[] = []
    for (const u of mine) {
      const d = this.destOf(u)
      if (!samePos(d, u.pos)) plans.push({ id: u.id, from: u.pos, to: d, side: 0, kanji: classOf(rules, u).kanji, warn: !canFireAfterMove(rules, u, d) })
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
      const warn = !canFireAfterMove(rules, sel, dest)
      children.push(
        h('div', { class: 'info' }, h('span', { class: 'koma small' }, c.kanji), h('b', {}, ` ${c.name}`), ` HP${sel.hp}/${c.hp} 移${c.move} 射${c.range} 視${c.vision}`),
        h(
          'div',
          { class: `hint ${warn ? 'warn' : ''}` },
          warn ? '⚠ この移動では撃てません（スナイパーは1マスまで）' : `青=移動先候補 / 赤=移動後の射程${onRoof ? '（屋上ボーナス込み）' : ''}。駒を再タップで取り消し`,
        ),
      )
    } else {
      children.push(h('div', { class: 'hint' }, '自分の駒をタップして移動先を選択。命令しない駒はその場に留まります。射撃は自動です。'))
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
    const myOrders = this.me().map((u) => ({ unitId: u.id, dest: { ...this.destOf(u) } }))
    const cpuOrders = decideOrders(observe(this.state, 1), this.aiRng, AI_PRESETS.cpu)
    this.turns.push([structuredClone(myOrders), structuredClone(cpuOrders)])
    const hpBefore = new Map(this.state.units.filter((u) => u.side === 0).map((u) => [u.id, u.hp]))
    const prevIntel = this.shownIntel
    const turn = this.state.turn
    const events = resolveTurn(this.state, [myOrders, cpuOrders], this.resolveRng)
    this.orders.clear()
    this.board.setPlans([])
    this.board.setMarks(new Map())
    this.panel.replaceChildren(h('div', { class: 'hint' }, '解決中…'))

    // ① 移動（敵は移動後に見えた位置／撃って露見した位置。HPは既知の値のまま）
    const midIntel: Record<string, Intel> = {}
    for (const [id, i] of Object.entries(this.intelMap())) midIntel[id] = { ...i, hp: prevIntel[id]?.hp ?? null }
    for (const e of events) {
      if (e.type === 'bailout' && e.unitId.startsWith('1-')) {
        const u = this.state.units.find((x) => x.id === e.unitId)!
        midIntel[u.id] = { unitId: u.id, cls: u.cls, pos: e.at, hp: prevIntel[u.id]?.hp ?? null, turn, visible: true }
      }
    }
    await this.board.syncPieces(this.pieceSpecs(midIntel, hpBefore), true)

    // ② 射撃
    const shots = events.filter((e): e is Extract<GameEvent, { type: 'attack' }> => e.type === 'attack')
    if (shots.length) {
      await Promise.all(
        shots.map((e) => {
          const side = e.unitId.startsWith('0-') ? 0 : 1
          this.board.popup(e.target, `-${e.damage}`, '#ffd34d')
          return this.board.shoot(e.from, e.target, side, e.spotted && side === 0)
        }),
      )
    }
    // ③ ベイルアウト
    const outs = events.filter((e): e is Extract<GameEvent, { type: 'bailout' }> => e.type === 'bailout')
    if (outs.length) await Promise.all(outs.map((e) => this.board.bailout(e.at, e.unitId.startsWith('0-') ? 0 : 1)))

    this.busy = false
    this.render()
    this.logTurn(turn, events)
    if (this.state.over) this.showEnd()
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
      if (e.type === 'attack') lines.push(`${this.name(e.unitId)} → ${this.name(e.hitId)} に命中 -${e.damage}${e.spotted && u.side === 0 ? '（味方の索敵）' : ''}`)
      if (e.type === 'bailout') lines.push(`💥 ${this.name(e.unitId)} ベイルアウト`)
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
