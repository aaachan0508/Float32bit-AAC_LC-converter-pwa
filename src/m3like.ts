type BiquadType = 'highpass' | 'lowshelf' | 'highshelf' | 'peaking' | 'bandpass'

type BiquadSpec = {
  type: BiquadType
  frequency: number
  q?: number
  gainDb?: number
}

type BiquadCoefs = {
  b0: number
  b1: number
  b2: number
  a1: number
  a2: number
}

export type M3LikeReport = {
  model: string
  sourceRmsDb: number
  sourcePeakDb: number
  preLevelRmsDb: number
  finalRmsDb: number
  finalPeakDb: number
  appliedGlobalAttenDb: number
  clippedFraction: number
}

export type M3LikeProcessResult = {
  audio: Float32Array
  report: M3LikeReport
}

const TARGET_PEAK_DBFS = -1.0
const MAX_GLOBAL_ATTEN_DB = 1.5
const FRAME_SIZE = 2048
const EPS = 1e-12

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function dbToGain(db: number): number {
  return Math.pow(10, db / 20)
}

function rmsDb(values: Float32Array): number {
  let sum = 0

  for (let i = 0; i < values.length; i++) {
    sum += values[i] * values[i]
  }

  return 20 * Math.log10(Math.sqrt(sum / Math.max(values.length, 1) + EPS))
}

function peakDb(values: Float32Array): number {
  let peak = 0

  for (let i = 0; i < values.length; i++) {
    const abs = Math.abs(values[i])
    if (abs > peak) peak = abs
  }

  return 20 * Math.log10(peak + EPS)
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0

  const sorted = [...values].sort((a, b) => a - b)
  const pos = clamp(p, 0, 100) / 100 * (sorted.length - 1)
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  const t = pos - lo
  return sorted[lo] * (1 - t) + sorted[hi] * t
}

function makeBiquad(spec: BiquadSpec, sampleRate: number): BiquadCoefs {
  const nyquist = sampleRate / 2
  const frequency = clamp(spec.frequency, 1, nyquist - 1)
  const q = Math.max(spec.q ?? 0.707, 0.001)
  const gainDb = spec.gainDb ?? 0
  const a = Math.pow(10, gainDb / 40)
  const w0 = 2 * Math.PI * frequency / sampleRate
  const cosW0 = Math.cos(w0)
  const sinW0 = Math.sin(w0)
  const alpha = sinW0 / (2 * q)
  const sqrtA = Math.sqrt(a)

  let b0 = 1
  let b1 = 0
  let b2 = 0
  let a0 = 1
  let a1 = 0
  let a2 = 0

  if (spec.type === 'highpass') {
    b0 = (1 + cosW0) / 2
    b1 = -(1 + cosW0)
    b2 = (1 + cosW0) / 2
    a0 = 1 + alpha
    a1 = -2 * cosW0
    a2 = 1 - alpha
  } else if (spec.type === 'bandpass') {
    b0 = alpha
    b1 = 0
    b2 = -alpha
    a0 = 1 + alpha
    a1 = -2 * cosW0
    a2 = 1 - alpha
  } else if (spec.type === 'peaking') {
    b0 = 1 + alpha * a
    b1 = -2 * cosW0
    b2 = 1 - alpha * a
    a0 = 1 + alpha / a
    a1 = -2 * cosW0
    a2 = 1 - alpha / a
  } else if (spec.type === 'lowshelf') {
    b0 = a * ((a + 1) - (a - 1) * cosW0 + 2 * sqrtA * alpha)
    b1 = 2 * a * ((a - 1) - (a + 1) * cosW0)
    b2 = a * ((a + 1) - (a - 1) * cosW0 - 2 * sqrtA * alpha)
    a0 = (a + 1) + (a - 1) * cosW0 + 2 * sqrtA * alpha
    a1 = -2 * ((a - 1) + (a + 1) * cosW0)
    a2 = (a + 1) + (a - 1) * cosW0 - 2 * sqrtA * alpha
  } else if (spec.type === 'highshelf') {
    b0 = a * ((a + 1) + (a - 1) * cosW0 + 2 * sqrtA * alpha)
    b1 = -2 * a * ((a - 1) + (a + 1) * cosW0)
    b2 = a * ((a + 1) + (a - 1) * cosW0 - 2 * sqrtA * alpha)
    a0 = (a + 1) - (a - 1) * cosW0 + 2 * sqrtA * alpha
    a1 = 2 * ((a - 1) - (a + 1) * cosW0)
    a2 = (a + 1) - (a - 1) * cosW0 - 2 * sqrtA * alpha
  }

  return {
    b0: b0 / a0,
    b1: b1 / a0,
    b2: b2 / a0,
    a1: a1 / a0,
    a2: a2 / a0,
  }
}

