// 1DesignTool design-kit — vessel construction recipes (round16 §6.1 table,
// work item R16-Q08). Hollow vessels, rims, foot rings, spouts, fitted lids.
//
// Every function takes (THREE, params) and returns
//   { group, parts, materials, joins? }
//   group     — Object3D root with named children
//   parts     — plain name → Object3D map; register what matters with
//               lib.parts.add(part, 'vessel.body', 'Body') in build()
//   materials — the role → material map actually used (params.materials
//               overrides per role; defaults are neutral stand-ins)
//   joins     — documented fit/contact facts other parts can rely on
//
// Construction notes:
//   - hollowLathe builds the wall as ONE closed lathe profile (outside up,
//     over the lip, inside down to the floor) — the rim and interior are the
//     same surface, which is what makes a vessel read as hollow.
//   - UV note: lathe U follows the profile length, V the revolution — painted
//     bands map cleanly; checker textures will show distortion near the axis.
//   - "Watertight-ish": profiles are closed loops so the surface has no open
//     boundary, but the profile is not checked for self-intersection — keep
//     wall < the minimum radius.
import { trail } from '../parts.js';
import { variableRadiusSweep } from './sweeps.js';

const fail = (msg) => { throw new Error(`recipes/vessels: ${msg}`); };
const isVec2 = (p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite);
const isVec3 = (p) => Array.isArray(p) && p.length === 3 && p.every(Number.isFinite);

function materialFor(THREE, materials, role, defaults) {
  if (materials?.[role]) return materials[role];
  const m = new THREE.MeshStandardMaterial({ roughness: 0.7, metalness: 0, ...defaults });
  m.userData.role = role;
  return m;
}

/**
 * Hollow vessel from an outer profile — the recipe for cups, pots, carafes.
 *   profile  — [[r, y], …] outer silhouette, bottom → rim, non-decreasing y;
 *              last point is the rim outer edge
 *   wall     — wall thickness (inner wall is profile offset inward by wall)
 *   base     — interior floor height; the vessel's real bottom thickness
 * The returned mesh is a single closed lathe — no separate inner shell to
 * drift out of registration.
 */
export function hollowLathe(THREE, { profile, wall = 0.004, base = 0.006, seg = 96, materials = null, role = 'body' } = {}) {
  if (!Array.isArray(profile) || profile.length < 2) fail('hollowLathe needs ≥ 2 outer profile points [[r, y], …]');
  if (!(wall > 0)) fail(`wall must be > 0 (got ${wall}) — a vessel without a wall is a shell, not a vessel`);
  if (!(base > 0)) fail(`base must be > 0 (got ${base}) — the floor needs real thickness`);
  let lastY = -Infinity;
  for (const p of profile) {
    if (!isVec2(p) || p[0] < 0) fail(`bad outer profile point ${JSON.stringify(p)} — expected [r≥0, y]`);
    if (p[1] < lastY) fail('outer profile y must be non-decreasing (bottom → rim)');
    lastY = p[1];
  }
  const [rimR, rimY] = profile[profile.length - 1];
  if (rimR <= wall) fail(`rim radius ${rimR} must exceed wall ${wall} — the opening disappears otherwise`);
  // Inner wall: outer profile offset inward by `wall`, kept only where a real
  // radius survives and above the floor — then reversed to descend to (0, base).
  const inner = profile
    .map(([r, y]) => [r - wall, y])
    .filter(([r, y]) => r > wall * 0.1 && y > base)
    .reverse();
  const combined = [
    ...profile,
    [rimR - wall * 0.45, rimY],          // lip: rolled edge from outer to inner
    [rimR - wall, rimY - wall * 0.2],
    ...inner,
    [0, base],                           // interior floor
  ];
  const pts = combined.map(([r, y]) => new THREE.Vector2(Math.max(r, 0), y));
  const body = new THREE.Mesh(new THREE.LatheGeometry(pts, seg), materialFor(THREE, materials, role, { color: 0xc9b59b }));
  body.name = 'body';
  body.userData.role = role; body.userData.recipe = 'vessels/hollowLathe';
  body.userData.opening = { r: rimR - wall, y: rimY }; // landmark: inner rim
  const group = new THREE.Group(); group.name = 'vessel'; group.add(body);
  return {
    group, parts: { body }, materials: { [role]: body.material },
    joins: { opening: { type: 'open-cavity', r: rimR - wall, y: rimY }, floor: { type: 'base-plane', y: base } },
  };
}

