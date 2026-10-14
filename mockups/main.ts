/**
 * 見た目の方向性を比べるための試作。ゲームのロジックは動かさず、同じ局面を3つのテーマで描く。
 *   npm run dev → /mockups/?theme=holo | diorama | paper
 * 局面: 市街地9×9、3手目。自軍スナイパーが屋上から敵アタッカーを狙っている。
 * 敵スナイパーは2手前に見た位置（ゴースト）だけ分かっている。
 * ビルの高さ（1〜3段）は、高さ案の見え方を確かめるための仮の値。
 */
import * as THREE from 'three'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js'
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'
import { canSee } from '../src/engine/game.ts'
import { key, terrainId } from '../src/engine/grid.ts'
import { getMap } from '../src/engine/maps.ts'
import { DEFAULT_RULES } from '../src/engine/rules.ts'
import type { Pos } from '../src/engine/types.ts'

// ---------- 局面 ----------
const map = getMap('city9')
const N = map.width
const HALF = (N - 1) / 2
const LEVEL_H = 0.42
const HEIGHT: Record<string, number> = { '4,4': 3, '2,2': 2, '6,6': 2 }
const level = (p: Pos) => (terrainId(map, p) === 'building' ? (HEIGHT[key(p)] ?? 1) : 0)

interface Piece {
  cls: string
  side: 0 | 1
  pos: Pos
  hp: number
  ghost?: number
}
const pieces: Piece[] = [
  { cls: 'sniper', side: 0, pos: { x: 2, y: 5 }, hp: 16 },
  { cls: 'attacker', side: 0, pos: { x: 3, y: 4 }, hp: 21 },
  { cls: 'gunner', side: 0, pos: { x: 1, y: 6 }, hp: 22 },
  { cls: 'scout', side: 0, pos: { x: 4, y: 6 }, hp: 16 },
  { cls: 'attacker', side: 1, pos: { x: 5, y: 2 }, hp: 28 },
  { cls: 'gunner', side: 1, pos: { x: 6, y: 5 }, hp: 13 },
  { cls: 'sniper', side: 1, pos: { x: 7, y: 2 }, hp: 16, ghost: 2 },
]
const SHOOTER = pieces[0]
const TARGET = pieces[4]
const HIT = 72

const cells: Pos[] = []
for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) cells.push({ x, y })
const visible = new Set(cells.filter((c) => pieces.some((p) => p.side === 0 && canSee(map, DEFAULT_RULES, p.cls, p.pos, c))).map(key))
for (const p of pieces) if (p.side === 0) visible.add(key(p.pos))

const kanji = (cls: string) => DEFAULT_RULES.classes[cls].kanji
const world = (p: Pos, lift = 0) => new THREE.Vector3(p.x - HALF, level(p) * LEVEL_H + lift, p.y - HALF)

// ---------- 共通 ----------
const themeId = new URLSearchParams(location.search).get('theme') ?? 'holo2'
document.body.className = themeId
const THEMES = [
  ['holo2', '★ホロ＋'],
  ['holo', '①'],
  ['diorama', '②'],
  ['paper', '③'],
]
document.getElementById('themes')!.innerHTML = THEMES.map(([id, name]) => `<a href="?theme=${id}" class="${id === themeId ? 'on' : ''}">${name}</a>`).join('')

const stage = document.getElementById('stage')!
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true })
renderer.setPixelRatio(Math.min(2, devicePixelRatio))
renderer.setSize(innerWidth, innerHeight)
renderer.shadowMap.enabled = true
renderer.shadowMap.type = THREE.PCFSoftShadowMap
stage.append(renderer.domElement)
const scene = new THREE.Scene()
const camera = new THREE.PerspectiveCamera(30, innerWidth / innerHeight, 0.1, 400)

function canvas(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void) {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  draw(c.getContext('2d')!)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  t.anisotropy = 8
  return t
}

function sprite(tex: THREE.Texture, w: number, h: number, pos: THREE.Vector3, opacity = 1) {
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, opacity }))
  s.scale.set(w * 1.5, h * 1.5, 1)
  s.position.copy(pos)
  s.renderOrder = 10
  scene.add(s)
  return s
}

function label(text: string, opt: { font: string; fill: string; stroke?: string; bg?: string; w?: number }) {
  const W = opt.w ?? 256
  return canvas(W, 96, (g) => {
    if (opt.bg) {
      g.fillStyle = opt.bg
      g.beginPath()
      g.roundRect(4, 14, W - 8, 68, 34)
      g.fill()
    }
    g.font = opt.font
    g.textAlign = 'center'
    g.textBaseline = 'middle'
    if (opt.stroke) {
      g.lineWidth = 10
      g.strokeStyle = opt.stroke
      g.strokeText(text, W / 2, 50)
    }
    g.fillStyle = opt.fill
    g.fillText(text, W / 2, 50)
  })
}

/**
 * 盤全体（＋ビルの屋上）が画面幅に収まる距離までカメラを引き、
 * 上のスコアと下のパネルの間に来るよう、表示窓をずらす
 */
function fitCamera(azimuth: number, elevation: number, xMax = 0.97) {
  const dir = new THREE.Vector3(-Math.sin(azimuth) * Math.cos(elevation), Math.sin(elevation), Math.cos(azimuth) * Math.cos(elevation))
  const corners: THREE.Vector3[] = []
  for (const x of [-HALF - 0.5, HALF + 0.5]) for (const z of [-HALF - 0.5, HALF + 0.5]) corners.push(new THREE.Vector3(x, 0, z), new THREE.Vector3(x, 1.4, z))
  const project = () => {
    camera.updateMatrixWorld()
    camera.updateProjectionMatrix()
    return corners.map((c) => c.clone().project(camera))
  }
  let pts: THREE.Vector3[] = []
  for (let d = 6; d < 200; d += 0.1) {
    camera.position.copy(dir).multiplyScalar(d)
    camera.lookAt(0, 0, 0)
    pts = project()
    if (pts.every((p) => Math.abs(p.x) <= xMax && Math.abs(p.y) <= 0.8)) break
  }
  const H = innerHeight
  const center = (Math.min(...pts.map((p) => p.y)) + Math.max(...pts.map((p) => p.y))) / 2
  const target = 1 - (2 * (64 + (H - 64 - 120) / 2)) / H
  camera.setViewOffset(innerWidth, H, 0, ((target - center) * H) / 2, innerWidth, H)
}

