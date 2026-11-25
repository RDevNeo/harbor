import { describe, expect, it } from 'bun:test'
import { acceptFix, addFix, climb, distanceM, elevationGainM, filterFixes, haversine, summarize, type Fix } from '../lib/track'

// ~1 degree of latitude = 111.195 km with the mean Earth radius.
const M_PER_DEG = 111_195

/** Fix `m` meters north of a base point, `s` seconds after start. */
const north = (m: number, s: number, extra: Partial<Fix> = {}): Fix => ({ t: s * 1000, lat: -23.55 + m / M_PER_DEG, lon: -46.63, acc: 5, ...extra })

// Deterministic pseudo-random noise in [-1, 1).
const noise = (i: number) => {
  const x = Math.sin(i * 12.9898 + 78.233) * 43758.5453
  return (x - Math.floor(x)) * 2 - 1
}

describe('haversine', () => {
  it('matches known distances', () => {
    expect(haversine({ lat: 0, lon: 0 }, { lat: 1, lon: 0 })).toBeCloseTo(M_PER_DEG, -1)
    // São Paulo (Sé) → Rio de Janeiro (Centro): ~361 km
    expect(haversine({ lat: -23.5505, lon: -46.6333 }, { lat: -22.9068, lon: -43.1729 }) / 1000).toBeCloseTo(361, 0)
    expect(haversine({ lat: 10, lon: 20 }, { lat: 10, lon: 20 })).toBe(0)
  })
})

describe('fix filter', () => {
  it('drops inaccurate fixes, standing-still jitter and implausible jumps', () => {
    const a = north(0, 0)
    expect(acceptFix(undefined, a)).toBe(true)
    expect(acceptFix(undefined, north(0, 0, { acc: 40 }))).toBe(false)
    expect(acceptFix(a, north(2, 1))).toBe(false) // 2 m jitter
    expect(acceptFix(a, north(10, 2))).toBe(true) // 5 m/s
    expect(acceptFix(a, north(300, 3))).toBe(false) // 100 m/s jump
    expect(acceptFix(a, north(10, 0))).toBe(false) // no time passed
    expect(acceptFix(a, north(6, 2, { speed: 0.2 }))).toBe(false) // device says we're standing still
  })

  it('ignores GPS wander while stopped so distance stays near the true path', () => {
    const fixes: Fix[] = []
    // 200 s standing still with ±3 m wander, then 1 km north at 5 m/s, with one 400 m spike.
    for (let s = 0; s < 200; s++) fixes.push(north(noise(s) * 3, s, { speed: 0.1 }))
    for (let s = 0; s <= 200; s++) fixes.push(north(s * 5 + noise(s + 7) * 1.5, 200 + s, s === 100 ? { lat: -23.55 + 900 / M_PER_DEG } : {}))
    fixes.push(north(1000, 402, { acc: 60 })) // inaccurate, dropped
    const kept = filterFixes(fixes)
    expect(distanceM(kept)).toBeGreaterThan(960)
    expect(distanceM(kept)).toBeLessThan(1060)
    // Unfiltered, the wander and the spike inflate it a lot.
    expect(distanceM(fixes)).toBeGreaterThan(1500)
  })
})

describe('elevation gain', () => {
  it('hysteresis ignores small wobbles but counts real climbs', () => {
    expect(climb([100, 102, 100, 102, 100, 102])).toBe(0)
    expect(climb([100, 104, 108, 104, 110])).toBe(14) // 100→108 (8) then 104→110 (6)
    expect(climb([100, 101, 102, 103, 104, 105])).toBe(5) // whole climb counts once confirmed
  })

  it('a flat ride with ±4 m altitude noise has ~0 gain (short and 30-min rides)', () => {
    for (const n of [300, 1800]) {
      const pts = Array.from({ length: n }, (_, i) => north(i * 6, i, { alt: 760 + noise(i) * 4 }))
      expect(elevationGainM(pts)).toBeLessThan(3)
    }
  })

  it('rolling hills (4 × 20 m) with noise read close to 80 m', () => {
    const pts = Array.from({ length: 1800 }, (_, i) => north(i * 6, i, { alt: 700 + 10 * Math.sin((i / 1800) * 2 * Math.PI * 4) + noise(i + 5) * 4 }))
    const gain = elevationGainM(pts)
    expect(gain).toBeGreaterThan(70)
    expect(gain).toBeLessThan(92)
  })

  it('a 50 m climb with noisy altitude reads close to 50 m', () => {
    const pts = Array.from({ length: 300 }, (_, i) => north(i * 6, i, { alt: 700 + (i / 299) * 50 + noise(i) * 4 }))
    const gain = elevationGainM(pts)
    expect(gain).toBeGreaterThan(40)
    expect(gain).toBeLessThan(60)
  })

  it('skips altitudes with poor vertical accuracy and missing altitude', () => {
    const pts = [north(0, 0, { alt: 700 }), north(10, 1, { alt: 800, altAcc: 50 }), north(20, 2, { alt: null }), north(30, 3, { alt: 701 })]
    expect(elevationGainM(pts)).toBe(0)
  })
})

