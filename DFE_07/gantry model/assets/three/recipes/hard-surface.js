// 1DesignTool design-kit — hard-surface construction recipes (round16 §6.1
// table, work item R16-Q08). Panels, extrusions, legs, joined frames — the
// furniture/product grammar. Returns { group, parts, materials, joins? } —
// see recipes/README.md for the convention.
//
// Join semantics: a "butt" join overlaps members at full length (the overlap
// is hidden inside the joint); a "miter" join trims each member's end along
// the bisector of the meeting angle — implemented as a shortening of each
// member by w/2·tan(θ/2), which reads as a miter at product scale without a
// boolean kernel. Document which you used; the checker cannot tell an
// intentional overlap from a collision without it.
import { bevelBox, profileExtrude as profileExtrudeGeo } from '../parts.js';

const fail = (msg) => { throw new Error(`recipes/hard-surface: ${msg}`); };
const isVec3 = (p) => Array.isArray(p) && p.length === 3 && p.every(Number.isFinite);
const isVec2 = (p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite);

function materialFor(THREE, materials, role, defaults) {
  if (materials?.[role]) return materials[role];
  const m = new THREE.MeshStandardMaterial({ roughness: 0.6, metalness: 0, ...defaults });
  m.userData.role = role;
  return m;
}

/** Beveled panel — the workhorse slab. bevel is a fraction-appropriate edge
    radius (direction manifests express it as bevel_fraction_of_local_thickness;
    pass the resolved value). bevel 0 is legal for faceted/folded directions. */
export function beveledPanel(THREE, { w, h, d, bevel = 0, materials = null, role = 'body' } = {}) {
  const mesh = new THREE.Mesh(
    bevelBox(THREE, { w, h, d, r: bevel }),
    materialFor(THREE, materials, role, { color: 0xe8e4dc }),
  );
  mesh.name = 'panel'; mesh.userData.role = role; mesh.userData.recipe = 'hard-surface/beveledPanel';
  const group = new THREE.Group(); group.name = 'panel'; group.add(mesh);
  return { group, parts: { panel: mesh }, materials: { [role]: mesh.material } };
}

/** 2D profile extruded to depth — brackets, plaques, key faces. Points are
    [[x, y], …] in the profile plane; extrusion runs +Z with the given bevel. */
export function profileExtrude(THREE, { points, depth, bevel = 0, materials = null, role = 'body' } = {}) {
  if (!Array.isArray(points) || points.length < 3 || points.some((p) => !isVec2(p))) {
    fail('profileExtrude needs ≥ 3 [x, y] points');
  }
  const mesh = new THREE.Mesh(
    profileExtrudeGeo(THREE, { points, depth, bevel }),
    materialFor(THREE, materials, role, { color: 0xe8e4dc }),
  );
  mesh.name = 'extrusion'; mesh.userData.role = role; mesh.userData.recipe = 'hard-surface/profileExtrude';
  const group = new THREE.Group(); group.name = 'extrusion'; group.add(mesh);
  return { group, parts: { extrusion: mesh }, materials: { [role]: mesh.material } };
}

/**
 * Tapered leg — origin at the TOP mount (y=0), extending down −Y for h.
 * rTop meets the apron/seat; rBottom meets the floor. A taper where the foot
 * is thinner than the hip reads as furniture; a uniform cylinder reads as a
 * pipe.
 */
export function taperedLeg(THREE, { h, rTop, rBottom, seg = 32, materials = null, role = 'leg' } = {}) {
  if (!(h > 0) || !(rTop > 0) || !(rBottom > 0)) fail('taperedLeg needs h, rTop, rBottom all > 0');
  const geo = new THREE.CylinderGeometry(rTop, rBottom, h, seg);
  geo.translate(0, -h / 2, 0); // origin at the mount — legs hang from what holds them
  const mesh = new THREE.Mesh(geo, materialFor(THREE, materials, role, { color: 0x8a6f55 }));
  mesh.name = 'leg'; mesh.userData.role = role; mesh.userData.recipe = 'hard-surface/taperedLeg';
  const group = new THREE.Group(); group.name = 'leg'; group.add(mesh);
  return {
    group, parts: { leg: mesh }, materials: { [role]: mesh.material },
    joins: { mount: { type: 'top-mount', at: [0, 0, 0], r: rTop }, foot: { type: 'contact-point', at: [0, -h, 0], r: rBottom } },
  };
}

