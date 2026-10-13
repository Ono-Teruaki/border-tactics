import * as THREE from 'three'
import { key, terrainId } from '../engine/grid.ts'
import type { MapDef, Pos } from '../engine/types.ts'

export type TileMark = 'fog' | 'reach' | 'range' | 'dest' | 'reachRange'

export interface PieceSpec {
  id: string
  side: 0 | 1
  kanji: string
  hp: number | null
  maxHp: number
  pos: Pos
  ghost?: boolean
  label?: string
  selected?: boolean
}

export interface PlanSpec {
  id: string
  from: Pos
  to: Pos
  side: 0 | 1
  kanji: string
  warn?: boolean
}

const BUILDING_H = 0.9
const COLORS = { me: 0x3d8bff, en: 0xff4d4d }
const VIEWS = [
  { name: '斜め', azimuth: Math.PI / 4, elevation: 0.9 },
  { name: '正面', azimuth: 0, elevation: 0.85 },
  { name: '真上', azimuth: 0, elevation: 1.5 },
]

interface Tween {
  start: number
  dur: number
  update: (t: number) => void
  resolve: () => void
}

/** 将棋盤風の3D盤面。ゲームロジックは持たず、渡された表示状態を描くだけ */
export class Board3D {
  readonly canvas: HTMLCanvasElement
  onTap: (p: Pos) => void = () => {}
  private renderer: THREE.WebGLRenderer
  private scene = new THREE.Scene()
  private camera: THREE.PerspectiveCamera
  private map: MapDef
  private half: number
  private overlays = new Map<string, THREE.Mesh>()
  private pickables: THREE.Object3D[] = []
  private pieces = new Map<string, THREE.Group>()
  private planGroup = new THREE.Group()
  private fxGroup = new THREE.Group()
  private texCache = new Map<string, THREE.Texture>()
  private komaGeo: THREE.ExtrudeGeometry
  private tweens: Tween[] = []
  private looping = false
  private viewIndex = 0
  private resizeObs: ResizeObserver
  private container: HTMLElement

