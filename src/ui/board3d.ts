import * as THREE from 'three'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'
import { key, terrainId } from '../engine/grid.ts'
import type { MapDef, Pos } from '../engine/types.ts'

export type TileMark = 'fog' | 'reach' | 'range' | 'dest' | 'reachRange'

export interface PieceSpec {
  id: string
  side: 0 | 1
  cls: string
  letter: string
  /** クラスの漢字（駒に浮かべる字） */
  kanji: string
  hp: number | null
  maxHp: number
  pos: Pos
  ghost?: boolean
  label?: string
  selected?: boolean
  targeted?: boolean
  /** マーク中（緑の印） */
  marked?: boolean
}

export interface PlanSpec {
  id: string
  cls: string
  from: Pos
  to: Pos
  warn?: boolean
  /** 狙い先（移動先からの射線） */
  target?: Pos
  targetOk?: boolean
}

const BUILDING_H = 0.9
/** 作戦卓ホログラム（ホロ＋）の配色 */
const C = {
  me: 0x37c3ff,
  en: 0xff5b47,
  warn: 0xffc247,
  edge: 0x7fe3ff,
  ink: '#0a1424',
}
const hex = (c: number) => '#' + c.toString(16).padStart(6, '0')
/** 駒の字を浮かべる高さ */
const TAG_Y = 0.66
const VIEWS = [
  { name: '標準', azimuth: 0.22, elevation: 0.92 },
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

/** チェス盤風の3D盤面。ゲームロジックは持たず、渡された表示状態を描くだけ */
export class Board3D {
  readonly canvas: HTMLCanvasElement
  onTap: (p: Pos) => void = () => {}
  private container: HTMLElement
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
  private visionEdges = new THREE.Group()
  private composer: EffectComposer
  private bloom: UnrealBloomPass
  private tweens: Tween[] = []
  private looping = false
  private viewIndex = 0
  private zoom = 1
  private pan = new THREE.Vector3()
  private baseDist = 10
  private resizeObs: ResizeObserver
  /** 演出の再生速度（スキップ時は大きくする） */
  speed = 1
  /** スローモーション係数（<1 で遅くなる） */
  private timeScale = 1

  constructor(container: HTMLElement, map: MapDef) {
    this.container = container
    this.map = map
    this.half = (map.width - 1) / 2
    this.renderer = new THREE.WebGLRenderer({ antialias: true })
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio))
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
    this.canvas = this.renderer.domElement
    this.canvas.style.touchAction = 'none'
    container.append(this.canvas)
    this.scene.background = gradientTexture('#0d1b2e', '#1a2d47')
    this.camera = new THREE.PerspectiveCamera(32, 1, 0.1, 200)
    // 字や光の筋をにじませる
    this.composer = new EffectComposer(this.renderer)
    this.composer.addPass(new RenderPass(this.scene, this.camera))
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.35, 0.3, 0.7)
    this.composer.addPass(this.bloom)
    this.composer.addPass(new OutputPass())

    this.scene.add(new THREE.HemisphereLight(0xbfe6ff, 0x0b1626, 1.1))
    const sun = new THREE.DirectionalLight(0xe6f4ff, 2.0)
    sun.position.set(-5, 14, 7)
    sun.castShadow = true
    sun.shadow.mapSize.set(2048, 2048)
    const s = map.width / 2 + 2
    Object.assign(sun.shadow.camera, { left: -s, right: s, top: s, bottom: -s, near: 1, far: 40 })
    this.scene.add(sun)

    this.buildBoard()
    this.scene.add(this.visionEdges, this.planGroup, this.fxGroup)

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
    // 卓：厚みのある台＋光る縁
    const tableGeo = new THREE.BoxGeometry(n + 1.0, 0.35, n + 1.0)
    const table = new THREE.Mesh(tableGeo, new THREE.MeshStandardMaterial({ color: 0x14263d, roughness: 0.6, metalness: 0.2 }))
    table.position.y = -0.18
    table.receiveShadow = true
    this.scene.add(table)
    const rim = new THREE.LineSegments(new THREE.EdgesGeometry(tableGeo), new THREE.LineBasicMaterial({ color: 0x3fa9d6 }))
    rim.position.y = -0.18
    this.scene.add(rim)
    const surface = new THREE.Mesh(new THREE.PlaneGeometry(n, n), new THREE.MeshStandardMaterial({ map: boardTexture(this.map), roughness: 0.55, metalness: 0.1 }))
    surface.rotation.x = -Math.PI / 2
    surface.position.y = 0.001
    surface.receiveShadow = true
    this.scene.add(surface)

    // ビル：すりガラスの箱＋光る輪郭
    const glass = new THREE.MeshStandardMaterial({ color: 0x2a5b85, roughness: 0.2, metalness: 0.3, transparent: true, opacity: 0.8, emissive: 0x0c2a44 })
    const roof = new THREE.MeshStandardMaterial({ color: 0x3d7bab, roughness: 0.4 })
    const edgeMat = new THREE.LineBasicMaterial({ color: 0x8fe6ff })
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const p = { x, y }
        if (terrainId(this.map, p) === 'building') {
          const b = new THREE.Mesh(new THREE.BoxGeometry(0.88, BUILDING_H, 0.88), [glass, glass, roof, glass, glass, glass])
          b.position.copy(this.world({ x, y })).setY(BUILDING_H / 2)
          b.castShadow = true
          b.receiveShadow = true
          b.userData.tile = p
          this.scene.add(b)
          this.pickables.push(b)
          const edge = new THREE.LineSegments(new THREE.EdgesGeometry(b.geometry), edgeMat)
          edge.position.copy(b.position)
          this.scene.add(edge)
        }
        const ov = new THREE.Mesh(new THREE.PlaneGeometry(0.98, 0.98), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }))
        ov.rotation.x = -Math.PI / 2
        ov.position.copy(this.world(p, 0.006))
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
      if (m?.has('fog')) (color = 0x02060c), (opacity = 0.55)
      if (m?.has('range')) (color = C.en), (opacity = 0.2)
      if (m?.has('reach')) (color = C.me), (opacity = 0.3)
      if (m?.has('reachRange')) (color = 0x9a7cff), (opacity = 0.35)
      if (m?.has('dest')) (color = C.me), (opacity = 0.6)
      mat.color.setHex(color)
      mat.opacity = opacity
    }
    this.drawVisionEdges(marks)
    this.requestRender()
  }

  /** 視界の境目（見えている地上マスと霧のマスの間）に光る線を引く */
  private drawVisionEdges(marks: Map<string, Set<TileMark>>) {
    this.visionEdges.clear()
    const fog = (p: Pos) => !!marks.get(key(p))?.has('fog')
    if (![...marks.values()].some((m) => m.has('fog'))) return
    const mat = new THREE.MeshBasicMaterial({ color: C.edge, transparent: true, opacity: 0.9 })
    const n = this.map.width
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const p = { x, y }
        if (fog(p) || terrainId(this.map, p) === 'building') continue
        for (const [dx, dy] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ]) {
          const q = { x: x + dx, y: y + dy }
          if (q.x < 0 || q.y < 0 || q.x >= n || q.y >= n || !fog(q)) continue
          const seg = new THREE.Mesh(new THREE.PlaneGeometry(dx ? 0.05 : 1, dx ? 1 : 0.05), mat)
          seg.rotation.x = -Math.PI / 2
          seg.position.set(x - this.half + dx * 0.5, 0.014, y - this.half + dy * 0.5)
          this.visionEdges.add(seg)
        }
      }
    }
  }

  // ---------- 駒 ----------
  /** 半透明の六角の台座＋光の柱＋浮かぶ光る字（クラスの漢字） */
  private makePiece(spec: PieceSpec): THREE.Group {
    const g = new THREE.Group()
    const col = spec.side === 0 ? C.me : C.en
    const body = new THREE.Mesh(
      new THREE.CylinderGeometry(0.34, 0.38, 0.08, 6),
      new THREE.MeshStandardMaterial({ color: col, emissive: col, emissiveIntensity: 0.12, transparent: true, opacity: 0.3, depthWrite: false }),
    )
    body.position.y = 0.04
    body.castShadow = true
    const rim = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.CylinderGeometry(0.38, 0.38, 0.001, 6)), new THREE.LineBasicMaterial({ color: col, transparent: true }))
    rim.position.y = 0.08
    const band = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.5, 6), new THREE.MeshBasicMaterial({ color: col, transparent: true }))
    band.position.y = 0.33
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.42, 0.49, 6, 1, Math.PI / 6), new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide }))
    ring.rotation.x = -Math.PI / 2
    ring.position.y = 0.012
    ring.name = 'ring'
    const reticle = new THREE.Mesh(new THREE.RingGeometry(0.4, 0.48, 4, 1, Math.PI / 4), new THREE.MeshBasicMaterial({ color: C.warn, side: THREE.DoubleSide }))
    reticle.rotation.x = -Math.PI / 2
    reticle.position.y = 0.014
    reticle.name = 'reticle'
    const tag = new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true, depthTest: false }))
    tag.scale.set(0.9, 0.5625, 1)
    tag.position.y = TAG_Y
    tag.renderOrder = 5
    g.add(body, rim, band, ring, reticle, tag)
    g.userData = { id: spec.id, body, band, rim, tag, tagKey: '', color: col }
    this.scene.add(g)
    this.pickables.push(body)
    return g
  }

  private applySpec(g: THREE.Group, spec: PieceSpec) {
    const { band, tag } = g.userData as { band: THREE.Mesh; tag: THREE.Sprite }
    this.setOpacity(g, spec.ghost ? 0.35 : 1)
    band.visible = !spec.ghost
    g.getObjectByName('ring')!.visible = !!spec.selected
    g.getObjectByName('reticle')!.visible = !!spec.targeted
    const tk = `${spec.letter}|${spec.cls}|${spec.side}|${spec.hp}|${spec.maxHp}|${spec.label}|${spec.ghost}|${spec.marked}`
    if (g.userData.tagKey !== tk) {
      tag.material.map?.dispose()
      tag.material.map = tagTexture(spec)
      tag.material.needsUpdate = true
      g.userData.tagKey = tk
    }
    ;(g.userData.body as THREE.Mesh).userData.tile = spec.pos
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
            grp.position.y += Math.sin(Math.PI * t) * 0.35
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
      if (p.from.x !== p.to.x || p.from.y !== p.to.y) {
        this.planGroup.add(flatArrow(this.world(p.from, 0.03), this.world(p.to, 0.03), p.warn ? C.warn : C.me))
        const ghost = new THREE.LineSegments(
          new THREE.EdgesGeometry(new THREE.CylinderGeometry(0.38, 0.38, 0.08, 6)),
          new THREE.LineBasicMaterial({ color: C.me, transparent: true, opacity: 0.7 }),
        )
        ghost.position.copy(this.world(p.to, 0.04))
        this.planGroup.add(ghost)
      }
      if (p.target) {
        const line = new THREE.Line(
          new THREE.BufferGeometry().setFromPoints([this.world(p.to, 0.55), this.world(p.target, 0.45)]),
          new THREE.LineDashedMaterial({ color: p.targetOk ? C.en : C.warn, dashSize: 0.12, gapSize: 0.08, depthTest: false, transparent: true }),
        )
        line.computeLineDistances()
        line.renderOrder = 4
        this.planGroup.add(line)
      }
    }
    this.requestRender()
  }

  // ---------- 演出 ----------
  wait(ms: number): Promise<void> {
    return this.tween(ms, () => {})
  }

  /** 1体だけ移動させる */
  movePiece(id: string, to: Pos, dur = 520): Promise<void> {
    const g = this.pieces.get(id)
    if (!g) return Promise.resolve()
    const from = g.position.clone()
    const target = this.world(to)
    ;(g.userData.body as THREE.Mesh).userData.tile = to
    return this.tween(dur, (t) => {
      const e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2
      g.position.lerpVectors(from, target, e)
      g.position.y += Math.sin(Math.PI * t) * 0.35
    })
  }

  /** 駒の透明度（視界に出入りする演出用）。次の syncPieces で元に戻る */
  setPieceOpacity(id: string, op: number) {
    const g = this.pieces.get(id)
    if (g) this.setOpacity(g, op)
  }

  private setOpacity(g: THREE.Group, op: number) {
    const { body, band, rim, tag } = g.userData as { body: THREE.Mesh; band: THREE.Mesh; rim: THREE.LineSegments; tag: THREE.Sprite }
    ;(body.material as THREE.MeshStandardMaterial).opacity = 0.22 * op
    ;(band.material as THREE.MeshBasicMaterial).opacity = 0.5 * op
    ;(rim.material as THREE.LineBasicMaterial).opacity = 0.7 * op
    tag.material.opacity = op
    body.castShadow = op > 0.5
    this.requestRender()
  }

  /**
   * マスの経路に沿って移動する（1マスごとに小さく跳ねる）。
   * fadeIn は最初の1マスで現れ（視界に入る）、fadeOut は最後の1マスで消える（視界から出る）
   */
  movePath(id: string, path: Pos[], opt: { fadeIn?: boolean; fadeOut?: boolean } = {}): Promise<void> {
    const g = this.pieces.get(id)
    if (!g || path.length < 2) return Promise.resolve()
    const pts = path.map((p) => this.world(p))
    const n = pts.length - 1
    ;(g.userData.body as THREE.Mesh).userData.tile = path[n]
    return this.tween(220 + 170 * n, (t) => {
      const e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2
      const f = e * n
      const i = Math.min(n - 1, Math.floor(f))
      const u = f - i
      g.position.lerpVectors(pts[i], pts[i + 1], u)
      // 段差は早めに上り下りし、1マスごとに小さく跳ねる
      g.position.y = THREE.MathUtils.lerp(pts[i].y, pts[i + 1].y, Math.min(1, u * 1.6)) + Math.sin(Math.PI * u) * 0.18
      let op = 1
      if (opt.fadeIn) op = Math.min(op, f)
      if (opt.fadeOut) op = Math.min(op, n - f)
      this.setOpacity(g, Math.max(0, Math.min(1, op)))
    })
  }

  /** 移動しようとして弾かれる（干渉マスの手前まで進んで戻る） */
  bouncePiece(id: string, toward: Pos, dur = 700): Promise<void> {
    const g = this.pieces.get(id)
    if (!g) return Promise.resolve()
    const from = g.position.clone()
    const mid = from.clone().lerp(this.world(toward), 0.62)
    return this.tween(dur, (t) => {
      // 前半で一気に進み、ぶつかって押し戻される
      const k = t < 0.45 ? 1 - (1 - t / 0.45) ** 2 : 1 - ((t - 0.45) / 0.55) ** 0.7
      g.position.lerpVectors(from, mid, k)
      g.position.y += Math.sin(Math.PI * Math.min(1, t / 0.45)) * 0.25 * (t < 0.45 ? 1 : 0)
    })
  }

  /** 干渉した地点の衝撃 */
  clash(at: Pos) {
    this.burst(at, 0xf0a020, 0.35)
    this.popup(at, '干渉!', '#ffc247', 900)
  }

  /** 指定したマス群が収まるようにカメラを寄せる */
  focus(points: Pos[], dur = 450, maxZoom = 2.6): Promise<void> {
    const xs = points.map((p) => p.x - this.half)
    const zs = points.map((p) => p.y - this.half)
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2
    const cz = (Math.min(...zs) + Math.max(...zs)) / 2
    const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs)) + 3
    const z = Math.min(maxZoom, Math.max(1, this.map.width / span))
    return this.cameraTo(new THREE.Vector3(cx, 0, cz), z, dur)
  }

  overview(dur = 450): Promise<void> {
    return this.cameraTo(new THREE.Vector3(), 1, dur)
  }

  private cameraTo(pan: THREE.Vector3, zoom: number, dur: number): Promise<void> {
    const p0 = this.pan.clone()
    const z0 = this.zoom
    return this.tween(dur, (t) => {
      const e = 1 - (1 - t) ** 3
      this.pan.lerpVectors(p0, pan, e)
      this.zoom = z0 + (zoom - z0) * e
      this.updateCamera()
    })
  }

  /** 弾ごとに発射して命中/ミスを表示。命中時はヒットストップ・閃光・揺れ */
  async volley(from: Pos, to: Pos, side: 0 | 1, shots: { hit: boolean; damage: number }[], spotted: boolean, targetId?: string): Promise<void> {
    if (spotted) this.popup(from, '索敵連携', '#3ddc84', 900)
    const color = side === 0 ? C.me : C.en
    for (let i = 0; i < shots.length; i++) {
      const s = shots[i]
      const a = this.world(from, 0.5)
      const b = this.world(to, 0.45)
      if (!s.hit) {
        // 外れ弾は少しそらす
        const off = new THREE.Vector3(-(b.z - a.z), 0, b.x - a.x).normalize().multiplyScalar((i % 2 ? 1 : -1) * 0.45)
        b.add(off).add(b.clone().sub(a).normalize().multiplyScalar(0.5))
      }
      await this.tracer(a, b, color, shots.length > 1 ? 110 : 170)
      const dx = (i - (shots.length - 1) / 2) * 0.45
      if (s.hit) {
        this.burst(to, color, 0.45)
        if (targetId) {
          this.flash(targetId)
          this.knockback(targetId, from)
        }
        this.popup(to, `-${s.damage}`, '#ff5b47', 850, dx, 1.25)
        // 手応え：ダメージが大きいほど強く。連射は1発ごとに軽く
        const str = Math.min(1.2, 0.3 + s.damage / 16) * (shots.length > 1 ? 0.6 : 1)
        await this.impact(str, side === 1)
      } else {
        this.popup(to, 'MISS', '#8aa4bf', 700, dx)
        await this.wait(shots.length > 1 ? 90 : 160)
      }
    }
    await this.wait(260)
  }

  /** 弾道：先端が飛んでいき、残光が消える */
  private tracer(a: THREE.Vector3, b: THREE.Vector3, color: number, flight: number): Promise<void> {
    const len = a.distanceTo(b)
    const dir = b.clone().sub(a).normalize()
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 1, 8), new THREE.MeshBasicMaterial({ color, transparent: true }))
    beam.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir)
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.08, 12, 8), new THREE.MeshBasicMaterial({ color: 0xffffff }))
    this.fxGroup.add(beam, head)
    const fly = this.tween(flight, (t) => {
      const l = Math.max(0.01, len * t)
      beam.scale.y = l
      beam.position.copy(a).addScaledVector(dir, l / 2)
      head.position.copy(a).addScaledVector(dir, l)
    })
    fly.then(() => {
      this.fxGroup.remove(head)
      this.tween(320, (t) => {
        ;(beam.material as THREE.MeshBasicMaterial).opacity = 1 - t
        beam.scale.x = beam.scale.z = 1 + t * 2
      }).then(() => void this.fxGroup.remove(beam))
    })
    return fly
  }

  /** 着弾の衝撃波と火花 */
  burst(at: Pos, color: number, size: number) {
    const c = this.world(at, 0.45)
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.2, 0.28, 32), new THREE.MeshBasicMaterial({ color, transparent: true, side: THREE.DoubleSide, depthWrite: false }))
    ring.position.copy(c)
    ring.lookAt(this.camera.position)
    const sparks: { m: THREE.Mesh; v: THREE.Vector3 }[] = []
    for (let i = 0; i < 10; i++) {
      const m = new THREE.Mesh(new THREE.SphereGeometry(0.035, 6, 4), new THREE.MeshBasicMaterial({ color: i % 2 ? 0xffffff : color, transparent: true }))
      m.position.copy(c)
      const v = new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.8 + 0.2, Math.random() - 0.5).normalize().multiplyScalar(size * (1.5 + Math.random()))
      sparks.push({ m, v })
      this.fxGroup.add(m)
    }
    this.fxGroup.add(ring)
    this.tween(420, (t) => {
      ring.scale.setScalar(1 + t * size * 6)
      ;(ring.material as THREE.MeshBasicMaterial).opacity = 1 - t
      for (const s of sparks) {
        s.m.position.copy(c).addScaledVector(s.v, t).setY(c.y + s.v.y * t - 0.6 * t * t)
        ;(s.m.material as THREE.MeshBasicMaterial).opacity = 1 - t
      }
    }).then(() => {
      this.fxGroup.remove(ring)
      for (const s of sparks) this.fxGroup.remove(s.m)
    })
  }

  /** 被弾した駒を一瞬光らせる */
  private flash(id: string) {
    const g = this.pieces.get(id)
    if (!g) return
    const mat = (g.userData.body as THREE.Mesh).material as THREE.MeshStandardMaterial
    const base = new THREE.Color(g.userData.color as number)
    const hit = new THREE.Color(0xffffff)
    this.tween(260, (t) => {
      mat.emissive.copy(hit).lerp(base, t)
      mat.emissiveIntensity = 2.5 * (1 - t) + 0.12 * t
    }).then(() => {
      mat.emissive.copy(base)
      mat.emissiveIntensity = 0.12
    })
  }

  /** 被弾の反動で少しのけぞる */
  private knockback(id: string, from: Pos) {
    const g = this.pieces.get(id)
    if (!g) return
    const base = g.position.clone()
    const dir = base.clone().sub(this.world(from)).setY(0).normalize()
    const axis = new THREE.Vector3(dir.z, 0, -dir.x)
    this.tween(260, (t) => {
      const k = Math.sin(Math.PI * t) * (1 - t)
      g.position.copy(base).addScaledVector(dir, k * 0.18)
      g.setRotationFromAxisAngle(axis, k * 0.35)
    }).then(() => {
      g.position.copy(base)
      g.rotation.set(0, 0, 0)
    })
  }

  /**
   * 画面を揺らす。strength は 0〜1.5 くらい（1 = 普通の命中）。
   * 揺れ幅はカメラまでの距離に比例させるので、引いた画でも寄った画でも同じくらい揺れて見える。
   * 着弾の瞬間に少し寄る（ズームパンチ）
   */
  shake(dur: number, strength: number): Promise<void> {
    const k = this.reducedMotion ? 0.25 : 1
    const fov0 = this.camera.fov
    const seed = Math.random() * 10
    return this.tween(dur, (t) => {
      this.updateCamera()
      const ms = t * dur
      const decay = (1 - t) ** 2
      const amp = (this.baseDist / this.zoom) * 0.014 * strength * k * decay
      const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0)
      const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1)
      this.camera.position.addScaledVector(right, Math.sin(ms * 0.09 + seed) * amp).addScaledVector(up, Math.cos(ms * 0.113 + seed) * amp * 0.8)
      this.camera.fov = fov0 - 2.2 * strength * k * (1 - t) ** 4
      this.camera.updateProjectionMatrix()
    }).then(() => {
      this.camera.fov = fov0
      this.camera.updateProjectionMatrix()
      this.updateCamera()
    })
  }

  private reducedMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
  private flashEl: HTMLDivElement | null = null

  /** 画面の閃光（味方が撃たれたら赤、敵に当てたら白など） */
  flashScreen(color: string, opacity: number) {
    if (!this.flashEl) {
      const el = document.createElement('div')
      el.style.cssText = 'position:absolute;inset:0;pointer-events:none;opacity:0;mix-blend-mode:screen;transition:opacity 280ms ease-out'
      this.container.append(el)
      this.flashEl = el
    }
    const el = this.flashEl
    el.style.transition = 'none'
    el.style.background = `radial-gradient(ellipse at center, transparent 35%, ${color} 120%), ${color}`
    el.style.opacity = String(Math.min(0.6, opacity * (this.reducedMotion ? 0.4 : 1)))
    requestAnimationFrame(() => {
      el.style.transition = 'opacity 280ms ease-out'
      el.style.opacity = '0'
    })
  }

  /**
   * 命中の手応えをまとめて出す: 画面の閃光 → 一瞬止める（ヒットストップ）→ 揺れ。対応端末は振動も。
   * strength は与えたダメージや撃破かどうかで決める。mine は味方が撃たれたとき（赤く光らせる）
   */
  async impact(strength: number, mine: boolean) {
    this.flashScreen(mine ? '#ff3b30' : '#ffffff', mine ? 0.28 * strength : 0.14 * strength)
    try {
      navigator.vibrate?.(Math.round(15 + 35 * strength))
    } catch {
      /* 振動できない端末は無視 */
    }
    await this.wait(35 + 45 * strength)
    await this.shake(180 + 160 * strength, strength)
  }

  popup(at: Pos, text: string, color: string, dur = 900, dx = 0, scale = 1): Promise<void> {
    const sprite = textSprite(text, color)
    sprite.scale.multiplyScalar(scale)
    const p = this.world(at, 1.3)
    p.x += dx
    sprite.position.copy(p)
    this.fxGroup.add(sprite)
    return this.tween(dur, (t) => {
      sprite.position.y = p.y + t * 0.5
      sprite.material.opacity = t < 0.7 ? 1 : 1 - (t - 0.7) / 0.3
    }).then(() => void this.fxGroup.remove(sprite))
  }

  /** 撃破：少しスローで吹っ飛ばされて倒れ、光の柱と「撃破」 */
  async defeat(id: string, at: Pos, side: 0 | 1, from?: Pos): Promise<void> {
    const g = this.pieces.get(id)
    if (g) {
      this.timeScale = 0.45
      const start = g.position.clone()
      let dir = from ? this.world(at).sub(this.world(from)).setY(0) : new THREE.Vector3(1, 0, 0)
      if (dir.lengthSq() === 0) dir = new THREE.Vector3(1, 0, 0)
      dir.normalize()
      const axis = new THREE.Vector3(dir.z, 0, -dir.x)
      const land = start.clone().addScaledVector(dir, 0.55)
      // 吹っ飛び：放物線で飛びながら回転して倒れる
      await this.tween(420, (t) => {
        g.position.lerpVectors(start, land, t)
        g.position.y = start.y + Math.sin(Math.PI * t) * 0.45
        g.setRotationFromAxisAngle(axis, (Math.PI / 2) * 0.92 * Math.min(1, t * 1.15) + Math.sin(Math.PI * t) * 0.35)
      })
      this.timeScale = 1
      this.burst({ x: at.x, y: at.y }, 0xffffff, 0.25)
      // 着地して小さく跳ねる
      await this.tween(260, (t) => {
        g.position.y = start.y + Math.sin(Math.PI * t) * 0.08
        g.setRotationFromAxisAngle(axis, (Math.PI / 2) * (0.92 + Math.sin(Math.PI * t) * -0.06))
      })
      await this.shake(220, 0.7)
    }
    const h = 6
    const pillar = new THREE.Mesh(
      new THREE.CylinderGeometry(0.28, 0.28, h, 24, 1, true),
      new THREE.MeshBasicMaterial({ color: side === 0 ? C.me : C.en, transparent: true, side: THREE.DoubleSide, depthWrite: false }),
    )
    const base = g ? g.position.clone().setY(this.world(at).y) : this.world(at)
    pillar.position.copy(base).setY(base.y + h / 2)
    this.fxGroup.add(pillar)
    this.burst(at, side === 0 ? C.me : C.en, 0.6)
    this.popup(at, '撃破', side === 0 ? '#37c3ff' : '#ff5b47', 1200, 0, 1.3)
    await this.tween(900, (t) => {
      ;(pillar.material as THREE.MeshBasicMaterial).opacity = 0.6 * (1 - t)
      pillar.scale.x = pillar.scale.z = 1 - t * 0.7
      if (g)
        g.traverse((o) => {
          const m = (o as THREE.Mesh).material as THREE.Material | undefined
          if (m && 'opacity' in m) (m as THREE.MeshBasicMaterial).opacity = Math.min((m as THREE.MeshBasicMaterial).opacity, 1 - t)
        })
    })
    this.fxGroup.remove(pillar)
  }

  /** 近接攻撃：踏み込んで斬撃 */
  async meleeStrike(attackerId: string, from: Pos, to: Pos, side: 0 | 1, shots: { hit: boolean; damage: number }[], targetId: string, lethal: boolean): Promise<void> {
    const g = this.pieces.get(attackerId)
    const color = side === 0 ? C.me : C.en
    await this.focus([from, to], 380, 3.2)
    for (let i = 0; i < shots.length; i++) {
      const s = shots[i]
      const isKill = lethal && i === shots.length - 1
      const home = g?.position.clone() ?? this.world(from)
      const lunge = home.clone().lerp(this.world(to), 0.58)
      // 溜め → 踏み込み
      if (g) {
        await this.tween(160, (t) => {
          g.position.copy(home).addScaledVector(lunge.clone().sub(home), -0.12 * Math.sin((Math.PI * t) / 2))
        })
        await this.tween(90, (t) => {
          g.position.lerpVectors(home, lunge, t * t)
          g.position.y = home.y + Math.sin(Math.PI * t) * 0.12
        })
      }
      if (isKill) this.timeScale = 0.45
      this.slash(from, to, color, s.hit)
      if (s.hit) {
        this.burst(to, color, isKill ? 0.7 : 0.45)
        this.flash(targetId)
        if (!isKill) this.knockback(targetId, from)
        this.popup(to, `-${s.damage}`, '#ff5b47', 850, 0, isKill ? 1.6 : 1.25)
        await this.impact(isKill ? 1.4 : Math.min(1.1, 0.4 + s.damage / 16), side === 1)
      } else {
        this.popup(to, 'MISS', '#8aa4bf', 700)
        await this.wait(160)
      }
      this.timeScale = 1
      // 戻る
      if (g) {
        await this.tween(200, (t) => {
          g.position.lerpVectors(lunge, home, 1 - (1 - t) ** 2)
        })
      }
    }
    await this.wait(200)
  }

  /** 斬撃の弧 */
  private slash(from: Pos, to: Pos, color: number, hit: boolean) {
    const c = this.world(to, 0.5)
    const arc = new THREE.Mesh(
      new THREE.TorusGeometry(0.42, 0.045, 6, 32, Math.PI * 0.85),
      new THREE.MeshBasicMaterial({ color: hit ? 0xffffff : 0xb8c0cc, transparent: true, depthTest: false }),
    )
    const glow = new THREE.Mesh(
      new THREE.TorusGeometry(0.42, 0.11, 6, 32, Math.PI * 0.85),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.5, depthTest: false }),
    )
    const grp = new THREE.Group()
    grp.add(glow, arc)
    grp.position.copy(c)
    grp.lookAt(this.camera.position)
    const dir = this.world(to).sub(this.world(from))
    grp.rotateZ(Math.atan2(dir.z, dir.x) + (hit ? -0.6 : 0.4))
    grp.renderOrder = 6
    this.fxGroup.add(grp)
    this.tween(300, (t) => {
      grp.rotateZ(0.12)
      grp.scale.setScalar(0.7 + t * 0.6)
      ;(arc.material as THREE.MeshBasicMaterial).opacity = 1 - t
      ;(glow.material as THREE.MeshBasicMaterial).opacity = 0.5 * (1 - t)
    }).then(() => void this.fxGroup.remove(grp))
  }

  /**
   * 遠距離でのとどめ：撃ち手に寄って発射 → 弾を追う → 着弾の瞬間をスローで。
   * それまでの弾は通常どおり。
   */
  async killShot(from: Pos, to: Pos, side: 0 | 1, shots: { hit: boolean; damage: number }[], spotted: boolean, targetId: string): Promise<void> {
    const color = side === 0 ? C.me : C.en
    const lastHit = shots.map((x) => x.hit).lastIndexOf(true)
    const before = shots.slice(0, lastHit)
    if (before.length) {
      await this.focus([from, to], 380)
      await this.volley(from, to, side, before, spotted, targetId)
    } else if (spotted) this.popup(from, '索敵連携', '#3ddc84', 900)
    // 撃ち手のアップ
    await this.focus([from], 380, 3.4)
    this.burst(from, 0xffffff, 0.2)
    await this.wait(120)
    // 弾を追う（スロー）
    this.timeScale = 0.5
    const a = this.world(from, 0.5)
    const b = this.world(to, 0.45)
    const flight = 260 + a.distanceTo(b) * 60
    const cam = this.focus([to], flight, 3.4)
    await this.tracer(a, b, color, flight)
    await cam
    // 着弾
    const s = shots[lastHit]
    this.burst(to, color, 0.75)
    this.flash(targetId)
    this.popup(to, `-${s.damage}`, '#ff5b47', 1000, 0, 1.7)
    await this.impact(1.5, side === 1)
    this.timeScale = 1
    for (const rest of shots.slice(lastHit + 1)) this.popup(to, rest.hit ? `-${rest.damage}` : 'MISS', '#8aa4bf', 600)
    await this.wait(150)
  }

  // ---------- カメラ（視点・ズーム・パン） ----------
  cycleView(): string {
    this.viewIndex = (this.viewIndex + 1) % VIEWS.length
    this.resetZoom()
    return VIEWS[this.viewIndex].name
  }
  zoomBy(f: number) {
    this.zoom = Math.min(3.5, Math.max(0.8, this.zoom * f))
    if (this.zoom <= 1.001) this.pan.set(0, 0, 0)
    this.updateCamera()
  }
  resetZoom() {
    this.zoom = 1
    this.pan.set(0, 0, 0)
    this.fitCamera()
  }

  private dir() {
    const v = VIEWS[this.viewIndex]
    // 自陣（左下 = -x, +z）側から見る
    return new THREE.Vector3(-Math.sin(v.azimuth) * Math.cos(v.elevation), Math.sin(v.elevation), Math.cos(v.azimuth) * Math.cos(v.elevation))
  }

  /** 盤全体が収まる距離を二分探索で求める */
  private fitCamera() {
    const e = this.map.width / 2 + 0.25
    const pts = [-e, e].flatMap((x) => [-e, e].flatMap((z) => [new THREE.Vector3(x, -0.5, z), new THREE.Vector3(x, 1.2, z)]))
    const dir = this.dir()
    const fits = (d: number) => {
      this.camera.position.copy(dir).multiplyScalar(d)
      this.camera.lookAt(0, 0, 0)
      this.camera.updateMatrixWorld()
      return pts.every((q) => {
        const pr = q.clone().project(this.camera)
        return Math.abs(pr.x) <= 0.97 && Math.abs(pr.y) <= 0.95
      })
    }
    let lo = 2
    let hi = 200
    for (let i = 0; i < 30; i++) {
      const mid = (lo + hi) / 2
      if (fits(mid)) hi = mid
      else lo = mid
    }
    this.baseDist = hi
    this.updateCamera()
  }

  private updateCamera() {
    const lim = this.half
    this.pan.x = Math.max(-lim, Math.min(lim, this.pan.x))
    this.pan.z = Math.max(-lim, Math.min(lim, this.pan.z))
    this.camera.position.copy(this.dir()).multiplyScalar(this.baseDist / this.zoom).add(this.pan)
    this.camera.lookAt(this.pan)
    this.camera.updateMatrixWorld()
    this.requestRender()
  }

  private panByPixels(dx: number, dy: number) {
    const h = this.canvas.clientHeight || 1
    const wpp = (2 * Math.tan((this.camera.fov * Math.PI) / 360) * (this.baseDist / this.zoom)) / h
    const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0).setY(0).normalize()
    const fwd = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), right).normalize()
    const elev = VIEWS[this.viewIndex].elevation
    this.pan.addScaledVector(right, -dx * wpp).addScaledVector(fwd, (dy * wpp) / Math.max(0.3, Math.sin(elev)))
    this.updateCamera()
  }

  private resize() {
    const w = this.container.clientWidth
    const h = this.container.clientHeight
    if (!w || !h) return
    this.renderer.setSize(w, h, false)
    this.composer.setSize(w, h)
    this.bloom.resolution.set(w / 2, h / 2)
    this.canvas.style.width = `${w}px`
    this.canvas.style.height = `${h}px`
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
    this.fitCamera()
  }

  private bindInput() {
    const pts = new Map<number, { x: number; y: number }>()
    let start: { x: number; y: number } | null = null
    let dragged = false
    let pinchDist = 0
    const mid = () => {
      const a = [...pts.values()]
      return { x: (a[0].x + a[1].x) / 2, y: (a[0].y + a[1].y) / 2, d: Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y) }
    }
    this.canvas.addEventListener('pointerdown', (e) => {
      this.canvas.setPointerCapture(e.pointerId)
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY })
      if (pts.size === 1) {
        start = { x: e.clientX, y: e.clientY }
        dragged = false
      } else if (pts.size === 2) {
        dragged = true
        pinchDist = mid().d
      }
    })
    this.canvas.addEventListener('pointermove', (e) => {
      const prev = pts.get(e.pointerId)
      if (!prev) return
      if (pts.size === 2) {
        const before = mid()
        pts.set(e.pointerId, { x: e.clientX, y: e.clientY })
        const after = mid()
        if (pinchDist > 0) this.zoomBy(after.d / pinchDist)
        pinchDist = after.d
        this.panByPixels(after.x - before.x, after.y - before.y)
        return
      }
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY })
      if (start && !dragged && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 10) dragged = true
      if (dragged && this.zoom > 1.001) this.panByPixels(e.clientX - prev.x, e.clientY - prev.y)
    })
    const end = (e: PointerEvent) => {
      const wasTap = pts.size === 1 && !dragged && e.type === 'pointerup'
      pts.delete(e.pointerId)
      if (pts.size < 2) pinchDist = 0
      if (!wasTap) return
      const r = this.canvas.getBoundingClientRect()
      const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1)
      const ray = new THREE.Raycaster()
      ray.setFromCamera(ndc, this.camera)
      const hit = ray.intersectObjects(this.pickables, false).find((h) => h.object.userData.tile)
      if (hit) this.onTap(hit.object.userData.tile as Pos)
    }
    this.canvas.addEventListener('pointerup', end)
    this.canvas.addEventListener('pointercancel', end)
    this.canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault()
        this.zoomBy(Math.exp(-e.deltaY * 0.0015))
      },
      { passive: false },
    )
  }

  private tween(dur: number, update: (t: number) => void): Promise<void> {
    return new Promise((resolve) => {
      this.tweens.push({ start: performance.now(), dur: Math.max(1, dur / (this.speed * this.timeScale)), update, resolve })
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
      this.composer.render()
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
      this.composer.render()
    })
  }
}

