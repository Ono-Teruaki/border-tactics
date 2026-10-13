import { AI_PRESETS, CPU_COMPS, decideOrders } from '../engine/ai.ts'
import { attackRange, canSee, canStrike, classOf, createGame, gameResult, moveAllowance, observe, resolveTurn } from '../engine/game.ts'
import { allPositions, key, reachable, samePos, terrainId } from '../engine/grid.ts'
import { MAPS } from '../engine/maps.ts'
import { createRng, type Rng } from '../engine/rng.ts'
import { DEFAULT_RULES } from '../engine/rules.ts'
import type { GameEvent, GameState, MapDef, Order, Pos, Stance, Unit, VictoryMode } from '../engine/types.ts'

const rules = DEFAULT_RULES
const root = document.querySelector<HTMLDivElement>('#app')!
const STANCE_LABEL: Record<Stance, string> = { watch: '警戒', attack: '攻撃', hide: '隠密' }
const STANCE_MARK: Record<Stance, string> = { watch: '警', attack: '撃', hide: '隠' }
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
        h('h2', {}, 'マップ'),
        h('div', { class: 'row' }, ...MAPS.map((m) => h('button', { class: `chip ${m.id === mapId ? 'on' : ''}`, onclick: () => ((mapId = m.id), render()) }, m.name))),
        miniMap(MAPS.find((m) => m.id === mapId)!),
        h('h2', {}, `編成（${comp.length}/${rules.teamSize}）`),
        h(
          'div',
          { class: 'slots' },
          ...Array.from({ length: rules.teamSize }, (_, i) =>
            h('button', { class: 'slot', onclick: () => (comp.splice(i, 1), render()) }, comp[i] ? h('span', { class: 'tok me' }, rules.classes[comp[i]].short) : '＋'),
          ),
        ),
        h(
          'div',
          { class: 'classes' },
          ...Object.values(rules.classes).map((c) =>
            h(
              'button',
              { class: 'classcard', onclick: () => (comp.length < rules.teamSize && comp.push(c.id), render()) },
              h('span', { class: 'tok me' }, c.short),
              h('b', {}, c.name),
              h('small', {}, `HP${c.hp} 移${c.move} 射${c.range} 攻${c.damage} 視${c.vision} コスト${c.cost}${c.attackMaxMove < 10 ? ` ※${c.attackMaxMove}マス超移動で撃てない` : ''}`),
            ),
          ),
        ),
        h('button', { class: 'primary', onclick: () => start() }, '出撃'),
        h('button', { class: 'link', onclick: showHelp }, 'ルール説明'),
      ),
    )
    const startBtn = root.querySelector<HTMLButtonElement>('.primary')!
    startBtn.disabled = comp.length !== rules.teamSize
  }
  const start = () => {
    lastComp = [...comp]
    lastMap = mapId
    const seed = Math.floor(Math.random() * 1e9)
    const rng = createRng(seed)
    const cpuComp = rng.pick(CPU_COMPS)
    new Battle(MAPS.find((m) => m.id === mapId)!, [comp, [...cpuComp]], seed, rng)
  }
  render()
}

function miniMap(map: MapDef) {
  const el = h('div', { class: 'minimap', style: `grid-template-columns: repeat(${map.width}, 1fr)` })
  for (const p of allPositions(map)) el.append(h('i', { class: `t-${terrainId(map, p)}` }))
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
        h('li', {}, '両軍が同時に命令を出し、一斉に実行します。'),
        h('li', {}, '①移動 → ②攻撃 の順に解決。ダメージは同時（相打ちあり）。'),
        h('li', {}, '同じマスに入ろうとすると弾かれて元の位置に戻ります。敵とぶつかると互いの位置がバレます。'),
        h('li', {}, '【警戒】移動後、見えている敵が射程-1以内にいれば自動で撃つ。'),
        h('li', {}, '【攻撃】指定マスを撃つ。見えていない場所への置き撃ちも可。撃つと位置がバレます。'),
        h('li', {}, '【隠密】移動力-1・攻撃不可。隣接されない限り見つからない。'),
        h('li', {}, '森: 視線を遮り、中のユニットは隣接しないと見えない。高台: 移動コスト2, 視界+2, 射程+1, 森越しに見える。建物: 通行・視線不可。'),
        h('li', {}, `勝敗: ${rules.turnLimit}ターン終了時の撃破コスト合計（全滅で即終了）。`),
        h('li', {}, '見えていない敵は「最後に見た位置」が半透明で表示されます。'),
      ),
      h('button', { class: 'primary', onclick: () => modal.remove() }, '閉じる'),
    ),
  )
  document.body.append(modal)
}

