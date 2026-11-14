// 1DesignTool design-kit — craft construction contract (round22 §2, §4, §5;
// work item R22-C02 kit side).
//
// The Three.js adapter for the craft bundle. Joint data, channel semantics and
// the math live in craft-motion.js (pure, Node-testable); this file owns the
// objects: rigs, covering geometry, pivots and pose application.
//
//   const rig = buildHumanoidRig(THREE, bundle, { variant: 'toy-v2', subject: 'toybot' });
//   applyPose(rig, evaluateSchedule(schedule, t));
//
// Every function takes the injected THREE namespace — no 'three' import, so
// the module runs in Node tests and inside artifact pages alike.

import {
  CONSTRUCTION_LEVELS, composeChannelsQ, decomposeQ, frameQuat,
  presetFor, packFor, jointTable, skeletonOf, landmarkM, diag,
  footPatchLocal, validateBundleContents,
  compilePerformance, evaluateSchedule,
} from './craft-motion.js';
import { limb, jointPeg, eyeDecals } from './parts.js';

const D2R = Math.PI / 180;

/* ----------------------------------------------------- browser loading --- */

/**
 * loadCraftBundleBrowser — the fetch() twin of scripts/lib-craft.mjs
 * `loadCraftBundle` (round26 Q1-02): one call brings the versioned bundle
 * into an artifact page, pins the same content hash, and reports the same
 * integrity findings. `baseUrl` is the copied `assets/three/craft` folder —
 * a relative URL inside the artifact or an absolute one.
 *
 * The conformance set can't be listed over HTTP, so schema.json declares
 * `conformanceFiles`; hashing the declared set in schema order reproduces
 * the Node loader's hash byte for byte. Returns
 * { ok, findings, bundle } — findings follow the checker shape
 * { rule, severity, message, origin:'bundle' }.
 */
export async function loadCraftBundleBrowser(baseUrl = './craft') {
  const base = String(baseUrl).replace(/\/+$/, '');
  const findings = [];
  const bundle = { schema: null, proportions: null, joints: null, performances: null, conformance: {} };
  const texts = {};
  const read = async (name) => {
    let text = null;
    try {
      const r = await fetch(`${base}/${name}`);
      if (!r.ok) {
        findings.push({ rule: 'craft/bundle-part-missing', severity: 'error', origin: 'bundle', message: `craft bundle part "${name}" — HTTP ${r.status} from ${base}` });
        return null;
      }
      text = await r.text();
    } catch (e) {
      findings.push({ rule: 'craft/bundle-part-missing', severity: 'error', origin: 'bundle', message: `craft bundle part "${name}" failed to load from ${base}: ${e.message}` });
      return null;
    }
    texts[name] = text;
    try { return JSON.parse(text); }
    catch (e) {
      findings.push({ rule: 'craft/bundle-part-invalid', severity: 'error', origin: 'bundle', message: `craft bundle part "${name}" is not JSON: ${e.message}` });
      return null;
    }
  };

  bundle.schema = await read('schema.json');
  bundle.proportions = await read('proportions.json');
  bundle.joints = await read('joints.json');
  bundle.performances = await read('performances.json');
  const confFiles = (bundle.schema?.conformanceFiles || [])
    .filter((f) => typeof f === 'string' && f.startsWith('conformance/') && f.endsWith('.json'))
    .sort();
  for (const f of confFiles) {
    bundle.conformance[f.slice('conformance/'.length, -'.json'.length)] = await read(f);
  }

  // Same byte stream the Node loader hashes: name\0content\n in sorted order.
  const hashNames = ['schema.json', 'proportions.json', 'joints.json', 'performances.json', ...confFiles];
  const hashSource = hashNames.filter((n) => texts[n] != null).map((n) => `${n}\0${texts[n]}\n`).join('');
  if (hashSource && globalThis.crypto?.subtle) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(hashSource));
    bundle.contentHash = `sha256:${[...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16)}`;
  } else {
    bundle.contentHash = null; // no WebCrypto (non-secure context) — unpinned, not faked
  }

  for (const d of validateBundleContents(bundle)) {
    findings.push({ rule: d.code, severity: d.severity, origin: 'bundle', message: d.message, ...(d.field ? { field: d.field } : {}) });
  }
  return { ok: !findings.some((f) => f.severity === 'error'), findings, bundle };
}