// ---------- 形状・テクスチャ ----------
/** 盤面に貼り付く平たい矢印 */
function flatArrow(a: THREE.Vector3, b: THREE.Vector3, color: number) {
  const len = Math.hypot(b.x - a.x, b.z - a.z)
  const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide })
  const shape = new THREE.Shape()
  const w = 0.04
  const hw = 0.14
  const hl = 0.26
  const body = Math.max(0.01, len - 0.3)
  shape.moveTo(-w, 0)
  shape.lineTo(-w, body - hl)
  shape.lineTo(-hw, body - hl)
  shape.lineTo(0, body)
  shape.lineTo(hw, body - hl)
  shape.lineTo(w, body - hl)
  shape.lineTo(w, 0)
  shape.closePath()
  const m = new THREE.Mesh(new THREE.ShapeGeometry(shape), mat)
  m.rotation.x = -Math.PI / 2 // shape の +y を -z（奥）へ
  const g = new THREE.Group()
  g.add(m)
  g.position.set(a.x, Math.max(a.y, b.y), a.z)
  g.rotation.y = Math.atan2(-(b.x - a.x), -(b.z - a.z))
  g.renderOrder = 3
  return g
}

function canvasTex(c: HTMLCanvasElement) {
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  t.anisotropy = 4
  return t
}


