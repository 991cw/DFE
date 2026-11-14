// 1DesignTool design-kit — deterministic motion recipes (round16 §6.6,
// work item R16-Q19).
//
// Every helper is a pure function of (t, opts): evaluate(clip, t, seed) must
// land on the same pose for any seek order, independent of frame rate or
// playback history. No 'three' import — clip builders take THREE as a
// parameter so the whole module loads under Node for tests.
//
// Two families:
//   curves   — scalar helpers for evaluatePose: lag, blinker, breathe,
//              anticipate, overshoot, phaseOffset, and the mechanism solvers
//              gearRatio / crankSlider / fourBar.
//   bakers   — springFollow (fixed-step integrator) and bakeFollowThrough
//              produce baked track data that survives GLB export; a live
//              spring in evaluatePose is a viewer feature until it is baked.
//
// Contacts and mechanical linkages may legitimately synchronize — a blanket
// "nothing arrives on the same frame" rule is wrong (§6.6). Deliberate lag is
// for soft appendages and follow-through, not for rigidly coupled parts.

const fail = (fn, msg) => { throw new Error(`motion/${fn}: ${msg}`); };
const num = (fn, name, v, ok) => {
  if (!Number.isFinite(v)) fail(fn, `${name} must be a finite number (got ${JSON.stringify(v)})`);
  if (ok && !ok(v)) fail(fn, `${name} out of range (got ${v})`);
  return v;
};
const TAU = Math.PI * 2;

/** mulberry32 — same generator as shared.js's seededRandom, duplicated here so
    this module never imports the DOM-side helper layer. */