/** 盤の上に平らに置く矢印 */
function flatArrow(a: THREE.Vector3, b: THREE.Vector3, width: number, mat: THREE.Material) {
  const len = a.distanceTo(b)
  const shape = new THREE.Shape()
  const hw = width / 2
  const head = width * 2.2
  shape.moveTo(0, -hw)
  shape.lineTo(len - head, -hw)
  shape.lineTo(len - head, -hw * 2.6)
  shape.lineTo(len, 0)
  shape.lineTo(len - head, hw * 2.6)
  shape.lineTo(len - head, hw)
  shape.lineTo(0, hw)
  const m = new THREE.Mesh(new THREE.ShapeGeometry(shape), mat)
  m.rotation.x = -Math.PI / 2
  m.rotation.z = -Math.atan2(b.z - a.z, b.x - a.x)
  m.position.copy(a)
  scene.add(m)
  return m
}

// ======================================================================
// ① 作戦卓ホログラム
// ======================================================================
function holo() {
  scene.background = new THREE.Color(0x04070c)
  const CY = 0x3cf0ff
  const EN = 0xff5a3c
  const add = (o: THREE.Object3D) => (scene.add(o), o)

  // 卓
  add(new THREE.Mesh(new THREE.BoxGeometry(N + 1.2, 0.2, N + 1.2), new THREE.MeshBasicMaterial({ color: 0x08131e }))).position.y = -0.1
  const frame = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(N + 1.2, 0.2, N + 1.2)), new THREE.LineBasicMaterial({ color: 0x1f6f94 }))
  frame.position.y = -0.1
  add(frame)
  // マス目
  const pts: number[] = []
  for (let i = 0; i <= N; i++) {
    const v = i - N / 2
    pts.push(-N / 2, 0.005, v, N / 2, 0.005, v, v, 0.005, -N / 2, v, 0.005, N / 2)
  }
  const grid = new THREE.BufferGeometry()
  grid.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3))
  add(new THREE.LineSegments(grid, new THREE.LineBasicMaterial({ color: 0x1a4560 })))
  // 視界：見えているマスだけ淡く光る
  const vis = new THREE.MeshBasicMaterial({ color: CY, transparent: true, opacity: 0.05, blending: THREE.AdditiveBlending, depthWrite: false })
  for (const c of cells) {
    if (!visible.has(key(c)) || level(c) > 0) continue
    const t = new THREE.Mesh(new THREE.PlaneGeometry(0.94, 0.94), vis)
    t.rotation.x = -Math.PI / 2
    t.position.copy(world(c, 0.01))
    add(t)
  }
  // 見えていないマスは走査線
  const scan = canvas(64, 64, (g) => {
    g.strokeStyle = 'rgba(255,90,60,0.28)'
    g.lineWidth = 2
    for (let i = -64; i < 128; i += 10) {
      g.beginPath()
      g.moveTo(i, 64)
      g.lineTo(i + 64, 0)
      g.stroke()
    }
  })
  const fogMat = new THREE.MeshBasicMaterial({ map: scan, transparent: true, depthWrite: false })
  for (const c of cells) {
    if (visible.has(key(c)) || level(c) > 0) continue
    const t = new THREE.Mesh(new THREE.PlaneGeometry(0.94, 0.94), fogMat)
    t.rotation.x = -Math.PI / 2
    t.position.copy(world(c, 0.012))
    add(t)
  }
  // ビル：半透明の箱＋光る輪郭。段ごとに線を入れて高さを読めるようにする
  for (const c of cells) {
    const lv = level(c)
    if (!lv) continue
    const h = lv * LEVEL_H
    const geo = new THREE.BoxGeometry(0.9, h, 0.9)
    const box = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0x0c3048, transparent: true, opacity: 0.55, depthWrite: false }))
    box.position.set(c.x - HALF, h / 2, c.y - HALF)
    add(box)
    const edge = new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color: 0x5fe6ff }))
    edge.position.copy(box.position)
    add(edge)
    for (let i = 1; i < lv; i++) {
      const ring = new THREE.LineLoop(
        new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-0.45, 0, -0.45), new THREE.Vector3(0.45, 0, -0.45), new THREE.Vector3(0.45, 0, 0.45), new THREE.Vector3(-0.45, 0, 0.45)]),
        new THREE.LineBasicMaterial({ color: 0x2aa8cc }),
      )
      ring.position.set(c.x - HALF, i * LEVEL_H, c.y - HALF)
      add(ring)
    }
    const top = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.9), new THREE.MeshBasicMaterial({ color: 0x113d58 }))
    top.rotation.x = -Math.PI / 2
    top.position.set(c.x - HALF, h + 0.002, c.y - HALF)
    add(top)
    sprite(label(`${lv}`, { font: '700 64px system-ui', fill: '#7ff5ff' }), 0.35, 0.13, world(c, 0.02).add(new THREE.Vector3(0.3, 0, 0.3)), 0.7)
  }
  // 駒：六角の台座＋光るクラス字
  for (const p of pieces) {
    const col = p.side === 0 ? CY : EN
    const base = world(p.pos)
    const g = new THREE.Group()
    g.position.copy(base)
    const op = p.ghost ? 0.35 : 1
    const plate = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.38, 0.08, 6), new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.12 * op }))
    plate.position.y = 0.04
    g.add(plate)
    const rim = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.CylinderGeometry(0.38, 0.38, 0.001, 6)), new THREE.LineBasicMaterial({ color: col, transparent: true, opacity: op }))
    rim.position.y = 0.08
    g.add(rim)
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.5, 6), new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.8 * op }))
    beam.position.y = 0.33
    if (!p.ghost) g.add(beam)
    scene.add(g)
    const hex = '#' + col.toString(16).padStart(6, '0')
    if (p.ghost) {
      sprite(label(`? ${p.ghost}手前`, { font: '700 46px system-ui', fill: hex, w: 320 }), 0.95, 0.29, base.clone().add(new THREE.Vector3(0, 0.45, 0)), 0.85)
      sprite(label(kanji(p.cls), { font: '900 64px system-ui', fill: hex }), 0.6, 0.23, base.clone().add(new THREE.Vector3(0, 0.2, 0)), 0.45)
    } else {
      sprite(label(kanji(p.cls), { font: '900 70px system-ui', fill: hex, stroke: '#04070c' }), 0.66, 0.25, base.clone().add(new THREE.Vector3(0, 0.66, 0)))
      sprite(label(`${p.hp}`, { font: '700 44px system-ui', fill: '#cdefff' }), 0.5, 0.19, base.clone().add(new THREE.Vector3(0.36, 0.5, 0)), 0.85)
    }
  }
  // 射線
  const a = world(SHOOTER.pos, 0.5)
  const b = world(TARGET.pos, 0.3)
  const line = new THREE.Mesh(
    new THREE.CylinderGeometry(0.018, 0.018, a.distanceTo(b), 6),
    new THREE.MeshBasicMaterial({ color: 0xffffff }),
  )
  line.position.copy(a).add(b).multiplyScalar(0.5)
  line.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize())
  add(line)
  const ret = new THREE.Mesh(new THREE.RingGeometry(0.42, 0.48, 4, 1, Math.PI / 4), new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide }))
  ret.rotation.x = -Math.PI / 2
  ret.position.copy(world(TARGET.pos, 0.02))
  add(ret)
  sprite(label(`命中 ${HIT}%`, { font: '800 48px system-ui', fill: '#7ff5ff', bg: 'rgba(4,20,30,0.9)', w: 300 }), 0.9, 0.29, a.clone().lerp(b, 0.55).add(new THREE.Vector3(0, 0.35, 0)))

  fitCamera(0.22, 0.95)
  const composer = new EffectComposer(renderer)
  composer.addPass(new RenderPass(scene, camera))
  composer.addPass(new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.7, 0.4, 0.12))
  composer.addPass(new OutputPass())
  return () => composer.render()
}

