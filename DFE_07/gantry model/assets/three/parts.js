// 1DesignTool design-kit — parameterized 3D part library (round16 §6.1,
// work item R16-Q08).
//
// Reusable construction pieces for scene modules. Every function takes the
// pinned THREE build as its first argument and returns a BufferGeometry, a
// Mesh, or a small Group — there is deliberately no `import 'three'` here so
// the module loads under plain Node for tests:
//
//   import * as THREE from '../vendor/three/three.module.js';
//   const body = parts.bevelBox(THREE, { w: 0.1, h: 0.05, d: 0.08, r: 0.008 });
//
// Conventions:
//   - Parameters are validated; invalid input throws `Error('parts/<fn>: …')`.
//     A recipe that cannot validate its parameters cannot promise its output.
//   - Pass opts.id / opts.role / opts.recipe to stamp userData
//     {partId, role, recipe} on the returned object — the semantic id is the
//     caller's (register the mesh with lib.parts.add for the dotted id).
//   - Nothing here allocates global state; same arguments → same geometry.
//   - Meshes that need materials take opts.material; omitted material gets a
//     neutral standard material so geometry review is never blocked on looks.

const fail = (fn, msg) => { throw new Error(`parts/${fn}: ${msg}`); };

const isNum = (v) => Number.isFinite(v);
const isVec = (v, n) => Array.isArray(v) && v.length === n && v.every(isNum);

function num(fn, name, v, { min = -Infinity, max = Infinity, exclusiveMin = false, int = false } = {}) {
  if (!isNum(v)) fail(fn, `${name} must be a finite number (got ${JSON.stringify(v)})`);
  if (int && !Number.isInteger(v)) fail(fn, `${name} must be an integer (got ${v})`);
  if (exclusiveMin ? v <= min : v < min) fail(fn, `${name} must be ${exclusiveMin ? '>' : '≥'} ${min} (got ${v})`);
  if (v > max) fail(fn, `${name} must be ≤ ${max} (got ${v})`);
  return v;
}

function vec(fn, name, v) {
  if (!isVec(v, 3)) fail(fn, `${name} must be [x, y, z] of finite numbers (got ${JSON.stringify(v)})`);
  return v;
}

function pts2(fn, name, v, min = 2) {
  if (!Array.isArray(v) || v.length < min) fail(fn, `${name} needs ≥ ${min} [x, y] points`);
  for (const p of v) if (!isVec(p, 2)) fail(fn, `${name}: bad point ${JSON.stringify(p)} — expected [x, y]`);
  return v;
}

function pts3(fn, name, v, min = 2) {
  if (!Array.isArray(v) || v.length < min) fail(fn, `${name} needs ≥ ${min} [x, y, z] points`);
  for (const p of v) if (!isVec(p, 3)) fail(fn, `${name}: bad point ${JSON.stringify(p)} — expected [x, y, z]`);
  return v;
}

/** Stamp caller semantics onto whatever the helper returns. */
function stamp(target, opts, recipe) {
  if (!target || !target.userData) return target;
  if (opts.id) target.userData.partId = opts.id;
  if (opts.role) target.userData.role = opts.role;
  target.userData.recipe = opts.recipe || recipe;
  return target;
}

function defaultMaterial(THREE) {
  return new THREE.MeshStandardMaterial({ color: 0xcccccc, roughness: 0.7, metalness: 0 });
}

/* ------------------------------------------------------------- primitives */

/**
 * Rounded box via clamp-and-normalize: a subdivided box whose vertices are
 * projected onto `inner box + radius r`. Normals are the projection direction
 * (exact for a rounded box), NOT computeVertexNormals — box vertices are
 * duplicated per face, so averaging would facet the rounds.
 * r = 0 is legal: directions whose edge policy is "faceted" pass it through.
 */