/**
 * Frame of rectangular-section members between named endpoints.
 *   members — [{ from: [x,y,z], to: [x,y,z], w, d }] section w×d along the axis
 *   miter   — false: butt joins, members run full length and overlap inside
 *             the joint (the hidden-overlap convention); true: each member is
 *             shortened at shared ends by w/2·tan(θ/2), an approximation of a
 *             bisector cut that reads as a miter without CSG.
 * Returned joins[] records every shared vertex so a reviewer can check the
 * intent (and so lint can tell a designed joint from a stray overlap).
 */
export function joinedFrame(THREE, { members, miter = false, materials = null, role = 'frame' } = {}) {
  if (!Array.isArray(members) || !members.length) fail('joinedFrame needs a non-empty members array');
  members.forEach((m, i) => {
    if (!isVec3(m.from) || !isVec3(m.to)) fail(`members[${i}] needs from/to [x,y,z]`);
    if (!(m.w > 0) || !(m.d > 0)) fail(`members[${i}] needs w > 0 and d > 0 (the section)`);
  });
  const EPS = 1e-6;
  // Shared-endpoint joints: where members meet, compute the meeting angle so
  // a miter can shorten each member into the bisector plane.
  const jointAt = members.map(() => ({ from: [], to: [] }));
  const joins = [];
  members.forEach((a, i) => {
    members.forEach((b, j) => {
      if (i >= j) return;
      for (const [ea, pa] of [['from', a.from], ['to', a.to]]) {
        for (const [eb, pb] of [['from', b.from], ['to', b.to]]) {
          if (pa.every((v, k) => Math.abs(v - pb[k]) < 1e-4)) {
            jointAt[i][ea].push(j); jointAt[j][eb].push(i);
            joins.push({ members: [i, j], at: pa, type: miter ? 'miter' : 'butt' });
          }
        }
      }
    });
  });
  const mat = materialFor(THREE, materials, role, { color: 0x8a6f55 });
  const group = new THREE.Group(); group.name = 'frame';
  const parts = {};
  members.forEach((m, i) => {
    const a = new THREE.Vector3().fromArray(m.from);
    const b = new THREE.Vector3().fromArray(m.to);
    const axis = b.clone().sub(a);
    let len = axis.length();
    if (len < EPS) fail(`members[${i}] has zero length`);
    const dir = axis.clone().normalize();
    let trimA = 0, trimB = 0;
    if (miter) {
      const trimFor = (me, myEnd, others) => others.reduce((trim, j) => {
        const o = members[j];
        const oa = new THREE.Vector3().fromArray(o.from), ob = new THREE.Vector3().fromArray(o.to);
        const oDir = ob.sub(oa).normalize();
        const cos = Math.min(1, Math.abs(dir.dot(oDir)));
        const theta = Math.acos(cos);
        if (theta < 1e-3) return trim; // collinear — nothing to miter
        return Math.max(trim, (Math.max(m.w, m.d) / 2) / Math.tan(theta / 2));
      }, 0);
      trimA = trimFor(i, 'from', jointAt[i].from);
      trimB = trimFor(i, 'to', jointAt[i].to);
      if (trimA + trimB >= len) fail(`members[${i}] would be mitered away entirely — reduce member count or width`);
      len -= trimA + trimB;
    }
    const geo = new THREE.BoxGeometry(m.w, len, m.d);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = `member-${i}`;
    mesh.userData.role = role; mesh.userData.recipe = 'hard-surface/joinedFrame';
    mesh.position.copy(a).addScaledVector(dir, trimA + len / 2);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    group.add(mesh);
    parts[`member_${i}`] = mesh;
  });
  return { group, parts, materials: { [role]: mat }, joins };
}

export default { beveledPanel, profileExtrude, taperedLeg, joinedFrame };