// ---------------- 戦闘画面 ----------------
class Battle {
  state: GameState
  orders = new Map<string, Order>()
  selected: string | null = null
  busy = false
  replay: { turn: number; orders: [Order[], Order[]] }[] = []
  logLines: string[] = []
  boardEl!: HTMLDivElement
  tokens = new Map<string, HTMLDivElement>()
  fx!: SVGSVGElement
  panel!: HTMLDivElement
  header!: HTMLDivElement
  logEl!: HTMLDivElement
  map: MapDef
  comps: [string[], string[]]
  seed: number
  rng: Rng

  constructor(map: MapDef, comps: [string[], string[]], seed: number, rng: Rng) {
    this.map = map
    this.comps = comps
    this.seed = seed
    this.rng = rng
    this.state = createGame(map, rules, comps)
    this.build()
    this.log(`敵編成: ${comps[1].map((c) => rules.classes[c].name).join('・')}`)
    this.render()
  }

  me() {
    return this.state.units.filter((u) => u.alive && u.side === 0)
  }
  orderFor(u: Unit): Order {
    return this.orders.get(u.id) ?? { unitId: u.id, dest: { ...u.pos }, stance: 'watch' }
  }

  build() {
    const { width, height } = this.map
    this.header = h('div', { class: 'hud' }) as HTMLDivElement
    this.boardEl = h('div', { class: 'board', style: `--w:${width};--h:${height}` }) as HTMLDivElement
    for (const p of allPositions(this.map)) {
      const cell = h('div', { class: `cell t-${terrainId(this.map, p)}`, 'data-k': key(p) })
      cell.addEventListener('click', () => this.tapCell(p))
      this.boardEl.append(cell)
    }
    this.fx = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    this.fx.setAttribute('class', 'fx')
    this.fx.setAttribute('viewBox', `0 0 ${width} ${height}`)
    this.boardEl.append(this.fx)
    this.panel = h('div', { class: 'panel' }) as HTMLDivElement
    this.logEl = h('div', { class: 'log' }) as HTMLDivElement
    root.replaceChildren(h('div', { class: 'battle' }, this.header, h('div', { class: 'boardwrap' }, this.boardEl), this.panel, this.logEl))
  }

  log(s: string) {
    this.logLines.unshift(s)
    this.logEl.replaceChildren(...this.logLines.slice(0, 40).map((l) => h('div', {}, l)))
  }

  tapCell(p: Pos) {
    if (this.busy || this.state.over) return
    const mine = this.me()
    const sel = mine.find((u) => u.id === this.selected)
    if (sel) {
      const o = this.orderFor(sel)
      if (o.stance === 'attack') {
        if (canStrike(this.map, rules, o.dest, p, attackRange(this.map, rules, sel.cls, o.dest)) && !samePos(p, o.dest)) {
          this.orders.set(sel.id, { ...o, target: p })
          this.render()
          return
        }
      }
      const reach = reachable(this.map, rules, sel.pos, moveAllowance(rules, sel, o.stance))
      const occupant = mine.find((u) => samePos(u.pos, p) && u.id !== sel.id)
      if (!occupant && reach.has(key(p))) {
        this.orders.set(sel.id, { ...o, dest: p, target: o.stance === 'attack' ? undefined : o.target })
        this.render()
        return
      }
    }
    const u = mine.find((x) => samePos(x.pos, p))
    this.selected = u && u.id !== this.selected ? u.id : null
    this.render()
  }

