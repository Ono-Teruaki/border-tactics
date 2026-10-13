import * as THREE from 'three'
import { key, terrainId } from '../engine/grid.ts'
import type { MapDef, Pos } from '../engine/types.ts'

export type TileMark = 'fog' | 'reach' | 'range' | 'dest' | 'reachRange'

export interface PieceSpec {
  id: string
  side: 0 | 1
  cls: string
  letter: string
  hp: number | null
  maxHp: number
  pos: Pos
  ghost?: boolean
  label?: string
  selected?: boolean
  targeted?: boolean
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
const C = {
  bg: 0xeef1f5,
  me: 0x2f6fec,
  en: 0xe0443e,
  white: 0xf6f6f4,
  black: 0x2a2e35,
  warn: 0xf0a020,
}
const VIEWS = [
  { name: '斜め', azimuth: Math.PI / 4, elevation: 0.9 },
  { name: '正面', azimuth: 0, elevation: 0.85 },
  { name: '真上', azimuth: 0, elevation: 1.5 },
]

/** クラスごとのシルエット（LatheGeometry の [半径, 高さ]） */
const BASE: [number, number][] = [
  [0, 0],
  [0.34, 0],
  [0.34, 0.05],
  [0.3, 0.08],
  [0.24, 0.11],
  [0.19, 0.16],
]
const PROFILES: Record<string, [number, number][]> = {
  attacker: [...BASE, [0.13, 0.42], [0.18, 0.5], [0.18, 0.55], [0.09, 0.58], [0.07, 0.86], [0.035, 0.98], [0, 1.02]],
  gunner: [...BASE, [0.12, 0.42], [0.2, 0.47], [0.2, 0.51], [0.1, 0.54], [0.15, 0.58], [0.17, 0.66], [0.15, 0.74], [0.09, 0.79], [0, 0.81]],
  sniper: [...BASE, [0.09, 0.4], [0.07, 0.74], [0.17, 0.78], [0.17, 0.82], [0.05, 0.85], [0.035, 1.08], [0, 1.1]],
  scout: [...BASE, [0.17, 0.3], [0.21, 0.4], [0.2, 0.48], [0.13, 0.54], [0.03, 0.56], [0.03, 0.74], [0.07, 0.77], [0.04, 0.81], [0, 0.82]],
}
const pieceHeight = (cls: string) => Math.max(...(PROFILES[cls] ?? PROFILES.gunner).map((p) => p[1]))

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
  private geoCache = new Map<string, THREE.BufferGeometry>()
  private tweens: Tween[] = []
  private looping = false
  private viewIndex = 0
  private zoom = 1
  private pan = new THREE.Vector3()
  private baseDist = 10
  private resizeObs: ResizeObserver
  /** 演出の再生速度（スキップ時は大きくする） */
  speed = 1

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
    this.scene.background = new THREE.Color(C.bg)
    this.camera = new THREE.PerspectiveCamera(32, 1, 0.1, 200)

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0xc8ced8, 2.0))
    const sun = new THREE.DirectionalLight(0xffffff, 2.2)
    sun.position.set(-5, 14, 7)
    sun.castShadow = true
    sun.shadow.mapSize.set(2048, 2048)
    const s = map.width / 2 + 2
    Object.assign(sun.shadow.camera, { left: -s, right: s, top: s, bottom: -s, near: 1, far: 40 })
    this.scene.add(sun)

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
    const top = new THREE.MeshStandardMaterial({ map: boardTexture(n), roughness: 0.45 })
    const side = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5 })
    const board = new THREE.Mesh(new THREE.BoxGeometry(n + 0.4, 0.3, n + 0.4), [side, side, top, side, side, side])
    board.position.y = -0.15
    board.receiveShadow = true
    this.scene.add(board)
    const plinth = new THREE.Mesh(new THREE.BoxGeometry(n + 0.1, 0.25, n + 0.1), new THREE.MeshStandardMaterial({ color: 0xd5dae2, roughness: 0.6 }))
    plinth.position.y = -0.42
    this.scene.add(plinth)

    const glass = new THREE.MeshStandardMaterial({ map: buildingTexture(), roughness: 0.3 })
    const roof = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5 })
    const edgeMat = new THREE.LineBasicMaterial({ color: 0xb8c0cc })
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const p = { x, y }
        if (terrainId(this.map, p) === 'building') {
          const b = new THREE.Mesh(new THREE.BoxGeometry(0.9, BUILDING_H, 0.9), [glass, glass, roof, roof, glass, glass])
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
      if (m?.has('fog')) (color = 0x4a5466), (opacity = 0.3)
      if (m?.has('range')) (color = C.en), (opacity = 0.14)
      if (m?.has('reach')) (color = C.me), (opacity = 0.28)
      if (m?.has('reachRange')) (color = 0x7a5cff), (opacity = 0.3)
      if (m?.has('dest')) (color = C.me), (opacity = 0.6)
      mat.color.setHex(color)
      mat.opacity = opacity
    }
    this.requestRender()
  }

  // ---------- 駒 ----------
  private geometry(cls: string) {
    let g = this.geoCache.get(cls)
    if (!g) {
      const pts = (PROFILES[cls] ?? PROFILES.gunner).map(([r, y]) => new THREE.Vector2(r, y))
      g = new THREE.LatheGeometry(pts, 40)
      g.computeVertexNormals()
      this.geoCache.set(cls, g)
    }
    return g
  }

  private makePiece(spec: PieceSpec): THREE.Group {
    const g = new THREE.Group()
    const body = new THREE.Mesh(
      this.geometry(spec.cls),
      new THREE.MeshStandardMaterial({ color: spec.side === 0 ? C.white : C.black, roughness: spec.side === 0 ? 0.35 : 0.45, transparent: true }),
    )
    body.castShadow = true
    const band = new THREE.Mesh(new THREE.TorusGeometry(0.3, 0.025, 8, 40), new THREE.MeshBasicMaterial({ color: spec.side === 0 ? C.me : C.en, transparent: true }))
    band.rotation.x = Math.PI / 2
    band.position.y = 0.07
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.4, 0.47, 48), new THREE.MeshBasicMaterial({ color: C.me, side: THREE.DoubleSide }))
    ring.rotation.x = -Math.PI / 2
    ring.position.y = 0.012
    ring.name = 'ring'
    const reticle = new THREE.Mesh(new THREE.RingGeometry(0.36, 0.47, 4, 1, Math.PI / 4), new THREE.MeshBasicMaterial({ color: C.en, side: THREE.DoubleSide }))
    reticle.rotation.x = -Math.PI / 2
    reticle.position.y = 0.014
    reticle.name = 'reticle'
    const tag = new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true, depthTest: false }))
    tag.scale.set(0.82, 0.32, 1)
    tag.position.y = pieceHeight(spec.cls) + 0.22
    tag.renderOrder = 5
    g.add(body, band, ring, reticle, tag)
    g.userData = { id: spec.id, body, band, tag, tagKey: '' }
    this.scene.add(g)
    this.pickables.push(body)
    return g
  }

  private applySpec(g: THREE.Group, spec: PieceSpec) {
    const { body, band, tag } = g.userData as { body: THREE.Mesh; band: THREE.Mesh; tag: THREE.Sprite }
    const op = spec.ghost ? 0.3 : 1
    ;(body.material as THREE.MeshStandardMaterial).opacity = op
    ;(band.material as THREE.MeshBasicMaterial).opacity = op
    body.castShadow = !spec.ghost
    g.getObjectByName('ring')!.visible = !!spec.selected
    g.getObjectByName('reticle')!.visible = !!spec.targeted
    const tk = `${spec.letter}|${spec.side}|${spec.hp}|${spec.maxHp}|${spec.label}|${spec.ghost}`
    if (g.userData.tagKey !== tk) {
      tag.material.map?.dispose()
      tag.material.map = tagTexture(spec)
      tag.material.needsUpdate = true
      g.userData.tagKey = tk
    }
    body.userData.tile = spec.pos
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
        const ghost = new THREE.Mesh(this.geometry(p.cls), new THREE.MeshStandardMaterial({ color: C.white, transparent: true, opacity: 0.45 }))
        ghost.position.copy(this.world(p.to))
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

  /** 移動しようとして弾かれる */
  bouncePiece(id: string, toward: Pos, dur = 600): Promise<void> {
    const g = this.pieces.get(id)
    if (!g) return Promise.resolve()
    const from = g.position.clone()
    const mid = from.clone().lerp(this.world(toward), 0.45)
    return this.tween(dur, (t) => {
      const k = t < 0.5 ? t * 2 : (1 - t) * 2
      g.position.lerpVectors(from, mid, k)
      g.position.y += Math.sin(Math.PI * k) * 0.2
    })
  }

  /** 指定したマス群が収まるようにカメラを寄せる */
  focus(points: Pos[], dur = 450): Promise<void> {
    const xs = points.map((p) => p.x - this.half)
    const zs = points.map((p) => p.y - this.half)
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2
    const cz = (Math.min(...zs) + Math.max(...zs)) / 2
    const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs)) + 3
    const z = Math.min(2.6, Math.max(1, this.map.width / span))
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

  /** 弾ごとに発射して命中/ミスを表示 */
  async volley(from: Pos, to: Pos, side: 0 | 1, shots: { hit: boolean; damage: number }[], spotted: boolean): Promise<void> {
    if (spotted) this.popup(from, '索敵連携', '#1f9d55', 900)
    for (let i = 0; i < shots.length; i++) {
      const s = shots[i]
      const a = this.world(from, 0.5)
      const b = this.world(to, 0.45)
      if (!s.hit) {
        // 外れ弾は少しそらす
        const off = new THREE.Vector3(-(b.z - a.z), 0, b.x - a.x).normalize().multiplyScalar((i % 2 ? 1 : -1) * 0.45)
        b.add(off).add(b.clone().sub(a).normalize().multiplyScalar(0.5))
      }
      this.beam(a, b, side === 0 ? C.me : C.en, 380)
      this.popup(to, s.hit ? `-${s.damage}` : 'MISS', s.hit ? '#e0443e' : '#8a93a0', 800, (i - (shots.length - 1) / 2) * 0.45)
      await this.wait(shots.length > 1 ? 220 : 380)
    }
    await this.wait(300)
  }

  private beam(a: THREE.Vector3, b: THREE.Vector3, color: number, dur: number) {
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, a.distanceTo(b), 8), new THREE.MeshBasicMaterial({ color, transparent: true }))
    beam.position.copy(a.clone().lerp(b, 0.5))
    beam.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize())
    this.fxGroup.add(beam)
    this.tween(dur, (t) => {
      ;(beam.material as THREE.MeshBasicMaterial).opacity = 1 - t
      beam.scale.x = beam.scale.z = 1 + t * 2
    }).then(() => void this.fxGroup.remove(beam))
  }

  shoot(from: Pos, to: Pos, side: 0 | 1, spotted: boolean): Promise<void> {
    const a = this.world(from, 0.5)
    const b = this.world(to, 0.45)
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, a.distanceTo(b), 8), new THREE.MeshBasicMaterial({ color: side === 0 ? C.me : C.en, transparent: true }))
    beam.position.copy(a.clone().lerp(b, 0.5))
    beam.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize())
    this.fxGroup.add(beam)
    if (spotted) this.popup(from, '索敵連携', '#1f9d55', 700)
    return this.tween(600, (t) => {
      ;(beam.material as THREE.MeshBasicMaterial).opacity = 1 - t
      beam.scale.x = beam.scale.z = 1 + t * 2
    }).then(() => void this.fxGroup.remove(beam))
  }

  popup(at: Pos, text: string, color: string, dur = 900, dx = 0): Promise<void> {
    const sprite = textSprite(text, color)
    const p = this.world(at, 1.3)
    p.x += dx
    sprite.position.copy(p)
    this.fxGroup.add(sprite)
    return this.tween(dur, (t) => {
      sprite.position.y = p.y + t * 0.5
      sprite.material.opacity = t < 0.7 ? 1 : 1 - (t - 0.7) / 0.3
    }).then(() => void this.fxGroup.remove(sprite))
  }

  /** ベイルアウト：光の柱 */
  bailout(at: Pos, side: 0 | 1): Promise<void> {
    const h = 6
    const pillar = new THREE.Mesh(
      new THREE.CylinderGeometry(0.28, 0.28, h, 24, 1, true),
      new THREE.MeshBasicMaterial({ color: side === 0 ? C.me : C.en, transparent: true, side: THREE.DoubleSide, depthWrite: false }),
    )
    const base = this.world(at)
    pillar.position.copy(base).setY(base.y + h / 2)
    this.fxGroup.add(pillar)
    this.popup(at, 'BAIL OUT', side === 0 ? '#2f6fec' : '#e0443e', 1100)
    return this.tween(1000, (t) => {
      ;(pillar.material as THREE.MeshBasicMaterial).opacity = 0.6 * (1 - t)
      pillar.scale.x = pillar.scale.z = 1 - t * 0.7
    }).then(() => void this.fxGroup.remove(pillar))
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
      this.tweens.push({ start: performance.now(), dur: Math.max(1, dur / this.speed), update, resolve })
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

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath()
  g.moveTo(x + r, y)
  g.arcTo(x + w, y, x + w, y + h, r)
  g.arcTo(x + w, y + h, x, y + h, r)
  g.arcTo(x, y + h, x, y, r)
  g.arcTo(x, y, x + w, y, r)
  g.closePath()
}

