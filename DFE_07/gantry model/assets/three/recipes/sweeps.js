// 1DesignTool design-kit — sweep & ribbon recipes (round16 §6.1 table, work
// item R16-Q08). Variable-radius tubes along paths and fitted ribbons for
// vessels' handles, garment hems, and surface trim.
//
// Convention: all functions take (THREE, params) and return
// { group, parts, materials } — see recipes/README.md.
//
// The fixed-profile variant of these shapes already exists as parts.trail —
// these recipes add radius/per-point control the base primitive keeps out of
// scope on purpose.
import { trail } from '../parts.js';

const fail = (msg) => { throw new Error(`recipes/sweeps: ${msg}`); };
const isVec3 = (p) => Array.isArray(p) && p.length === 3 && p.every(Number.isFinite);
const isVec2 = (p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite);

function materialFor(THREE, materials, role, defaults) {
  if (materials?.[role]) return materials[role];
  const m = new THREE.MeshStandardMaterial({ roughness: 0.65, metalness: 0, ...defaults });
  m.userData.role = role;
  return m;
}

/** Shared tube builder: rings of `tubeSeg` points on the path's Frenet frames,
    radius interpolated along `radii` (one per control point), capped by fans. */
function sweepTube(THREE, { points, radiusAt, seg, tubeSeg }) {
  const curve = new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3().fromArray(p)));
  const frames = curve.computeFrenetFrames(seg, false);
  const m = tubeSeg;
  const rings = seg + 1;
  const positions = new Float32Array((rings * m + 2) * 3);
  const uvs = new Float32Array((rings * m + 2) * 2);
  const tmp = new THREE.Vector3();
  const write = (i, v) => { positions[i * 3] = v.x; positions[i * 3 + 1] = v.y; positions[i * 3 + 2] = v.z; };
  for (let i = 0; i < rings; i++) {
    const u = i / seg;
    const c = curve.getPointAt(u);
    const N = frames.normals[i], B = frames.binormals[i];
    const r = radiusAt(u);
    for (let j = 0; j < m; j++) {
      const a = (j / m) * Math.PI * 2;
      tmp.copy(c).addScaledVector(N, Math.cos(a) * r).addScaledVector(B, Math.sin(a) * r);
      const vi = i * m + j;
      write(vi, tmp);
      uvs[vi * 2] = j / m; uvs[vi * 2 + 1] = u;
    }
  }
  const capA = rings * m, capB = capA + 1;
  write(capA, curve.getPointAt(0));
  write(capB, curve.getPointAt(1));
  const index = [];
  for (let i = 0; i < seg; i++) {
    for (let j = 0; j < m; j++) {
      const a = i * m + j, b = i * m + ((j + 1) % m);
      const c = (i + 1) * m + j, d = (i + 1) * m + ((j + 1) % m);
      index.push(a, c, b, b, c, d);
    }
  }
  for (let j = 0; j < m; j++) {
    index.push(capA, (j + 1) % m, j);
    index.push(capB, seg * m + j, seg * m + ((j + 1) % m));
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.setIndex(index);
  geo.computeVertexNormals();
  return geo;
}

/**
 * Tube along a path whose radius varies — handles that swell at the grip,
 * tails that taper, spouts that flare.
 *   points — ≥ 2 control points [x, y, z]; radii — one positive radius per
 *   control point, interpolated linearly along the curve parameter.
 *   radii: [r0] alone broadcasts a constant radius (equivalent to parts.tube).
 */
export function variableRadiusSweep(THREE, { points, radii, seg = 48, tubeSeg = 12, materials = null, role = 'sweep' } = {}) {
  if (!Array.isArray(points) || points.length < 2 || points.some((p) => !isVec3(p))) {
    fail('variableRadiusSweep needs ≥ 2 points [x, y, z]');
  }
  if (radii == null) fail('radii required — a radius is the whole point of this recipe');
  const rs = Array.isArray(radii) ? radii : [radii];
  if (rs.length !== 1 && rs.length !== points.length) {
    fail(`radii length ${rs.length} must be 1 or equal points length ${points.length}`);
  }
  if (rs.some((r) => !(r > 0))) fail(`radii must all be > 0 (got ${JSON.stringify(rs)})`);
  if (!(seg >= 2 && Number.isInteger(seg)) || !(tubeSeg >= 3 && Number.isInteger(tubeSeg))) {
    fail('seg must be an integer ≥ 2, tubeSeg an integer ≥ 3');
  }
  const radiusAt = rs.length === 1 ? () => rs[0] : (u) => {
    const f = u * (rs.length - 1);
    const k = Math.min(rs.length - 2, Math.floor(f));
    return rs[k] + (rs[k + 1] - rs[k]) * (f - k);
  };
  const mesh = new THREE.Mesh(sweepTube(THREE, { points, radiusAt, seg, tubeSeg }), materialFor(THREE, materials, role, { color: 0xc9b59b }));
  mesh.name = 'sweep'; mesh.userData.role = role; mesh.userData.recipe = 'sweeps/variableRadiusSweep';
  const group = new THREE.Group(); group.name = 'sweep'; group.add(mesh);
  return { group, parts: { sweep: mesh }, materials: { [role]: mesh.material } };
}

/**
 * Ribbon fitted to a path — a strip of rectangular cross-section swept along
 * `path`. "Fitted" means the caller supplies the path already offset from the
 * surface it hugs (wall radius + clearance); the ribbon hugs because the path
 * does. width lies along the Frenet normal, thickness along the binormal —
 * for a vertical wall path with up-ish tangents, width runs horizontally.
 *   path — ≥ 2 points; width, thickness — cross-section; both > 0
 */
export function fittedRibbon(THREE, { path, width, thickness, seg = 48, materials = null, role = 'trim' } = {}) {
  if (!Array.isArray(path) || path.length < 2 || path.some((p) => !isVec3(p))) {
    fail('fittedRibbon needs ≥ 2 path points [x, y, z]');
  }
  if (!(width > 0) || !(thickness > 0)) fail(`fittedRibbon needs width > 0 and thickness > 0 (got ${width} × ${thickness})`);
  if (!(seg >= 2 && Number.isInteger(seg))) fail('seg must be an integer ≥ 2');
  const w = width / 2, t = thickness / 2;
  const profile = [[-w, -t], [w, -t], [w, t], [-w, t]];
  const mesh = trail(THREE, { points: path, profile, seg });
  mesh.material = materialFor(THREE, materials, role, { color: 0xb8b4ac });
  mesh.name = 'ribbon'; mesh.userData.role = role; mesh.userData.recipe = 'sweeps/fittedRibbon';
  const group = new THREE.Group(); group.name = 'ribbon'; group.add(mesh);
  return { group, parts: { ribbon: mesh }, materials: { [role]: mesh.material } };
}

/** Convenience: constant-radius tube via the same recipe layer. Prefer
    parts.tube inside build() when you do not need the recipe return shape. */
export function tubeSweep(THREE, { points, r, seg = 48, tubeSeg = 12, closed = false, materials = null, role = 'sweep' } = {}) {
  const out = variableRadiusSweep(THREE, {
    points: closed ? [...points, points[0]] : points,
    radii: new Array(closed ? points.length + 1 : points.length).fill(r),
    seg, tubeSeg, materials, role,
  });
  out.parts.sweep.userData.recipe = 'sweeps/tubeSweep';
  return out;
}

export default { variableRadiusSweep, fittedRibbon, tubeSweep };