/**
 * buildCraftCharacter — one call from a scene module to a live rig (round26
 * Q1-02). Loads the bundle at `bundleBase`, fetches the authored
 * `*.craft.json` at `doc`, compiles it, builds the rig, applies placement —
 * and throws with the findings when any stage cannot run (the gate checks
 * the same doc; a scene that cannot build must say so, not stand still).
 * Returns { root, rig, schedule, bundle, evaluate(THREE, t) }.
 */
export async function buildCraftCharacter(THREE, { bundleBase = './craft', doc, variant, level, subject } = {}) {
  const { bundle, findings } = await loadCraftBundleBrowser(bundleBase);
  const loadErrs = findings.filter((f) => f.severity === 'error');
  if (loadErrs.length || !bundle?.schema) {
    throw new Error(`craft bundle did not load cleanly: ${loadErrs.map((f) => f.message).join('; ') || 'empty bundle'}`);
  }
  const res = await fetch(doc);
  if (!res.ok) throw new Error(`craft doc "${doc}" — HTTP ${res.status}`);
  const docObj = await res.json();
  const { diagnostics, schedule } = compilePerformance(bundle, docObj);
  const errs = (diagnostics || []).filter((d) => d.severity === 'error');
  if (!schedule || errs.length) {
    throw new Error(`craft doc did not compile: ${errs.map((d) => d.message).join('; ') || 'no schedule produced'}`);
  }
  const rig = buildHumanoidRig(THREE, bundle, {
    variant: variant || docObj.construction?.variant || 'toy-v2',
    level: level || docObj.construction?.level,
    subject: subject || docObj.subject,
    jointOffsets: docObj.construction?.jointOffsets || {},
    jointCovers: docObj.construction?.jointCovers || {},
    packCovers: schedule.packDef?.covers || {},
    face: schedule.packDef?.face?.kind === 'painted',
  });
  const pl = docObj.construction?.placement || {};
  if (pl.position) rig.group.position.set(...pl.position);
  if (pl.yawDeg) rig.group.rotation.y = pl.yawDeg * D2R;
  return {
    root: rig.group, rig, schedule, bundle, doc: docObj,
    evaluate: (T, t) => applyPose(T, rig, evaluateSchedule(schedule, t)),
  };
}

/* ----------------------------------------------------------- materials --- */

function toMat(THREE, m, fallbackColor) {
  if (m && m.isMaterial) return m;
  const color = typeof m === 'number' || typeof m === 'string' ? m : fallbackColor;
  return new THREE.MeshStandardMaterial({ color, roughness: 0.5, metalness: 0.05 });
}

/* ---------------------------------------------------- cap containment ---- */

/**
 * The spherical-joint recipe's hard invariant (round22 §5): a cover ball of
 * radius R hides the cap only if the cap's whole section circle fits —
 * sqrt(capR² + capD²) ≤ R − margin, where margin ≥ max(0.12·R, marginFloorM).
 * Ball radius alone proves nothing; the margin is geometric.
 */
export function checkCapContainment({ capR, capD = 0, R, margin = null, marginFloorM = 0.0005 } = {}) {
  const needed = Math.hypot(capR, capD);
  const marginRequired = Math.max(0.12 * R, marginFloorM);
  const clearance = R - needed;
  // Geometry decides: the ball must leave the required margin against the cap
  // section. A *declared* margin that exceeds the real clearance is a lie —
  // and one below it is an undersized promise; both are reported separately.
  const ok = clearance >= marginRequired;
  const diagnostic = ok
    ? (margin !== null && clearance < margin ? diag('craft/cap-containment', 'error',
      `declared margin ${(margin * 1000).toFixed(1)} mm exceeds the real clearance ${(clearance * 1000).toFixed(1)} mm — the cover is not what was promised`,
      { needed, clearance, margin }) : null)
    : diag('craft/cap-containment', 'error',
      `cap section ${(needed * 1000).toFixed(1)} mm + required margin ${(marginRequired * 1000).toFixed(1)} mm exceeds ball radius ${(R * 1000).toFixed(1)} mm (clearance ${(clearance * 1000).toFixed(1)} mm)`,
      { needed, clearance, marginRequired });
  return { ok, needed, clearance, marginRequired, diagnostic };
}

/**
 * ballJoint recipe (round22 §5): a stationary covering sphere centred on the
 * joint, owned by the PARENT side, plus the child pivot sharing the same
 * centre. Attach `group` to the parent pivot; rotate only `pivot`.
 */