/** 駒の上に浮かぶ小さなタグ（クラス記号 + HPバー / 何手前） */
/** 駒の札：クラスの漢字（陣営色の淡い色＋暗い縁取りで読みやすく）とHPバー。見失った敵は「? 2手前」 */
function tagTexture(spec: PieceSpec) {
  const W = 256
  const H = 160
  const c = document.createElement('canvas')
  c.width = W
  c.height = H
  const g = c.getContext('2d')!
  const col = hex(spec.side === 0 ? C.me : C.en)
  const pale = spec.side === 0 ? '#d4f1ff' : '#ffd9d3'
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.lineJoin = 'round'
  if (spec.label) {
    g.font = '800 30px system-ui, sans-serif'
    g.lineWidth = 8
    g.strokeStyle = C.ink
    g.strokeText(`? ${spec.label}`, W / 2, 24)
    g.fillStyle = col
    g.fillText(`? ${spec.label}`, W / 2, 24)
  }
  g.font = '900 76px "Hiragino Sans", "Noto Sans JP", "Yu Gothic", system-ui, sans-serif'
  g.lineWidth = 14
  g.strokeStyle = C.ink
  g.strokeText(spec.kanji, W / 2, 80)
  g.lineWidth = 3
  g.strokeStyle = col
  g.strokeText(spec.kanji, W / 2, 80)
  g.fillStyle = spec.ghost ? col : pale
  g.fillText(spec.kanji, W / 2, 80)
  if (spec.marked) {
    g.beginPath()
    g.arc(W / 2 - 56, 52, 10, 0, Math.PI * 2)
    g.fillStyle = '#3ddc84'
    g.fill()
  }
  if (!spec.ghost) {
    // HPバー（バー＋数字）
    const x0 = 44
    const bw = 120
    const y0 = 128
    g.beginPath()
    g.roundRect(x0 - 8, y0 - 15, W - 2 * (x0 - 8), 30, 15)
    g.fillStyle = 'rgba(8,18,32,0.88)'
    g.fill()
    g.beginPath()
    g.roundRect(x0, y0 - 7, bw, 14, 7)
    g.fillStyle = 'rgba(255,255,255,0.15)'
    g.fill()
    if (spec.hp !== null && spec.hp > 0) {
      const r = Math.max(0, Math.min(1, spec.hp / spec.maxHp))
      g.beginPath()
      g.roundRect(x0, y0 - 7, Math.max(10, bw * r), 14, 7)
      g.fillStyle = r > 0.5 ? col : r > 0.25 ? '#ffc247' : '#ff7a6a'
      g.fill()
    }
    g.font = '800 24px system-ui, sans-serif'
    g.textAlign = 'right'
    g.fillStyle = '#e3f4ff'
    g.fillText(spec.hp === null ? '?' : String(spec.hp), W - 40, y0 + 1)
  }
  return canvasTex(c)
}