// ======================================================================
// ② ミニチュアのジオラマ
// ======================================================================
function diorama() {
  scene.background = canvas(4, 256, (g) => {
    const gr = g.createLinearGradient(0, 0, 0, 256)
    gr.addColorStop(0, '#bcd9ea')
    gr.addColorStop(1, '#f1ece2')
    g.fillStyle = gr
    g.fillRect(0, 0, 4, 256)
  })
  scene.add(new THREE.HemisphereLight(0xfff6e8, 0x8a96a3, 1.6))
  const sun = new THREE.DirectionalLight(0xfff0d8, 2.6)
  sun.position.set(-6, 12, 4)
  sun.castShadow = true
  sun.shadow.mapSize.set(2048, 2048)
  sun.shadow.bias = -0.0005
  Object.assign(sun.shadow.camera, { left: -8, right: 8, top: 8, bottom: -8, near: 1, far: 40 })
  scene.add(sun)

  // 台座（土の断面）＋石畳
  const soil = new THREE.Mesh(new THREE.BoxGeometry(N + 1.4, 0.9, N + 1.4), new THREE.MeshStandardMaterial({ color: 0x7a5a3e, roughness: 0.95 }))
  soil.position.y = -0.47
  soil.receiveShadow = true
  scene.add(soil)
  const grass = new THREE.Mesh(new THREE.BoxGeometry(N + 1.4, 0.06, N + 1.4), new THREE.MeshStandardMaterial({ color: 0x8dbb6a, roughness: 1 }))
  grass.position.y = -0.03
  grass.receiveShadow = true
  scene.add(grass)
  const paving = canvas(N * 64, N * 64, (g) => {
    for (let y = 0; y < N; y++)
      for (let x = 0; x < N; x++) {
        g.fillStyle = '#bdb6a8'
        g.fillRect(x * 64, y * 64, 64, 64)
        const v = (x * 7 + y * 13) % 5
        g.fillStyle = ['#e2dccf', '#ddd6c8', '#e6e0d4', '#d8d1c2', '#e0dacd'][v]
        g.fillRect(x * 64 + 3, y * 64 + 3, 58, 58)
        // 石の継ぎ目
        g.strokeStyle = 'rgba(120,110,95,0.25)'
        g.lineWidth = 1.5
        g.beginPath()
        g.moveTo(x * 64 + 3, y * 64 + 32)
        g.lineTo(x * 64 + 61, y * 64 + 32)
        g.moveTo(x * 64 + (y % 2 ? 22 : 42), y * 64 + 3)
        g.lineTo(x * 64 + (y % 2 ? 22 : 42), y * 64 + 32)
        g.stroke()
      }
  })
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(N, N), new THREE.MeshStandardMaterial({ map: paving, roughness: 0.9 }))
  ground.rotation.x = -Math.PI / 2
  ground.position.y = 0.002
  ground.receiveShadow = true
  scene.add(ground)

  // 縁の木
  const leaf = new THREE.MeshStandardMaterial({ color: 0x5f9a4c, roughness: 0.9 })
  const trunk = new THREE.MeshStandardMaterial({ color: 0x7b5638 })
  for (let i = 0; i < 26; i++) {
    const t = i / 26
    const side = Math.floor(t * 4)
    const u = (t * 4) % 1
    const e = N / 2 + 0.35
    const pos = [new THREE.Vector3(-e + u * 2 * e, 0, -e), new THREE.Vector3(e, 0, -e + u * 2 * e), new THREE.Vector3(e - u * 2 * e, 0, e), new THREE.Vector3(-e, 0, e - u * 2 * e)][side]
    if ((i * 37) % 3 === 0) continue
    const s = 0.7 + ((i * 53) % 5) * 0.08
    const tr = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.04, 0.2 * s), trunk)
    tr.position.copy(pos).setY(0.1 * s)
    const lf = new THREE.Mesh(new THREE.IcosahedronGeometry(0.2 * s, 0), leaf)
    lf.position.copy(pos).setY(0.3 * s)
    lf.castShadow = true
    scene.add(tr, lf)
  }

  // ビル
  const WALLS = ['#e8b88a', '#d98a66', '#f0e2c4', '#a9c0cf', '#c9d3a8']
  const wallTex = (wall: string, lv: number) =>
    canvas(128, 128 * lv, (g) => {
      g.fillStyle = wall
      g.fillRect(0, 0, 128, 128 * lv)
      for (let f = 0; f < lv * 2; f++)
        for (let w = 0; w < 3; w++) {
          const x = 14 + w * 38
          const y = 18 + f * 64
          g.fillStyle = '#3d4e5c'
          g.fillRect(x, y, 24, 32)
          g.fillStyle = 'rgba(255,255,255,0.35)'
          g.fillRect(x + 2, y + 2, 9, 28)
          g.fillStyle = 'rgba(0,0,0,0.12)'
          g.fillRect(x - 2, y + 32, 28, 4)
        }
    })
  let bi = 0
  for (const c of cells) {
    const lv = level(c)
    if (!lv) continue
    const h = lv * LEVEL_H
    const wall = WALLS[bi++ % WALLS.length]
    const side = new THREE.MeshStandardMaterial({ map: wallTex(wall, lv), roughness: 0.85 })
    const roofM = new THREE.MeshStandardMaterial({ color: 0x9a9a96, roughness: 0.9 })
    const b = new THREE.Mesh(new THREE.BoxGeometry(0.86, h, 0.86), [side, side, roofM, roofM, side, side])
    b.position.set(c.x - HALF, h / 2, c.y - HALF)
    b.castShadow = b.receiveShadow = true
    scene.add(b)
    const parapet = new THREE.Mesh(new THREE.BoxGeometry(0.92, 0.05, 0.92), new THREE.MeshStandardMaterial({ color: 0xf4efe6 }))
    parapet.position.set(c.x - HALF, h + 0.02, c.y - HALF)
    parapet.castShadow = true
    scene.add(parapet)
    if ((c.x + c.y) % 2) {
      const ac = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.1, 0.14), new THREE.MeshStandardMaterial({ color: 0xd9dcdf }))
      ac.position.set(c.x - HALF + 0.24, h + 0.08, c.y - HALF - 0.22)
      ac.castShadow = true
      scene.add(ac)
    }
  }

  // 視界の外は霧
  const fogTex = canvas(128, 128, (g) => {
    const gr = g.createRadialGradient(64, 64, 6, 64, 64, 64)
    gr.addColorStop(0, 'rgba(250,250,252,0.95)')
    gr.addColorStop(0.6, 'rgba(245,246,250,0.7)')
    gr.addColorStop(1, 'rgba(245,246,250,0)')
    g.fillStyle = gr
    g.fillRect(0, 0, 128, 128)
  })
  const fogMat = new THREE.MeshBasicMaterial({ map: fogTex, transparent: true, depthWrite: false, opacity: 0.85 })
  for (const c of cells) {
    if (visible.has(key(c))) continue
    for (const [ox, oz, s] of [
      [0, 0, 1.6],
      [0.25, -0.2, 1.1],
    ]) {
      const f = new THREE.Mesh(new THREE.PlaneGeometry(s, s), fogMat)
      f.rotation.x = -Math.PI / 2
      f.position.copy(world(c, 0.12 + ((c.x + c.y) % 3) * 0.03)).add(new THREE.Vector3(ox, 0, oz))
      f.renderOrder = 5
      scene.add(f)
    }
  }

  // 駒：おもちゃの兵隊
  const plastic = (c: number, op = 1) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.45, transparent: op < 1, opacity: op })
  for (const p of pieces) {
    const col = p.side === 0 ? 0x2f6fe0 : 0xd8473a
    const op = p.ghost ? 0.35 : 1
    const g = new THREE.Group()
    g.position.copy(world(p.pos))
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.32, 0.06, 32), plastic(col, op))
    base.position.y = 0.03
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.12, 0.22, 6, 16), plastic(col, op))
    body.position.y = 0.3
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.1, 20, 14), plastic(0xf2d2b0, op))
    head.position.y = 0.55
    const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.11, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2), plastic(p.side === 0 ? 0x234f9e : 0x9e2f25, op))
    helmet.position.y = 0.57
    g.add(base, body, head, helmet)
    // クラスごとの持ち物
    if (p.cls === 'sniper') {
      const gun = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.55), plastic(0x2b2f36, op))
      gun.rotation.z = Math.PI / 2.6
      gun.position.set(0.1, 0.42, 0.08)
      g.add(gun)
    } else if (p.cls === 'gunner') {
      const gun = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.08, 0.32), plastic(0x2b2f36, op))
      gun.position.set(0.12, 0.33, 0.1)
      g.add(gun)
    } else if (p.cls === 'attacker') {
      const blade = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.42, 0.06), plastic(0xd8dde3, op))
      blade.position.set(0.17, 0.42, 0)
      blade.rotation.z = -0.3
      g.add(blade)
    } else if (p.cls === 'scout') {
      const ant = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.35), plastic(0x2b2f36, op))
      ant.position.set(-0.1, 0.6, -0.05)
      g.add(ant)
    }
    g.traverse((o) => (o.castShadow = !p.ghost))
    g.rotation.y = p.side === 0 ? -Math.PI * 0.75 : Math.PI * 0.25
    scene.add(g)
    const top = world(p.pos, 0.95)
    if (p.ghost) sprite(label(`? ${p.ghost}手前`, { font: '800 44px system-ui', fill: '#ffffff', bg: 'rgba(216,71,58,0.85)', w: 300 }), 0.85, 0.27, top)
    else sprite(label(`${kanji(p.cls)} ${p.hp}`, { font: '800 50px system-ui', fill: '#fff', bg: p.side === 0 ? '#2f6fe0' : '#d8473a', w: 220 }), 0.62, 0.27, top)
  }

  // 射線：弾道の弧
  const a = world(SHOOTER.pos, 0.45)
  const b = world(TARGET.pos, 0.35)
  const mid = a.clone().lerp(b, 0.5).add(new THREE.Vector3(0, 0.5, 0))
  const curve = new THREE.QuadraticBezierCurve3(a, mid, b)
  scene.add(new THREE.Mesh(new THREE.TubeGeometry(curve, 40, 0.025, 8), new THREE.MeshBasicMaterial({ color: 0xffb02e })))
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.36, 0.44, 40), new THREE.MeshBasicMaterial({ color: 0xffb02e, side: THREE.DoubleSide }))
  ring.rotation.x = -Math.PI / 2
  ring.position.copy(world(TARGET.pos, 0.07))
  scene.add(ring)
  sprite(label(`${HIT}%`, { font: '900 56px system-ui', fill: '#2b2f36', bg: '#ffb02e', w: 180 }), 0.55, 0.29, mid.clone().add(new THREE.Vector3(0, 0.2, 0)))

  fitCamera(0.22, 0.85)
  // ミニチュア写真風：画面の上下をぼかす（ティルトシフト）
  const tilt = new ShaderPass({
    uniforms: { tDiffuse: { value: null }, res: { value: new THREE.Vector2(innerWidth, innerHeight) } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: `
      uniform sampler2D tDiffuse; uniform vec2 res; varying vec2 vUv;
      void main(){
        float k = smoothstep(0.18, 0.5, abs(vUv.y - 0.5)) * 4.0;
        vec4 c = vec4(0.0); float wsum = 0.0;
        for (int i = -4; i <= 4; i++) for (int j = -4; j <= 4; j++) {
          float w = exp(-float(i*i + j*j) / 8.0);
          c += texture2D(tDiffuse, vUv + vec2(float(i), float(j)) * k / res) * w; wsum += w;
        }
        gl_FragColor = c / wsum;
      }`,
  })
  const composer = new EffectComposer(renderer)
  composer.addPass(new RenderPass(scene, camera))
  composer.addPass(tilt)
  composer.addPass(new OutputPass())
  return () => composer.render()
}