export function bevelBox(THREE, { w, h, d, r = 0, seg = 4, ...opts } = {}) {
  const fn = 'bevelBox';
  num(fn, 'w', w, { min: 0, exclusiveMin: true });
  num(fn, 'h', h, { min: 0, exclusiveMin: true });
  num(fn, 'd', d, { min: 0, exclusiveMin: true });
  num(fn, 'r', r, { min: 0 });
  num(fn, 'seg', seg, { min: 1, int: true });
  const half = Math.min(w, h, d) / 2;
  if (r >= half) fail(fn, `r ${r} must be < half the smallest extent (${half}) — a radius at half-depth is a capsule end, not an edge`);
  const geo = new THREE.BoxGeometry(w, h, d, seg, seg, seg);
  if (r === 0) return stamp(geo, opts, 'bevelBox');
  const iw = w / 2 - r, ih = h / 2 - r, id = d / 2 - r;
  const pos = geo.attributes.position;
  const normals = new Float32Array(pos.count * 3);
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const cx = clamp(x, -iw, iw), cy = clamp(y, -ih, ih), cz = clamp(z, -id, id);
    let nx = x - cx, ny = y - cy, nz = z - cz;
    let len = Math.hypot(nx, ny, nz);
    if (len < 1e-9) {
      // Interior grid vertex: fall back to the dominant original axis.
      const ax = Math.abs(x), ay = Math.abs(y), az = Math.abs(z);
      nx = ny = nz = 0;
      if (ax >= ay && ax >= az) nx = Math.sign(x) || 1;
      else if (ay >= az) ny = Math.sign(y) || 1;
      else nz = Math.sign(z) || 1;
      len = 1;
    }
    nx /= len; ny /= len; nz /= len;
    pos.setXYZ(i, cx + nx * r, cy + ny * r, cz + nz * r);
    normals[i * 3] = nx; normals[i * 3 + 1] = ny; normals[i * 3 + 2] = nz;
  }
  geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  pos.needsUpdate = true;
  geo.computeBoundingSphere();
  return stamp(geo, opts, 'bevelBox');
}

/**
 * Cylinder with rounded cap edges, built as a lathe profile: up the flat
 * bottom, around the bevel, up the side, over the top bevel, in to the axis.
 * bevel = 0 degenerates to a plain cylinder profile.
 */
export function roundedCyl(THREE, { r, h, bevel = 0, seg = 48, capSeg = 5, ...opts } = {}) {
  const fn = 'roundedCyl';
  num(fn, 'r', r, { min: 0, exclusiveMin: true });
  num(fn, 'h', h, { min: 0, exclusiveMin: true });
  num(fn, 'bevel', bevel, { min: 0 });
  num(fn, 'seg', seg, { min: 3, int: true });
  num(fn, 'capSeg', capSeg, { min: 1, int: true });
  if (bevel >= Math.min(r, h / 2)) fail(fn, `bevel ${bevel} must be < min(r, h/2) — it would swallow the part`);
  const P = (x, y) => new THREE.Vector2(x, y);
  const profile = [P(0, 0)];
  if (bevel > 0) {
    profile.push(P(r - bevel, 0));
    for (let i = 1; i <= capSeg; i++) {
      const a = -Math.PI / 2 + (i / capSeg) * (Math.PI / 2);
      profile.push(P(r - bevel + bevel * Math.cos(a), bevel + bevel * Math.sin(a)));
    }
    profile.push(P(r, h - bevel));
    for (let i = 1; i <= capSeg; i++) {
      const a = (i / capSeg) * (Math.PI / 2);
      profile.push(P(r - bevel + bevel * Math.cos(a), h - bevel + bevel * Math.sin(a)));
    }
    profile.push(P(0, h));
  } else {
    profile.push(P(r, 0), P(r, h), P(0, h));
  }
  return stamp(new THREE.LatheGeometry(profile, seg), opts, 'roundedCyl');
}

/** Torus with parameter validation. Ring lies in the XY plane (axis +Z);
    rotate x by π/2 to lay it flat on the ground. tube ≥ R self-intersects
    (a spindle) — rejected so the failure is a message, not a silhouette. */
