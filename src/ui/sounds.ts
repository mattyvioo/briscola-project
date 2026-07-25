/**
 * Soundboard.
 *
 * Every sound is synthesised with the Web Audio API rather than shipped as an
 * audio file. The obvious "meme" sounds — vine boom, bruh, the airhorn from a
 * particular track — are all somebody's copyright, and this repo is public, so
 * committing scraped MP3s would be handing you a licensing problem. These are
 * the generic cartoon/game-show gestures underneath those memes, built from
 * oscillators: no bytes to download, nothing to attribute, and they work
 * offline.
 *
 * To use real recordings instead, drop files in public/sounds/ and swap
 * `play()` for an <audio> element — the protocol side needs no changes.
 */

export const SOUND_IDS = [
  'airhorn',
  'trombone',
  'rimshot',
  'applause',
  'boing',
  'coin',
  'zap',
  'drumroll',
] as const

export type SoundId = (typeof SOUND_IDS)[number]

export function isSoundId(value: unknown): value is SoundId {
  return typeof value === 'string' && (SOUND_IDS as readonly string[]).includes(value)
}

export const SOUND_LABELS: Readonly<Record<SoundId, { icon: string; label: string }>> = {
  airhorn: { icon: '📯', label: 'Trombetta' },
  trombone: { icon: '🎺', label: 'Che tristezza' },
  rimshot: { icon: '🥁', label: 'Ba-dum-tss' },
  applause: { icon: '👏', label: 'Applausi' },
  boing: { icon: '🤸', label: 'Boing' },
  coin: { icon: '🪙', label: 'Moneta' },
  zap: { icon: '⚡', label: 'Zap' },
  drumroll: { icon: '🪘', label: 'Rullo' },
}

const MUTE_KEY = 'briscola.muted'

let ctx: AudioContext | null = null
let muted = readMuted()

function readMuted(): boolean {
  try {
    return localStorage.getItem(MUTE_KEY) === '1'
  } catch {
    return false
  }
}

export function isMuted(): boolean {
  return muted
}

export function setMuted(next: boolean) {
  muted = next
  try {
    localStorage.setItem(MUTE_KEY, next ? '1' : '0')
  } catch {
    // Preference persistence is optional.
  }
}

/**
 * Browsers refuse to start audio without a user gesture, so the context is
 * created lazily and resumed on every play. A sound arriving from the network
 * before this player has touched anything simply will not be heard — there is
 * no way around that, and it is not worth an error.
 */
function audio(): AudioContext | null {
  if (typeof AudioContext === 'undefined') return null
  ctx ??= new AudioContext()
  if (ctx.state === 'suspended') void ctx.resume()
  return ctx
}

/** Call from a click handler to unlock audio as early as possible. */
export function unlockAudio() {
  audio()
}

type Envelope = { attack?: number; decay: number; peak?: number }

function tone(
  c: AudioContext,
  at: number,
  opts: {
    type: OscillatorType
    from: number
    to?: number
    env: Envelope
    detune?: number
  },
): void {
  const osc = c.createOscillator()
  const gain = c.createGain()
  osc.type = opts.type
  osc.frequency.setValueAtTime(opts.from, at)
  if (opts.to !== undefined) osc.frequency.exponentialRampToValueAtTime(opts.to, at + opts.env.decay)
  if (opts.detune) osc.detune.setValueAtTime(opts.detune, at)

  const peak = opts.env.peak ?? 0.25
  const attack = opts.env.attack ?? 0.01
  gain.gain.setValueAtTime(0.0001, at)
  gain.gain.exponentialRampToValueAtTime(peak, at + attack)
  gain.gain.exponentialRampToValueAtTime(0.0001, at + opts.env.decay)

  osc.connect(gain).connect(c.destination)
  osc.start(at)
  osc.stop(at + opts.env.decay + 0.02)
}