// ======================================================================
// ③ 卓上の作戦地図
// ======================================================================
function paper() {
  const S = 112
  const M = 70
  const W = N * S + M * 2
  // 机
  scene.background = new THREE.Color(0x2a1d15)
  const wood = canvas(512, 512, (g) => {
    g.fillStyle = '#4a3324'
    g.fillRect(0, 0, 512, 512)
    for (let i = 0; i < 90; i++) {
      g.strokeStyle = `rgba(${i % 2 ? '30,18,10' : '110,80,55'},${0.15 + (i % 5) * 0.04})`
      g.lineWidth = 1 + (i % 3)
      g.beginPath()
      const y = (i * 61) % 512
      g.moveTo(0, y)
      g.bezierCurveTo(170, y + 8, 340, y - 8, 512, y + 3)
      g.stroke()
    }
  })
  wood.wrapS = wood.wrapT = THREE.RepeatWrapping
  wood.repeat.set(3, 3)
  const desk = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), new THREE.MeshStandardMaterial({ map: wood, roughness: 0.7 }))
  desk.rotation.x = -Math.PI / 2
  desk.position.y = -0.02
  desk.receiveShadow = true
  scene.add(desk)

  scene.add(new THREE.HemisphereLight(0xfff1dc, 0x3a2a20, 1.2))
  const lamp = new THREE.SpotLight(0xffe2b8, 260, 40, 0.6, 0.6, 1.6)
  lamp.position.set(-4, 13, 3)
  lamp.target.position.set(0, 0, 0)
  lamp.castShadow = true
  lamp.shadow.mapSize.set(2048, 2048)
  lamp.shadow.bias = -0.0004
  scene.add(lamp, lamp.target)

  const cx = (x: number) => M + x * S + S / 2
  // 紙：視界の外は鉛筆の斜線、ゴーストと射線は書き込み
  const paperTex = canvas(W, W, (g) => {
    g.fillStyle = '#f3ecdc'
    g.fillRect(0, 0, W, W)
    for (let i = 0; i < 9000; i++) {
      g.fillStyle = `rgba(120,100,70,${Math.random() * 0.06})`
      g.fillRect(Math.random() * W, Math.random() * W, 2, 2)
    }
    // 見えていないマス
    g.save()
    g.strokeStyle = 'rgba(70,70,80,0.33)'
    g.lineWidth = 2
    for (const c of cells) {
      if (visible.has(key(c))) continue
      g.save()
      g.beginPath()
      g.rect(M + c.x * S, M + c.y * S, S, S)
      g.clip()
      for (let i = -S; i < S * 2; i += 13) {
        g.beginPath()
        g.moveTo(M + c.x * S + i, M + c.y * S + S + 2)
        g.lineTo(M + c.x * S + i + S + 4, M + c.y * S - 3)
        g.stroke()
      }
      g.restore()
    }
    g.restore()
    // マス目
    g.strokeStyle = 'rgba(60,85,110,0.55)'
    g.lineWidth = 2
    for (let i = 0; i <= N; i++) {
      g.beginPath()
      g.moveTo(M + i * S, M)
      g.lineTo(M + i * S, M + N * S)
      g.moveTo(M, M + i * S)
      g.lineTo(M + N * S, M + i * S)
      g.stroke()
    }
    g.lineWidth = 5
    g.strokeRect(M - 8, M - 8, N * S + 16, N * S + 16)
    // 座標
    g.fillStyle = 'rgba(60,85,110,0.85)'
    g.font = 'italic 34px Georgia, serif'
    g.textAlign = 'center'
    g.textBaseline = 'middle'
    for (let i = 0; i < N; i++) {
      g.fillText('ABCDEFGHI'[i], cx(i), M / 2 - 4)
      g.fillText(String(N - i), M / 2 - 6, cx(i))
    }
    // 出撃区画
    for (const [side, col] of [
      [0, 'rgba(47,93,158,0.6)'],
      [1, 'rgba(178,58,46,0.6)'],
    ] as const) {
      g.strokeStyle = col
      g.lineWidth = 4
      g.setLineDash([12, 8])
      const xs = map.spawns[side].map((p) => p.x)
      const ys = map.spawns[side].map((p) => p.y)
      g.strokeRect(M + Math.min(...xs) * S + 8, M + Math.min(...ys) * S + 8, 2 * S - 16, 2 * S - 16)
      g.setLineDash([])
    }
    // ゴースト：鉛筆の丸と書き込み
    for (const p of pieces.filter((q) => q.ghost)) {
      g.strokeStyle = 'rgba(178,58,46,0.85)'
      g.lineWidth = 4
      g.setLineDash([10, 8])
      g.beginPath()
      g.arc(cx(p.pos.x), cx(p.pos.y), S * 0.36, 0, Math.PI * 2)
      g.stroke()
      g.setLineDash([])
      g.fillStyle = 'rgba(178,58,46,0.9)'
      g.font = '700 54px "Hiragino Mincho ProN", serif'
      g.fillText(kanji(p.cls) + '?', cx(p.pos.x), cx(p.pos.y) + 2)
      g.font = 'italic 30px Georgia, serif'
      g.fillText(`${p.ghost}手前`, cx(p.pos.x), cx(p.pos.y) + S * 0.62)
    }
    // コンパス
    g.save()
    g.translate(W - M - S * 0.5, W - M - S * 0.55)
    g.strokeStyle = 'rgba(60,85,110,0.6)'
    g.fillStyle = 'rgba(60,85,110,0.6)'
    g.lineWidth = 2
    g.beginPath()
    g.arc(0, 0, 34, 0, Math.PI * 2)
    g.stroke()
    g.beginPath()
    g.moveTo(0, -44)
    g.lineTo(8, 0)
    g.lineTo(0, 44)
    g.lineTo(-8, 0)
    g.closePath()
    g.fill()
    g.restore()
  })
  const sheet = new THREE.Mesh(new THREE.BoxGeometry((W / S) * 1, 0.03, (W / S) * 1), [
    new THREE.MeshStandardMaterial({ color: 0xe8dfca }),
    new THREE.MeshStandardMaterial({ color: 0xe8dfca }),
    new THREE.MeshStandardMaterial({ map: paperTex, roughness: 0.95 }),
    new THREE.MeshStandardMaterial({ color: 0xe8dfca }),
    new THREE.MeshStandardMaterial({ color: 0xe8dfca }),
    new THREE.MeshStandardMaterial({ color: 0xe8dfca }),
  ])
  sheet.position.y = 0.0
  sheet.rotation.y = 0.012
  sheet.receiveShadow = true
  scene.add(sheet)

  // ビル：厚紙の模型。側面はペンのハッチング
  const hatch = (lv: number) =>
    canvas(128, 128 * lv, (g) => {
      g.fillStyle = '#efe6d2'
      g.fillRect(0, 0, 128, 128 * lv)
      g.strokeStyle = 'rgba(40,40,40,0.35)'
      g.lineWidth = 2
      for (let i = -128 * lv; i < 128 * lv; i += 12) {
        g.beginPath()
        g.moveTo(i, 128 * lv)
        g.lineTo(i + 128 * lv, 0)
        g.stroke()
      }
      for (let f = 1; f < lv; f++) {
        g.strokeStyle = 'rgba(40,40,40,0.8)'
        g.lineWidth = 3
        g.beginPath()
        g.moveTo(0, f * 128)
        g.lineTo(128, f * 128)
        g.stroke()
      }
    })
  const ink = new THREE.LineBasicMaterial({ color: 0x2b2620 })
  for (const c of cells) {
    const lv = level(c)
    if (!lv) continue
    const h = lv * LEVEL_H
    const side = new THREE.MeshStandardMaterial({ map: hatch(lv), roughness: 0.95 })
    const top = new THREE.MeshStandardMaterial({ color: 0xf6f0e2, roughness: 0.95 })
    const geo = new THREE.BoxGeometry(0.86, h, 0.86)
    const b = new THREE.Mesh(geo, [side, side, top, top, side, side])
    b.position.set(c.x - HALF, h / 2 + 0.015, c.y - HALF)
    b.castShadow = b.receiveShadow = true
    scene.add(b)
    const e = new THREE.LineSegments(new THREE.EdgesGeometry(geo), ink)
    e.position.copy(b.position)
    scene.add(e)
    sprite(label('▲'.repeat(lv), { font: '700 40px serif', fill: '#2b2620' }), 0.5, 0.19, world(c, 0.04).add(new THREE.Vector3(0, 0.02, 0)), 0.75)
  }

  // 駒：木製のコマ。頭にクラスの字を判子
  const lathe = new THREE.LatheGeometry(
    [
      [0, 0],
      [0.3, 0],
      [0.3, 0.07],
      [0.22, 0.12],
      [0.16, 0.3],
      [0.2, 0.36],
      [0.2, 0.4],
      [0, 0.41],
    ].map(([r, y]) => new THREE.Vector2(r, y)),
    40,
  )
  for (const p of pieces) {
    if (p.ghost) continue
    const col = p.side === 0 ? 0x2f5d9e : 0xb23a2e
    const m = new THREE.Mesh(lathe, new THREE.MeshStandardMaterial({ color: col, roughness: 0.75 }))
    m.position.copy(world(p.pos, 0.015))
    m.castShadow = true
    scene.add(m)
    const stamp = new THREE.Mesh(
      new THREE.CircleGeometry(0.2, 32),
      new THREE.MeshStandardMaterial({
        transparent: true,
        map: canvas(128, 128, (g) => {
          g.fillStyle = '#f3ead7'
          g.beginPath()
          g.arc(64, 64, 60, 0, Math.PI * 2)
          g.fill()
          g.fillStyle = p.side === 0 ? '#2f5d9e' : '#b23a2e'
          g.font = '900 84px "Hiragino Mincho ProN", serif'
          g.textAlign = 'center'
          g.textBaseline = 'middle'
          g.fillText(kanji(p.cls), 64, 70)
        }),
      }),
    )
    stamp.rotation.x = -Math.PI / 2
    stamp.rotation.z = Math.PI * 0.12
    stamp.position.copy(world(p.pos, 0.43))
    scene.add(stamp)
    sprite(label(`${p.hp}`, { font: 'italic 700 54px Georgia, serif', fill: p.side === 0 ? '#2f5d9e' : '#b23a2e', bg: '#f3ead7', w: 140 }), 0.36, 0.25, world(p.pos, 0.72))
  }

  // 射線：赤インクの矢印と書き込み
  const a = world(SHOOTER.pos)
  const b = world(TARGET.pos)
  a.y = b.y = 0.02
  const dir = b.clone().sub(a).normalize()
  flatArrow(a.clone().addScaledVector(dir, 0.35), b.clone().addScaledVector(dir, -0.3), 0.07, new THREE.MeshBasicMaterial({ color: 0xb23a2e, transparent: true, opacity: 0.85 }))
  sprite(label(`${HIT}%`, { font: 'italic 700 64px Georgia, serif', fill: '#b23a2e', stroke: '#f3ecdc', w: 200 }), 0.6, 0.29, a.clone().lerp(b, 0.5).add(new THREE.Vector3(0.35, 0.15, 0)))

  fitCamera(0.22, 0.92)
  return () => renderer.render(scene, camera)
}