  setStance(s: Stance) {
    const u = this.me().find((x) => x.id === this.selected)
    if (!u) return
    const o = this.orderFor(u)
    const reach = reachable(this.map, rules, u.pos, moveAllowance(rules, u, s))
    this.orders.set(u.id, { ...o, stance: s, dest: reach.has(key(o.dest)) ? o.dest : { ...u.pos }, target: undefined })
    this.render()
  }

  visibleTiles(): Set<string> {
    const out = new Set<string>()
    const mine = this.me()
    for (const p of allPositions(this.map)) if (mine.some((u) => canSee(this.map, rules, u.cls, u.pos, p, false))) out.add(key(p))
    for (const u of mine) out.add(key(u.pos))
    return out
  }

  render(skipTokens = false) {
    const s = this.state
    this.header.replaceChildren(
      h('span', {}, `T${Math.min(s.turn, rules.turnLimit)}/${rules.turnLimit}`),
      h('span', { class: 'score' }, h('b', { class: 'c-me' }, String(s.killCost[0])), ' - ', h('b', { class: 'c-en' }, String(s.killCost[1]))),
      h('span', {}, `敵残 ${s.units.filter((u) => u.alive && u.side === 1).length}`),
      h('button', { class: 'mini', onclick: showHelp }, '?'),
    )

    // セル：霧・ハイライト
    const vis = this.visibleTiles()
    const sel = this.me().find((u) => u.id === this.selected)
    const selOrder = sel ? this.orderFor(sel) : null
    const reach = sel && selOrder ? reachable(this.map, rules, sel.pos, moveAllowance(rules, sel, selOrder.stance)) : null
    for (const cell of this.boardEl.querySelectorAll<HTMLDivElement>('.cell')) {
      const k = cell.dataset.k!
      const [x, y] = k.split(',').map(Number)
      cell.classList.toggle('fog', !vis.has(k))
      cell.classList.toggle('reach', !!reach?.has(k))
      const inRange =
        !!sel && selOrder?.stance === 'attack' && !samePos({ x, y }, selOrder.dest) && canStrike(this.map, rules, selOrder.dest, { x, y }, attackRange(this.map, rules, sel.cls, selOrder.dest))
      cell.classList.toggle('range', inRange)
    }

    if (!skipTokens) this.renderTokens()
    this.renderOrders()
    this.renderPanel()
  }

  renderTokens(phase?: { hp?: Map<string, number>; showDead?: Set<string> }) {
    const s = this.state
    const seen = new Set<string>()
    const place = (id: string, cls: string, pos: Pos, side: 'me' | 'en', extra: string, hp: number | null, maxHp: number, label?: string) => {
      seen.add(id)
      let el = this.tokens.get(id)
      if (!el) {
        el = h('div', { class: 'unit' }) as HTMLDivElement
        el.addEventListener('click', () => this.tapCell(this.tokenPos.get(id)!))
        this.tokens.set(id, el)
        this.boardEl.append(el)
      }
      this.tokenPos.set(id, pos)
      el.className = `unit ${side} ${extra} ${id === this.selected ? 'sel' : ''}`
      el.style.setProperty('--x', String(pos.x))
      el.style.setProperty('--y', String(pos.y))
      const pips = hp === null ? '?' : '●'.repeat(Math.max(0, hp)) + '○'.repeat(Math.max(0, maxHp - hp))
      el.replaceChildren(h('span', { class: 'cls' }, rules.classes[cls].short), h('span', { class: 'hp' }, pips), label ? h('span', { class: 'tag' }, label) : '')
    }
    for (const u of s.units) {
      if (u.side !== 0) continue
      if (!u.alive && !phase?.showDead?.has(u.id)) continue
      const o = this.orderFor(u)
      place(u.id, u.cls, u.pos, 'me', `${o.stance === 'hide' && !this.busy ? 'hiding' : ''} ${!u.alive ? 'dead' : ''}`, phase?.hp?.get(u.id) ?? u.hp, classOf(rules, u).hp, this.busy ? undefined : STANCE_MARK[o.stance])
    }
    for (const i of Object.values(s.intel[0])) {
      const age = s.turn - 1 - i.turn
      place(i.unitId, i.cls, i.pos, 'en', i.visible ? '' : 'ghost', phase?.hp?.get(i.unitId) ?? i.hp, rules.classes[i.cls].hp, i.visible ? undefined : age <= 0 ? '今' : `${age}T前`)
    }
    if (phase?.showDead) {
      for (const id of phase.showDead) {
        const u = s.units.find((x) => x.id === id)!
        if (u.side === 1) place(u.id, u.cls, u.pos, 'en', 'dead', 0, classOf(rules, u).hp)
      }
    }
    for (const [id, el] of this.tokens) {
      if (!seen.has(id)) {
        el.remove()
        this.tokens.delete(id)
      }
    }
  }
  tokenPos = new Map<string, Pos>()