export function bevelTorus(THREE, { R, tube, seg = 64, tubeSeg = 16, ...opts } = {}) {
  const fn = 'bevelTorus';
  num(fn, 'R', R, { min: 0, exclusiveMin: true });
  num(fn, 'tube', tube, { min: 0, exclusiveMin: true });
  num(fn, 'seg', seg, { min: 3, int: true });
  num(fn, 'tubeSeg', tubeSeg, { min: 3, int: true });
  if (tube >= R) fail(fn, `tube ${tube} must be < R ${R} — a spindle torus is never intentional here`);
  return stamp(new THREE.TorusGeometry(R, tube, tubeSeg, seg), opts, 'bevelTorus');
}

/**
 * Lathe a 2D profile [[r, y], …] around +Y. y must be non-decreasing —
 * a descending profile doubles back on itself and produces self-intersection
 * that only shows up in render. r ≥ 0; use 0 at the axis (floor/dome tips).
 */
export function lathe(THREE, { profile, seg = 64, ...opts } = {}) {
  const fn = 'lathe';
  pts2(fn, 'profile', profile, 2);
  num(fn, 'seg', seg, { min: 3, int: true });
  let lastY = -Infinity;
  for (const [r, y] of profile) {
    if (r < 0) fail(fn, `profile radius must be ≥ 0 (got ${r})`);
    if (y < lastY) fail(fn, `profile y must be non-decreasing (${y} after ${lastY}) — the surface would fold back on itself`);
    lastY = y;
  }
  const pts = profile.map(([r, y]) => new THREE.Vector2(r, y));
  return stamp(new THREE.LatheGeometry(pts, seg), opts, 'lathe');
}

/** Closed 2D Shape from [[x, y], …] — input for profileExtrude or direct
    ShapeGeometry use. ≥ 3 points; the shape is implicitly closed. */
export function profileShape(THREE, { points, ...opts } = {}) {
  const fn = 'profileShape';
  pts2(fn, 'points', points, 3);
  return stamp(new THREE.Shape(points.map(([x, y]) => new THREE.Vector2(x, y))), opts, 'profileShape');
}

/** Extrude a 2D profile along +Z with a small manufactured bevel.
    bevel is capped below depth/2 — a bevel deeper than the part self-intersects. */
export function profileExtrude(THREE, { points, depth, bevel = 0, bevelSeg = 2, curveSeg = 8, ...opts } = {}) {
  const fn = 'profileExtrude';
  pts2(fn, 'points', points, 3);
  num(fn, 'depth', depth, { min: 0, exclusiveMin: true });
  num(fn, 'bevel', bevel, { min: 0 });
  if (bevel >= depth / 2) fail(fn, `bevel ${bevel} must be < depth/2 (${depth / 2})`);
  const shape = profileShape(THREE, { points });
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth, curveSegments: curveSeg,
    bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel, bevelSegments: bevelSeg,
  });
  return stamp(geo, opts, 'profileExtrude');
}

/** Flat annulus of height h standing on +Y — trim rings, foot rings, sockets.
    The profile is a closed loop so the band has a real inner and outer wall. */
export function ring(THREE, { rOuter, rInner, h, seg = 64, ...opts } = {}) {
  const fn = 'ring';
  num(fn, 'rOuter', rOuter, { min: 0, exclusiveMin: true });
  num(fn, 'rInner', rInner, { min: 0, exclusiveMin: true });
  num(fn, 'h', h, { min: 0, exclusiveMin: true });
  num(fn, 'seg', seg, { min: 3, int: true });
  if (rInner >= rOuter) fail(fn, `rInner ${rInner} must be < rOuter ${rOuter} — a ring needs a hole`);
  const P = (x, y) => new THREE.Vector2(x, y);
  const profile = [P(rInner, 0), P(rOuter, 0), P(rOuter, h), P(rInner, h), P(rInner, 0)];
  return stamp(new THREE.LatheGeometry(profile, seg), opts, 'ring');
}

/**
 * Tapered limb between two points — arms, legs, struts. Returns a Mesh whose
 * origin sits at `from` and whose +Y aims at `to`, so it pivots at its root
 * (set rotation via quaternion, or re-aim with another limb call).
 * r0 = radius at `from`, r1 at `to`; a rigid toy limb promises articulation
 * at its joints, never mid-limb bending.
 */
