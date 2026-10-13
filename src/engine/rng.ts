/** シード付き乱数（mulberry32）。エンジン内では Math.random を使わない */
export interface Rng {
  next(): number
  int(n: number): number
  pick<T>(arr: readonly T[]): T
  shuffle<T>(arr: T[]): T[]
}

export function createRng(seed: number): Rng {
  let a = seed >>> 0
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const int = (n: number) => Math.floor(next() * n)
  return {
    next,
    int,
    pick: (arr) => arr[int(arr.length)],
    shuffle: (arr) => {
      for (let i = arr.length - 1; i > 0; i--) {
        const j = int(i + 1)
        ;[arr[i], arr[j]] = [arr[j], arr[i]]
      }
      return arr
    },
  }
}

/** 1つのシードから用途別の独立した乱数列を作る（棋譜の再生で解決用の乱数がずれないように） */
export function seedStreams(seed: number) {
  return {
    setup: createRng(seed),
    ai: createRng((seed ^ 0x9e3779b9) >>> 0),
    resolve: createRng((seed + 0x632be5ab) >>> 0),
  }
}