export function ballJoint(THREE, { R, capR, capD = 0, margin = 0, material, marginFloorM } = {}) {
  const containment = checkCapContainment({ capR, capD, R, margin, marginFloorM });
  const group = new THREE.Group();
  const ball = new THREE.Mesh(new THREE.SphereGeometry(R, 28, 20), material);
  ball.userData = { craft: 'joint-cover', kind: 'ballJoint', R };
  group.add(ball);
  const pivot = new THREE.Group();
  pivot.name = 'pivot';
  group.add(pivot);
  return { group, pivot, ball, containment };
}

/* ------------------------------------------------------------- the rig --- */

// Which body segment a pivot owns (the mesh it carries toward its child) and
// how its radius derives from preset.widths — factors are part of the rig
// recipe, not new proportion data (proportions stay in proportions.json).
const SEGMENTS = {
  pelvis: { to: 'abdomen', r: 'hipW', rs: 0.5, r1: 'hipW', r1s: 0.42, kind: 'torso' },
  abdomen: { to: 'chest', r: 'hipW', rs: 0.42, r1: 'chestDepth', r1s: 0.85, kind: 'torso' },
  chest: { to: 'neck', r: 'chestDepth', rs: 0.85, r1: 'neckR', r1s: 1.2, kind: 'torso' },
  neck: { to: 'head', r: 'neckR', rs: 1, kind: 'limb' },
  'shoulder.L': { to: 'elbow.L', r: 'upperArmR', rs: 1, kind: 'limb' },
  'elbow.L': { to: 'forearmTwist.L', r: 'forearmR', rs: 1, kind: 'limb' },
  'forearmTwist.L': { to: 'wrist.L', r: 'forearmR', rs: 1, rEnd: 0.8, kind: 'limb' },
  'wrist.L': { to: null, r: 'handR', rs: 1, kind: 'extremity' },
  'hip.L': { to: 'knee.L', r: 'thighR', rs: 1, kind: 'limb' },
  'knee.L': { to: 'ankle.L', r: 'shinR', rs: 1, kind: 'limb' },
  'ankle.L': { to: null, kind: 'foot' },
  'foot.L': { to: null, r: 'shinR', rs: 0.8, kind: 'toe' },
};

/**
 * Build the compiler-owned humanoid rig from the bundle skeleton.
 * opts: { variant, level, subject, materials:{shell,accent,seam,face},
 *         jointOffsets, jointCovers, face }
 * Returns { group, joints:Map, lids, chest, patches, skeleton, preset, level,
 *           subject, covers } — joints[id] = { pivot, spec, restLocalPos,
 *           restLocalQuat, worldPos, worldQuat }.
 */