  constructor(container: HTMLElement, map: MapDef) {
    this.container = container
    this.map = map
    this.half = (map.width - 1) / 2
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false })
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio))
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
    this.canvas = this.renderer.domElement
    this.canvas.style.touchAction = 'none'
    container.append(this.canvas)
    this.scene.background = new THREE.Color(0x0d1117)
    this.camera = new THREE.PerspectiveCamera(32, 1, 0.1, 200)

    this.scene.add(new THREE.HemisphereLight(0xfff4e0, 0x202530, 1.6))
    const sun = new THREE.DirectionalLight(0xffffff, 2.2)
    sun.position.set(-6, 14, 8)
    sun.castShadow = true
    sun.shadow.mapSize.set(1024, 1024)
    const s = map.width / 2 + 2
    Object.assign(sun.shadow.camera, { left: -s, right: s, top: s, bottom: -s, near: 1, far: 40 })
    this.scene.add(sun)

    this.komaGeo = makeKomaGeometry()
    this.buildBoard()
    this.scene.add(this.planGroup, this.fxGroup)

    this.resizeObs = new ResizeObserver(() => this.resize())
    this.resizeObs.observe(container)
    this.bindInput()
    this.resize()
  }

  dispose() {
    this.resizeObs.disconnect()
    this.renderer.dispose()
    this.canvas.remove()
  }

  // ---------- 座標 ----------
  world(p: Pos, lift = 0): THREE.Vector3 {
    return new THREE.Vector3(p.x - this.half, this.surfaceY(p) + lift, p.y - this.half)
  }
  surfaceY(p: Pos) {
    return terrainId(this.map, p) === 'building' ? BUILDING_H : 0
  }
  tileToScreen(p: Pos): { x: number; y: number } {
    const v = this.world(p, 0.1).project(this.camera)
    const r = this.canvas.getBoundingClientRect()
    return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height }
  }

  // ---------- 盤 ----------
  private buildBoard() {
    const n = this.map.width
    const top = new THREE.MeshStandardMaterial({ map: boardTexture(n), roughness: 0.75 })
    const side = new THREE.MeshStandardMaterial({ color: 0xc08a45, roughness: 0.8 })
    const board = new THREE.Mesh(new THREE.BoxGeometry(n + 0.5, 0.7, n + 0.5), [side, side, top, side, side, side])
    board.position.y = -0.35
    board.receiveShadow = true
    this.scene.add(board)
    // 脚
    const legMat = new THREE.MeshStandardMaterial({ color: 0x8a5a2b, roughness: 0.9 })
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.28, 0.8, 16), legMat)
      leg.position.set((sx * (n - 1)) / 2, -1.1, (sz * (n - 1)) / 2)
      this.scene.add(leg)
    }

    const bTex = buildingTexture()
    const bSide = new THREE.MeshStandardMaterial({ map: bTex, roughness: 0.6 })
    const bTop = new THREE.MeshStandardMaterial({ color: 0x9aa3ad, roughness: 0.7 })
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const p = { x, y }
        const isB = terrainId(this.map, p) === 'building'
        if (isB) {
          const b = new THREE.Mesh(new THREE.BoxGeometry(0.88, BUILDING_H, 0.88), [bSide, bSide, bTop, bTop, bSide, bSide])
          b.position.copy(this.world({ x, y })).setY(BUILDING_H / 2)
          b.castShadow = true
          b.receiveShadow = true
          b.userData.tile = p
          this.scene.add(b)
          this.pickables.push(b)
        }
        const ov = new THREE.Mesh(new THREE.PlaneGeometry(0.94, 0.94), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }))
        ov.rotation.x = -Math.PI / 2
        ov.position.copy(this.world(p, 0.012))
        ov.userData.tile = p
        ov.renderOrder = 1
        this.overlays.set(key(p), ov)
        this.scene.add(ov)
        this.pickables.push(ov)
      }
    }
  }

  setMarks(marks: Map<string, Set<TileMark>>) {
    for (const [k, ov] of this.overlays) {
      const m = marks.get(k)
      const mat = ov.material as THREE.MeshBasicMaterial
      let color = 0x000000
      let opacity = 0
      if (m?.has('fog')) (color = 0x05070c), (opacity = 0.5)
      if (m?.has('range')) (color = 0xff4d4d), (opacity = 0.32)
      if (m?.has('reach')) (color = 0x3d8bff), (opacity = 0.42)
      if (m?.has('reachRange')) (color = 0x9b6bff), (opacity = 0.45)
      if (m?.has('dest')) (color = 0x7fd3ff), (opacity = 0.7)
      mat.color.setHex(color)
      mat.opacity = opacity
    }
    this.requestRender()
  }

  // ---------- 駒 ----------
  private komaTexture(spec: { kanji: string; side: 0 | 1; hp: number | null; maxHp: number; ghost?: boolean; label?: string }) {
    const k = `${spec.kanji}|${spec.side}|${spec.hp}|${spec.maxHp}|${spec.ghost}|${spec.label}`
    let tex = this.texCache.get(k)
    if (!tex) {
      tex = komaTexture(spec)
      this.texCache.set(k, tex)
    }
    return tex
  }

  private makePiece(spec: PieceSpec): THREE.Group {
    const g = new THREE.Group()
    const top = new THREE.MeshStandardMaterial({ roughness: 0.55, transparent: true })
    const side = new THREE.MeshStandardMaterial({ color: 0xe2b874, roughness: 0.6, transparent: true })
    const koma = new THREE.Mesh(this.komaGeo, [top, side])
    koma.castShadow = true
    koma.userData.piece = spec.id
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.44, 0.46, 0.03, 32), new THREE.MeshBasicMaterial({ color: spec.side === 0 ? COLORS.me : COLORS.en, transparent: true }))
    base.position.y = 0.015
    koma.position.y = 0.03
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.46, 0.035, 8, 40), new THREE.MeshBasicMaterial({ color: 0xffffff }))
    ring.rotation.x = Math.PI / 2
    ring.position.y = 0.05
    ring.name = 'ring'
    g.add(base, koma, ring)
    // 自軍は敵陣（右上）へ、敵は自陣（左下）へ向く
    g.rotation.y = spec.side === 0 ? -Math.PI / 4 : (Math.PI * 3) / 4
    g.userData = { id: spec.id, top, side, base, koma }
    this.scene.add(g)
    this.pickables.push(koma)
    return g
  }

  private applySpec(g: THREE.Group, spec: PieceSpec) {
    const { top, side, base, koma } = g.userData as { top: THREE.MeshStandardMaterial; side: THREE.MeshStandardMaterial; base: THREE.Mesh; koma: THREE.Mesh }
    top.map = this.komaTexture(spec)
    top.needsUpdate = true
    const op = spec.ghost ? 0.35 : 1
    top.opacity = op
    side.opacity = op
    ;(base.material as THREE.MeshBasicMaterial).opacity = spec.ghost ? 0.3 : 1
    koma.castShadow = !spec.ghost
    g.getObjectByName('ring')!.visible = !!spec.selected
    koma.userData.tile = spec.pos
    g.userData.pos = spec.pos
  }

  /** 駒の表示を同期する。animate なら移動をトゥイーン */
  syncPieces(specs: PieceSpec[], animate = false, dur = 450): Promise<void> {
    const seen = new Set<string>()
    const moves: Promise<void>[] = []
    for (const spec of specs) {
      seen.add(spec.id)
      let g = this.pieces.get(spec.id)
      const target = this.world(spec.pos)
      if (!g) {
        g = this.makePiece(spec)
        g.position.copy(target)
        this.pieces.set(spec.id, g)
      } else if (animate && !g.position.equals(target)) {
        const from = g.position.clone()
        const grp = g
        moves.push(
          this.tween(dur, (t) => {
            const e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2
            grp.position.lerpVectors(from, target, e)
            grp.position.y += Math.sin(Math.PI * t) * 0.6
          }),
        )
      } else {
        g.position.copy(target)
      }
      this.applySpec(g, spec)
    }
    for (const [id, g] of this.pieces) {
      if (seen.has(id)) continue
      this.scene.remove(g)
      this.pickables = this.pickables.filter((o) => o.parent !== g)
      this.pieces.delete(id)
    }
    this.requestRender()
    return Promise.all(moves).then(() => {})
  }

  setPlans(plans: PlanSpec[]) {
    this.planGroup.clear()
    for (const p of plans) {
      const a = this.world(p.from, 0.25)
      const b = this.world(p.to, 0.25)
      const mid = a.clone().lerp(b, 0.5)
      mid.y += 0.6 + a.distanceTo(b) * 0.1
      const curve = new THREE.QuadraticBezierCurve3(a, mid, b)
      const color = p.warn ? 0xffb020 : p.side === 0 ? 0x7fd3ff : 0xff8080
      const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, 20, 0.035, 6), new THREE.MeshBasicMaterial({ color }))
      this.planGroup.add(tube)
      const cone = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.25, 12), new THREE.MeshBasicMaterial({ color }))
      cone.position.copy(b)
      cone.lookAt(curve.getPoint(0.9))
      cone.rotateX(-Math.PI / 2)
      this.planGroup.add(cone)
      // 移動先の半透明駒
      const top = new THREE.MeshStandardMaterial({ map: this.komaTexture({ kanji: p.kanji, side: p.side, hp: null, maxHp: 0, ghost: true }), transparent: true, opacity: 0.45 })
      const side = new THREE.MeshStandardMaterial({ color: 0xe2b874, transparent: true, opacity: 0.45 })
      const ghost = new THREE.Mesh(this.komaGeo, [top, side])
      ghost.position.copy(this.world(p.to, 0.03))
      ghost.rotation.y = p.side === 0 ? -Math.PI / 4 : (Math.PI * 3) / 4
      this.planGroup.add(ghost)
    }
    this.requestRender()
  }

  // ---------- 演出 ----------
  shoot(from: Pos, to: Pos, side: 0 | 1, spotted: boolean): Promise<void> {
    const a = this.world(from, 0.3)
    const b = this.world(to, 0.3)
    const len = a.distanceTo(b)
    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(0.05, 0.05, len, 8),
      new THREE.MeshBasicMaterial({ color: side === 0 ? 0x9fd0ff : 0xffa0a0, transparent: true }),
    )
    beam.position.copy(a.clone().lerp(b, 0.5))
    beam.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize())
    this.fxGroup.add(beam)
    if (spotted) this.popup(from, '索敵', '#9fe0a0', 600)
    return this.tween(650, (t) => {
      ;(beam.material as THREE.MeshBasicMaterial).opacity = 1 - t
      beam.scale.x = beam.scale.z = 1 + t * 1.5
    }).then(() => void this.fxGroup.remove(beam))
  }

  popup(at: Pos, text: string, color: string, dur = 900): Promise<void> {
    const sprite = textSprite(text, color)
    const p = this.world(at, 0.8)
    sprite.position.copy(p)
    this.fxGroup.add(sprite)
    return this.tween(dur, (t) => {
      sprite.position.y = p.y + t * 0.8
      sprite.material.opacity = t < 0.7 ? 1 : 1 - (t - 0.7) / 0.3
    }).then(() => void this.fxGroup.remove(sprite))
  }

  /** ベイルアウト：光の柱 */
  bailout(at: Pos, side: 0 | 1): Promise<void> {
    const h = 6
    const pillar = new THREE.Mesh(
      new THREE.CylinderGeometry(0.3, 0.3, h, 16, 1, true),
      new THREE.MeshBasicMaterial({ color: side === 0 ? 0x9fd0ff : 0xffa0a0, transparent: true, side: THREE.DoubleSide, depthWrite: false }),
    )
    const base = this.world(at)
    pillar.position.copy(base).setY(base.y + h / 2)
    this.fxGroup.add(pillar)
    this.popup(at, 'BAIL OUT', side === 0 ? '#9fd0ff' : '#ffb0b0', 1100)
    return this.tween(1000, (t) => {
      ;(pillar.material as THREE.MeshBasicMaterial).opacity = 0.8 * (1 - t)
      pillar.scale.x = pillar.scale.z = 1 - t * 0.7
    }).then(() => void this.fxGroup.remove(pillar))
  }

  cycleView(): string {
    this.viewIndex = (this.viewIndex + 1) % VIEWS.length
    this.placeCamera()
    return VIEWS[this.viewIndex].name
  }

  // ---------- 内部 ----------
  private placeCamera() {
    const v = VIEWS[this.viewIndex]
    const e = this.map.width / 2 + 0.3
    const pts = [-e, e].flatMap((x) => [-e, e].flatMap((z) => [new THREE.Vector3(x, -0.7, z), new THREE.Vector3(x, 1.2, z)]))
    // 方位: 自陣（左下 = -x, +z）側から見る。盤の角が画面に収まる最短距離を二分探索
    const dir = new THREE.Vector3(-Math.sin(v.azimuth) * Math.cos(v.elevation), Math.sin(v.elevation), Math.cos(v.azimuth) * Math.cos(v.elevation))
    const fits = (d: number) => {
      this.camera.position.copy(dir).multiplyScalar(d)
      this.camera.lookAt(0, 0, 0)
      this.camera.updateMatrixWorld()
      return pts.every((q) => {
        const pr = q.clone().project(this.camera)
        return Math.abs(pr.x) <= 0.96 && Math.abs(pr.y) <= 0.94
      })
    }
    let lo = 2
    let hi = 200
    for (let i = 0; i < 30; i++) {
      const mid = (lo + hi) / 2
      if (fits(mid)) hi = mid
      else lo = mid
    }
    fits(hi)
    this.requestRender()
  }

  private resize() {
    const w = this.container.clientWidth
    const h = this.container.clientHeight
    if (!w || !h) return
    this.renderer.setSize(w, h, false)
    this.canvas.style.width = `${w}px`
    this.canvas.style.height = `${h}px`
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
    this.placeCamera()
  }

  private bindInput() {
    let down: { x: number; y: number } | null = null
    this.canvas.addEventListener('pointerdown', (e) => (down = { x: e.clientX, y: e.clientY }))
    this.canvas.addEventListener('pointerup', (e) => {
      if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 12) return
      down = null
      const r = this.canvas.getBoundingClientRect()
      const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1)
      const ray = new THREE.Raycaster()
      ray.setFromCamera(ndc, this.camera)
      const hit = ray.intersectObjects(this.pickables, false).find((h) => h.object.userData.tile)
      if (hit) this.onTap(hit.object.userData.tile as Pos)
    })
  }

  private tween(dur: number, update: (t: number) => void): Promise<void> {
    return new Promise((resolve) => {
      this.tweens.push({ start: performance.now(), dur, update, resolve })
      this.loop()
    })
  }

  private loop() {
    if (this.looping) return
    this.looping = true
    const step = () => {
      const now = performance.now()
      this.tweens = this.tweens.filter((tw) => {
        const t = Math.min(1, (now - tw.start) / tw.dur)
        tw.update(t)
        if (t >= 1) tw.resolve()
        return t < 1
      })
      this.renderer.render(this.scene, this.camera)
      if (this.tweens.length) requestAnimationFrame(step)
      else this.looping = false
    }
    requestAnimationFrame(step)
  }

  private renderQueued = false
  requestRender() {
    if (this.looping || this.renderQueued) return
    this.renderQueued = true
    requestAnimationFrame(() => {
      this.renderQueued = false
      this.renderer.render(this.scene, this.camera)
    })
  }
}