function applyBiquad(input: Float32Array, coefs: BiquadCoefs): Float32Array {
  const output = new Float32Array(input.length)
  let x1 = 0
  let x2 = 0
  let y1 = 0
  let y2 = 0

  for (let i = 0; i < input.length; i++) {
    const x0 = input[i]
    const y0 = coefs.b0 * x0 + coefs.b1 * x1 + coefs.b2 * x2 - coefs.a1 * y1 - coefs.a2 * y2
    output[i] = y0
    x2 = x1
    x1 = x0
    y2 = y1
    y1 = y0
  }

  return output
}

function applyBiquadChain(input: Float32Array, sampleRate: number, specs: BiquadSpec[]): Float32Array {
  let current = input

  for (const spec of specs) {
    current = applyBiquad(current, makeBiquad(spec, sampleRate))
  }

  return current
}

function splitInterleavedStereo(input: Float32Array): { left: Float32Array; right: Float32Array } {
  const length = Math.floor(input.length / 2)
  const left = new Float32Array(length)
  const right = new Float32Array(length)

  for (let i = 0; i < length; i++) {
    left[i] = input[i * 2]
    right[i] = input[i * 2 + 1]
  }

  return { left, right }
}

function makeMidSide(left: Float32Array, right: Float32Array): { mid: Float32Array; side: Float32Array } {
  const mid = new Float32Array(left.length)
  const side = new Float32Array(left.length)

  for (let i = 0; i < left.length; i++) {
    mid[i] = 0.5 * (left[i] + right[i])
    side[i] = 0.5 * (left[i] - right[i])
  }

  return { mid, side }
}

function interleaveFromMidSide(mid: Float32Array, side: Float32Array): Float32Array {
  const output = new Float32Array(mid.length * 2)

  for (let i = 0; i < mid.length; i++) {
    output[i * 2] = mid[i] + side[i]
    output[i * 2 + 1] = mid[i] - side[i]
  }

  return output
}

function frameRms(values: Float32Array, frameSize: number): number[] {
  const frameCount = Math.ceil(values.length / frameSize)
  const rmsValues: number[] = []

  for (let frame = 0; frame < frameCount; frame++) {
    const start = frame * frameSize
    const end = Math.min(start + frameSize, values.length)
    let sum = 0

    for (let i = start; i < end; i++) {
      sum += values[i] * values[i]
    }

    rmsValues.push(Math.sqrt(sum / Math.max(end - start, 1) + EPS))
  }

  return rmsValues
}

function smoothGains(gains: number[]): number[] {
  if (gains.length <= 1) return gains

  const forward = [...gains]
  const alpha = 0.35

  for (let i = 1; i < forward.length; i++) {
    forward[i] = forward[i - 1] * (1 - alpha) + forward[i] * alpha
  }

  for (let i = forward.length - 2; i >= 0; i--) {
    forward[i] = forward[i + 1] * (1 - alpha) + forward[i] * alpha
  }

  return forward
}

function applyFrameGains(values: Float32Array, gains: number[], frameSize: number): Float32Array {
  const output = new Float32Array(values.length)

  for (let i = 0; i < values.length; i++) {
    const framePos = i / frameSize
    const frame = Math.floor(framePos)
    const nextFrame = Math.min(frame + 1, gains.length - 1)
    const t = framePos - frame
    const gain = gains[frame] * (1 - t) + gains[nextFrame] * t
    output[i] = values[i] * gain
  }

  return output
}

function applySoftGateApprox(values: Float32Array, reductionDb: number): Float32Array {
  if (reductionDb <= 0) return values

  const rmsValues = frameRms(values, FRAME_SIZE)
  const floor = percentile(rmsValues, 10)
  const threshold = floor * dbToGain(12)
  const gains = rmsValues.map((value) => {
    const deficit = clamp((threshold - value) / Math.max(threshold - floor, EPS), 0, 1)
    return dbToGain(-reductionDb * deficit)
  })

  return applyFrameGains(values, smoothGains(gains), FRAME_SIZE)
}

function applyPresenceCompressorApprox(
  values: Float32Array,
  sampleRate: number,
  ratio: number,
  maxReductionDb: number,
): Float32Array {
  if (ratio <= 1 || maxReductionDb <= 0) return values

  const band = applyBiquadChain(values, sampleRate, [
    { type: 'bandpass', frequency: 4000, q: 1.0 },
    { type: 'peaking', frequency: 5000, q: 0.8, gainDb: 2.0 },
  ])

  const rmsValues = frameRms(band, FRAME_SIZE)
  const frameDbValues = rmsValues.map((value) => 20 * Math.log10(value + EPS))
  const thresholdDb = percentile(frameDbValues, 70)
  const gains = frameDbValues.map((valueDb) => {
    const overDb = Math.max(0, valueDb - thresholdDb)
    const reductionDb = Math.min(overDb * (1 - 1 / ratio), maxReductionDb)
    return dbToGain(-reductionDb)
  })

  const smoothed = smoothGains(gains)
  const output = new Float32Array(values.length)

  for (let i = 0; i < values.length; i++) {
    const framePos = i / FRAME_SIZE
    const frame = Math.floor(framePos)
    const nextFrame = Math.min(frame + 1, smoothed.length - 1)
    const t = framePos - frame
    const gain = smoothed[frame] * (1 - t) + smoothed[nextFrame] * t
    output[i] = values[i] + band[i] * (gain - 1)
  }

  return output
}