export function buildHumanoidRig(THREE, bundle, opts = {}) {
  const variant = opts.variant || 'toy-v2';
  const preset = presetFor(bundle, variant);
  if (!preset) throw new Error(`craft/buildHumanoidRig: unknown variant "${variant}"`);
  const level = opts.level || 'covered-rigid';
  if (!CONSTRUCTION_LEVELS.includes(level)) {
    throw new Error(`craft/buildHumanoidRig: level must be one of ${CONSTRUCTION_LEVELS.join(', ')}`);
  }
  const subject = opts.subject || 'rig';
  const mats = {
    shell: toMat(THREE, opts.materials?.shell, 0xf2f4f7),
    accent: toMat(THREE, opts.materials?.accent, 0x111318),
    seam: toMat(THREE, opts.materials?.seam, 0x111318),
    face: toMat(THREE, opts.materials?.face, 0x14171c),
  };
  const skeleton = skeletonOf(bundle, variant, { jointOffsets: opts.jointOffsets || {} });
  // cover precedence: construction.jointCovers (audited overrides) → pack
  // defaults → the template's own seam hint
  const packCovers = opts.packCovers || {};
  const docCovers = opts.jointCovers || {};
  const coverSpec = (id, j) => {
    const merged = { kind: docCovers[id]?.kind ?? packCovers[id]?.kind ?? j.seam?.cover, ...(docCovers[id] || {}) };
    return merged.kind && merged.kind !== 'none' ? merged : null;
  };

  const group = new THREE.Group();
  group.name = subject;
  const joints = new Map();

  // dependency order is the skeleton's own: parents are defined before children
  for (const [id, j] of skeleton) {
    const pivot = new THREE.Group();
    pivot.name = id;
    pivot.userData = { craft: 'joint', id, kind: j.kind, channels: j.channels };
    pivot.position.set(j.restLocalPos[0], j.restLocalPos[1], j.restLocalPos[2]);
    const q = j.restLocalQuat;
    pivot.quaternion.set(q[0], q[1], q[2], q[3]);
    const parentPivot = j.parent ? joints.get(j.parent).pivot : group;
    parentPivot.add(pivot);
    joints.set(id, {
      id, spec: j, pivot,
      restLocalPos: new THREE.Vector3(...j.restLocalPos),
      restLocalQuat: new THREE.Quaternion(q[0], q[1], q[2], q[3]),
      worldPos: j.worldPos, worldQuat: j.worldQuat,
    });
  }

  const M = preset.headM;
  const segOf = (jid) => SEGMENTS[jid.replace(/\.R$/, '.L')];
  const childLocalOf = (jid) => {
    const seg = segOf(jid);
    const side = jid.endsWith('.R') ? '.R' : jid.endsWith('.L') ? '.L' : '';
    const child = seg?.to ? seg.to.replace(/\.L$/, side) : null;
    return child && joints.get(child) ? joints.get(child).restLocalPos : null;
  };

  // --- body segments --------------------------------------------------------
  const lids = {};
  let chestMesh = null;
  for (const [id, j] of joints) {
    const seg = segOf(id);
    const to = childLocalOf(id);
    const r = seg?.r ? (preset.widths[seg.r] || 0.2) * M * (seg.rs ?? 1) : 0.01;
    if (seg && (seg.kind === 'torso' || seg.kind === 'limb') && to) {
      const r1 = seg.r1 ? (preset.widths[seg.r1] || 0.2) * M * (seg.r1s ?? 1) : r * (seg.rEnd || 0.92);
      const m = limb(THREE, { from: [0, 0, 0], to: [to.x, to.y, to.z], r0: r, r1, material: mats.shell });
      m.userData.craft = 'segment';
      j.pivot.add(m);
      if (id === 'chest') chestMesh = m;
    } else if (seg && seg.kind === 'extremity') {
      // hand: a rounded stub continuing the forearm line (+Y in joint frame)
      const len = preset.widths.handLen * M;
      const m = limb(THREE, { from: [0, 0, 0], to: [0, len, 0], r0: r, r1: r * 0.9, material: mats.shell });
      m.userData.craft = 'segment';
      j.pivot.add(m);
    } else if (seg && seg.kind === 'foot') {
      // foot block: heel→toe, sole on the ground plane, world-axis-aligned at
      // rest (the ankle frame is tilted — the block undoes that tilt)
      const side = j.spec.side || 'L';
      const heel = preset.skeleton[`heel.${side}`] || mirrorX(preset.skeleton['heel.L']);
      const toe = preset.skeleton[`toe.${side}`] || mirrorX(preset.skeleton['toe.L']);
      const rest = j.worldPos;
      const footH = Math.max(0.006, rest[1] * 1.15, heel[1] * 2);
      const w = preset.widths.footLen * M * 0.52;
      const depth = toe[2] - heel[2];
      const box = new THREE.Mesh(new THREE.BoxGeometry(w, footH, depth), mats.shell);
      const wq = j.worldQuat;
      const inv = new THREE.Quaternion(-wq[0], -wq[1], -wq[2], wq[3]);
      const centre = new THREE.Vector3(0, footH / 2 - rest[1], (heel[2] + toe[2]) / 2 - rest[2]).applyQuaternion(inv);
      box.position.copy(centre);
      box.quaternion.copy(inv);
      box.userData.craft = 'segment';
      j.pivot.add(box);
    } else if (seg && seg.kind === 'toe') {
      const m = new THREE.Mesh(new THREE.SphereGeometry(r * 0.62, 16, 12), mats.shell);
      m.userData.craft = 'segment';
      j.pivot.add(m);
    }
    if (id === 'head') {
      const headR = (preset.widths.headW || 0.7) * M * 0.5;
      const crownY = headR * 0.82;
      const head = new THREE.Mesh(new THREE.SphereGeometry(headR, 36, 28), mats.shell);
      head.position.set(0, crownY, 0);
      head.userData.craft = 'segment';
      j.pivot.add(head);
      if (opts.face !== false) {
        // painted face: decal eyes + geometric lids (the blink channel scales
        // lid.scale.y — real closure geometry, not a UV trick)
        const eyeR = headR * 0.16;
        const positions = [-1, 1].map((side) => {
          const ex = side * headR * 0.42, ey = crownY + headR * 0.06;
          const ez = Math.sqrt(Math.max(headR * headR - ex * ex - (ey - crownY) * (ey - crownY), 0)) * 0.985;
          return [ex, ey, ez];
        });
        const eyes = eyeDecals(THREE, { positions, radius: eyeR, material: mats.face });
        j.pivot.add(eyes);
        for (const [i, p] of positions.entries()) {
          const lid = new THREE.Mesh(new THREE.SphereGeometry(eyeR * 1.25, 14, 10), mats.shell);
          lid.position.set(p[0] * 1.01, p[1] * 1.01, p[2] * 1.01);
          lid.scale.z = 0.4;
          lid.userData = { craft: 'lid', side: i === 0 ? 'L' : 'R' };
          j.pivot.add(lid);
          lids[i === 0 ? 'L' : 'R'] = lid;
        }
      }
    }
    // --- joint covers: ball covers belong to the parent (stationary), pegs
    // ride with the joint (the pin turns in the socket) ----------------------
    const cov = coverSpec(id, j.spec);
    const segR = seg?.r ? (preset.widths[seg.r] || 0.2) * M * (seg.rs ?? 1) : 0.01;
    if (cov?.kind === 'ballJoint') {
      const capR = cov.cap?.r ?? segR;
      const capD = cov.cap?.d ?? 0;
      const R = cov.R ?? capR * 1.35;
      const margin = cov.margin ?? capR * 0.35;
      const bj = ballJoint(THREE, { R, capR, capD, margin, material: mats.accent });
      bj.group.userData.craftJoint = id;
      bj.containment.joint = id;
      if (j.spec.parent && joints.get(j.spec.parent)) {
        bj.group.position.copy(j.restLocalPos);
        joints.get(j.spec.parent).pivot.add(bj.group);
      } else {
        j.pivot.add(bj.group);
      }
      j.cover = { kind: 'ballJoint', R, capR, capD, margin, containment: bj.containment };
    } else if (cov?.kind === 'peg' || (cov === null && j.spec.seam?.cover === 'peg' && level !== 'rigid-hierarchy')) {
      const pegLen = segR * 2.6;
      const geo = jointPeg(THREE, { r: segR * 0.55, len: pegLen });
      geo.translate(0, -pegLen / 2, 0); // centre the pin on the joint
      const peg = new THREE.Mesh(geo, mats.seam);
      peg.rotation.z = Math.PI / 2; // pin axis = joint-local X (the hinge axis)
      peg.userData.craft = 'joint-cover';
      j.pivot.add(peg);
      j.cover = { kind: 'peg' };
    }
  }

  // --- foot contact patches (round22 §6): the sole rectangle under each
  // foot — same corners the performance baker locks, in ankle-local coords --
  const patches = {};
  for (const side of ['L', 'R']) {
    const cornersLocal = footPatchLocal(skeleton, preset, side);
    if (!cornersLocal) continue;
    patches[side] = { joint: `ankle.${side}`, cornersLocal };
  }

  // The certified skeleton is measured WITHOUT jointOffsets — the audit
  // compares built pivots against what the preset promised, not what the
  // (non-certified) override asked for.
  const expectedSkeleton = skeletonOf(bundle, variant, { jointOffsets: {} });

  return {
    group, joints, lids, chest: chestMesh, patches,
    skeleton, expectedSkeleton, preset, level, subject,
    version: bundle?.schema ? `${bundle.schema.bundleId}@${bundle.schema.bundleVersion}` : null,
  };
}