// ---------- 形状・テクスチャ ----------
const KW = 0.74
const KH = 0.86

function makeKomaGeometry() {
  const s = new THREE.Shape()
  s.moveTo(-KW / 2, -KH / 2)
  s.lineTo(KW / 2, -KH / 2)
  s.lineTo(KW * 0.4, KH * 0.22)
  s.lineTo(0, KH / 2)
  s.lineTo(-KW * 0.4, KH * 0.22)
  s.closePath()
  const geo = new THREE.ExtrudeGeometry(s, { depth: 0.14, bevelEnabled: true, bevelThickness: 0.025, bevelSize: 0.02, bevelSegments: 2 })
  geo.rotateX(-Math.PI / 2)
  // 上面の UV を形状の外接矩形に合わせる
  const uv = geo.attributes.uv as THREE.BufferAttribute
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) / KW + 0.5, uv.getY(i) / KH + 0.5)
  return geo
}

function canvasTex(c: HTMLCanvasElement) {
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  t.anisotropy = 4
  return t
}

function komaTexture(spec: { kanji: string; side: 0 | 1; hp: number | null; maxHp: number; ghost?: boolean; label?: string }) {
  const W = 256
  const H = Math.round((W * KH) / KW)
  const c = document.createElement('canvas')
  c.width = W
  c.height = H
  const g = c.getContext('2d')!
  const grad = g.createLinearGradient(0, 0, W, H)
  grad.addColorStop(0, '#f3d49a')
  grad.addColorStop(1, '#e0b46c')
  g.fillStyle = grad
  g.fillRect(0, 0, W, H)
  g.strokeStyle = 'rgba(150,100,40,0.25)'
  for (let i = 0; i < 14; i++) {
    g.beginPath()
    g.moveTo(0, (i / 14) * H + 4)
    g.bezierCurveTo(W * 0.3, (i / 14) * H - 6, W * 0.7, (i / 14) * H + 10, W, (i / 14) * H)
    g.stroke()
  }
  g.fillStyle = spec.side === 0 ? '#1b1b1b' : '#b3141b'
  g.font = `900 ${W * 0.5}px "Hiragino Mincho ProN", "Yu Mincho", serif`
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.fillText(spec.kanji, W / 2, H * 0.47)
  if (spec.label) {
    g.font = `700 ${W * 0.15}px system-ui, sans-serif`
    g.fillText(spec.label, W / 2, H * 0.82)
  } else if (spec.hp !== null) {
    const n = spec.maxHp
    const r = W * 0.045
    const gap = r * 2.6
    for (let i = 0; i < n; i++) {
      g.beginPath()
      g.arc(W / 2 + (i - (n - 1) / 2) * gap, H * 0.82, r, 0, Math.PI * 2)
      if (i < spec.hp) g.fill()
      else {
        g.lineWidth = 3
        g.stroke()
      }
    }
  } else if (!spec.ghost) {
    g.font = `700 ${W * 0.16}px system-ui`
    g.fillText('?', W / 2, H * 0.82)
  }
  return canvasTex(c)
}