/** 駒の上に浮かぶ小さなタグ（クラス記号 + HPバー / 何手前） */
function tagTexture(spec: PieceSpec) {
  const W = 160
  const H = 62
  const c = document.createElement('canvas')
  c.width = W
  c.height = H
  const g = c.getContext('2d')!
  const accent = spec.side === 0 ? '#2f6fec' : '#e0443e'
  g.globalAlpha = spec.ghost ? 0.75 : 1
  roundRect(g, 3, 3, W - 6, H - 6, 18)
  g.fillStyle = spec.side === 0 ? '#ffffff' : '#2a2e35'
  g.fill()
  g.lineWidth = 4
  g.strokeStyle = accent
  g.stroke()
  g.fillStyle = spec.side === 0 ? '#1d2330' : '#ffffff'
  g.font = '800 32px system-ui, sans-serif'
  g.textBaseline = 'middle'
  g.textAlign = 'center'
  g.fillText(spec.letter, 30, H / 2 + 1)
  if (spec.label) {
    g.font = '700 22px system-ui, sans-serif'
    g.fillText(spec.label, 100, H / 2 + 1)
  } else {
    const x0 = 54
    const bw = 62
    roundRect(g, x0, H / 2 - 8, bw, 16, 6)
    g.fillStyle = spec.side === 0 ? '#dfe3ea' : '#4a505a'
    g.fill()
    if (spec.hp !== null && spec.hp > 0) {
      const r = Math.max(0, Math.min(1, spec.hp / spec.maxHp))
      roundRect(g, x0, H / 2 - 8, Math.max(12, bw * r), 16, 6)
      g.fillStyle = r > 0.5 ? accent : r > 0.25 ? '#f0a020' : '#e0443e'
      g.fill()
    }
    g.fillStyle = spec.side === 0 ? '#1d2330' : '#ffffff'
    g.font = '800 22px system-ui, sans-serif'
    g.textAlign = 'right'
    g.fillText(spec.hp === null ? '?' : String(spec.hp), W - 12, H / 2 + 1)
  }
  return canvasTex(c)
}