function mirrorX(p) { return p ? [-p[0], p[1], p[2]] : null; }
function qconjArr(q) { return [-q[0], -q[1], -q[2], q[3]]; }
function rotArr(q, v) {
  const u = [q[0], q[1], q[2]], s = q[3];
  const uv = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const uuv = [u[1] * uv[2] - u[2] * uv[1], u[2] * uv[0] - u[0] * uv[2], u[0] * uv[1] - u[1] * uv[0]];
  return [v[0] + 2 * s * uv[0] + 2 * uuv[0], v[1] + 2 * s * uv[1] + 2 * uuv[1], v[2] + 2 * s * uv[2] + 2 * uuv[2]];
}

/* -------------------------------------------------------------- poses ---- */

/**
 * Apply one evaluated state (craft-motion evaluateSchedule output) to the rig.
 * Channels the joint template does not declare are dropped here — validated
 * documents never produce them, but the contract holds even for hand-built
 * eval objects.
 */
export function applyPose(THREE, rig, evalState) {
  const e = new THREE.Euler();
  const q = new THREE.Quaternion();
  for (const [id, c] of Object.entries(evalState.channels || {})) {
    const j = rig.joints.get(id);
    if (!j || !c) continue;
    const allowed = j.spec.channels;
    const pick = (k) => (typeof c[k] === 'number' && channelAllowed(allowed, k) ? c[k] : 0);
    const pitch = pick('pitch') + pick('bend'); // bend and pitch share the +X axis by construction
    const roll = pick('roll');
    const twist = pick('twist');
    e.set(pitch * D2R, twist * D2R, roll * D2R, 'XZY');
    q.setFromEuler(e);
    j.pivot.quaternion.copy(j.restLocalQuat).multiply(q);
    if (Array.isArray(c.position) && allowed.includes('position')) {
      j.pivot.position.set(
        j.restLocalPos.x + c.position[0],
        j.restLocalPos.y + c.position[1],
        j.restLocalPos.z + c.position[2],
      );
    } else {
      j.pivot.position.copy(j.restLocalPos);
    }
  }
  if (evalState.mesh?.chestScale && rig.chest) {
    rig.chest.scale.set(...evalState.mesh.chestScale);
  }
  if (typeof evalState.face?.lid === 'number') {
    const open = Math.max(0.06, 1 - evalState.face.lid);
    for (const lid of Object.values(rig.lids || {})) lid.scale.y = open;
  }
}