/** White noise through a band-pass — the basis of the percussive sounds. */
function noise(
  c: AudioContext,
  at: number,
  opts: { duration: number; freq: number; q?: number; peak?: number; sweepTo?: number },
): void {
  const frames = Math.max(1, Math.floor(c.sampleRate * opts.duration))
  const buffer = c.createBuffer(1, frames, c.sampleRate)
  const chan = buffer.getChannelData(0)
  for (let i = 0; i < frames; i++) chan[i] = Math.random() * 2 - 1

  const src = c.createBufferSource()
  src.buffer = buffer

  const filter = c.createBiquadFilter()
  filter.type = 'bandpass'
  filter.frequency.setValueAtTime(opts.freq, at)
  if (opts.sweepTo) filter.frequency.exponentialRampToValueAtTime(opts.sweepTo, at + opts.duration)
  filter.Q.value = opts.q ?? 1

  const gain = c.createGain()
  const peak = opts.peak ?? 0.3
  gain.gain.setValueAtTime(0.0001, at)
  gain.gain.exponentialRampToValueAtTime(peak, at + 0.01)
  gain.gain.exponentialRampToValueAtTime(0.0001, at + opts.duration)

  src.connect(filter).connect(gain).connect(c.destination)
  src.start(at)
  src.stop(at + opts.duration + 0.02)
}

const RECIPES: Record<SoundId, (c: AudioContext, t: number) => void> = {
  // Two detuned saws holding a note — the beating between them is what makes
  // an air horn sound like an air horn rather than a synth lead.
  airhorn(c, t) {
    for (const detune of [-12, 9]) {
      tone(c, t, { type: 'sawtooth', from: 300, to: 330, env: { decay: 0.75, peak: 0.16 }, detune })
      tone(c, t, { type: 'sawtooth', from: 450, to: 495, env: { decay: 0.75, peak: 0.1 }, detune })
    }
  },

  // Four descending notes, each sliding into the next.
  trombone(c, t) {
    const steps = [233.08, 207.65, 185.0, 155.56]
    steps.forEach((f, i) => {
      const start = t + i * 0.18
      tone(c, start, {
        type: 'sawtooth',
        from: f,
        to: f * 0.94,
        env: { decay: 0.22, peak: 0.22, attack: 0.03 },
      })
    })
  },

  // Snare-ish hit, then the cymbal.
  rimshot(c, t) {
    noise(c, t, { duration: 0.09, freq: 1400, q: 0.8, peak: 0.32 })
    tone(c, t, { type: 'triangle', from: 220, to: 90, env: { decay: 0.1, peak: 0.22 } })
    noise(c, t + 0.16, { duration: 0.5, freq: 6000, q: 0.4, peak: 0.26, sweepTo: 3000 })
  },

  // Many short noise bursts at random offsets read as a crowd clapping.
  applause(c, t) {
    for (let i = 0; i < 34; i++) {
      const at = t + Math.random() * 1.1
      noise(c, at, { duration: 0.05, freq: 1200 + Math.random() * 2400, q: 0.7, peak: 0.06 })
    }
  },

  boing(c, t) {
    tone(c, t, { type: 'sine', from: 720, to: 90, env: { decay: 0.45, peak: 0.3 } })
    tone(c, t + 0.04, { type: 'sine', from: 520, to: 70, env: { decay: 0.35, peak: 0.16 } })
  },

  // The two-note pickup everyone knows from platformers.
  coin(c, t) {
    tone(c, t, { type: 'square', from: 987.77, env: { decay: 0.08, peak: 0.16 } })
    tone(c, t + 0.08, { type: 'square', from: 1318.51, env: { decay: 0.3, peak: 0.16 } })
  },

  zap(c, t) {
    tone(c, t, { type: 'sawtooth', from: 1800, to: 120, env: { decay: 0.28, peak: 0.2 } })
    noise(c, t, { duration: 0.25, freq: 2400, q: 1.5, peak: 0.14, sweepTo: 300 })
  },

  drumroll(c, t) {
    for (let i = 0; i < 26; i++) {
      noise(c, t + i * 0.045, { duration: 0.04, freq: 1100, q: 0.9, peak: 0.16 })
    }
    noise(c, t + 26 * 0.045, { duration: 0.5, freq: 5200, q: 0.4, peak: 0.3, sweepTo: 2600 })
    tone(c, t + 26 * 0.045, { type: 'triangle', from: 200, to: 80, env: { decay: 0.16, peak: 0.24 } })
  },
}

export function playSound(id: SoundId) {
  if (muted) return
  const c = audio()
  if (!c) return
  // A small lead-in keeps the first grain from being clipped on some devices.
  RECIPES[id](c, c.currentTime + 0.02)
}