function boardTexture(n: number) {
  const px = 64
  const pad = 0.25
  const size = Math.round((n + pad * 2) * px)
  const c = document.createElement('canvas')
  c.width = c.height = size
  const g = c.getContext('2d')!
  g.fillStyle = '#e6b86a'
  g.fillRect(0, 0, size, size)
  for (let i = 0; i < 60; i++) {
    g.strokeStyle = `rgba(160,105,40,${0.08 + Math.random() * 0.1})`
    g.lineWidth = 1 + Math.random() * 2
    const y = Math.random() * size
    g.beginPath()
    g.moveTo(0, y)
    g.bezierCurveTo(size * 0.3, y + 8, size * 0.6, y - 8, size, y + 4)
    g.stroke()
  }
  g.strokeStyle = '#2a1a08'
  g.lineWidth = 2
  const o = pad * px
  for (let i = 0; i <= n; i++) {
    g.beginPath()
    g.moveTo(o + i * px, o)
    g.lineTo(o + i * px, o + n * px)
    g.moveTo(o, o + i * px)
    g.lineTo(o + n * px, o + i * px)
    g.stroke()
  }
  return canvasTex(c)
}

function buildingTexture() {
  const c = document.createElement('canvas')
  c.width = 64
  c.height = 64
  const g = c.getContext('2d')!
  g.fillStyle = '#6f7882'
  g.fillRect(0, 0, 64, 64)
  g.fillStyle = '#2b3440'
  for (let y = 0; y < 4; y++) for (let x = 0; x < 3; x++) g.fillRect(6 + x * 19, 6 + y * 15, 13, 9)
  g.fillStyle = 'rgba(255,220,140,0.6)'
  g.fillRect(25, 21, 13, 9)
  return canvasTex(c)
}

function textSprite(text: string, color: string) {
  const c = document.createElement('canvas')
  c.width = 256
  c.height = 96
  const g = c.getContext('2d')!
  g.font = '900 64px system-ui, sans-serif'
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.lineWidth = 10
  g.strokeStyle = '#000'
  g.strokeText(text, 128, 48)
  g.fillStyle = color
  g.fillText(text, 128, 48)
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: canvasTex(c), transparent: true, depthTest: false }))
  sprite.scale.set(1.4, 0.525, 1)
  sprite.renderOrder = 10
  return sprite
}