describe('summarize', () => {
  it('computes km, duration, avg speed and a thumbnail', () => {
    const pts = Array.from({ length: 121 }, (_, i) => north(i * 5, i * 1, { alt: 700 }))
    const s = summarize(pts, 120_000)
    expect(s.km).toBeCloseTo(0.6, 2)
    expect(s.durationSec).toBe(120)
    expect(s.avgKmh).toBeCloseTo(18, 0)
    expect(s.gainM).toBe(0)
    expect(s.thumb?.length).toBeGreaterThan(10)
    expect(summarize([], 1000)).toMatchObject({ km: 0, gainM: 0, durationSec: 1, avgKmh: 0 })
    expect(summarize([], 1000).thumb).toBeUndefined()
  })
})

describe('pauses', () => {
  it('distance excludes the gap between segments (no line across a pause)', () => {
    // 500 m north, pause, (moved 2 km meanwhile), then 300 m more in segment 1.
    const a = Array.from({ length: 101 }, (_, i) => north(i * 5, i))
    const b = Array.from({ length: 61 }, (_, i) => north(2500 + i * 5, 400 + i, { seg: 1 }))
    expect(distanceM([...a, ...b])).toBeCloseTo(800, 0)
    expect(distanceM([...a, ...b.map((p) => ({ ...p, seg: 0 }))])).toBeGreaterThan(2700) // same points, one segment
  })

  it("the first fix after resuming is accepted even far away (it's not a GPS jump)", () => {
    let pts: Fix[] = [north(0, 0)]
    pts = addFix(pts, north(3000, 10, { seg: 1 })) // 300 m/s if it were the same segment
    expect(pts).toHaveLength(2)
    expect(acceptFix(pts[0], north(3000, 10))).toBe(false)
    expect(acceptFix(north(0, 0), north(1, 1, { seg: 1, speed: 0 }))).toBe(true) // starts fresh: no jitter/speed checks
  })

  it('climb while paused does not count; each segment counts its own climbs', () => {
    const flat = (from: number, n: number, alt: number, seg: number) => Array.from({ length: n }, (_, i) => north((from + i) * 6, from + i, { alt, seg }))
    // Segment 0 at 700 m, pause, segment 1 at 760 m (drove up while paused): 0 gain.
    expect(elevationGainM([...flat(0, 60, 700, 0), ...flat(100, 60, 760, 1)])).toBe(0)
    // Without the pause the 60 m step would count.
    expect(elevationGainM([...flat(0, 60, 700, 0), ...flat(100, 60, 760, 0)])).toBeGreaterThan(55)
    // A real 30 m climb inside segment 1 still counts.
    const climb30 = Array.from({ length: 120 }, (_, i) => north((200 + i) * 6, 200 + i, { alt: 760 + (i / 119) * 30, seg: 1 }))
    const g = elevationGainM([...flat(0, 60, 700, 0), ...climb30])
    expect(g).toBeGreaterThan(25)
    expect(g).toBeLessThan(33)
  })

  it('summary duration is the recorded (moving) time, not wall-clock', () => {
    const pts = [...Array.from({ length: 61 }, (_, i) => north(i * 5, i)), ...Array.from({ length: 61 }, (_, i) => north(1000 + i * 5, 600 + i, { seg: 1 }))]
    const s = summarize(pts, 120_000) // 2 min recorded, though 11 min passed
    expect(s.durationSec).toBe(120)
    expect(s.km).toBeCloseTo(0.6, 2)
    expect(s.avgKmh).toBeCloseTo(18, 0)
  })
})