  renderOrders() {
    const ns = 'http://www.w3.org/2000/svg'
    this.fx.replaceChildren()
    if (this.busy) return
    for (const u of this.me()) {
      const o = this.orderFor(u)
      if (!samePos(o.dest, u.pos)) {
        const l = document.createElementNS(ns, 'line')
        l.setAttribute('x1', String(u.pos.x + 0.5))
        l.setAttribute('y1', String(u.pos.y + 0.5))
        l.setAttribute('x2', String(o.dest.x + 0.5))
        l.setAttribute('y2', String(o.dest.y + 0.5))
        l.setAttribute('class', 'mv')
        this.fx.append(l)
        const c = document.createElementNS(ns, 'circle')
        c.setAttribute('cx', String(o.dest.x + 0.5))
        c.setAttribute('cy', String(o.dest.y + 0.5))
        c.setAttribute('r', '0.3')
        c.setAttribute('class', `dest ${o.stance}`)
        this.fx.append(c)
      }
      if (o.stance === 'attack' && o.target) {
        const l = document.createElementNS(ns, 'line')
        l.setAttribute('x1', String(o.dest.x + 0.5))
        l.setAttribute('y1', String(o.dest.y + 0.5))
        l.setAttribute('x2', String(o.target.x + 0.5))
        l.setAttribute('y2', String(o.target.y + 0.5))
        l.setAttribute('class', 'aim')
        this.fx.append(l)
        const t = document.createElementNS(ns, 'text')
        t.setAttribute('x', String(o.target.x + 0.5))
        t.setAttribute('y', String(o.target.y + 0.72))
        t.setAttribute('class', 'cross')
        t.textContent = '⌖'
        this.fx.append(t)
      }
    }
  }

  renderPanel() {
    const sel = this.me().find((u) => u.id === this.selected)
    if (this.state.over) {
      this.panel.replaceChildren()
      return
    }
    const children: (Node | string)[] = []
    if (sel) {
      const c = classOf(rules, sel)
      const o = this.orderFor(sel)
      const hint =
        o.stance === 'attack'
          ? o.target
            ? '狙うマスを変えるには赤いマスをタップ'
            : '移動先（青）を決めてから、撃つマス（赤）をタップ'
          : o.stance === 'hide'
            ? '隠密: 移動力-1、攻撃しない。隣接されなければ見つからない'
            : '警戒: 移動後、見えた敵が射程内なら自動で撃つ'
      children.push(
        h('div', { class: 'info' }, h('b', {}, c.name), ` HP${sel.hp}/${c.hp} 移${c.move} 射${c.range} 攻${c.damage} 視${c.vision}`),
        h('div', { class: 'row' }, ...(['watch', 'attack', 'hide'] as Stance[]).map((st) => h('button', { class: `chip ${o.stance === st ? 'on' : ''}`, onclick: () => this.setStance(st) }, STANCE_LABEL[st]))),
        h('div', { class: 'hint' }, hint),
      )
    } else {
      children.push(h('div', { class: 'hint' }, '味方ユニットをタップして命令。命令しないユニットはその場で警戒します。'))
    }
    children.push(
      h(
        'div',
        { class: 'row' },
        h('button', { class: 'chip', onclick: () => (this.orders.clear(), this.render()) }, 'リセット'),
        h('button', { class: 'primary grow', onclick: () => this.execute() }, `実行 ▶`),
      ),
    )
    this.panel.replaceChildren(...children)
  }