export function limb(THREE, { from, to, r0, r1 = r0, seg = 24, material = null, ...opts } = {}) {
  const fn = 'limb';
  vec(fn, 'from', from); vec(fn, 'to', to);
  num(fn, 'r0', r0, { min: 0, exclusiveMin: true });
  num(fn, 'r1', r1, { min: 0, exclusiveMin: true });
  num(fn, 'seg', seg, { min: 3, int: true });
  const a = new THREE.Vector3().fromArray(from);
  const b = new THREE.Vector3().fromArray(to);
  const len = a.distanceTo(b);
  if (len < 1e-6) fail(fn, 'from and to coincide — a zero-length limb is not a part');
  const geo = new THREE.CylinderGeometry(r1, r0, len, seg);
  geo.translate(0, len / 2, 0); // base at origin, tip toward +Y
  const mesh = new THREE.Mesh(geo, material || defaultMaterial(THREE));
  mesh.position.copy(a);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
  mesh.userData.length = len;
  return stamp(mesh, opts, 'limb');
}

/** Peg for a revolute/peg joint: cylinder along +Y, base at origin. Pair it
    with socket() — the joint reads because both halves exist. */
export function jointPeg(THREE, { r, len, seg = 24, ...opts } = {}) {
  const fn = 'jointPeg';
  num(fn, 'r', r, { min: 0, exclusiveMin: true });
  num(fn, 'len', len, { min: 0, exclusiveMin: true });
  num(fn, 'seg', seg, { min: 3, int: true });
  const geo = new THREE.CylinderGeometry(r, r, len, seg);
  geo.translate(0, len / 2, 0);
  return stamp(geo, opts, 'jointPeg');
}

/** Socket that receives a peg of radius r: a sleeve of inner radius r,
    wall thickness `wall`, depth `len`, base at y=0. The clearance between
    peg and socket is the caller's design decision (r is the *hole*). */
export function socket(THREE, { r, len, wall, seg = 48, ...opts } = {}) {
  const fn = 'socket';
  num(fn, 'r', r, { min: 0, exclusiveMin: true });
  num(fn, 'len', len, { min: 0, exclusiveMin: true });
  num(fn, 'wall', wall, { min: 0, exclusiveMin: true });
  return stamp(ring(THREE, { rOuter: r + wall, rInner: r, h: len, seg }), { ...opts }, 'socket');
}

/**
 * Sweep a closed cross-section profile along a Catmull-Rom path — handles,
 * straps, cords. profile is [[x, y], …] in the ring plane (≥ 3 points,
 * implicitly closed); points is the path (≥ 2). Ends are capped by a fan to
 * the profile centroid so the tube reads solid in close-ups.
 * Tangents/frames come from the curve's own Frenet sampling (arc-length
 * parameterized), so ring spacing follows the curve, not the control points.
 */
export function trail(THREE, { points, profile, seg = 32, material = null, ...opts } = {}) {
  const fn = 'trail';
  pts3(fn, 'points', points, 2);
  pts2(fn, 'profile', profile, 3);
  num(fn, 'seg', seg, { min: 2, int: true });
  const curve = new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3().fromArray(p)));
  const frames = curve.computeFrenetFrames(seg, false);
  const m = profile.length;
  const rings = seg + 1;
  const positions = new Float32Array((rings * m + 2) * 3);
  const uvs = new Float32Array((rings * m + 2) * 2);
  const centroid = profile.reduce((c, [x, y]) => [c[0] + x / m, c[1] + y / m], [0, 0]);
  const write = (idx, v) => { positions[idx * 3] = v.x; positions[idx * 3 + 1] = v.y; positions[idx * 3 + 2] = v.z; };
  const tmp = new THREE.Vector3();
  for (let i = 0; i < rings; i++) {
    const u = i / seg;
    const c = curve.getPointAt(u);
    const N = frames.normals[i], B = frames.binormals[i];
    for (let j = 0; j < m; j++) {
      const [px, py] = profile[j];
      tmp.copy(c).addScaledVector(N, px).addScaledVector(B, py);
      const vi = i * m + j;
      write(vi, tmp);
      uvs[vi * 2] = j / m; uvs[vi * 2 + 1] = u;
    }
  }
  const capA = rings * m, capB = capA + 1; // start and end cap centers
  write(capA, tmp.copy(curve.getPointAt(0)).addScaledVector(frames.normals[0], centroid[0]).addScaledVector(frames.binormals[0], centroid[1]));
  write(capB, tmp.copy(curve.getPointAt(1)).addScaledVector(frames.normals[seg], centroid[0]).addScaledVector(frames.binormals[seg], centroid[1]));
  const index = [];
  for (let i = 0; i < seg; i++) {
    for (let j = 0; j < m; j++) {
      const a = i * m + j, b = i * m + ((j + 1) % m);
      const c = (i + 1) * m + j, d = (i + 1) * m + ((j + 1) % m);
      index.push(a, c, b, b, c, d);
    }
  }
  for (let j = 0; j < m; j++) { // end caps: fans over the first/last ring
    index.push(capA, (j + 1) % m, j);
    index.push(capB, seg * m + j, seg * m + ((j + 1) % m));
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.setIndex(index);
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, material || defaultMaterial(THREE));
  return stamp(mesh, opts, 'trail');
}

