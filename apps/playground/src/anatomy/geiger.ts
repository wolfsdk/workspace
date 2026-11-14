import type { Geiger } from "../lab/index.ts";

const MAX_CLICKS = 12;
/** Seconds over which one tick's clicks are spread. */
const WINDOW_S = 0.35;
const CLICK_S = 0.004;
const VOLUME = 0.2;

/** Clicks for one tick: one per factor of four in changed bytes, capped. */
export function clickCount(changedBytes: number): number {
  if (!(changedBytes >= 1) || !Number.isFinite(changedBytes)) return 0;
  return Math.min(MAX_CLICKS, 1 + Math.floor(Math.log2(changedBytes) / 2));
}

/** Start offsets in seconds, ascending, irregular like a counter's clicks. */
export function clickOffsets(count: number, random: () => number = Math.random): number[] {
  const out: number[] = [];
  for (let i = 0; i < count; i++) out.push(random() * WINDOW_S);
  return out.sort((a, b) => a - b);
}

type AudioContextCtor = new () => AudioContext;

function audioContextCtor(): AudioContextCtor | undefined {
  const g = globalThis as { AudioContext?: AudioContextCtor; webkitAudioContext?: AudioContextCtor };
  return g.AudioContext ?? g.webkitAudioContext;
}

/** Run a Web Audio call that may throw or return a rejecting promise. */
function quietly(run: () => unknown): void {
  try {
    const result = run();
    if (result instanceof Promise) result.catch(() => {});
  } catch {
    // Audio is optional; a failing context stays silent.
  }
}

/**
 * Muted until `setMuted(false)`, which is the moment the audio context is
 * created, so browsers that need a user gesture get one. Without Web Audio
 * every method is a no-op.
 */
export function createGeiger(): Geiger {
  let muted = true;
  let disposed = false;
  let ctx: AudioContext | null = null;
  let out: GainNode | null = null;
  let click: AudioBuffer | null = null;

  const context = (): AudioContext | null => {
    if (ctx || disposed) return ctx;
    const Ctor = audioContextCtor();
    if (!Ctor) return null;
    try {
      const next = new Ctor();
      const gain = next.createGain();
      gain.gain.value = VOLUME;
      gain.connect(next.destination);
      const length = Math.max(1, Math.ceil(next.sampleRate * CLICK_S));
      const buffer = next.createBuffer(1, length, next.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * Math.exp((-5 * i) / length);
      ctx = next;
      out = gain;
      click = buffer;
    } catch {
      ctx = null;
    }
    return ctx;
  };

  return {
    get muted() {
      return muted;
    },
    setMuted(next: boolean) {
      muted = disposed || next;
      if (muted) return;
      const c = context();
      if (c && c.state === "suspended") quietly(() => c.resume());
    },
    tick(changedBytes: number) {
      if (muted || disposed) return;
      const c = context();
      const n = clickCount(changedBytes);
      if (!c || !out || !click || n === 0) return;
      const t0 = c.currentTime + 0.01;
      for (const offset of clickOffsets(n)) {
        quietly(() => {
          const source = c.createBufferSource();
          source.buffer = click;
          source.connect(out!);
          source.start(t0 + offset);
        });
      }
    },
    dispose() {
      disposed = true;
      muted = true;
      const c = ctx;
      ctx = null;
      out = null;
      click = null;
      if (c) quietly(() => c.close());
    },
  };
}