/** Rim bead at radius r — a deliberate lip/edge ring. `profile` is the bead
    cross-section [[dr, dy], …] relative to (r, y); default is a small
    rounded bead (tube ≈ 4% of r, min 1 mm). */
export function rim(THREE, { r, profile = null, y = 0, seg = 96, materials = null, role = 'trim' } = {}) {
  if (!(r > 0)) fail(`rim radius must be > 0 (got ${r})`);
  const t = Math.max(r * 0.04, 0.001);
  const cross = profile || [
    [0, 0], [t * 0.7, 0], [t, t * 0.3], [t, t * 0.7], [t * 0.7, t], [0, t],
  ];
  if (!Array.isArray(cross) || cross.length < 3) fail('rim profile needs ≥ 3 cross-section points');
  for (const p of cross) if (!isVec2(p)) fail(`bad rim profile point ${JSON.stringify(p)}`);
  const pts = cross.map(([dr, dy]) => new THREE.Vector2(r + dr, y + dy));
  const mesh = new THREE.Mesh(new THREE.LatheGeometry(pts, seg), materialFor(THREE, materials, role, { color: 0xb8b4ac }));
  mesh.name = 'rim'; mesh.userData.role = role; mesh.userData.recipe = 'vessels/rim';
  const group = new THREE.Group(); group.name = 'rim'; group.add(mesh);
  return { group, parts: { rim: mesh }, materials: { [role]: mesh.material } };
}

/** Foot ring: stands the vessel off the support so the base reads as a
    deliberate foot, not a flat bottom. width defaults to 15% of r. */
export function footRing(THREE, { r, h = 0.004, width = null, seg = 64, materials = null, role = 'foot' } = {}) {
  if (!(r > 0)) fail(`footRing radius must be > 0 (got ${r})`);
  if (!(h > 0)) fail(`footRing height must be > 0 (got ${h})`);
  const w = width ?? r * 0.15;
  if (!(w > 0 && w < r)) fail(`footRing width ${w} must be in (0, r)`);
  const P = (x, y) => new THREE.Vector2(x, y);
  const pts = [P(r - w, 0), P(r, 0), P(r, h), P(r - w, h), P(r - w, 0)];
  const mesh = new THREE.Mesh(new THREE.LatheGeometry(pts, seg), materialFor(THREE, materials, role, { color: 0xa99377 }));
  mesh.name = 'foot-ring'; mesh.userData.role = role; mesh.userData.recipe = 'vessels/footRing';
  const group = new THREE.Group(); group.name = 'foot-ring'; group.add(mesh);
  return {
    group, parts: { foot: mesh }, materials: { [role]: mesh.material },
    joins: { support: { type: 'contact-plane', y: 0, r } },
  };
}

/**
 * Pour spout attached to a vessel wall — a tapered open tube that rises from
 * `attach`. The base embeds into the wall (embedded join); the tip is open.
 *   attach — [x, y, z] on the outer wall; the spout exits radially
 *   angle  — upward tilt of the spout axis in radians (0 = horizontal)
 *   flare  — tip radius as a multiple of r0 (a spout widens to pour)
 *   len    — length along the exit direction; r0 — base radius
 */