/** Constant-radius tube along a Catmull-Rom path — the simple case of trail().
    points are [x,y,z]; r is the tube radius; closed joins the loop. */
export function tube(THREE, { points, r, seg = 48, tubeSeg = 12, closed = false, ...opts } = {}) {
  const fn = 'tube';
  pts3(fn, 'points', points, 2);
  num(fn, 'r', r, { min: 0, exclusiveMin: true });
  num(fn, 'seg', seg, { min: 2, int: true });
  num(fn, 'tubeSeg', tubeSeg, { min: 3, int: true });
  const curve = new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3().fromArray(p)), closed);
  return stamp(new THREE.TubeGeometry(curve, seg, r, tubeSeg, closed), opts, 'tube');
}

/**
 * Deterministic placement of many copies — gravel, foliage, voxel cells.
 * `place(i, rng)` returns {position:[x,y,z], rotation?:[rx,ry,rz],
 * scale?: s | [sx,sy,sz]} per instance; rng is mulberry32(seed) so the field
 * is identical on every run and every seek. One draw call, one geometry —
 * that is the point of instancing (voxel direction's draw-call budget
 * depends on it).
 */
export function instancedField(THREE, { geometry, material, count, place, seed = 1, ...opts } = {}) {
  const fn = 'instancedField';
  if (!geometry || !geometry.attributes?.position) fail(fn, 'geometry must be a BufferGeometry with a position attribute');
  if (!material) fail(fn, 'material required — instanced cells share one material by design');
  num(fn, 'count', count, { min: 1, int: true });
  if (typeof place !== 'function') fail(fn, 'place(i, rng) callback required — deterministic placement is the contract');
  num(fn, 'seed', seed);
  let a = (seed >>> 0) || 1;
  const rng = () => { // mulberry32 — same stream as lib.seededRandom
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const mesh = new THREE.InstancedMesh(geometry, material, count);
  const M = new THREE.Matrix4(), P = new THREE.Vector3(), Q = new THREE.Quaternion(), S = new THREE.Vector3(), E = new THREE.Euler();
  for (let i = 0; i < count; i++) {
    const spec = place(i, rng) || {};
    P.fromArray(spec.position || [0, 0, 0]);
    if (spec.rotation) { E.set(spec.rotation[0], spec.rotation[1], spec.rotation[2]); Q.setFromEuler(E); } else Q.identity();
    const s = spec.scale ?? 1;
    if (Array.isArray(s)) S.fromArray(s); else S.setScalar(s);
    M.compose(P, Q, S);
    mesh.setMatrixAt(i, M);
  }
  mesh.instanceMatrix.needsUpdate = true;
  return stamp(mesh, opts, 'instancedField');
}

/* --------------------------------------------------------- people things */

/**
 * Versioned body-landmark ratios as fractions of total height — a starting
 * proportion set, not a constructed anatomy. Multiply by your subject's
 * height to get dimensions. Presets:
 *   toy            ~4.5 heads — mascots, lacquer toys
 *   chibi          ~2.5 heads — soft clay, toon, voxel figures
 *   stylised-human ~6 heads   — stylized people
 *   realistic      ~7.5 heads — realistic proportion
 */
const PROPORTION_PRESETS = {
  'toy':            { headH: 0.222, torsoH: 0.28, legLen: 0.30, armReach: 0.30, eyeY: 0.82 },
  'chibi':          { headH: 0.400, torsoH: 0.24, legLen: 0.20, armReach: 0.24, eyeY: 0.70 },
  'stylised-human': { headH: 0.167, torsoH: 0.28, legLen: 0.42, armReach: 0.36, eyeY: 0.90 },
  'realistic':      { headH: 0.133, torsoH: 0.30, legLen: 0.47, armReach: 0.38, eyeY: 0.93 },
};
export function proportions(preset) {
  const p = PROPORTION_PRESETS[preset];
  if (!p) fail('proportions', `unknown preset ${JSON.stringify(preset)} — known: ${Object.keys(PROPORTION_PRESETS).join(', ')}`);
  return { preset, ...p };
}
export const PROPORTION_PRESET_NAMES = Object.keys(PROPORTION_PRESETS);

/**
 * Painted-face eyes as flat circular decals — the canvas-free route to a
 * graphic face. positions are [x,y,z] on the face surface (two for a pair);
 * each circle lies in the plane facing `normal` (default +Z), lifted `offset`
 * above the surface so it never z-fights. Returns a Group of named meshes —
 * register them under the head's part id, not the scene root.
 * NOTE (round16 §6.1): painted faces serve toys/mascots; a brief needing eye
 * volume, a mouth cavity or deforming lids takes the geometric route instead.
 */
export function eyeDecals(THREE, { positions, radius, material = null, normal = [0, 0, 1], offset = 0.002, ...opts } = {}) {
  const fn = 'eyeDecals';
  pts3(fn, 'positions', positions, 1);
  num(fn, 'radius', radius, { min: 0, exclusiveMin: true });
  vec(fn, 'normal', normal);
  num(fn, 'offset', offset, { min: 0 });
  const n = new THREE.Vector3().fromArray(normal).normalize();
  const mat = material || new THREE.MeshStandardMaterial({ color: 0x1d2127, roughness: 0.5, metalness: 0 });
  const group = new THREE.Group();
  group.name = 'eye-decals';
  const geo = new THREE.CircleGeometry(radius, 24);
  const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
  positions.forEach((p, i) => {
    const eye = new THREE.Mesh(geo, mat);
    eye.name = `eye-${i}`;
    eye.quaternion.copy(quat);
    eye.position.fromArray(p).addScaledVector(n, offset);
    stamp(eye, { role: opts.role || 'face' }, 'eyeDecals');
    group.add(eye);
  });
  return stamp(group, opts, 'eyeDecals');
}

/**
 * Graphic face texture from a caller-drawn 2D canvas — the painted-face
 * recipe (round16 §6.1). The canvas is explicit so the kit stays DOM-free:
 * draw it in the page, pass it here, get a correctly color-spaced texture.
 * UV offsets on this texture are NOT portable animation (the r180 exporter
 * does not carry uv transforms) — blinks need geometric lids or morphs.
 */
export function faceTexture(THREE, canvas, { colorSpace = null, ...opts } = {}) {
  const fn = 'faceTexture';
  if (!canvas || typeof canvas !== 'object' || !(canvas.width > 0 && canvas.height > 0)) {
    fail(fn, 'a drawn canvas (with width/height) is required — node tests cannot exercise this path');
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = colorSpace || THREE.SRGBColorSpace;
  tex.flipY = true;
  stamp(tex, opts, 'faceTexture');
  return tex;
}

export default {
  bevelBox, roundedCyl, bevelTorus, lathe, profileShape, profileExtrude, ring,
  limb, jointPeg, socket, trail, tube, instancedField,
  proportions, PROPORTION_PRESET_NAMES, eyeDecals, faceTexture,
};
