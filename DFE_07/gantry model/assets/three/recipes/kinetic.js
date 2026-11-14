// 1DesignTool design-kit — kinetic construction recipes (round16 §6.1 table
// + §6.6, work item R16-Q08/R16-Q19). Jointed structures that declare their
// axes and limits, and a baked crank-slider drive.
//
// Convention: (THREE, params) → { group, parts, materials, joins? } plus
// recipe-specific controllers (set(), clip). Moving parts expose pivots —
// rotate the pivot Group, never edit the mesh under it.
//
// Baking note (round16 §8): live motion curves are viewer-side. For GLB,
// bake rotations into tracks — cyclicDrive shows the pattern. Keep node names
// simple ('wheel', 'slider', 'rod'): glTF animation binds by node name and
// dots are sanitized to '' by the exporter.
import { crankSlider } from '../motion.js';
import { limb } from '../parts.js';

const fail = (msg) => { throw new Error(`recipes/kinetic: ${msg}`); };
const isVec3 = (p) => Array.isArray(p) && p.length === 3 && p.every(Number.isFinite);

function materialFor(THREE, materials, role, defaults) {
  if (materials?.[role]) return materials[role];
  const m = new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0.1, ...defaults });
  m.userData.role = role;
  return m;
}

/**
 * Pivot chain — nested pivot Groups, each carrying one link. Animate the
 * pivots; the links and child pivots follow because they are children.
 *   links   — [{ len, r }] per link; the mesh runs +Y inside its pivot
 *   jointR  — joint ball radius (0 = no visible joint spheres)
 * Returns parts { pivot_0…pivot_n, link_0…link_n-1, joint_i } — pivot_0 is
 * also the group root's child. Animate pivot_i.rotation (or quaternion);
 * never translate it — the chain's constraints are the pivots' positions.
 */
export function pivotChain(THREE, { links, jointR = 0, materials = null, role = 'link' } = {}) {
  if (!Array.isArray(links) || !links.length) fail('pivotChain needs a non-empty links array');
  links.forEach((l, i) => {
    if (!(l.len > 0) || !(l.r > 0)) fail(`links[${i}] needs len > 0 and r > 0`);
  });
  const mat = materialFor(THREE, materials, role, { color: 0xdad4c8 });
  const jointMat = materialFor(THREE, materials, 'joint', { color: 0x4a4e55, roughness: 0.4 });
  const root = new THREE.Group(); root.name = 'pivot-chain';
  const parts = {};
  let parent = root;
  links.forEach((l, i) => {
    const pivot = new THREE.Group();
    pivot.name = `pivot-${i}`;
    parent.add(pivot);
    parts[`pivot_${i}`] = pivot;
    const link = limb(THREE, { from: [0, 0, 0], to: [0, l.len, 0], r0: l.r, r1: l.r, material: mat });
    link.name = `link-${i}`;
    link.userData.role = role; link.userData.recipe = 'kinetic/pivotChain';
    pivot.add(link);
    parts[`link_${i}`] = link;
    if (jointR > 0) {
      const j = new THREE.Mesh(new THREE.SphereGeometry(jointR, 16, 12), jointMat);
      j.name = `joint-${i}`;
      j.userData.role = 'joint'; j.userData.recipe = 'kinetic/pivotChain';
      pivot.add(j);
      parts[`joint_${i}`] = j;
    }
    pivot.position.y = i === 0 ? 0 : links[i - 1].len; // each pivot sits at the previous link's tip
    parent = pivot;
  });
  return { group: root, parts, materials: { [role]: mat, joint: jointMat } };
}

/**
 * Constrained hinge — a pin plus a leaf plate that swings about `axis`
 * within `range` radians. Returns { …, set(a), clamp(a) }: set() rotates the
 * leaf pivot; clamp() enforces the declared limits. The pin is fixed
 * geometry — the moving half of a hinge is the leaf.
 *   leaf — { len, w, thickness }: plate extending +X from the pin
 *   axis — hinge axis (default +Z); range — [min, max] radians
 */
export function constrainedHinge(THREE, { axis = [0, 0, 1], range = [-Math.PI / 2, Math.PI / 2], pinR = 0.006, pinLen = 0.04, leaf = { len: 0.08, w: 0.03, thickness: 0.004 }, materials = null, role = 'hinge' } = {}) {
  if (!isVec3(axis) || Math.hypot(...axis) < 1e-9) fail(`hinge axis must be a nonzero [x,y,z] (got ${JSON.stringify(axis)})`);
  const [lo, hi] = range;
  if (!(lo < hi)) fail(`range must be [min < max] (got ${JSON.stringify(range)})`);
  if (!(pinR > 0) || !(pinLen > 0)) fail('constrainedHinge needs pinR > 0 and pinLen > 0');
  const { len, w, thickness } = leaf || {};
  if (!(len > 0) || !(w > 0) || !(thickness > 0)) fail('leaf needs len, w, thickness all > 0');
  const ax = new THREE.Vector3().fromArray(axis).normalize();
  const mat = materialFor(THREE, materials, role, { color: 0x9aa0a8, metalness: 0.6, roughness: 0.35 });
  const group = new THREE.Group(); group.name = 'hinge';
  const pin = new THREE.Mesh(new THREE.CylinderGeometry(pinR, pinR, pinLen, 20), mat);
  pin.name = 'pin'; pin.userData.role = role; pin.userData.recipe = 'kinetic/constrainedHinge';
  pin.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), ax); // pin lies along the axis
  group.add(pin);
  const pivot = new THREE.Group(); pivot.name = 'hinge-pivot';
  const plate = new THREE.Mesh(new THREE.BoxGeometry(len, w, thickness), mat);
  plate.name = 'leaf'; plate.position.x = len / 2;
  plate.userData.role = role; plate.userData.recipe = 'kinetic/constrainedHinge';
  pivot.add(plate);
  group.add(pivot);
  const clamp = (a) => Math.min(hi, Math.max(lo, a));
  const set = (a) => { pivot.quaternion.setFromAxisAngle(ax, clamp(a)); return clamp(a); };
  return {
    group, parts: { pin, pivot, leaf: plate }, materials: { [role]: mat },
    axis: ax.toArray(), range: [lo, hi], clamp, set,
    joins: { pivot: { type: 'revolute', axis: ax.toArray(), range: [lo, hi] } },
  };
}