  async execute() {
    if (this.busy || this.state.over) return
    this.busy = true
    this.selected = null
    const myOrders = this.me().map((u) => this.orderFor(u))
    const cpuOrders = decideOrders(observe(this.state, 1), this.rng, AI_PRESETS.cpu)
    this.replay.push({ turn: this.state.turn, orders: [structuredClone(myOrders), structuredClone(cpuOrders)] })
    const hpBefore = new Map(this.state.units.map((u) => [u.id, u.hp]))
    const turn = this.state.turn
    const events = resolveTurn(this.state, [myOrders, cpuOrders], this.rng)
    this.orders.clear()
    const dead = new Set(events.filter((e) => e.type === 'bailout').map((e) => e.unitId))

    // ① 移動
    this.render(true)
    this.renderTokens({ hp: hpBefore, showDead: dead })
    await sleep(450)
    // ② 攻撃
    this.drawAttacks(events)
    this.renderTokens({ showDead: dead })
    await sleep(dead.size ? 700 : 500)
    // ③ ベイルアウト
    this.fx.replaceChildren()
    this.busy = false
    this.render()
    this.logTurn(turn, events)
    if (this.state.over) this.showEnd()
  }

  drawAttacks(events: GameEvent[]) {
    const ns = 'http://www.w3.org/2000/svg'
    this.fx.replaceChildren()
    for (const e of events) {
      if (e.type !== 'attack') continue
      const side = this.state.units.find((u) => u.id === e.unitId)!.side
      const l = document.createElementNS(ns, 'line')
      l.setAttribute('x1', String(e.from.x + 0.5))
      l.setAttribute('y1', String(e.from.y + 0.5))
      l.setAttribute('x2', String(e.target.x + 0.5))
      l.setAttribute('y2', String(e.target.y + 0.5))
      l.setAttribute('class', `shot ${side === 0 ? 'me' : 'en'}`)
      this.fx.append(l)
      const t = document.createElementNS(ns, 'text')
      t.setAttribute('x', String(e.target.x + 0.5))
      t.setAttribute('y', String(e.target.y + 0.3))
      t.setAttribute('class', `pop ${e.hitId ? 'hit' : 'miss'}`)
      t.textContent = e.hitId ? `-${e.damage}` : 'MISS'
      this.fx.append(t)
    }
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
      if (e.type === 'attack') {
        if (u.side === 0 || e.hitId) lines.push(`${this.name(e.unitId)}${e.watch ? '[警戒]' : ''} → ${e.hitId ? `${this.name(e.hitId)}に命中 -${e.damage}` : '外れ'}`)
        else lines.push(`${this.name(e.unitId)}の射撃を検知（位置露見）`)
      }
      if (e.type === 'bailout') lines.push(`💥 ${this.name(e.unitId)} ベイルアウト`)
    }
    if (!lines.length) lines.push('交戦なし')
    for (const l of lines.reverse()) this.log(`T${turn} ${l}`)
  }

  showEnd() {
    const r = gameResult(this.state)
    const w = r.winner[rules.victory]
    const title = w === 0 ? '勝利' : w === 1 ? '敗北' : '引き分け'
    const record = JSON.stringify({ seed: this.seed, map: this.map.id, comps: this.comps, replay: this.replay })
    const modal = h(
      'div',
      { class: 'modal' },
      h(
        'div',
        { class: 'sheet' },
        h('h2', { class: w === 0 ? 'c-me' : w === 1 ? 'c-en' : '' }, title),
        h('p', {}, `撃破コスト ${r.killCost[0]} - ${r.killCost[1]} ／ 撃破数 ${r.kills[0]} - ${r.kills[1]} ／ ${r.turns}ターン`),
        h(
          'p',
          { class: 'sub' },
          '他の勝利条件だと: ',
          (Object.keys(MODE_LABEL) as VictoryMode[]).map((m) => `${MODE_LABEL[m]}=${r.winner[m] === 0 ? '勝' : r.winner[m] === 1 ? '負' : '分'}`).join(' / '),
        ),
        h('button', { class: 'primary', onclick: () => (modal.remove(), showSetup()) }, 'もう一度'),
        h(
          'button',
          {
            class: 'link',
            onclick: async (e: Event) => {
              try {
                await navigator.clipboard.writeText(record)
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
