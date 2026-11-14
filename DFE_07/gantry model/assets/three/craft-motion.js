// 1DesignTool design-kit — craft performance compiler (round22 §3, §6, §7;
// work item R22-C03/C04 kit side).
//
// The agent-facing contract: a semantic performance document names poses,
// targets and frames; the compiler owns the joint channels. This module is
// pure math — no 'three' import — so it runs under plain Node for the checker
// and in the page for the runtime. craft.js adapts its output to THREE.
//
//   const { ok, diagnostics, schedule } = compilePerformance(bundle, doc);
//   const state = evaluateSchedule(schedule, t);   // pure in t — any seek order
//
// Bundle data lives in assets/three/craft/*.json (round22 §3): one versioned
// bundle pinned by content hash, consumed identically by the Three.js adapter
// (this file + craft.js) and, later, the bpy adapter. Canonical coordinates:
// right-handed metres, +Y up, +Z character-forward, character-left +X.
// Channel semantics (joints.json channelModel): pitch = rotation about local
// +X, roll about +Z, twist about +Y (the bone axis); composed
// q = qx(pitch)·qz(roll)·qy(twist), intrinsic X-Z-Y, in degrees.
//
// Determinism (§3): identical input + seed + bundle hash + adapter version →
// identical evaluated output within declared tolerances. Random streams are
// doc.seed ^ fnv1a(subject + ':' + layer), so inserting a subject never
// reshuffles another subject's blink.

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

export const CRAFT_DOC_VERSION = 1;
export const CONSTRUCTION_LEVELS = ['rigid-hierarchy', 'covered-rigid', 'deformation'];

/* ------------------------------------------------------------- vectors --- */

const vadd = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const vsub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const vscale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const vdot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const qdot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]; // quats are 4-vectors — vdot silently drops w
const vcross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const vlen = (a) => Math.hypot(a[0], a[1], a[2]);
const vnorm = (a) => { const l = vlen(a); return l < 1e-12 ? [0, 0, 0] : vscale(a, 1 / l); };
const vlerp = (a, b, u) => [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];

/* --------------------------------------------------------- quaternions --- */
// [x, y, z, w] — the same component order THREE.Quaternion serializes to.

const qmul = (a, b) => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
const qconj = (q) => [-q[0], -q[1], -q[2], q[3]];
const qnorm = (q) => { const l = Math.hypot(q[0], q[1], q[2], q[3]); return l < 1e-12 ? [0, 0, 0, 1] : q.map((v) => v / l); };
const qrot = (q, v) => {
  const u = [q[0], q[1], q[2]], s = q[3];
  const uv = vcross(u, v), uuv = vcross(u, uv);
  return vadd(v, vadd(vscale(uv, 2 * s), vscale(uuv, 2)));
};
const qAxisAngle = (axis, deg) => {
  const a = vnorm(axis), h = deg * D2R / 2, s = Math.sin(h);
  return [a[0] * s, a[1] * s, a[2] * s, Math.cos(h)];
};
const qBasis = (x, y, z) => {
  const m00 = x[0], m01 = y[0], m02 = z[0], m10 = x[1], m11 = y[1], m12 = z[1], m20 = x[2], m21 = y[2], m22 = z[2];
  const tr = m00 + m11 + m22;
  let q;
  if (tr > 0) { const s = Math.sqrt(tr + 1) * 2; q = [(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, s / 4]; }
  else if (m00 > m11 && m00 > m22) { const s = Math.sqrt(1 + m00 - m11 - m22) * 2; q = [s / 4, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s]; }
  else if (m11 > m22) { const s = Math.sqrt(1 + m11 - m00 - m22) * 2; q = [(m01 + m10) / s, s / 4, (m12 + m21) / s, (m02 - m20) / s]; }
  else { const s = Math.sqrt(1 + m22 - m00 - m11) * 2; q = [(m02 + m20) / s, (m12 + m21) / s, s / 4, (m10 - m01) / s]; }
  return qnorm(q);
};
const qToMat = (q) => {
  const [x, y, z, w] = q;
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w),
    2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
    2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y),
  ];
};
/** Shortest arc rotating unit vector a onto unit vector b. */
const qShortestArc = (a, b) => {
  const d = vdot(a, b);
  if (d > 0.999999) return [0, 0, 0, 1];
  if (d < -0.999999) {
    let ax = vcross([1, 0, 0], a);
    if (vlen(ax) < 1e-6) ax = vcross([0, 0, 1], a);
    ax = vnorm(ax);
    return [ax[0], ax[1], ax[2], 0];
  }
  const ax = vcross(a, b);
  const s = Math.sqrt((1 + d) * 2), inv = 1 / s;
  return qnorm([ax[0] * inv, ax[1] * inv, ax[2] * inv, s * 0.5]);
};

/* ------------------------------------------------------ channel angles --- */

/** Channel set → local quaternion. Degrees; order qx(pitch)·qz(roll)·qy(twist). */
export function composeChannelsQ(c = {}) {
  let q = [0, 0, 0, 1];
  if (c.pitch) q = qmul(q, qAxisAngle([1, 0, 0], c.pitch));
  if (c.roll) q = qmul(q, qAxisAngle([0, 0, 1], c.roll));
  if (c.twist) q = qmul(q, qAxisAngle([0, 1, 0], c.twist));
  if (c.bend) q = qmul(q, qAxisAngle([1, 0, 0], c.bend));
  return q;
}

/** Inverse of composeChannelsQ — intrinsic X-Z-Y decomposition, degrees. */
export function decomposeQ(q) {
  const m = qToMat(qnorm(q));
  const sz = Math.min(1, Math.max(-1, -m[1]));
  const roll = Math.asin(sz);
  let pitch, twist;
  if (Math.abs(Math.cos(roll)) < 1e-6) { pitch = Math.atan2(-m[5], m[8]); twist = 0; }
  else { pitch = Math.atan2(m[7], m[4]); twist = Math.atan2(m[2], m[0]); }
  return { pitch: pitch * R2D, roll: roll * R2D, twist: twist * R2D };
}

/** Swing channels aiming the bone axis (+Y in joint frame) at unit dir v. */
export function swingForDir(v) {
  const roll = Math.asin(Math.min(1, Math.max(-1, -v[0])));
  const pitch = Math.atan2(v[2], v[1]);
  return { pitch: pitch * R2D, roll: roll * R2D };
}

/**
 * Joint-local rest frame (joints.json frames.convention): +Y along the bone
 * toward the child, +X = normalize(+Y × +Zworld), +Z completes the basis.
 * Returns the frame as a quaternion (basis columns x, y, z).
 */
export function frameQuat(boneDir) {
  const y = vnorm(boneDir);
  let hint = [0, 0, 1];
  if (Math.abs(vdot(y, hint)) > 0.999) hint = [1, 0, 0];
  const x = vnorm(vcross(y, hint));
  const z = vcross(x, y);
  return qBasis(x, y, z);
}

/* --------------------------------------------------------------- ids ----- */

/** fnv1a — stable stream ids: doc.seed ^ fnv1a(subject + ':' + layer). */
export function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