/** 盤面：マス目を焼き込む */
function boardTexture(map: MapDef) {
  const n = map.width
  const S = 96
  const c = document.createElement('canvas')
  c.width = c.height = n * S
  const g = c.getContext('2d')!
  g.fillStyle = '#183a58'
  g.fillRect(0, 0, n * S, n * S)
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const gr = g.createRadialGradient(x * S + S / 2, y * S + S / 2, 6, x * S + S / 2, y * S + S / 2, S * 0.7)
      gr.addColorStop(0, 'rgba(90,200,255,0.16)')
      gr.addColorStop(1, 'rgba(90,200,255,0)')
      g.fillStyle = gr
      g.fillRect(x * S, y * S, S, S)
      g.strokeStyle = 'rgba(110,210,255,0.32)'
      g.lineWidth = 3
      g.strokeRect(x * S + 1.5, y * S + 1.5, S - 3, S - 3)
    }
  }
  // 出撃区画
  for (const [side, col] of [
    [0, 'rgba(55,195,255,0.6)'],
    [1, 'rgba(255,91,71,0.6)'],
  ] as const) {
    const xs = map.spawns[side].map((p) => p.x)
    const ys = map.spawns[side].map((p) => p.y)
    g.strokeStyle = col
    g.lineWidth = 4
    g.setLineDash([12, 9])
    g.strokeRect(Math.min(...xs) * S + 8, Math.min(...ys) * S + 8, (Math.max(...xs) - Math.min(...xs) + 1) * S - 16, (Math.max(...ys) - Math.min(...ys) + 1) * S - 16)
    g.setLineDash([])
  }
  return canvasTex(c)
}

function gradientTexture(top: string, bottom: string) {
  const c = document.createElement('canvas')
  c.width = 4
  c.height = 256
  const g = c.getContext('2d')!
  const gr = g.createLinearGradient(0, 0, 0, 256)
  gr.addColorStop(0, top)
  gr.addColorStop(1, bottom)
  g.fillStyle = gr
  g.fillRect(0, 0, 4, 256)
  return canvasTex(c)
}

function textSprite(text: string, color: string) {
  const c = document.createElement('canvas')
  c.width = 320
  c.height = 96
  const g = c.getContext('2d')!
  g.font = '900 58px system-ui, sans-serif'
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.lineWidth = 12
  g.strokeStyle = C.ink
  g.strokeText(text, 160, 48)
  g.fillStyle = color
  g.fillText(text, 160, 48)
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: canvasTex(c), transparent: true, depthTest: false }))
  sprite.scale.set(1.6, 0.48, 1)
  sprite.renderOrder = 10
  return sprite
}