export function pourSpout(THREE, { attach, angle = 0.5, flare = 1.5, r0 = 0.008, len = 0.035, seg = 12, materials = null, role = 'body' } = {}) {
  if (!isVec3(attach)) fail(`pourSpout attach must be [x, y, z] (got ${JSON.stringify(attach)})`);
  if (!(r0 > 0) || !(len > 0)) fail('pourSpout needs r0 > 0 and len > 0');
  if (!(flare > 0)) fail(`flare must be > 0 (got ${flare})`);
  const radial = new THREE.Vector3(attach[0], 0, attach[2]);
  if (radial.lengthSq() < 1e-9) fail('attach sits on the axis — a spout needs a wall point with a radial direction');
  radial.normalize();
  const dir = new THREE.Vector3(radial.x * Math.cos(angle), Math.sin(angle), radial.z * Math.cos(angle));
  const a = new THREE.Vector3().fromArray(attach);
  const embed = r0 * 0.8; // the join is embedded: the spout enters the wall
  const p0 = a.clone().addScaledVector(dir, -embed);
  const p1 = a.clone().addScaledVector(dir, len * 0.5).add(new THREE.Vector3(0, len * 0.06, 0));
  const p2 = a.clone().addScaledVector(dir, len);
  const sweep = variableRadiusSweep(THREE, {
    points: [p0.toArray(), p1.toArray(), p2.toArray()],
    radii: [r0, r0 * (1 + flare) * 0.55, r0 * flare],
    seg: 24, tubeSeg: seg,
  });
  const spout = sweep.parts.sweep;
  spout.material = materialFor(THREE, materials, role, { color: 0xc9b59b });
  spout.name = 'spout'; spout.userData.role = role; spout.userData.recipe = 'vessels/pourSpout';
  const group = new THREE.Group(); group.name = 'spout'; group.add(spout);
  return {
    group, parts: { spout }, materials: { [role]: spout.material },
    joins: { base: { type: 'embedded', at: attach, embed }, tip: { type: 'open', at: p2.toArray(), r: r0 * flare } },
  };
}

/**
 * Lid fitted to an opening of radius r — top disc plus a plug that drops
 * `lip` into the vessel. The plug radius is r − clearance: the clearance is
 * the join, and it is explicit so the lid never visibly intersects the rim.
 *   r — inner radius of the opening the lid fits
 *   clearance — radial gap between plug and wall (paper-thin default 1 mm)
 *   lip — how deep the plug descends; h — lid slab thickness; knob — add a
 *   small centered knob (the lift affordance)
 */
export function fittedLid(THREE, { r, clearance = 0.001, lip = 0.006, h = 0.006, knob = true, seg = 72, materials = null, role = 'lid' } = {}) {
  if (!(r > 0)) fail(`fittedLid radius must be > 0 (got ${r})`);
  if (!(clearance > 0 && clearance < r * 0.3)) fail(`clearance ${clearance} must be positive and ≪ r — a plug at r exactly never fits`);
  if (!(lip > 0) || !(h > 0)) fail('fittedLid needs lip > 0 and h > 0');
  const plug = r - clearance;
  const P = (x, y) => new THREE.Vector2(x, y);
  const pts = [
    P(0, 0), P(plug, 0), P(plug, lip),   // plug: bottom face, wall up to seat
    P(r, lip), P(r, lip + h),            // underside out to the edge, top edge
    P(0, lip + h),                       // top face back to the axis
  ];
  const lid = new THREE.Mesh(new THREE.LatheGeometry(pts, seg), materialFor(THREE, materials, role, { color: 0xc9b59b }));
  lid.name = 'lid'; lid.userData.role = role; lid.userData.recipe = 'vessels/fittedLid';
  const group = new THREE.Group(); group.name = 'lid'; group.add(lid);
  const parts = { lid };
  const mats = { [role]: lid.material };
  if (knob) {
    const k = new THREE.Mesh(new THREE.SphereGeometry(Math.min(r * 0.22, 0.012), 24, 16), lid.material);
    k.name = 'knob'; k.position.y = lip + h;
    k.scale.y = 0.75; // a flattened knob reads turned, not spherical
    k.userData.role = role; k.userData.recipe = 'vessels/fittedLid';
    group.add(k); parts.knob = k;
  }
  return {
    group, parts, materials: mats,
    joins: { seat: { type: 'plug-fit', plugR: plug, clearance, drop: lip } },
  };
}

/** Re-export so a scene module can pull vessels + the shared tube primitive
    from one import site. */
export { trail };

export default { hollowLathe, rim, footRing, pourSpout, fittedLid };