function boardTexture(n: number) {
  const px = 96
  const pad = 0.2
  const size = Math.round((n + pad * 2) * px)
  const c = document.createElement('canvas')
  c.width = c.height = size
  const g = c.getContext('2d')!
  g.fillStyle = '#ffffff'
  g.fillRect(0, 0, size, size)
  const o = pad * px
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      g.fillStyle = (x + y) % 2 === 0 ? '#f7f8fa' : '#e1e5ec'
      g.fillRect(o + x * px, o + y * px, px, px)
    }
  }
  g.strokeStyle = '#c3cad4'
  g.lineWidth = 3
  g.strokeRect(o, o, n * px, n * px)
  return canvasTex(c)
}

function buildingTexture() {
  const c = document.createElement('canvas')
  c.width = 64
  c.height = 64
  const g = c.getContext('2d')!
  g.fillStyle = '#ffffff'
  g.fillRect(0, 0, 64, 64)
  for (let y = 0; y < 4; y++) {
    g.fillStyle = y % 2 ? '#cfe0f5' : '#dce9f8'
    g.fillRect(6, 7 + y * 14, 52, 8)
  }
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
  g.strokeStyle = '#ffffff'
  g.strokeText(text, 160, 48)
  g.fillStyle = color
  g.fillText(text, 160, 48)
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: canvasTex(c), transparent: true, depthTest: false }))
  sprite.scale.set(1.6, 0.48, 1)
  sprite.renderOrder = 10
  return sprite
}