/** mulberry32 — same generator as motion.js/shared.js. */
export function mulberry32(seed) {
  let a = (seed >>> 0) || 1;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const isNum = (v) => Number.isFinite(v);
const isVec = (v, n) => Array.isArray(v) && v.length === n && v.every(isNum);

/** Typed diagnostic — the compiler never throws on a bad performance, it
    reports. severity 'error' blocks the verdict; 'warning' is reported with
    the clamp/degradation it caused. */
export function diag(code, severity, message, extra = {}) {
  return { code, severity, message, ...extra };
}

/* ----------------------------------------------------- bundle access ----- */

export function bundleRef(bundle) {
  const s = bundle?.schema || {};
  return s.bundleId && s.bundleVersion ? `${s.bundleId}@${s.bundleVersion}` : null;
}

export function packFor(bundle, packId) {
  return bundle?.performances?.packs?.[packId] || null;
}

export function presetFor(bundle, presetId) {
  return bundle?.proportions?.presets?.[presetId] || null;
}

/** Bundle integrity + internal consistency — shared by the Node loader
    (scripts/lib-craft.mjs) and the browser loader (craft.js), so a corrupted
    bundle reports the same diagnostics on either side. Callers own the
    part-presence findings; this checks what loaded. */
export function validateBundleContents(bundle) {
  const diags = [];
  const ref = bundleRef(bundle);
  if (!ref) diags.push(diag('craft/bundle-version', 'error', 'schema.json must declare bundleId + bundleVersion'));
  if (bundle.schema && bundle.schema.schemaVersion !== 1) {
    diags.push(diag('craft/bundle-version', 'error', `craft bundle schemaVersion ${bundle.schema.schemaVersion} is not supported by this checker (supports 1)`));
  }
  const packs = bundle.performances?.packs || {};
  for (const [pid, p] of Object.entries(packs)) {
    if (p.bundle !== ref) diags.push(diag('craft/bundle-version', 'error', `pack "${pid}" pins bundle "${p.bundle}" but the bundle identifies as "${ref}"`));
    if (p.preset && !bundle.proportions?.presets?.[p.preset]) diags.push(diag('craft/bundle-preset', 'error', `pack "${pid}" preset "${p.preset}" is not in proportions.json`));
    for (const v of p.variants || []) {
      if (!bundle.proportions?.presets?.[v]) diags.push(diag('craft/bundle-preset', 'error', `pack "${pid}" approves variant "${v}" which is not in proportions.json`));
    }
    for (const pose of p.performances || []) {
      if (!bundle.performances?.poseLibrary?.[pose]) diags.push(diag('craft/bundle-pose', 'error', `pack "${pid}" advertises pose "${pose}" which is not in the pose library`));
    }
    for (const l of p.lifeLayers || []) {
      if (!bundle.performances?.lifeLayers?.[l]) diags.push(diag('craft/bundle-life', 'error', `pack "${pid}" enables life layer "${l}" which is not defined`));
    }
  }
  // preset internal consistency (round22 §4): headM·headsTall == heightM and
  // skeleton y-values match their surface landmarks where both exist.
  for (const [pid, p] of Object.entries(bundle.proportions?.presets || {})) {
    if (Math.abs(p.headM * p.headsTall - p.heightM) > 0.002) {
      diags.push(diag('craft/preset-inconsistent', 'error', `preset "${pid}": headM(${p.headM}) × headsTall(${p.headsTall}) ≠ heightM(${p.heightM}) — landmarks and joint centres must be one model`));
    }
    const sole = p.surface?.sole === undefined ? null : landmarkM(p, p.surface.sole);
    if (sole !== null && Math.abs(sole - 0) > 0.003) {
      diags.push(diag('craft/preset-inconsistent', 'error', `preset "${pid}": surface.sole resolves to ${sole.toFixed(4)} m, not 0 — the skeleton must stand on the ground plane`));
    }
    const crownSkel = p.skeleton?.crown?.[1];
    if (crownSkel !== undefined && Math.abs(crownSkel - p.heightM) > 0.006) {
      diags.push(diag('craft/preset-inconsistent', 'error', `preset "${pid}": crown landmark at ${crownSkel} m but heightM is ${p.heightM}`));
    }
    // table→skeleton coverage: every template joint needs its attach landmark
    for (const [id, j] of jointTable(bundle)) {
      const name = j.attach;
      const ok = p.skeleton?.[name] || (name.endsWith('.R') && p.skeleton?.[name.replace(/\.R$/, '.L')]);
      if (!ok) diags.push(diag('craft/bundle-skeleton', 'error', `preset "${pid}" has no skeleton landmark "${name}" for joint "${id}"`));
    }
  }
  return diags;
}

/** Surface landmark (heads below crown) → metres above the sole. */
export function landmarkM(preset, headsBelowCrown) {
  return preset.heightM - headsBelowCrown * preset.headM;
}

/** Derived rest endpoints (round22 §4): fingertips come from wrist + hand
    length + the hanging rest pose — never an independently authored number. */
export function derivedLandmarks(preset) {
  const s = preset.skeleton;
  const handM = preset.widths.handLen * preset.headM;
  const footM = preset.widths.footLen * preset.headM;
  const out = {};
  for (const side of ['L', 'R']) {
    const w = s[`wrist.${side}`] || (side === 'R' ? mirrorPos(s['wrist.L']) : null);
    if (w) out[`fingertip.${side}`] = [w[0], w[1] - handM, w[2]];
    const b = s[`ball.${side}`] || (side === 'R' ? mirrorPos(s['ball.L']) : null);
    if (b) out[`toeTip.${side}`] = [b[0], 0, b[2] + footM * 0.5];
  }
  return out;
}

function mirrorPos(p) { return [-p[0], p[1], p[2]]; }

/**
 * Expand the joint template to a full table: L joints gain mirrored R twins.
 * Positions mirror across YZ; channel semantics stay numeric-identical —
 * the mirrored frame does the work (joints.json frames.mirror).
 * Returns Map jointId → {id, kind, parent, attach, child, side, channels,
 * limits, seam, pole} with .R entries where the template declares side:'L'.
 */
export function jointTable(bundle) {
  const src = bundle?.joints?.joints || {};
  const table = new Map();
  for (const [id, j] of Object.entries(src)) {
    table.set(id, { id, ...j });
    if (j.side === 'L') {
      const rid = id.replace(/\.L$/, '.R');
      table.set(rid, {
        ...j, id: rid, side: 'R',
        attach: j.attach.replace(/\.L$/, '.R'),
        child: typeof j.child === 'string' ? j.child.replace(/\.L$/, '.R') : j.child,
        parent: j.parent.replace(/\.L$/, '.R'),
        pivots: j.pivots ? Object.fromEntries(Object.entries(j.pivots).map(([k, v]) => [k, v.replace(/\.L$/, '.R')])) : j.pivots,
      });
    }
  }
  return table;
}

/** Chain table: joints.json authors .L chains; .R is the mirrored twin — same
    local pole dir because the frame is mirrored, not the numbers. */
export function chainsFor(bundle) {
  const src = bundle?.joints?.chains || {};
  const out = {};
  for (const [id, c] of Object.entries(src)) {
    out[id] = { id, ...c };
    if (id.endsWith('.L')) {
      const rid = id.replace(/\.L$/, '.R');
      out[rid] = {
        id: rid,
        root: c.root.replace(/\.L$/, '.R'), mid: c.mid.replace(/\.L$/, '.R'),
        end: c.end.replace(/\.L$/, '.R'),
        twist: c.twist ? c.twist.replace(/\.L$/, '.R') : c.twist,
        foot: c.foot ? c.foot.replace(/\.L$/, '.R') : c.foot,
        pole: c.pole ? c.pole.replace(/\.L$/, '.R') : c.pole,
      };
    }
  }
  return out;
}

/**
 * The skeleton as joint rest frames in canonical world space: for every joint
 * — world position (from the preset skeleton, mirrored for .R), the frame
 * quaternion, and the parent-relative rest transform the rig uses.
 * opts.jointOffsets shifts a joint centre (audited, non-certified — the
 * checker measures the deviation it introduces).
 */
export function skeletonOf(bundle, presetId, { jointOffsets = {} } = {}) {
  const preset = presetFor(bundle, presetId);
  if (!preset) return null;
  const table = jointTable(bundle);
  const skel = preset.skeleton;

  // A joint's `attach`/`child` may name a skeleton landmark that is not itself
  // a joint (head → crown, ankle → ball.L) — resolve both tables, mirrored.
  const landmarkPos = (name) => {
    if (!name) return null;
    let p = skel[name];
    if (p) return [...p];
    if (name.endsWith('.R')) { const l = skel[name.replace(/\.R$/, '.L')]; return l ? mirrorPos(l) : null; }
    return null;
  };

  const worldPos = new Map();
  for (const [id, j] of table) {
    let p = landmarkPos(j.attach);
    if (!p) return null; // a template joint with no landmark is a bundle defect
    const off = jointOffsets[id];
    if (off) p = vadd(p, off);
    worldPos.set(id, p);
  }

  // Rest frames: +Y toward the declared child (joint or landmark); childless
  // joints (wrist) keep their parent's direction — a hand continues the line.
  const worldQuat = new Map();
  for (const [id, j] of table) {
    let dir;
    const childP = (j.child && (worldPos.get(j.child) || landmarkPos(j.child))) || null;
    if (childP) dir = vsub(childP, worldPos.get(id));
    else if (j.parent) dir = qrot(worldQuat.get(j.parent) || [0, 0, 0, 1], [0, 1, 0]);
    else dir = [0, 1, 0];
    if (vlen(dir) < 1e-9) dir = [0, 1, 0];
    worldQuat.set(id, frameQuat(dir));
  }

  const out = new Map();
  for (const [id, j] of table) {
    const parentQ = j.parent ? worldQuat.get(j.parent) : [0, 0, 0, 1];
    const parentP = j.parent ? worldPos.get(j.parent) : [0, 0, 0];
    const restLocalQuat = qmul(qconj(parentQ), worldQuat.get(id));
    const restLocalPos = qrot(qconj(parentQ), vsub(worldPos.get(id), parentP));
    out.set(id, {
      id, kind: j.kind, side: j.side || null,
      parent: j.parent, child: j.child, attach: j.attach,
      channels: j.channels || [], limits: j.limits || null, seam: j.seam || null,
      pole: j.pole || null, pivots: j.pivots || null,
      worldPos: worldPos.get(id), worldQuat: worldQuat.get(id),
      restLocalPos, restLocalQuat,
    });
  }
  return out;
}

/** Forward kinematics: rest skeleton + channel map → {pos, quat} per joint.
    channels: {jointId: {pitch?, roll?, twist?, bend?, position?:[x,y,z]}} —
    position is honoured only where the template allows a position channel. */
export function fkWorld(skeleton, channels = {}) {
  const order = topoOrder(skeleton);
  const out = new Map();
  for (const id of order) {
    const j = skeleton.get(id);
    const c = channels[id] || {};
    const cq = composeChannelsQ(c);
    const parent = j.parent ? out.get(j.parent) : { pos: [0, 0, 0], quat: [0, 0, 0, 1] };
    const localPos = c.position && j.channels.includes('position')
      ? vadd(j.restLocalPos, c.position)
      : j.restLocalPos;
    out.set(id, {
      pos: vadd(parent.pos, qrot(parent.quat, localPos)),
      quat: qmul(parent.quat, qmul(j.restLocalQuat, cq)),
    });
  }
  return out;
}

function topoOrder(skeleton) {
  const out = [];
  const seen = new Set();
  const visit = (id) => {
    if (seen.has(id)) return;
    const j = skeleton.get(id);
    if (!j) return;
    if (j.parent) visit(j.parent);
    seen.add(id);
    out.push(id);
  };
  for (const id of skeleton.keys()) visit(id);
  return out;
}

/**
 * The contact patch under a foot (round22 §6): a sole rectangle — heel→toe
 * across, ±0.24·footLen wide — authored in rest world space at y=0 and
 * returned in the ankle joint's local frame. craft.js glues the same corners
 * onto the ankle pivot, so the patch the checker measures is the patch the
 * baker locked.
 */
export function footPatchLocal(skeleton, preset, side) {
  const ankle = skeleton.get(`ankle.${side}`);
  if (!ankle) return null;
  const skel = preset.skeleton;
  const lm = (n) => skel[`${n}.${side}`] || mirrorPos(skel[`${n}.L`]);
  const heel = lm('heel'), toe = lm('toe');
  if (!heel || !toe) return null;
  const xw = preset.widths.footLen * preset.headM * 0.24;
  const x0 = ankle.worldPos[0];
  const inv = qconj(ankle.worldQuat);
  return [[x0 - xw, 0, heel[2]], [x0 + xw, 0, heel[2]], [x0 - xw, 0, toe[2]], [x0 + xw, 0, toe[2]]]
    .map((p) => qrot(inv, vsub(p, ankle.worldPos)));
}
export const patchCentroid = (corners) => vscale(corners.reduce(vadd, [0, 0, 0]), 1 / corners.length);

/* ------------------------------------------------------------- solving --- */

/**
 * Analytic two-bone solve: root fixed, end should land on target, mid bend
 * placed by the pole direction (world space, already mapped from the
 * preset-local pole frame by the caller). Too-far AND too-close are
 * unreachable — a typed diagnostic with the residual, never a clamp.
 * Returns { ok, mid, midDir, endDir, flexionDeg, diagnostic?, poleFallback? }.
 */
export function solveTwoBone({ root, lengths, target, poleDir, tolerance = 1e-4 } = {}) {
  const [l1, l2] = lengths;
  const toT = vsub(target, root);
  const d = vlen(toT);
  const reach = l1 + l2;
  const fold = Math.abs(l1 - l2);
  if (d > reach + tolerance) {
    return { ok: false, diagnostic: diag('craft/target-unreachable', 'error',
      `target is ${(d - reach).toFixed(4)} m beyond the chain's reach (${d.toFixed(4)} > ${l1}+${l2})`, { residual: d - reach }) };
  }
  if (d < fold - tolerance) {
    return { ok: false, diagnostic: diag('craft/target-unreachable', 'error',
      `target is ${(fold - d).toFixed(4)} m inside the chain's minimum fold (${d.toFixed(4)} < |${l1}−${l2}|)`, { residual: fold - d }) };
  }
  const dir = vnorm(toT);
  let p = vsub(poleDir, vscale(dir, vdot(poleDir, dir)));
  let poleFallback = false;
  if (vlen(p) < 1e-9) {
    // Pole ∥ target direction is singular — fall back to the rest bend plane
    // (any vector orthogonal to dir), and report it rather than flipping.
    poleFallback = true;
    p = Math.abs(dir[1]) < 0.9 ? vcross(dir, [0, 1, 0]) : vcross(dir, [1, 0, 0]);
    p = vnorm(p);
  } else {
    p = vnorm(p);
  }
  const cosA = Math.min(1, Math.max(-1, (l1 * l1 + d * d - l2 * l2) / (2 * l1 * Math.max(d, 1e-9))));
  const alpha = Math.acos(cosA);
  const midDir = vnorm(vadd(vscale(dir, Math.cos(alpha)), vscale(p, Math.sin(alpha))));
  const mid = vadd(root, vscale(midDir, l1));
  const endDir = vnorm(vsub(target, mid));
  const cosB = Math.min(1, Math.max(-1, (l1 * l1 + l2 * l2 - d * d) / (2 * l1 * l2)));
  const flexionDeg = (Math.PI - Math.acos(cosB)) * R2D;
  return { ok: true, mid, midDir, endDir, flexionDeg, poleFallback };
}

/**
 * Chain solve → channel map, in the joints' own frames.
 *   skeleton — skeletonOf() output
 *   poseChannels — channels already active (parent poses affect the frame the
 *     solve is expressed in); the solve composes on top of them
 *   chain — {root, mid, end, endKeep?} where endKeep: 'world-quat' quat the end
 *     joint should keep (foot stays flat), else null
 *   target — world-space [x,y,z]
 * Returns { ok, channels:{root:{pitch,roll}, mid:{bend}, end?:{pitch,roll,twist}}, midPos, diagnostic? }.
 */
export function solveChainChannels(skeleton, poseChannels, chain, target, { tolerance = 1e-4 } = {}) {
  const base = fkWorld(skeleton, poseChannels);
  const root = skeleton.get(chain.root);
  const poleJ = skeleton.get(chain.mid)?.pole;
  const poleWorld = poleJ ? qrot(base.get(chain.root).quat, poleJ.dir) : [0, 0, 1];
  const l1 = vlen(vsub(root.worldPos, skeleton.get(chain.mid).worldPos));
  const l2 = vlen(vsub(skeleton.get(chain.mid).worldPos, skeleton.get(chain.end).worldPos));
  const solved = solveTwoBone({ root: base.get(chain.root).pos, lengths: [l1, l2], target, poleDir: poleWorld, tolerance });
  if (!solved.ok) return { ok: false, diagnostic: solved.diagnostic };

  const channels = {};
  // Root swing: aim rest bone dir at the solved mid direction, expressed in
  // the frame the parent's current pose leaves behind (the pivot's channel
  // space — strip the root's own previous channel off the evaluated quat).
  const rootRestQ = qmul(base.get(chain.root).quat, qconj(composeChannelsQ(poseChannels[chain.root] || {})));
  const dirLocal = qrot(qconj(rootRestQ), solved.midDir);
  const swing = swingForDir(dirLocal);
  channels[chain.root] = { ...(poseChannels[chain.root] || {}), pitch: swing.pitch, roll: swing.roll };
  // Recompute world with the new root channel so the mid frame is honest.
  const withRoot = fkWorld(skeleton, { ...poseChannels, [chain.root]: channels[chain.root] });
  const midFrameQ = withRoot.get(chain.mid).quat;
  const midRestQ = qmul(midFrameQ, qconj(composeChannelsQ(poseChannels[chain.mid] || {}))); // mid frame sans its own channel
  const endDirLocal = qrot(qconj(midRestQ), solved.endDir);
  const bend = Math.atan2(endDirLocal[2], endDirLocal[1]) * R2D;
  channels[chain.mid] = { ...(poseChannels[chain.mid] || {}), bend };

  // End joint keeps a declared world orientation (planted foot stays flat).
  if (chain.endKeep) {
    const withMid = fkWorld(skeleton, { ...poseChannels, [chain.root]: channels[chain.root], [chain.mid]: channels[chain.mid] });
    const endJ = skeleton.get(chain.end);
    const A = qmul(withMid.get(chain.end).quat, qconj(composeChannelsQ(poseChannels[chain.end] || {})));
    // Joints with a twist channel can hold the full quat exactly; swing-only
    // joints take the minimal-twist correction — the residual twist stays in
    // the measured orientation error rather than being silently dropped.
    const allowed = endJ.channels;
    const need = allowed.includes('twist')
      ? qmul(qconj(A), chain.endKeep)
      : qmul(qconj(A), qmul(qShortestArc(qrot(A, [0, 1, 0]), qrot(chain.endKeep, [0, 1, 0])), A));
    const dec = decomposeQ(need);
    const endCh = { ...(poseChannels[chain.end] || {}) };
    if (allowed.includes('swing')) { endCh.pitch = dec.pitch; endCh.roll = dec.roll; }
    if (allowed.includes('twist')) endCh.twist = dec.twist;
    channels[chain.end] = endCh;
  }
  return { ok: true, channels, midPos: solved.mid, poleFallback: solved.poleFallback };
}

/* -------------------------------------------------------------- limits --- */

/** Channels vs the joint's declared ranges → violations [{channel, value, range}]. */
export function limitViolations(joint, channels) {
  const out = [];
  if (!joint.limits) return out;
  for (const [ch, range] of Object.entries(joint.limits)) {
    const v = channels?.[ch];
    if (!isNum(v)) continue;
    if (v < range[0] - 1e-6 || v > range[1] + 1e-6) {
      out.push({ channel: ch, value: v, range });
    }
  }
  return out;
}

/** Combined rules (joints.json `combined`): summed channels across a joint
    group must stay inside the declared envelope — individually legal channels
    can still compose into an implausible pose. */
export function combinedViolations(rules, channelMap) {
  const out = [];
  for (const rule of rules || []) {
    if (rule.rule !== 'sum') continue;
    for (const [ch, range] of Object.entries(rule.limits || {})) {
      const sum = rule.joints.reduce((s, id) => s + (channelMap[id]?.[ch] || 0), 0);
      if (sum < range[0] - 1e-6 || sum > range[1] + 1e-6) {
        out.push({ rule: rule.id, channel: ch, value: sum, range });
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------ contacts --- */

/** Pack contact tolerance in metres: relative × heightM, floored (§6). */
export function contactToleranceM(bundle, pack, preset) {
  const t = bundle?.performances?.contactPolicy?.tolerance || { relative: 0.0006, floorM: 0.0002 };
  return Math.max(t.relative * (preset?.heightM ?? 1.7), t.floorM);
}

/** Signed separation + tangential slip for one patch observation. */
export function contactCheck({ patchMinY, groundY, driftXZ = 0, toleranceM }) {
  const separation = patchMinY - groundY;
  const findings = [];
  if (Math.abs(separation) > toleranceM) {
    findings.push(diag('craft/contact-separation', 'error',
      `planted patch sits ${separation >= 0 ? '+' : ''}${separation.toFixed(4)} m off the declared plane (tolerance ${toleranceM.toFixed(4)})`,
      { separation, tolerance: toleranceM }));
  }
  if (driftXZ > toleranceM) {
    findings.push(diag('craft/contact-slip', 'error',
      `planted patch drifted ${driftXZ.toFixed(4)} m tangentially while locked (tolerance ${toleranceM.toFixed(4)})`,
      { slip: driftXZ, tolerance: toleranceM }));
  }
  return { ok: findings.length === 0, separation, slip: driftXZ, findings };
}

/** Centre-of-mass projection vs the support polygon (§6) — only for declared
    static unsupported poses with a usable mass estimate; anything else is
    unverified, never a fabricated pass. Returns null when undecidable. */
export function supportCheck(comXZ, polygonXZ, { toleranceM = 0 } = {}) {
  if (!isVec(comXZ, 2) || !Array.isArray(polygonXZ) || polygonXZ.length < 3) return null;
  let minD = Infinity;
  for (let i = 0; i < polygonXZ.length; i++) {
    const a = polygonXZ[i], b = polygonXZ[(i + 1) % polygonXZ.length];
    const e = [b[0] - a[0], b[1] - a[1]];
    const u = Math.min(1, Math.max(0, ((comXZ[0] - a[0]) * e[0] + (comXZ[1] - a[1]) * e[1]) / (vdot(e, e) || 1e-12)));
    const px = a[0] + e[0] * u - comXZ[0], pz = a[1] + e[1] * u - comXZ[1];
    minD = Math.min(minD, Math.hypot(px, pz));
  }
  // winding-agnostic inside test
  let inside = false;
  for (let i = 0, j = polygonXZ.length - 1; i < polygonXZ.length; j = i++) {
    const [xi, zi] = polygonXZ[i], [xj, zj] = polygonXZ[j];
    if ((zi > comXZ[1]) !== (zj > comXZ[1]) && comXZ[0] < ((xj - xi) * (comXZ[1] - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return { ok: inside || minD <= toleranceM, inside, margin: inside ? minD : -minD };
}

/* -------------------------------------------------------------- seams ---- */

/**
 * Loop-seam comparison (§7): position, orientation (quaternion-sign-aware),
 * linear and angular velocity at the wrap point. A travelling loop declares
 * rootDelta — the world root is not expected to return to its start.
 * a, b: {position, quaternion, linearVel, angularVelDps} measured at the
 * seam's two sides; returns {ok, worst, channels:{…residuals}}.
 */
export function loopSeamCheck(a, b, { tolerances = {}, rootDelta = null } = {}) {
  const tol = {
    positionM: tolerances.positionM ?? 0.001,
    angleDeg: tolerances.angleDeg ?? 0.5,
    linearVelMps: tolerances.linearVelMps ?? 0.01,
    angularVelDps: tolerances.angularVelDps ?? 2.0,
  };
  // rootDelta is the declared root travel over one loop: wrap the END state
  // back into the start's frame (b − Δ) rather than pushing a forward — a
  // travelling loop's end is start + Δ.
  const posB = rootDelta ? vsub(b.position, rootDelta) : b.position;
  const position = vlen(vsub(a.position, posB));
  const dot = Math.min(1, Math.abs(qdot(qnorm(a.quaternion), qnorm(b.quaternion))));
  const orientation = 2 * Math.acos(dot) * R2D;
  const linearVel = vlen(vsub(a.linearVel, b.linearVel));
  const angularVel = vlen(vsub(a.angularVelDps, b.angularVelDps));
  const channels = { position, orientation, linearVel, angularVel };
  const worst = position > tol.positionM ? 'position'
    : orientation > tol.angleDeg ? 'orientation'
    : linearVel > tol.linearVelMps ? 'linearVel'
    : angularVel > tol.angularVelDps ? 'angularVel' : null;
  return { ok: !worst, worst, channels, tolerances: tol };
}

/* ------------------------------------------------------------ easings ---- */

const EASINGS = {
  linear: (u) => u,
  hold: () => 1,
  out_cubic: (u) => 1 - Math.pow(1 - u, 3),
  in_out_cubic: (u) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2),
};
export const EASING_NAMES = Object.keys(EASINGS);

/* ------------------------------------------------- document validation --- */

// Fields a performance event may carry — the compiler owns everything else.
// Raw joint transforms have no field name at all: anything that looks like
// one is reported as forbidden, not merely unknown (round22 §2, §7).
const EVENT_KEYS = new Set(['pose', 'at', 'target', 'ik_target', 'chain', 'note']);
const FORBIDDEN_KEY = /rotation|quaternion|euler|degrees|radians|matrix|channel|joint|bone|position|scale|translat|orient/i;
const TOP_KEYS = new Set(['schemaVersion', 'craftPack', 'bundle', 'seed', 'fps', 'subject',
  'construction', 'environment', 'contacts', 'performance', 'duration', 'delivery', 'support', 'note']);

const CHANNEL_SETS = {
  rest: (table) => [...table.keys()],
  hold: (table) => [...table.keys()],
  gaze: () => ['neck', 'head'],
  ik: (table, chainId, joints) => {
    const ch = joints.chains?.[chainId];
    if (!ch) return [];
    return [ch.root, ch.mid, ch.end, ch.twist].filter(Boolean);
  },
  seat: (table) => ['pelvis', 'hip.L', 'knee.L', 'ankle.L', 'foot.L', 'hip.R', 'knee.R', 'ankle.R', 'foot.R'],
};

/**
 * Validate a semantic performance document against the bundle. Returns
 * { diagnostics, doc } — diagnostics carry codes the checker turns into
 * findings; a doc with error diagnostics must not be compiled for real.
 */
export function validatePerformanceDoc(bundle, doc) {
  const diagnostics = [];
  const d = (code, severity, message, extra) => diagnostics.push(diag(code, severity, message, extra));
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    d('craft/doc-shape', 'error', 'craft document must be a JSON object');
    return { diagnostics, doc: null };
  }
  for (const k of Object.keys(doc)) {
    if (!TOP_KEYS.has(k)) d('craft/unknown-field', 'error', `top-level field "${k}" is not part of the craft contract`, { field: k });
  }
  if (doc.schemaVersion !== CRAFT_DOC_VERSION) {
    d('craft/doc-version', 'error', `schemaVersion must be ${CRAFT_DOC_VERSION} (got ${JSON.stringify(doc.schemaVersion)})`, { field: 'schemaVersion' });
  }
  const ref = bundleRef(bundle);
  if (doc.bundle !== undefined && doc.bundle !== ref) {
    d('craft/bundle-version', 'error', `document pins bundle "${doc.bundle}" but the loaded bundle is "${ref}" — unknown versions fail before compilation`, { field: 'bundle', expected: ref });
  }
  const pack = packFor(bundle, doc.craftPack);
  if (!doc.craftPack || typeof doc.craftPack !== 'string') {
    d('craft/unknown-pack', 'error', 'craftPack is required and must name a pack in the bundle', { field: 'craftPack' });
  } else if (!pack) {
    d('craft/unknown-pack', 'error', `craftPack "${doc.craftPack}" is not advertised by bundle ${ref} — known: ${Object.keys(bundle?.performances?.packs || {}).join(', ') || 'none'}`,
      { field: 'craftPack' });
  } else if (pack.bundle !== ref) {
    d('craft/bundle-version', 'error', `pack "${doc.craftPack}" requires bundle "${pack.bundle}" but ${ref} is loaded`, { field: 'craftPack', expected: pack.bundle });
  }
  if (typeof doc.subject !== 'string' || !doc.subject.trim()) {
    d('craft/subject', 'error', 'subject is required — it is the stable id random streams derive from', { field: 'subject' });
  }
  if (!Number.isInteger(doc.seed)) {
    d('craft/seed', 'error', 'seed is required (integer) — determinism is contractual: input + seed + bundle hash + adapter version fixes the output', { field: 'seed' });
  }
  if (!isNum(doc.fps) || doc.fps <= 0 || doc.fps > 240) {
    d('craft/fps', 'error', `fps must be a positive number ≤ 240 (got ${JSON.stringify(doc.fps)})`, { field: 'fps' });
  }
  const fps = isNum(doc.fps) ? doc.fps : 24;
  const dur = doc.duration || {};
  let frames = null;
  if (isNum(dur.frames)) frames = Math.round(dur.frames);
  else if (isNum(dur.seconds)) frames = Math.round(dur.seconds * fps);
  if (frames === null || !Number.isInteger(frames) || frames <= 0) {
    d('craft/duration', 'error', 'duration.frames (integer > 0) or duration.seconds is required — the take length is explicit in the production contract', { field: 'duration' });
    frames = frames || 0;
  }
  if (dur.preRoll !== undefined && (!Number.isInteger(dur.preRoll) || dur.preRoll < 0)) {
    d('craft/duration', 'error', 'duration.preRoll must be a non-negative integer frame count', { field: 'duration.preRoll' });
  }

  // construction
  const con = doc.construction || {};
  if (con.level !== undefined && !CONSTRUCTION_LEVELS.includes(con.level)) {
    d('craft/level-unsupported', 'error', `construction.level "${con.level}" is not a supported level (${CONSTRUCTION_LEVELS.join(', ')})`, { field: 'construction.level' });
  }
  if (pack && con.level && !pack.levels.includes(con.level)) {
    d('craft/level-unsupported', 'error', `pack "${doc.craftPack}" supports ${pack.levels.join(', ')} — level "${con.level}" needs a different pack or an authored rig`,
      { field: 'construction.level' });
  }
  const preset = pack ? presetFor(bundle, con.variant || pack.preset) : null;
  if (pack && con.variant !== undefined && !pack.variants.includes(con.variant)) {
    d('craft/variant', 'error', `variant "${con.variant}" is not approved by pack "${doc.craftPack}" (${pack.variants.join(', ')}) — characters cannot invent a proportion family`, { field: 'construction.variant' });
  }
  if (pack && !preset) {
    d('craft/variant', 'error', `pack "${doc.craftPack}" preset "${con.variant || pack.preset}" is not in proportions.json`, { field: 'construction.variant' });
  }
  const jointOffsets = con.jointOffsets || {};
  if (con.jointOffsets !== undefined) {
    if (typeof con.jointOffsets !== 'object' || con.jointOffsets === null) {
      d('craft/joint-offsets', 'error', 'construction.jointOffsets must be a map jointId → [x,y,z]', { field: 'construction.jointOffsets' });
    } else {
      for (const [j, v] of Object.entries(jointOffsets)) {
        if (!isVec(v, 3)) d('craft/joint-offsets', 'error', `jointOffsets.${j} must be [x,y,z] metres`, { field: `construction.jointOffsets.${j}` });
      }
      if (Object.keys(jointOffsets).length) {
        d('craft/uncertified-offsets', 'warning',
          `jointOffsets moves ${Object.keys(jointOffsets).join(', ')} off the preset skeleton — measured by craft/pivot-deviation; the certified route authors no joint centres`,
          { field: 'construction.jointOffsets', joints: Object.keys(jointOffsets) });
      }
    }
  }
  if (con.placement !== undefined) {
    const p = con.placement;
    if (typeof p !== 'object' || p === null || (p.position !== undefined && !isVec(p.position, 3)) || (p.yawDeg !== undefined && !isNum(p.yawDeg))) {
      d('craft/placement', 'error', 'construction.placement must be {position:[x,y,z]?, yawDeg?}', { field: 'construction.placement' });
    }
  }
  if (con.jointCovers !== undefined) {
    if (typeof con.jointCovers !== 'object' || con.jointCovers === null) {
      d('craft/cover-shape', 'error', 'construction.jointCovers must be a map jointId → {kind, R?, cap?}', { field: 'construction.jointCovers' });
    } else {
      for (const [jid, cov] of Object.entries(con.jointCovers)) {
        if (!cov || typeof cov !== 'object' || !['ballJoint', 'peg', 'none'].includes(cov.kind)) {
          d('craft/cover-shape', 'error', `jointCovers.${jid}.kind must be ballJoint | peg | none`, { field: `construction.jointCovers.${jid}` });
        } else if (cov.kind === 'ballJoint' && cov.R !== undefined && (!isNum(cov.R) || cov.R <= 0)) {
          d('craft/cover-shape', 'error', `jointCovers.${jid}.R must be a positive ball radius in metres`, { field: `construction.jointCovers.${jid}.R` });
        }
      }
    }
  }

  // environment
  const env = doc.environment || {};
  const targets = env.targets || {};
  if (env.targets !== undefined && (typeof env.targets !== 'object' || env.targets === null)) {
    d('craft/target-shape', 'error', 'environment.targets must be a map id → {position:[x,y,z], orientation?}', { field: 'environment.targets' });
  }
  for (const [tid, t] of Object.entries(targets)) {
    if (!t || typeof t !== 'object' || !isVec(t.position, 3)) {
      d('craft/target-shape', 'error', `target "${tid}" must carry a world-space position [x,y,z] — targets identify affordances, not object centres`, { field: `environment.targets.${tid}` });
    }
  }
  const groundPlane = isNum(env.groundPlane) ? env.groundPlane : 0;

  // contacts
  const table = jointTable(bundle);
  const contacts = Array.isArray(doc.contacts) ? doc.contacts : [];
  if (doc.contacts !== undefined && !Array.isArray(doc.contacts)) {
    d('craft/contact-shape', 'error', 'contacts must be an array of {id, joint, kind, interval:[f0,f1]}', { field: 'contacts' });
  }
  contacts.forEach((c, i) => {
    const at = `contacts[${i}]`;
    if (!c || typeof c !== 'object') return d('craft/contact-shape', 'error', `${at} must be an object`, { field: at });
    if (typeof c.id !== 'string' || !c.id) d('craft/contact-shape', 'error', `${at}.id is required`, { field: `${at}.id` });
    if (!table.has(c.joint)) d('craft/contact-joint', 'error', `${at}.joint "${c.joint}" is not a joint in the template`, { field: `${at}.joint` });
    if (!['foot', 'seat', 'hand'].includes(c.kind)) d('craft/contact-kind', 'error', `${at}.kind must be foot | seat | hand`, { field: `${at}.kind` });
    if (c.kind === 'seat' && (typeof c.target !== 'string' || !targets[c.target])) {
      d('craft/target-missing', 'error', `${at} kind "seat" needs target naming the seat affordance in environment.targets${typeof c.target === 'string' ? ` — "${c.target}" is not declared` : ''}`, { field: `${at}.target` });
    }
    if (!isVec(c.interval, 2) || c.interval[0] < 0 || c.interval[1] <= c.interval[0] || (frames && c.interval[1] > frames)) {
      d('craft/contact-interval', 'error', `${at}.interval must be [startFrame, endFrame] inside 0..${frames}`, { field: `${at}.interval` });
    }
  });

  // performance events
  const events = Array.isArray(doc.performance) ? doc.performance : [];
  if (!Array.isArray(doc.performance) || !doc.performance.length) {
    d('craft/performance', 'error', 'performance must be a non-empty array of events {pose, at, target?|ik_target?}', { field: 'performance' });
  }
  const lib = bundle?.performances?.poseLibrary || {};
  const joints = bundle?.joints || {};
  const seen = [];
  events.forEach((e, i) => {
    const at = `performance[${i}]`;
    if (!e || typeof e !== 'object') return d('craft/event-shape', 'error', `${at} must be an object`, { field: at });
    for (const k of Object.keys(e)) {
      if (!EVENT_KEYS.has(k)) {
        const forbidden = FORBIDDEN_KEY.test(k);
        d(forbidden ? 'craft/forbidden-field' : 'craft/unknown-field', 'error',
          forbidden
            ? `${at}.${k} authors raw joint data — the contract is semantic (pose + target); the compiler owns joint channels`
            : `${at}.${k} is not part of the performance vocabulary (${[...EVENT_KEYS].join(', ')})`,
          { field: `${at}.${k}` });
      }
    }
    const pose = lib[e.pose];
    if (!pose) {
      d('craft/unknown-pose', 'error',
        `pose "${e.pose}" is not in the pose library — and is not advertised by pack "${doc.craftPack}" (${(pack?.performances || []).join(', ') || 'none'}). Locomotion is deliberately unadvertised: route walks/runs to a reviewed rigged asset`,
        { field: `${at}.pose` });
      return;
    }
    if (pack && !pack.performances.includes(e.pose)) {
      d('craft/unknown-pose', 'error', `pack "${doc.craftPack}" does not advertise pose "${e.pose}" (supports: ${pack.performances.join(', ')})`, { field: `${at}.pose` });
    }
    if (!Number.isInteger(e.at) || e.at < 0 || (frames && e.at >= frames)) {
      d('craft/event-at', 'error', `${at}.at must be an integer frame inside 0..${frames - 1}`, { field: `${at}.at` });
    }
    if (pose.requires === 'target' && (typeof e.target !== 'string' || !targets[e.target])) {
      d('craft/target-missing', 'error', `${at} pose "${e.pose}" needs target naming an environment.targets entry${typeof e.target === 'string' ? ` — "${e.target}" is not declared` : ''}`, { field: `${at}.target` });
    }
    if (pose.requires === 'ik_target' && (typeof e.ik_target !== 'string' || !targets[e.ik_target])) {
      d('craft/target-missing', 'error', `${at} pose "${e.pose}" needs ik_target naming an environment.targets entry${typeof e.ik_target === 'string' ? ` — "${e.ik_target}" is not declared` : ''}`, { field: `${at}.ik_target` });
    }
    if (e.chain !== undefined) {
      const chains = chainsFor(bundle);
      const allowed = pose.chains ? Object.keys(pose.chains) : (pose.chain ? [pose.chain] : []);
      if (!chains[e.chain] || !allowed.includes(e.chain)) {
        d('craft/chain', 'error', `${at}.chain "${e.chain}" is not a chain pose "${e.pose}" offers (${allowed.join(', ') || 'none'})`, { field: `${at}.chain` });
      }
    }
    // conflicts: same onset frame + intersecting channel sets
    const chSet = new Set((CHANNEL_SETS[pose.kind] || (() => []))(table, e.chain || pose.chain, joints));
    for (const prev of seen) {
      if (prev.at === e.at && [...chSet].some((j) => prev.channels.has(j))) {
        d('craft/event-conflict', 'error',
          `${at} pose "${e.pose}" and "${prev.pose}" share frame ${e.at} and channels — the recipe owns transitions; two onsets cannot own the same joint at the same frame`,
          { field: `${at}.at`, frame: e.at, joints: [...chSet].filter((j) => prev.channels.has(j)) });
      }
    }
    seen.push({ at: e.at, pose: e.pose, channels: chSet });
  });

  return {
    diagnostics,
    doc: diagnostics.some((x) => x.severity === 'error') ? null : {
      doc, pack, preset, fps, frames, loop: dur.loop === true, preRoll: dur.preRoll || 0,
      groundPlane, targets, contacts, jointOffsets, level: con.level || pack?.levels?.[pack.levels.length - 1],
      placement: con.placement || {}, jointCovers: con.jointCovers || {},
      support: doc.support || null, delivery: doc.delivery || {},
    },
  };
}

/* ---------------------------------------------------------- compilation --- */

/**
 * Compile a validated document into an evaluated schedule (round22 §7 order):
 *   validate → expand poses to rest-relative channel targets → solve
 *   constraints (IK, seat, contact locks) → bake per-frame corrections for
 *   contact-locked chains → compile life layers once (blink events, sway
 *   bakes) → the result is sampled/linted downstream.
 * Evaluation is a pure function of t over the compiled data: segment lookup is
 * a binary search, blink events are precompiled, leg corrections are baked —
 * no seek resimulates from t=0.
 */
export function compilePerformance(bundle, doc) {
  const { diagnostics, doc: norm } = validatePerformanceDoc(bundle, doc);
  if (!norm) return { ok: false, diagnostics, schedule: null };
  const { pack, preset, fps, frames, loop, targets, contacts, jointOffsets, placement, support } = norm;
  const jointsData = bundle.joints;
  const skeleton = skeletonOf(bundle, preset.id, { jointOffsets });
  const lib = bundle.performances.poseLibrary;
  const easing = bundle.performances.easing || {};

  // --- placement transform (world-space targets/contacts meet it) ----------
  const placePos = placement.position || [0, 0, 0];
  const placeYawQ = qAxisAngle([0, 1, 0], placement.yawDeg || 0);
  const toWorld = (p) => vadd(qrot(placeYawQ, p), placePos);

  const skeletonW = new Map();
  for (const [id, j] of skeleton) {
    skeletonW.set(id, { ...j, worldPos: toWorld(j.worldPos), worldQuat: qmul(placeYawQ, j.worldQuat) });
  }

  // --- expand events to steady channel targets -------------------------------
  const sorted = [...doc.performance].map((e, i) => ({ ...e, order: i })).sort((a, b) => a.at - b.at || a.order - b.order);
  const segments = [];
  const restChannels = {};
  for (const id of skeleton.keys()) restChannels[id] = {};

  // Blended pose channels at time t over `segments` — THE canonical
  // evaluation of the event list (used for each segment's onset state, by
  // the contact baker and by evaluateSchedule, so a baked leg solve always
  // sees the same pelvis position the runtime will produce).
  // Transition easing is followed by the pose's settle overshoot: a decaying
  // sine bump in the [t0+trans, t0+trans+settle) window, per channel, on the
  // channel delta — the motion grammar's named vocabulary, not an ad-hoc
  // wobble (round22 §7).
  const blendAt = (t) => {
    let idx = -1;
    for (let i = 0; i < segments.length; i++) if (segments[i].t0 <= t) idx = i;
    if (idx < 0) return { ...restChannels };
    const seg = segments[idx];
    const u = seg.transS > 0 ? Math.min(1, (t - seg.t0) / seg.transS) : 1;
    const w = EASINGS[seg.easing](Math.max(0, u));
    const su = seg.settleS > 0 ? (t - seg.t0 - seg.transS) / seg.settleS : 1;
    const over = (su > 0 && su < 1) ? seg.overshoot * Math.sin(Math.PI * su) * (1 - su) : 0;
    const out = {};
    const keys = new Set([...Object.keys(seg.prevSteady), ...Object.keys(seg.steady)]);
    for (const k of keys) {
      const a = seg.prevSteady[k] || {}, b = seg.steady[k] || {};
      const c = {};
      for (const ch of new Set([...Object.keys(a), ...Object.keys(b)])) {
        if (ch === 'position') {
          const av = a.position || [0, 0, 0], bv = b.position || [0, 0, 0];
          const base = vlerp(av, bv, w);
          c.position = over ? vadd(base, vscale(vsub(bv, av), over)) : base;
        } else {
          const delta = (b[ch] || 0) - (a[ch] || 0);
          c[ch] = (a[ch] || 0) + delta * (w + over);
        }
      }
      out[k] = c;
    }
    return out;
  };
  const steadyAt = blendAt; // kept as an internal alias: the baker calls it

  const poseChannels = (e) => {
    const pose = lib[e.pose];
    switch (pose.kind) {
      case 'rest': return { ...restChannels };
      case 'hold': return null; // inherits previous steady channels
      case 'gaze': {
        const t = targets[e.target];
        const headW = skeletonW.get('head').worldPos;
        // Targets are world-space; neck/head twists are rig-local. Remove
        // the placement yaw or a rotated character looks the wrong way.
        const dvec = qrot(qconj(placeYawQ), vsub(t.position, headW));
        const dist = vlen(dvec);
        const yawDeg = Math.atan2(dvec[0], dvec[2]) * R2D;
        const pitchDeg = -Math.atan2(dvec[1], Math.hypot(dvec[0], dvec[2])) * R2D;
        const share = pose.joints || { neck: 0.4, head: 0.6 };
        const out = { ...restChannels, neck: { pitch: pitchDeg * share.neck, twist: yawDeg * share.neck }, head: { pitch: pitchDeg * share.head, twist: yawDeg * share.head } };
        // envelope check: per-joint limits + combined neck-head rule
        const clamp = (id) => {
          const j = skeleton.get(id); const c = out[id];
          for (const [ch, range] of Object.entries(j.limits || {})) {
            if (isNum(c[ch])) c[ch] = Math.min(range[1], Math.max(range[0], c[ch]));
          }
        };
        const want = { neck: { ...out.neck }, head: { ...out.head } };
        clamp('neck'); clamp('head');
        const comb = (jointsData.combined || []).find((r) => r.id === 'neck-head');
        if (comb) {
          for (const [ch, range] of Object.entries(comb.limits)) {
            const sum = out.neck[ch] + out.head[ch];
            if (sum < range[0] || sum > range[1]) {
              const k = Math.min(range[1], Math.max(range[0], sum)) / (sum || 1);
              out.neck[ch] *= k; out.head[ch] *= k;
            }
          }
        }
        const clamped = Math.abs(out.neck.pitch - want.neck.pitch) > 1e-6 || Math.abs(out.head.pitch - want.head.pitch) > 1e-6
          || Math.abs(out.neck.twist - want.neck.twist) > 1e-6 || Math.abs(out.head.twist - want.head.twist) > 1e-6;
        const diags = [];
        if (dist < 1e-6) diags.push(diag('craft/target-missing', 'error', `gaze target "${e.target}" sits at the head joint — no direction to look along`, { field: 'target' }));
        if (clamped) {
          const residual = Math.hypot(pitchDeg - (out.neck.pitch + out.head.pitch), yawDeg - (out.neck.twist + out.head.twist));
          diags.push(diag('craft/target-clamped', 'warning',
            `gaze to "${e.target}" needs ${pitchDeg.toFixed(1)}° pitch / ${yawDeg.toFixed(1)}° yaw — clamped into the neck+head envelope (residual ${residual.toFixed(1)}°)`,
            { field: 'target', residual }));
        }
        return { channels: out, diagnostics: diags };
      }
      case 'ik': {
        const chainId = e.chain || pose.chain;
        const chainDef = chainsFor(bundle)[chainId];
        if (!chainDef) return { channels: null, diagnostics: [diag('craft/chain', 'error', `chain "${chainId}" is not declared in joints.json`)] };
        const solved = solveChainChannels(skeletonW, restChannels, { root: chainDef.root, mid: chainDef.mid, end: chainDef.end }, targets[e.ik_target].position, { tolerance: 1e-5 });
        if (!solved.ok) return { channels: null, diagnostics: [{ ...solved.diagnostic, field: 'ik_target', target: e.ik_target, chain: chainId }] };
        const out = { ...restChannels, ...solved.channels };
        const diags = solved.poleFallback
          ? [diag('craft/pole-singular', 'warning', `pole direction is parallel to the reach for "${e.ik_target}" — the rest bend plane was kept`, { field: 'ik_target' })]
          : [];
        return { channels: out, diagnostics: diags, solved, chainId, targetPos: targets[e.ik_target].position };
      }
      case 'seat': {
        const t = targets[e.target];
        const seatY = t.position[1];
        const pelvis = skeletonW.get('pelvis');
        const crotchY = landmarkM(preset, preset.surface.crotchSurface);
        const clearance = (pelvis.worldPos[1] - toWorld([0, crotchY, 0])[1]) + preset.widths.thighR * preset.headM * 0.45;
        const drop = seatY + clearance - pelvis.worldPos[1];
        const out = { ...restChannels, pelvis: { position: [0, drop, 0] } };
        return { channels: out, diagnostics: [], seatY, clearance };
      }
      default:
        return { channels: null, diagnostics: [diag('craft/unknown-pose', 'error', `pose kind "${pose.kind}" has no expander in this compiler version`)] };
    }
  };

  let prevSteady = restChannels; // last steady target — what 'hold' holds
  for (const e of sorted) {
    const pose = lib[e.pose];
    const expanded = poseChannels(e);
    const steady = pose.kind === 'hold' ? prevSteady : (expanded?.channels || prevSteady);
    const transFrames = pose.transition?.frames ?? 18;
    const easeName = pose.transition?.easing || easing.arrival || 'out_cubic';
    const lifeEligible = pose.life === 'none' ? [] : (pose.life === 'inherit' || !pose.life ? (segments.length ? segments[segments.length - 1].lifeEligible : []) : pose.life);
    const supports = pose.supports === 'inherit' ? (segments.length ? segments[segments.length - 1].supports : []) : (pose.supports || []);
    // The blend starts from the pose actually evaluated at this onset — an
    // event interrupting an in-flight transition must not snap back to the
    // previous steady target first (the "transition pop").
    const onset = blendAt(e.at / fps);
    segments.push({
      pose: e.pose, kind: pose.kind, atFrame: e.at, t0: e.at / fps,
      transS: transFrames / fps, easing: EASINGS[easeName] ? easeName : 'out_cubic',
      settleS: (pose.settle?.frames ?? 0) / fps, overshoot: pose.settle?.overshoot ?? 0,
      steady, prevSteady: onset, lifeEligible, supports,
      target: e.target || e.ik_target || null,
      targetPos: expanded?.targetPos || null, seatY: expanded?.seatY ?? null,
      seatClearance: expanded?.clearance ?? null, chainId: expanded?.chainId || null,
      diagnostics: expanded?.diagnostics || [],
      failed: expanded?.channels === null && pose.kind !== 'hold',
    });
    if (pose.kind !== 'hold' && expanded?.channels) prevSteady = expanded.channels;
  }
  // A declared loop wraps: the first event eases from the pose evaluated at
  // the end of the take, not from rest — the seam check then compares two
  // sides of the same continuous motion instead of rest↔steady (round22 §7).
  if (loop && segments.length > 0) segments[0].prevSteady = blendAt(frames / fps);

  // --- contacts: lock poses recorded at interval activation ------------------
  // A foot contact locks the ankle transform wherever it is when the interval
  // begins; every covered frame then re-solves hip/knee/ankle so the lock
  // holds through transitions and life-layer pelvis motion (round22 §6).
  const contactDefs = contacts.map((c) => ({ ...c }));
  const footContacts = contactDefs.filter((c) => c.kind === 'foot');
  const lockedAt = new Map(); // contactId → frame

  // --- life layer compilation (once — never resimulated per seek) -------------
  const lifeDefs = bundle.performances.lifeLayers || {};
  const enabledLife = new Set();
  for (const l of pack.lifeLayers || []) if (lifeDefs[l]) enabledLife.add(l);
  const lifeWAt = (layer, t) => {
    let idx = -1;
    for (let i = 0; i < segments.length; i++) if (segments[i].t0 <= t) idx = i;
    if (idx < 0) return 0;
    const cur = segments[idx].lifeEligible.includes(layer) ? 1 : 0;
    const prev = idx > 0 && segments[idx - 1].lifeEligible.includes(layer) ? 1 : 0;
    const seg = segments[idx];
    const u = seg.transS > 0 ? Math.min(1, Math.max(0, (t - seg.t0) / seg.transS)) : 1;
    const w = EASINGS[seg.easing](u);
    return prev + (cur - prev) * w;
  };

  // blink events: compiled once from the seed stream
  const blinks = [];
  if (enabledLife.has('blink')) {
    const bl = lifeDefs.blink;
    const rng = mulberry32((norm.doc.seed ?? 1) ^ fnv1a(`${norm.doc.subject}:blink`));
    const [pMin, pMax] = bl.periodS || [3, 5];
    const durS = (bl.eventMs || 167) / 1000;
    const span = frames / fps;
    let T = pMin + (pMax - pMin) * 0.5 * rng();
    while (T < span) {
      blinks.push({ t: T, dur: durS });
      if (rng() < (bl.doubleChance ?? 0.25)) blinks.push({ t: T + durS + 0.12, dur: durS });
      T += pMin + (pMax - pMin) * rng();
    }
  }

  // --- bake contact-locked frames ---------------------------------------------
  const swayAmp = (layer) => {
    const def = lifeDefs[layer];
    if (!def || !enabledLife.has(layer)) return 0;
    return def.ampRefM * (preset.heightM / (def.refHeightM || 1.7));
  };
  const swayOf = (t, wShift, wSway) => {
    const a1 = swayAmp('weightShift') * wShift;
    const a2 = swayAmp('microSway') * wSway;
    const f1 = lifeDefs.weightShift?.freqHz || 0.1;
    const f2 = lifeDefs.microSway?.freqHz || 0.22;
    return [
      a1 * Math.sin(2 * Math.PI * f1 * t) + a2 * Math.sin(2 * Math.PI * f2 * t + 1.1),
      0,
      a2 * 0.6 * Math.sin(2 * Math.PI * f2 * 0.7 * t + 0.4),
    ];
  };

  const baked = new Map(); // frame → {jointId: channels}
  const locks = new Map(); // contactId → {patchWorld, centroidLocal, ankleQuat} — recorded at activation
  const unsolvableContacts = new Set(); // ids whose lock could never be satisfied
  let swayClampedFrames = 0; // frames where feasibility forced sway below 100%
  const seatSegs = segments.filter((s) => s.kind === 'seat' && !s.failed);
  const hasLocks = footContacts.length || seatSegs.length;
  if (hasLocks) {
    for (let f = 0; f <= frames; f++) {
      const t = f / fps;
      const baseChannels = steadyAt(t);
      const wShift = lifeWAt('weightShift', t);
      const wSway = lifeWAt('microSway', t);
      const sway = swayOf(t, wShift, wSway);
      const pelvisBase = { ...(baseChannels.pelvis || {}) };
      const pelvisC = { ...pelvisBase };
      const frameChannelsOf = (pc, sv, s) => {
        const out = { ...baseChannels };
        const p = { ...pc };
        const scaled = vscale(sv, s);
        if (scaled[0] || scaled[2] || p.position) p.position = vadd(p.position || [0, 0, 0], scaled);
        out.pelvis = p;
        return out;
      };
      // open locks at their interval start, in whatever pose is active. The
      // locked frame is the sole PATCH centroid + the ankle's orientation —
      // not the ankle origin — because the foot pivots about the ground, not
      // about a point 13 mm above it.
      for (const c of footContacts) {
        if (!locks.has(c.id) && f >= c.interval[0]) {
          const fk = fkWorld(skeletonW, frameChannelsOf(pelvisBase, sway, 0));
          const ankleId = c.joint === 'foot.L' || c.joint === 'foot.R' ? `ankle.${c.joint.slice(-1)}` : c.joint;
          const ankle = skeletonW.get(ankleId);
          const patchLocal = footPatchLocal(skeletonW, preset, c.joint.slice(-1));
          const centroidLocal = patchLocal ? patchCentroid(patchLocal) : [0, 0, 0];
          const aQuat = fk.get(ankleId)?.quat || ankle.worldQuat;
          locks.set(c.id, {
            ankleId,
            patchWorld: vadd(fk.get(ankleId)?.pos || ankle.worldPos, qrot(aQuat, centroidLocal)),
            centroidLocal,
            ankleQuat: aQuat,
          });
          lockedAt.set(c.id, f);
        }
      }
      // Re-solve legs so every locked patch keeps its recorded transform:
      // the ankle position lands where the (held) ankle orientation puts the
      // patch centroid back on its locked world spot. Life-layer sway is
      // feasibility-clamped (round22 §7 — layers disable when unsupported):
      // a figure standing at full leg extension cannot sway without breaking
      // contact, so the bake bisects the amplitude to the largest solvable
      // scale and records it — never a silent stretch.
      const chainMap = chainsFor(bundle);
      const solveLockedLegs = (frameChannels) => {
        const out = {};
        for (const c of footContacts) {
          if (f < c.interval[0] || f > c.interval[1] || !locks.has(c.id)) continue;
          const side = c.joint.slice(-1);
          const chainDef = chainMap[`leg.${side}`];
          const lock = locks.get(c.id);
          const ankleTarget = vsub(lock.patchWorld, qrot(lock.ankleQuat, lock.centroidLocal));
          const solved = solveChainChannels(skeletonW, frameChannels, {
            root: chainDef.root, mid: chainDef.mid, end: chainDef.end, endKeep: lock.ankleQuat,
          }, ankleTarget, { tolerance: 1e-6 });
          if (!solved.ok) return null;
          out[chainDef.root] = solved.channels[chainDef.root];
          out[chainDef.mid] = solved.channels[chainDef.mid];
          out[chainDef.end] = solved.channels[chainDef.end];
        }
        return out;
      };
      let legPatch = null;
      let swayScale = 0;
      for (const s of [1, 0.6, 0.3, 0]) {
        const legs = solveLockedLegs(frameChannelsOf(pelvisBase, sway, s));
        if (legs) {
          legPatch = legs; swayScale = s;
          const scaled = vscale(sway, s);
          if (scaled[0] || scaled[2] || pelvisBase.position) pelvisC.position = vadd(pelvisBase.position || [0, 0, 0], scaled);
          break;
        }
      }
      if (!legPatch) {
        unsolvableContacts.add('legs');
        legPatch = {};
      } else if (swayScale < 1) {
        swayClampedFrames++;
      }
      void unsolvableContacts; // reported on the schedule below
      const patch = { ...legPatch };
      const needBake = swayScale > 0 || (pelvisBase.position) || Object.keys(patch).length;
      if (needBake || Object.keys(patch).length) {
        patch.pelvis = pelvisC;
        baked.set(f, patch);
      }
    }
  }

  const schedule = {
    bundle: bundleRef(bundle), pack: pack.id, subject: norm.doc.subject,
    seed: norm.doc.seed ?? 1, fps, frames, seconds: frames / fps, loop, preRoll: norm.preRoll,
    skeleton: skeletonW, preset, packDef: pack, jointsData,
    segments, baked, blinks,
    life: { enabled: [...enabledLife], wAt: lifeWAt, swayOf, defs: lifeDefs,
      swayClampedFrames },
    contacts: contactDefs, locks, lockedAt, groundPlane: norm.groundPlane,
    targets, restChannels, support,
    blendAt,
  };
  for (const s of segments) for (const d2 of s.diagnostics || []) diagnostics.push(d2);
  for (const id of unsolvableContacts) diagnostics.push(diag('craft/contact-unsolvable', 'error',
    `locked contact group "${id}" is unreachable in the authored pose — no solvable pelvis ` +
    `configuration keeps it planted`));
  return { ok: !diagnostics.some((x) => x.severity === 'error'), diagnostics, schedule };
}

/* ----------------------------------------------------------- evaluation --- */

/**
 * Pure function of t over the compiled schedule. Returns
 * { channels, mesh, face, activeContacts, segments } — channels is a map
 * jointId → {pitch?, roll?, twist?, bend?, position?} in degrees/metres,
 * ready for craft.js's applyPose (or the bpy adapter's own channel applier).
 */
export function evaluateSchedule(schedule, t) {
  const tc = Math.min(Math.max(t, 0), schedule.seconds);
  const { segments } = schedule;
  let idx = -1;
  // binary search: last segment with t0 <= tc
  let lo = 0, hi = segments.length - 1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (segments[m].t0 <= tc) { idx = m; lo = m + 1; } else hi = m - 1;
  }
  const channels = schedule.blendAt(tc);
  // baked contact-lock corrections override the blended pose per frame
  const f = Math.round(tc * schedule.fps);
  const patch = schedule.baked.get(Math.min(f, schedule.frames));
  if (patch) for (const [j, c] of Object.entries(patch)) channels[j] = { ...(channels[j] || {}), ...c };

  // life layers: breathe (chest-local scale), blink (lid closure), sway is
  // already inside the baked pelvis correction — never added twice.
  const mesh = {};
  const face = {};
  if (schedule.life.enabled.includes('breathe')) {
    const def = schedule.life.defs.breathe;
    const w = schedule.life.wAt('breathe', tc);
    if (w > 0) {
      const s = 1 + def.amount * w * (0.5 - 0.5 * Math.cos(2 * Math.PI * def.rateHz * tc)) * 2;
      const [ax, ay, az] = def.axis || [1, 0.4, 1];
      mesh.chestScale = [1 + (s - 1) * ax, 1 + (s - 1) * ay, 1 + (s - 1) * az];
    }
  }
  if (schedule.life.enabled.includes('blink') && schedule.blinks.length) {
    // compiled event list: binary search the window containing tc
    let lo2 = 0, hi2 = schedule.blinks.length - 1, cand = -1;
    while (lo2 <= hi2) {
      const m = (lo2 + hi2) >> 1;
      if (schedule.blinks[m].t <= tc) { cand = m; lo2 = m + 1; } else hi2 = m - 1;
    }
    let lid = 0;
    for (let k = Math.max(0, cand - 1); k <= cand && k >= 0; k++) {
      const b = schedule.blinks[k];
      const u = (tc - b.t) / b.dur;
      if (u >= 0 && u <= 1) lid = Math.max(lid, Math.sin(Math.PI * u));
    }
    face.lid = lid;
  }

  const activeContacts = schedule.contacts.filter((c) => tc * schedule.fps >= c.interval[0] && tc * schedule.fps <= c.interval[1]);
  const seg = idx >= 0 ? segments[idx] : null;
  return {
    t: tc, channels, mesh, face,
    activeContacts, pose: seg?.pose || null, segmentIndex: idx,
    transition: seg && seg.transS > 0 ? Math.min(1, Math.max(0, (tc - seg.t0) / seg.transS)) : 1,
  };
}

export default {
  CRAFT_DOC_VERSION, CONSTRUCTION_LEVELS,
  composeChannelsQ, decomposeQ, swingForDir, frameQuat, fnv1a, mulberry32,
  diag, bundleRef, packFor, presetFor, landmarkM, derivedLandmarks,
  validateBundleContents,
  jointTable, chainsFor, skeletonOf, fkWorld, solveTwoBone, solveChainChannels,
  footPatchLocal, patchCentroid,
  limitViolations, combinedViolations, contactToleranceM, contactCheck,
  supportCheck, loopSeamCheck, EASING_NAMES,
  validatePerformanceDoc, compilePerformance, evaluateSchedule,
};