function channelAllowed(allowed, ch) {
  if (allowed.includes(ch)) return true;
  if (ch === 'pitch' || ch === 'roll') return allowed.includes('swing');
  return false;
}

/* --------------------------------------------------------- measurement --- */

/**
 * Measured pivot centres vs the preset skeleton (round22 §5): returns
 * [{id, measured:[x,y,z], expected:[x,y,z], deviationM}] in rig-local space —
 * the caller's placement transform is factored out, so deviations measure the
 * rig, not where it was dropped.
 */
export function pivotDeviations(THREE, rig) {
  rig.group.updateMatrixWorld(true);
  const expectedMap = rig.expectedSkeleton || rig.skeleton;
  const out = [];
  const v = new THREE.Vector3();
  for (const [id, j] of rig.joints) {
    j.pivot.getWorldPosition(v);
    rig.group.worldToLocal(v);
    const expected = expectedMap.get(id).worldPos;
    out.push({
      id,
      measured: [v.x, v.y, v.z],
      expected,
      deviationM: Math.hypot(v.x - expected[0], v.y - expected[1], v.z - expected[2]),
    });
  }
  return out;
}

/** World-space (rig-local) foot patch corners for contact checks. */
export function footPatchWorld(THREE, rig, side) {
  rig.group.updateMatrixWorld(true);
  const p = rig.patches[side];
  if (!p) return null;
  const pivot = rig.joints.get(p.joint)?.pivot;
  if (!pivot) return null;
  const v = new THREE.Vector3();
  return p.cornersLocal.map((c) => {
    v.set(c[0], c[1], c[2]);
    pivot.localToWorld(v);
    rig.group.worldToLocal(v);
    return [v.x, v.y, v.z];
  });
}

/** Convex hull of two (or more) world-space patches → support polygon [x,z][]. */
export function supportPolygon(patchSets) {
  const pts = [];
  for (const set of patchSets) for (const p of set || []) pts.push([p[0], p[2]]);
  if (pts.length < 3) return pts;
  // monotone chain — tiny, deterministic
  const s = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const p of s) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (const p of [...s].reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

export { CONSTRUCTION_LEVELS, composeChannelsQ, decomposeQ, frameQuat, packFor, landmarkM };

export default {
  CONSTRUCTION_LEVELS, checkCapContainment, ballJoint, buildHumanoidRig,
  applyPose, pivotDeviations, footPatchWorld, supportPolygon,
  composeChannelsQ, decomposeQ, frameQuat, packFor, landmarkM,
  loadCraftBundleBrowser, buildCraftCharacter,
};
