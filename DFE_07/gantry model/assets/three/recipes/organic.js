// 1DesignTool design-kit — organic construction recipes (round16 §6.1 table,
// work item R16-Q08). Tapered curved volumes, seeded branching structures,
// deterministic scatter clumps — for soft clay, plants, hair, anything grown.
//
// Convention: (THREE, params) → { group, parts, materials }.
// Determinism: every rng() draw is from mulberry32(seed) inside the call —
// no hidden state, no Math.random. Same seed → same form, always.
import { mulberry32 } from '../motion.js';
import { variableRadiusSweep } from './sweeps.js';
import { instancedField } from '../parts.js';

const fail = (msg) => { throw new Error(`recipes/organic: ${msg}`); };
const isVec3 = (p) => Array.isArray(p) && p.length === 3 && p.every(Number.isFinite);

function materialFor(THREE, materials, role, defaults) {
  if (materials?.[role]) return materials[role];
  const m = new THREE.MeshStandardMaterial({ roughness: 0.8, metalness: 0, ...defaults });
  m.userData.role = role;
  return m;
}

/**
 * Tapered volume along a curve — limbs, necks, tails, stems. Thin wrapper
 * over the sweep recipe: radius interpolates r0 → r1 across the control
 * points. For a per-point radius profile use sweeps.variableRadiusSweep.
 */
export function taperedCurve(THREE, { points, r0, r1 = r0, seg = 32, tubeSeg = 10, materials = null, role = 'body' } = {}) {
  if (!(r0 > 0) || !(r1 > 0)) fail(`taperedCurve needs r0 > 0 and r1 > 0 (got ${r0} → ${r1})`);
  if (!Array.isArray(points) || points.length < 2 || points.some((p) => !isVec3(p))) {
    fail('taperedCurve needs ≥ 2 points [x, y, z]');
  }
  const radii = points.map((_, i) => r0 + (r1 - r0) * (i / (points.length - 1)));
  const out = variableRadiusSweep(THREE, { points, radii, seg, tubeSeg, materials, role });
  out.parts.sweep.name = 'taper';
  out.parts.sweep.userData.recipe = 'organic/taperedCurve';
  return out;
}

/**
 * Branching structure — a trunk with branches grown at seeded heights.
 *   trunk    — { points: [[x,y,z], …] bottom → top, r0, r1 }
 *   branches — explicit array [{ at, len, r, tilt, azimuth }] OR a count;
 *              a count generates branches deterministically from seed:
 *              at ∈ [0.3, 0.9] of trunk height, tilt 25–60° from the trunk,
 *              azimuth uniform. `at` is a fraction along the trunk point list.
 * Returns parts { trunk, branch_0, branch_1, … } plus `seed` so the caller
 * can record the exact form in the plan.
 */