export function mulberry32(seed) {
  let a = (seed >>> 0) || 1;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ----------------------------------------------------------- live curves */

/**
 * Fixed-step semi-implicit spring — the deterministic way to do follow
 * motion without per-frame state. Returns an evaluator (t, state) → {x, v}
 * that re-integrates from t=0 on every call at the declared dt. The step is
 * a documented simulation-accuracy choice (default 1/240 s), NOT an assumed
 * playback rate; for portable delivery bake the result (bakeFollowThrough or
 * your own sampler), since the runtime spring itself is not a clip channel.
 *   state: {x0, v0, target} — target may be a scalar or fn(t).
 */
export function springFollow({ stiffness = 40, damping = 8, mass = 1, dt = 1 / 240 } = {}) {
  const fn = 'springFollow';
  num(fn, 'stiffness', stiffness, (v) => v > 0);
  num(fn, 'damping', damping, (v) => v >= 0);
  num(fn, 'mass', mass, (v) => v > 0);
  num(fn, 'dt', dt, (v) => v > 0);
  return (t, { x0 = 0, v0 = 0, target = 0 } = {}) => {
    num(fn, 't', t, (v) => v >= 0);
    const goal = typeof target === 'function' ? target : () => target;
    let x = x0, v = v0, s = 0;
    while (s < t) {
      const h = Math.min(dt, t - s); // fixed steps + one remainder — same every call
      const a = (-stiffness * (x - goal(s)) - damping * v) / mass;
      v += a * h;          // semi-implicit: velocity first,
      x += v * h;          // then position from the new velocity
      s += h;
    }
    return { x, v };
  };
}

/** Phase-lagged copy of a sinusoid: the follower runs `lead` seconds behind
    the leader at the same frequency — tails, antennae, loose panels. */
export function lag(t, { lead = 0.1, amount = 1, freq = 1 } = {}) {
  num('lag', 'lead', lead, (v) => v >= 0);
  num('lag', 'freq', freq, (v) => v > 0);
  return amount * Math.sin(TAU * freq * (t - lead));
}

/**
 * Seeded blink schedule → eyelid closure in [0, 1] (0 open, 1 fully closed).
 * Events land at period·(0.6–1.4×) intervals from the seed stream, each shaped
 * sin(π·u) so lid closure genuinely reaches 1 at mid-event; ~25% of events
 * (doubleChance) add a follow-up blink shortly after. The schedule is
 * regenerated from the seed on every call — random seek order cannot change
 * it. Cadence stays inspectable over ≥ 20 s.
 */
export function blinker(t, { period = 3.2, duration = 0.14, offset = 0, seed = 1, doubleChance = 0.25 } = {}) {
  const fn = 'blinker';
  num(fn, 't', t, (v) => v >= 0);
  num(fn, 'period', period, (v) => v > 0);
  num(fn, 'duration', duration, (v) => v > 0);
  num(fn, 'doubleChance', doubleChance, (v) => v >= 0 && v <= 1);
  const rng = mulberry32(seed);
  let lid = 0;
  let T = offset + period * (0.5 + 0.5 * rng());
  while (T < t) {
    const u = (t - T) / duration;
    if (u >= 0 && u <= 1) lid = Math.max(lid, Math.sin(Math.PI * u));
    if (rng() < doubleChance) { // double-blink: a second event just after
      const u2 = (t - (T + duration + 0.12)) / duration;
      if (u2 >= 0 && u2 <= 1) lid = Math.max(lid, Math.sin(Math.PI * u2));
    }
    T += period * (0.6 + 0.8 * rng());
  }
  return lid;
}

/** Slow symmetric breath, 0 → amount → 0 at `rate` Hz, resting at 0 when t=0
    so it composes with a rest pose. Apply to a chest/shoulder landmark or a
    local scale — never a whole-body Y scale (that lifts the feet). */
export function breathe(t, { rate = 0.25, amount = 0.01 } = {}) {
  num('breathe', 'rate', rate, (v) => v > 0);
  num('breathe', 'amount', amount, (v) => v >= 0);
  return amount * (0.5 - 0.5 * Math.cos(TAU * rate * t));
}

/** Pre-action dip: returns −dip shaped as a smooth bump over [t0−lead, t0],
    back to 0 exactly at t0 so the launch curve (e.g. overshoot) owns the
    forward motion. Start and end derivatives are zero. */
export function anticipate(t, { t0 = 0, lead = 0.3, dip = 0.2 } = {}) {
  num('anticipate', 'lead', lead, (v) => v > 0);
  const u = (t - (t0 - lead)) / lead;
  if (u <= 0 || u >= 1) return 0;
  return -dip * Math.sin(Math.PI * u);
}

/**
 * Bounded step response that arrives at t0 and settles at 1: critically
 * damped for amount ≤ 0, and for 0 < amount < 1 a second-order step tuned so
 * the first overshoot peak equals `amount` at ~`settle` seconds after t0.
 * amount ≥ 1 rejected — a 100% overshoot is a bounce, not a settle.
 */
export function overshoot(t, { t0 = 0, amount = 0.15, settle = 0.5 } = {}) {
  const fn = 'overshoot';
  num(fn, 'settle', settle, (v) => v > 0);
  num(fn, 'amount', amount, (v) => v < 1);
  const s = t - t0;
  if (s <= 0) return 0;
  if (amount <= 0) { // critically damped: no ring
    const wn = 4.75 / settle;
    return 1 - Math.exp(-wn * s) * (1 + wn * s);
  }
  const ln = Math.log(amount);
  const zeta = -ln / Math.sqrt(Math.PI * Math.PI + ln * ln);
  const wd = Math.PI / settle;             // peak lands at s ≈ settle
  const wn = wd / Math.sqrt(1 - zeta * zeta);
  const env = Math.exp(-zeta * wn * s);
  return 1 - env * (Math.cos(wd * s) + (zeta / Math.sqrt(1 - zeta * zeta)) * Math.sin(wd * s));
}

/* ------------------------------------------------------------- mechanics */

/**
 * Spur-gear chain. teeth = [driver, …, last] tooth counts; successive gears
 * counter-rotate. Returns { ratios, angleAt(i, driverAngle) } — ratios[0]=1,
 * ratios[i] = −ratios[i−1]·T[i−1]/T[i]. Axes are the caller's; this keeps the
 * ratio math honest.
 */
export function gearRatio({ teeth } = {}) {
  const fn = 'gearRatio';
  if (!Array.isArray(teeth) || teeth.length < 2) fail(fn, 'teeth needs ≥ 2 tooth counts [driver, …, driven]');
  for (const n of teeth) num(fn, 'teeth', n, (v) => Number.isInteger(v) && v > 0);
  const ratios = [1];
  for (let i = 1; i < teeth.length; i++) ratios.push(-ratios[i - 1] * (teeth[i - 1] / teeth[i]));
  return { ratios, angleAt: (i, driverAngle) => driverAngle * ratios[i] };
}

/**
 * Crank–slider: crank of radius r turning at freq Hz drives a slider through
 * a rod of length l. Returns {x, theta} — x = r·cosθ + √(l²−r²·sin²θ).
 * l must exceed r; l ≤ r is a dead mechanism, not a design choice.
 */
export function crankSlider(t, { r, l, freq = 0.25, phase = 0 } = {}) {
  const fn = 'crankSlider';
  num(fn, 'r', r, (v) => v > 0);
  num(fn, 'l', l, (v) => v > 0);
  if (l <= r) fail(fn, `rod length ${l} must exceed crank radius ${r} — the slider would lock`);
  num(fn, 'freq', freq, (v) => v > 0);
  const theta = TAU * freq * t + phase;
  const s = Math.sin(theta);
  return { x: r * Math.cos(theta) + Math.sqrt(l * l - r * r * s * s), theta };
}

/**
 * Planar four-bar linkage: fixed pivots O2=(0,0), O4=(ground,0); crank of
 * length `crank` turns at freq Hz; `coupler` joins crank tip to `rocker`
 * swinging about O4. Returns {crank, coupler, rocker} angles in radians.
 * branch 'open' | 'crossed' selects the assembly mode. Throws when the
 * linkage cannot assemble at the current angle — a requirement failure, not
 * a number to clamp away.
 */
export function fourBar(t, { linkages, freq = 0.25, phase = 0, branch = 'open' } = {}) {
  const fn = 'fourBar';
  const { ground, crank, coupler, rocker } = linkages || {};
  for (const [k, v] of Object.entries({ ground, crank, coupler, rocker })) {
    num(fn, `linkages.${k}`, v, (x) => x > 0);
  }
  if (!['open', 'crossed'].includes(branch)) fail(fn, `branch must be 'open' or 'crossed' (got ${JSON.stringify(branch)})`);
  const th2 = TAU * freq * t + phase;
  const ax = crank * Math.cos(th2), ay = crank * Math.sin(th2); // crank tip
  const dx = ax - ground;
  const s = Math.hypot(dx, ay);                                  // crank tip ↔ rocker pivot
  if (s < 1e-12) fail(fn, 'crank tip coincides with the rocker pivot — singular');
  if (s > coupler + rocker + 1e-9 || s < Math.abs(coupler - rocker) - 1e-9) {
    fail(fn, `cannot assemble at θ=${th2.toFixed(3)}: coupler+rocker cannot reach the crank tip (s=${s.toFixed(4)})`);
  }
  const cosB = Math.min(1, Math.max(-1, (s * s + rocker * rocker - coupler * coupler) / (2 * s * rocker)));
  const psi = Math.atan2(ay, dx);
  const beta = Math.acos(cosB);
  const th4 = psi + (branch === 'open' ? beta : -beta);
  const bx = ground + rocker * Math.cos(th4), by = rocker * Math.sin(th4);
  return { crank: th2, coupler: Math.atan2(ay - by, ax - bx), rocker: th4 };
}

/** Phase-shifted cyclic time, wrapped into [0, period): stagger channels that
    share a clip without duplicating it. */
export function phaseOffset(t, { phase = 0, period = 1 } = {}) {
  num('phaseOffset', 'period', period, (v) => v > 0);
  return (((t + phase) % period) + period) % period;
}

/* ---------------------------------------------------------------- baking */

/**
 * Bake a driver's motion into KeyframeTrack-shaped data with one-pole lag —
 * the follow-through recipe for antennas, loose straps and tails.
 *   target  — node name the track binds to (no dots; GLB binding sanitizes)
 *   driver  — fn(t) → [x,y,z] (position) | Quaternion | [x,y,z,w] (rotation)
 *   frames/fps — sampling density is an export-precision choice
 *   decay   — per-sample retention in [0,1): 0 follows exactly, 0.9 trails far
 * Returns { name, times, values, valueSize, kind } where kind is 'vector' or
 * 'quaternion' — feed it to THREE.VectorKeyframeTrack/QuaternionKeyframeTrack
 * (or kinetic recipes, which do it for you).
 */
export function bakeFollowThrough(THREE, { target, driver, frames = 32, fps = 30, decay = 0.75 } = {}) {
  const fn = 'bakeFollowThrough';
  if (typeof target !== 'string' || !target) fail(fn, 'target node name required (no dots — glTF binding sanitizes)');
  if (typeof driver !== 'function') fail(fn, 'driver(t) function required');
  num(fn, 'frames', frames, (v) => Number.isInteger(v) && v >= 2);
  num(fn, 'fps', fps, (v) => v > 0);
  num(fn, 'decay', decay, (v) => v >= 0 && v < 1);
  const first = driver(0);
  const isQuat = first && (first.isQuaternion || (Array.isArray(first) && first.length === 4));
  const size = isQuat ? 4 : 3;
  const arr = (v) => (v && typeof v.toArray === 'function') ? v.toArray() : v;
  const times = new Float32Array(frames);
  const values = new Float32Array(frames * size);
  const alpha = 1 - decay;
  const prev = new THREE.Quaternion();
  const cur = new THREE.Quaternion();
  for (let i = 0; i < frames; i++) {
    const t = i / fps;
    times[i] = t;
    const raw = arr(driver(t));
    if (!Array.isArray(raw) || raw.length !== size) fail(fn, `driver(t=${t.toFixed(3)}) must return ${size} components, got ${JSON.stringify(driver(t))}`);
    if (i === 0) values.set(raw.map(Number), 0);
    else if (isQuat) {
      cur.set(raw[0], raw[1], raw[2], raw[3]).normalize();
      prev.fromArray(values, (i - 1) * size).slerp(cur, alpha); // lag via slerp toward the driver
      prev.toArray(values, i * size);
    } else {
      for (let k = 0; k < size; k++) values[i * size + k] = values[(i - 1) * size + k] + (raw[k] - values[(i - 1) * size + k]) * alpha;
    }
  }
  return {
    name: `${target}.${isQuat ? 'quaternion' : 'position'}`,
    times, values, valueSize: size, kind: isQuat ? 'quaternion' : 'vector',
    duration: times[frames - 1],
  };
}

/**
 * Loop-closure check: max endpoint delta of a baked or declared track.
 * Accepts KeyframeTrack-shaped data ({times, values} + getValueSize() or
 * valueSize) or a THREE.KeyframeTrack. Quaternion channels compare as angular
 * distance (q and −q are the same orientation — |dot| handles the sign).
 * Used by tests to prove a cyclic clip ends where it starts (§8.3).
 */
export function loopError(track) {
  const fn = 'loopError';
  const values = track?.values, times = track?.times;
  if (!values || !times || times.length < 2) fail(fn, 'track needs ≥ 2 keys ({times, values})');
  const size = track.valueSize || (typeof track.getValueSize === 'function' ? track.getValueSize() : null);
  if (!size) fail(fn, 'cannot determine track value size');
  const a = Array.from(values.slice(0, size));
  const b = Array.from(values.slice(values.length - size));
  const quat = size === 4 && (/quaternion/i.test(track.name || '') || track.kind === 'quaternion');
  if (quat) {
    const dot = Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]));
    return 2 * Math.acos(dot); // radians
  }
  return Math.max(...a.map((v, i) => Math.abs(v - b[i])));
}

export default {
  mulberry32, springFollow, lag, blinker, breathe, anticipate, overshoot,
  gearRatio, crankSlider, fourBar, phaseOffset, bakeFollowThrough, loopError,
};

// Shared opt-in motion/1 APIs; legacy helpers retain their existing semantics.
export { springPosition, ease as sampleMotionEase, preparePath, prepareFollow, beatBoundaries, frameTime, color as interpolateColor } from "./motion-core.generated.js";