// ======================================================================
// ★ ホロ＋（①ホロをベースに、②ジオラマの取っつきやすさを足す）
// - 背景は真っ黒にせず、深い紺の作戦卓。視界は光で、視界の境目は明るい線で見せる
// - 駒は光る記号ではなく、陣営色のはっきりした立体の人形（ジオラマ由来）。足元が光る
// - 札は「クラスの字＋HPバー」の陣営色のピル。ビルは半透明のガラスに段の線
// ======================================================================
function holo2() {
  const ME = 0x37c3ff
  const EN = 0xff5b47
  const hex = (c: number) => '#' + c.toString(16).padStart(6, '0')
  scene.background = canvas(4, 256, (g) => {
    const gr = g.createLinearGradient(0, 0, 0, 256)
    gr.addColorStop(0, '#0d1b2e')
    gr.addColorStop(1, '#1a2d47')
    g.fillStyle = gr
    g.fillRect(0, 0, 4, 256)
  })
  scene.add(new THREE.HemisphereLight(0xbfe6ff, 0x0b1626, 1.1))
  const keyLight = new THREE.DirectionalLight(0xe6f4ff, 2.0)
  keyLight.position.set(-5, 11, 6)
  keyLight.castShadow = true
  keyLight.shadow.mapSize.set(2048, 2048)
  keyLight.shadow.bias = -0.0005
  Object.assign(keyLight.shadow.camera, { left: -8, right: 8, top: 8, bottom: -8, near: 1, far: 40 })
  scene.add(keyLight)

  // 卓：厚みのある台＋光る縁
  const table = new THREE.Mesh(new THREE.BoxGeometry(N + 1.0, 0.35, N + 1.0), new THREE.MeshStandardMaterial({ color: 0x14263d, roughness: 0.6, metalness: 0.2 }))
  table.position.y = -0.18
  table.receiveShadow = true
  scene.add(table)
  const rim = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(N + 1.0, 0.35, N + 1.0)), new THREE.LineBasicMaterial({ color: 0x3fa9d6 }))
  rim.position.y = -0.18
  scene.add(rim)
  // 盤面：マス目を焼き込んだテクスチャ。見えているマスは明るく、霧のマスは暗く走査線
  const S = 64
  const surface = canvas(N * S, N * S, (g) => {
    for (const c of cells) {
      const seen = visible.has(key(c))
      g.fillStyle = seen ? '#1d4566' : '#0c1828'
      g.fillRect(c.x * S, c.y * S, S, S)
      if (seen) {
        const gr = g.createRadialGradient(c.x * S + S / 2, c.y * S + S / 2, 4, c.x * S + S / 2, c.y * S + S / 2, S * 0.7)
        gr.addColorStop(0, 'rgba(90,200,255,0.18)')
        gr.addColorStop(1, 'rgba(90,200,255,0)')
        g.fillStyle = gr
        g.fillRect(c.x * S, c.y * S, S, S)
      } else {
        g.strokeStyle = 'rgba(120,150,190,0.10)'
        g.lineWidth = 2
        for (let i = 4; i < S; i += 8) {
          g.beginPath()
          g.moveTo(c.x * S, c.y * S + i)
          g.lineTo(c.x * S + S, c.y * S + i)
          g.stroke()
        }
      }
      g.strokeStyle = seen ? 'rgba(110,210,255,0.35)' : 'rgba(110,160,210,0.12)'
      g.lineWidth = 2
      g.strokeRect(c.x * S + 1, c.y * S + 1, S - 2, S - 2)
    }
    // 出撃区画
    for (const [side, col] of [
      [0, 'rgba(55,195,255,0.55)'],
      [1, 'rgba(255,91,71,0.55)'],
    ] as const) {
      g.strokeStyle = col
      g.lineWidth = 3
      g.setLineDash([8, 6])
      const xs = map.spawns[side].map((p) => p.x)
      const ys = map.spawns[side].map((p) => p.y)
      g.strokeRect(Math.min(...xs) * S + 6, Math.min(...ys) * S + 6, 2 * S - 12, 2 * S - 12)
      g.setLineDash([])
    }
  })
  const board = new THREE.Mesh(new THREE.PlaneGeometry(N, N), new THREE.MeshStandardMaterial({ map: surface, roughness: 0.55, metalness: 0.1 }))
  board.rotation.x = -Math.PI / 2
  board.position.y = 0.001
  board.receiveShadow = true
  scene.add(board)

  // 視界の境目：見えている地上マスと見えないマスの間に光る線
  const edgeMat = new THREE.MeshBasicMaterial({ color: 0x7fe3ff, transparent: true, opacity: 0.9 })
  for (const c of cells) {
    if (!visible.has(key(c))) continue
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const n = { x: c.x + dx, y: c.y + dy }
      if (n.x < 0 || n.y < 0 || n.x >= N || n.y >= N || visible.has(key(n))) continue
      const seg = new THREE.Mesh(new THREE.PlaneGeometry(dx ? 0.05 : 1, dx ? 1 : 0.05), edgeMat)
      seg.rotation.x = -Math.PI / 2
      seg.position.set(c.x - HALF + dx * 0.5, 0.012, c.y - HALF + dy * 0.5)
      scene.add(seg)
    }
  }

  // ビル：すりガラスの箱＋光る輪郭＋段の線
  for (const c of cells) {
    const lv = level(c)
    if (!lv) continue
    const h = lv * LEVEL_H
    const geo = new THREE.BoxGeometry(0.88, h, 0.88)
    const glass = new THREE.MeshStandardMaterial({ color: 0x2a5b85, roughness: 0.2, metalness: 0.3, transparent: true, opacity: 0.78, emissive: 0x0c2a44 })
    const b = new THREE.Mesh(geo, glass)
    b.position.set(c.x - HALF, h / 2, c.y - HALF)
    b.castShadow = b.receiveShadow = true
    scene.add(b)
    const e = new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color: 0x8fe6ff }))
    e.position.copy(b.position)
    scene.add(e)
    for (let i = 1; i < lv; i++) {
      const band = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.025, 0.9), new THREE.MeshBasicMaterial({ color: 0x5cc8f0 }))
      band.position.set(c.x - HALF, i * LEVEL_H, c.y - HALF)
      scene.add(band)
    }
    const top = new THREE.Mesh(new THREE.PlaneGeometry(0.88, 0.88), new THREE.MeshStandardMaterial({ color: 0x3d7bab, roughness: 0.4 }))
    top.rotation.x = -Math.PI / 2
    top.position.set(c.x - HALF, h + 0.003, c.y - HALF)
    top.receiveShadow = true
    scene.add(top)
  }

  // 駒：①ホロと同じ「半透明の六角の台座＋光の柱＋浮かぶ光る字」
  for (const p of pieces) {
    const col = p.side === 0 ? ME : EN
    const base = world(p.pos)
    const g = new THREE.Group()
    g.position.copy(base)
    const op = p.ghost ? 0.35 : 1
    const plate = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.38, 0.08, 6), new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.18 * op }))
    plate.position.y = 0.04
    g.add(plate)
    const rimLine = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.CylinderGeometry(0.38, 0.38, 0.001, 6)), new THREE.LineBasicMaterial({ color: col, transparent: true, opacity: op }))
    rimLine.position.y = 0.08
    g.add(rimLine)
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.5, 6), new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.85 * op }))
    beam.position.y = 0.33
    if (!p.ghost) g.add(beam)
    scene.add(g)
    if (p.ghost) {
      sprite(label(`? ${p.ghost}手前`, { font: '700 46px system-ui', fill: hex(col), w: 320 }), 0.95, 0.29, base.clone().add(new THREE.Vector3(0, 0.45, 0)), 0.85)
      sprite(label(kanji(p.cls), { font: '900 64px system-ui', fill: hex(col) }), 0.6, 0.23, base.clone().add(new THREE.Vector3(0, 0.2, 0)), 0.45)
    } else {
      sprite(label(kanji(p.cls), { font: '900 70px system-ui', fill: hex(col), stroke: '#0a1424' }), 0.66, 0.25, base.clone().add(new THREE.Vector3(0, 0.66, 0)))
      sprite(label(`${p.hp}`, { font: '700 44px system-ui', fill: '#e3f4ff' }), 0.5, 0.19, base.clone().add(new THREE.Vector3(0.36, 0.5, 0)), 0.9)
    }
  }

  // 射線：光の筋＋照準＋命中率
  const a = world(SHOOTER.pos, 0.45)
  const b = world(TARGET.pos, 0.35)
  const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, a.distanceTo(b), 8), new THREE.MeshBasicMaterial({ color: 0xffffff }))
  beam.position.copy(a).add(b).multiplyScalar(0.5)
  beam.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize())
  scene.add(beam)
  const halo = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, a.distanceTo(b), 8), new THREE.MeshBasicMaterial({ color: ME, transparent: true, opacity: 0.25 }))
  halo.position.copy(beam.position)
  halo.quaternion.copy(beam.quaternion)
  scene.add(halo)
  const ret = new THREE.Mesh(new THREE.RingGeometry(0.4, 0.46, 4, 1, Math.PI / 4), new THREE.MeshBasicMaterial({ color: 0xffd25a, side: THREE.DoubleSide }))
  ret.rotation.x = -Math.PI / 2
  ret.position.copy(world(TARGET.pos, 0.02))
  scene.add(ret)
  sprite(label(`命中 ${HIT}%`, { font: '900 46px system-ui', fill: '#ffd25a', bg: 'rgba(10,20,36,0.92)', w: 280 }), 0.8, 0.28, a.clone().lerp(b, 0.5).add(new THREE.Vector3(0, 0.38, 0)))

  fitCamera(0.22, 0.9)
  const composer = new EffectComposer(renderer)
  composer.addPass(new RenderPass(scene, camera))
  composer.addPass(new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.75, 0.4, 0.4))
  composer.addPass(new OutputPass())
  return () => composer.render()
}

const render = { holo, holo2, diorama, paper }[themeId as 'holo']?.() ?? holo()
// ?zoom=2 で寄った画（駒の見え方の確認用）
const zoomQ = Number(new URLSearchParams(location.search).get('zoom') ?? 1)
if (zoomQ > 1) {
  camera.zoom = zoomQ
  camera.updateProjectionMatrix()
}
render()
;(window as unknown as { ready: boolean }).ready = true