export function branching(THREE, { trunk, branches, seed = 1, seg = 24, tubeSeg = 8, materials = null, role = 'body' } = {}) {
  if (!trunk || !Array.isArray(trunk.points) || trunk.points.length < 2 || trunk.points.some((p) => !isVec3(p))) {
    fail('branching needs trunk.points ≥ 2 [x,y,z] (bottom → top)');
  }
  if (!(trunk.r0 > 0) || !((trunk.r1 ?? trunk.r0) > 0)) fail('trunk needs r0 > 0 (and r1 > 0 if tapered)');
  const rng = mulberry32(seed);
  const n = Array.isArray(branches) ? branches.length : (Number.isInteger(branches) && branches > 0 ? branches : null);
  if (n == null) fail('branches must be a count or an array of {at, len, r, tilt, azimuth}');
  const tp = trunk.points.map((p) => new THREE.Vector3().fromArray(p));
  const heights = tp.map((p) => p.y);
  const y0 = Math.min(...heights), y1 = Math.max(...heights);
  const pointAt = (at) => { // linear interpolate along the trunk control points
    const f = Math.min(1, Math.max(0, at)) * (tp.length - 1);
    const k = Math.min(tp.length - 2, Math.floor(f));
    return tp[k].clone().lerp(tp[k + 1], f - k);
  };
  const specs = Array.isArray(branches) ? branches : Array.from({ length: n }, () => ({
    at: 0.3 + 0.6 * rng(),
    len: (y1 - y0) * (0.2 + 0.3 * rng()),
    r: (trunk.r1 ?? trunk.r0) * (0.35 + 0.25 * rng()),
    tilt: (25 + 35 * rng()) * Math.PI / 180,
    azimuth: rng() * Math.PI * 2,
  }));
  const group = new THREE.Group(); group.name = 'branching';
  const parts = {};
  const mats = {};
  const trunkMesh = taperedCurve(THREE, { points: trunk.points, r0: trunk.r0, r1: trunk.r1 ?? trunk.r0, seg, tubeSeg, materials, role });
  trunkMesh.parts.sweep.name = 'trunk';
  trunkMesh.parts.sweep.userData.recipe = 'organic/branching';
  group.add(trunkMesh.parts.sweep);
  parts.trunk = trunkMesh.parts.sweep;
  mats[role] = trunkMesh.parts.sweep.material;
  specs.forEach((b, i) => {
    const at = b.at ?? 0.5, tilt = b.tilt ?? Math.PI / 4, az = b.azimuth ?? 0;
    if (!(b.len > 0) || !(b.r > 0)) fail(`branches[${i}] needs len > 0 and r > 0`);
    const base = pointAt(at);
    const dir = new THREE.Vector3(Math.cos(az) * Math.sin(tilt), Math.cos(tilt), Math.sin(az) * Math.sin(tilt)).normalize();
    const p0 = base.toArray();
    const p1 = base.clone().addScaledVector(dir, b.len * 0.55).add(new THREE.Vector3(0, b.len * 0.08, 0)).toArray();
    const p2 = base.clone().addScaledVector(dir, b.len).toArray();
    const bm = taperedCurve(THREE, { points: [p0, p1, p2], r0: b.r, r1: b.r * 0.4, seg: 16, tubeSeg, materials, role });
    bm.parts.sweep.name = `branch-${i}`;
    bm.parts.sweep.userData.recipe = 'organic/branching';
    group.add(bm.parts.sweep);
    parts[`branch_${i}`] = bm.parts.sweep;
  });
  return { group, parts, materials: mats, seed };
}

/**
 * Deterministic scatter clump — gravel, foliage balls, pebbles, voxel moss.
 *   shape  — BufferGeometry, or {kind:'sphere'|'box'|'cone', r|size}
 *   count, spread — placement disc radius; seed — the form's identity
 *   scaleRange [lo, hi] — per-instance uniform scale spread (default 0.7–1.3)
 * One InstancedMesh = one draw call — the voxel direction's budget relies on it.
 */
export function clump(THREE, { shape = { kind: 'sphere', r: 0.01 }, count = 24, spread = 0.1, seed = 1, scaleRange = [0.7, 1.3], materials = null, role = 'clump' } = {}) {
  let geo = shape;
  if (!geo || !geo.attributes?.position) {
    const k = shape?.kind || 'sphere', s = shape?.r ?? shape?.size ?? 0.01;
    if (!(s > 0)) fail(`clump shape size must be > 0 (got ${s})`);
    geo = k === 'box' ? new THREE.BoxGeometry(s * 2, s * 2, s * 2)
      : k === 'cone' ? new THREE.ConeGeometry(s, s * 2, 8)
      : k === 'sphere' ? new THREE.SphereGeometry(s, 12, 8)
      : fail(`unknown clump shape kind ${JSON.stringify(k)} — sphere | box | cone | a BufferGeometry`);
  }
  if (!(Number.isInteger(count) && count > 0)) fail(`count must be a positive integer (got ${count})`);
  if (!(spread > 0)) fail(`spread must be > 0 (got ${spread})`);
  const [lo, hi] = scaleRange;
  if (!(lo > 0) || !(hi >= lo)) fail(`scaleRange must be [lo>0, hi≥lo] (got ${JSON.stringify(scaleRange)})`);
  const mat = materialFor(THREE, materials, role, { color: 0x7a8c6a });
  const mesh = instancedField(THREE, {
    geometry: geo, material: mat, count, seed,
    place: (i, rng) => {
      const a = rng() * Math.PI * 2, r = Math.sqrt(rng()) * spread;
      return {
        position: [Math.cos(a) * r, 0, Math.sin(a) * r],
        rotation: [0, rng() * Math.PI * 2, 0],
        scale: lo + (hi - lo) * rng(),
      };
    },
  });
  mesh.name = 'clump'; mesh.userData.role = role; mesh.userData.recipe = 'organic/clump';
  const group = new THREE.Group(); group.name = 'clump'; group.add(mesh);
  return { group, parts: { clump: mesh }, materials: { [role]: mat }, seed };
}

export default { taperedCurve, branching, clump };