/**
 * Crank-slider drive, baked to a looping AnimationClip — the canonical
 * kinetic mechanism and the template for "bake it for GLB".
 *   radius — crank wheel radius; rod — connecting-rod length (> radius)
 *   duration — loop seconds; fps — bake rate
 * Parts: wheel (rotates about +Z), pin (child of wheel, rides the rim),
 * slider (block on the X axis), rod (midpoint-positioned, +Y-aligned limb).
 * Tracks bind by node name — wheel.quaternion, slider.position, rod.position
 * and rod.quaternion are baked over [0, duration] inclusive so the last key
 * lands exactly on the first pose (verify with motion.loopError).
 */
export function cyclicDrive(THREE, { radius, rod, duration = 4, fps = 30, sliderSize = null, materials = null, role = 'mechanism' } = {}) {
  if (!(radius > 0)) fail(`cyclicDrive radius must be > 0 (got ${radius})`);
  if (!(rod > radius)) fail(`rod length ${rod} must exceed crank radius ${radius} — the slider would lock`);
  if (!(duration > 0) || !(fps > 0)) fail('cyclicDrive needs duration > 0 and fps > 0');
  const mat = materialFor(THREE, materials, role, { color: 0x8f959c, metalness: 0.5, roughness: 0.4 });
  const group = new THREE.Group(); group.name = 'cyclic-drive';
  const wheelGeo = new THREE.CylinderGeometry(radius, radius, radius * 0.3, 48);
  wheelGeo.rotateX(Math.PI / 2); // disc in the XY plane, axis +Z — the spin axis
  const wheel = new THREE.Mesh(wheelGeo, mat);
  wheel.name = 'wheel';
  wheel.userData.role = role; wheel.userData.recipe = 'kinetic/cyclicDrive';
  const pin = new THREE.Mesh(new THREE.SphereGeometry(radius * 0.12, 12, 8), mat);
  pin.name = 'pin';
  pin.position.set(radius, 0, 0); // rides the rim; child of wheel so the wheel track carries it
  pin.userData.role = role;
  wheel.add(pin);
  const s = sliderSize ?? radius * 0.5;
  const slider = new THREE.Mesh(new THREE.BoxGeometry(s, s, s * 0.7), mat);
  slider.name = 'slider';
  slider.userData.role = role; slider.userData.recipe = 'kinetic/cyclicDrive';
  // Rod geometry centered at origin, axis +Y: the baked tracks set midpoint
  // position + orientation, so the mesh itself must be origin-centered.
  const rodMesh = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.08, radius * 0.08, rod, 16), mat);
  rodMesh.name = 'rod';
  rodMesh.userData.role = role; rodMesh.userData.recipe = 'kinetic/cyclicDrive';
  group.add(wheel, slider, rodMesh);
  // Bake: N+1 samples over [0, duration]; last sample repeats the first pose.
  const n = Math.max(2, Math.round(duration * fps));
  const times = new Float32Array(n + 1);
  const wheelQ = new Float32Array((n + 1) * 4);
  const sliderP = new Float32Array((n + 1) * 3);
  const rodP = new Float32Array((n + 1) * 3);
  const rodQ = new Float32Array((n + 1) * 4);
  const q = new THREE.Quaternion(), zAxis = new THREE.Vector3(0, 0, 1);
  const pinW = new THREE.Vector3(), dir = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
  for (let i = 0; i <= n; i++) {
    const t = (i / n) * duration;
    times[i] = t;
    const { x, theta } = crankSlider(t, { r: radius, l: rod, freq: 1 / duration });
    q.setFromAxisAngle(zAxis, theta);
    q.toArray(wheelQ, i * 4);
    sliderP[i * 3] = x; sliderP[i * 3 + 1] = 0; sliderP[i * 3 + 2] = 0;
    pinW.set(radius * Math.cos(theta), radius * Math.sin(theta), 0);
    const sx = x, sy = 0;
    rodP[i * 3] = (pinW.x + sx) / 2; rodP[i * 3 + 1] = (pinW.y + sy) / 2; rodP[i * 3 + 2] = 0;
    dir.set(sx - pinW.x, sy - pinW.y, 0).normalize();
    q.setFromUnitVectors(up, dir);
    q.toArray(rodQ, i * 4);
  }
  const tracks = [
    new THREE.QuaternionKeyframeTrack('wheel.quaternion', times, wheelQ),
    new THREE.VectorKeyframeTrack('slider.position', times, sliderP),
    new THREE.VectorKeyframeTrack('rod.position', times, rodP),
    new THREE.QuaternionKeyframeTrack('rod.quaternion', times, rodQ),
  ];
  const clip = new THREE.AnimationClip('cyclic-drive', duration, tracks);
  return {
    group, parts: { wheel, pin, slider, rod: rodMesh }, materials: { [role]: mat },
    clip, constraints: { crankR: radius, rodLen: rod, period: duration },
    joins: {
      crankPin: { type: 'revolute', axis: [0, 0, 1] },
      sliderGuide: { type: 'prismatic', axis: [1, 0, 0] },
    },
  };
}

export default { pivotChain, constrainedHinge, cyclicDrive };