function applyFixedM3CurvesApprox(mid: Float32Array, side: Float32Array, sampleRate: number): { mid: Float32Array; side: Float32Array } {
  const processedMid = applyBiquadChain(mid, sampleRate, [
    { type: 'highpass', frequency: 35, q: 0.707 },
    { type: 'lowshelf', frequency: 80, q: 0.8, gainDb: -5.5 },
    { type: 'peaking', frequency: 650, q: 0.9, gainDb: 3.2 },
    { type: 'peaking', frequency: 1800, q: 1.0, gainDb: 1.8 },
    { type: 'peaking', frequency: 3200, q: 0.75, gainDb: -1.0 },
    { type: 'highshelf', frequency: 7600, q: 0.75, gainDb: 3.4 },
    { type: 'peaking', frequency: 11200, q: 3.0, gainDb: -1.0 },
  ])

  const processedSide = applyBiquadChain(side, sampleRate, [
    { type: 'highpass', frequency: 90, q: 0.707 },
    { type: 'lowshelf', frequency: 250, q: 0.7, gainDb: -11.5 },
    { type: 'peaking', frequency: 650, q: 0.9, gainDb: -2.6 },
    { type: 'peaking', frequency: 2200, q: 1.0, gainDb: 1.2 },
    { type: 'peaking', frequency: 5000, q: 0.75, gainDb: -3.0 },
    { type: 'highshelf', frequency: 9000, q: 0.75, gainDb: 2.2 },
    { type: 'peaking', frequency: 11200, q: 3.0, gainDb: -1.0 },
  ])

  return { mid: processedMid, side: processedSide }
}

function matchRmsToSource(values: Float32Array, sourceRms: number): Float32Array {
  const currentRms = rmsDb(values)
  const gain = dbToGain(sourceRms - currentRms)
  const output = new Float32Array(values.length)

  for (let i = 0; i < values.length; i++) {
    output[i] = values[i] * gain
  }

  return output
}

function peakProtectLimitedClip(values: Float32Array): { audio: Float32Array; appliedGlobalAttenDb: number; clippedFraction: number } {
  const allowed = dbToGain(TARGET_PEAK_DBFS)
  let peak = 0

  for (let i = 0; i < values.length; i++) {
    peak = Math.max(peak, Math.abs(values[i]))
  }

  let appliedGlobalAttenDb = 0

  if (peak > allowed) {
    const requiredAttenDb = -20 * Math.log10(peak / allowed)
    appliedGlobalAttenDb = Math.max(requiredAttenDb, -MAX_GLOBAL_ATTEN_DB)
  }

  const gain = dbToGain(appliedGlobalAttenDb)
  const output = new Float32Array(values.length)
  let clipped = 0

  for (let i = 0; i < values.length; i++) {
    const beforeClip = values[i] * gain
    const afterClip = clamp(beforeClip, -allowed, allowed)
    output[i] = afterClip
    if (beforeClip !== afterClip) clipped += 1
  }

  return {
    audio: output,
    appliedGlobalAttenDb,
    clippedFraction: clipped / Math.max(values.length, 1),
  }
}

export function processM3LikeApprox(input: Float32Array, sampleRate = 48000): M3LikeProcessResult {
  const { left, right } = splitInterleavedStereo(input)
  const { mid: rawMid, side: rawSide } = makeMidSide(left, right)
  const sourceRmsDb = rmsDb(input)
  const sourcePeakDb = peakDb(input)

  const curved = applyFixedM3CurvesApprox(rawMid, rawSide, sampleRate)
  const gatedMid = applySoftGateApprox(curved.mid, 5)
  const gatedSide = applySoftGateApprox(curved.side, 10)
  const compressedMid = applyPresenceCompressorApprox(gatedMid, sampleRate, 1.6, 2.0)
  const compressedSide = applyPresenceCompressorApprox(gatedSide, sampleRate, 2.8, 5.0)

  const preLevel = interleaveFromMidSide(compressedMid, compressedSide)
  const preLevelRmsDb = rmsDb(preLevel)
  const rmsMatched = matchRmsToSource(preLevel, sourceRmsDb)
  const protectedAudio = peakProtectLimitedClip(rmsMatched)

  return {
    audio: protectedAudio.audio,
    report: {
      model: 'M3-like TS approx v0.1: M/S fixed curves + soft gate approx + presence compressor approx',
      sourceRmsDb,
      sourcePeakDb,
      preLevelRmsDb,
      finalRmsDb: rmsDb(protectedAudio.audio),
      finalPeakDb: peakDb(protectedAudio.audio),
      appliedGlobalAttenDb: protectedAudio.appliedGlobalAttenDb,
      clippedFraction: protectedAudio.clippedFraction,
    },
  }
}
