// 1DesignTool design-kit — scene-kit: one maintained stage, not another
// renderer (round16 §6.5, work item R16-Q18).
//
// A thin facade over runtime.js + presets/* that turns a directions3d
// manifest into a staged scene. A scene module calls it inside build() with
// the `lib` helpers the runtime passes in — the same knobs presets use:
// roots.environment for lights and ground, scene.environment for the
// reflection map, renderer for tone mapping/exposure. No second renderer,
// no second animation loop, no CDN:
//
//   import * as stage from './assets/three/scene-kit.js';
//   const dir = await stage.loadDirection('lacquer-toy');        // or a manifest object
//   const handle = stage.applyDirectionStage(lib, dir, { target: root });
//   this.views = { hero: stage.frameObject(lib, root, { angle: 'three-quarter' }) };
//   this.post = handle.bloom ? { bloom: handle.bloom } : undefined; // runtime picks it up at boot
//
// Honesty contract: applyDirectionStage returns {applied, skipped} — every
// manifest knob either lands or is reported with a reason. An unknown rig
// name keeps the runtime's default lighting AND appears in skipped[]; it is
// never silently mapped to a look the direction did not declare. Manifest
// fields that are not stage duties (construction, proportions, materials,
// budgets, delivery) are consumed by lint/critique — they are not reported
// as skipped here because the stage never claimed them.
//
// disposeOwned(handle) releases only what the stage created; runtime-owned
// resources (the ground-catcher, the renderer, prior lights a rig replaced)
// belong to api.dispose().

import { disposeTree } from './shared.js';
import { applyStudioProduct } from './presets/studio-product.js';
import { applyStylizedMatte } from './presets/stylized-matte.js';
import { applyTechnicalAssembly } from './presets/technical-assembly.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

// motion.js is dependency-free (helpers take THREE as a parameter) so it is
// safe to re-export flat — scene modules get stage + motion from one import.
export * from './motion.js';
export { default as motion } from './motion.js';

export const SCENE_KIT_VERSION = 1;

const fail = (fn, msg) => { throw new Error(`scene-kit/${fn}: ${msg}`); };
const KEBAB = /^[a-z][a-z0-9-]*$/;

/* ----------------------------------------------------- manifest loading */

/**
 * The manifest fields the stage actually consumes. Deliberately smaller than
 * directions3d/schema.json — lint owns the full contract; the stage refuses
 * to stage a manifest it cannot read rather than guessing at defaults.
 */
function checkManifest(fn, d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) fail(fn, `direction must be a manifest object (got ${JSON.stringify(d)})`);
  for (const k of ['id', 'version', 'light_rig', 'environment', 'signature']) {
    if (typeof d[k] !== 'string' || !d[k]) fail(fn, `manifest needs a non-empty "${k}" string`);
  }
  if (!Array.isArray(d.construction?.recipes) || !d.construction.recipes.length) {
    fail(fn, 'manifest needs construction.recipes (non-empty) — the construction contract is the point of a direction');
  }
  return d;
}

/**
 * Resolve a direction manifest. Accepts a manifest object (validated) or a
 * kebab-case id fetched from the kit's directions3d/ — resolved against this
 * module's own URL, so `KIT/assets/three/scene-kit.js` always finds
 * `KIT/directions3d/<id>.json` in the repo and in installed skill copies.
 * A project that copied only assets/ has no directions3d/ — the fetch fails
 * and the error says so; pass the manifest object inline instead of
 * depending on a file that was never installed.
 */
export async function loadDirection(idOrManifest, { fetchFn } = {}) {
  const fn = 'loadDirection';
  if (idOrManifest && typeof idOrManifest === 'object') return checkManifest(fn, idOrManifest);
  const id = idOrManifest;
  if (typeof id !== 'string' || !KEBAB.test(id)) fail(fn, `id must be kebab-case (got ${JSON.stringify(id)})`);
  const url = new URL(`../../directions3d/${id}.json`, import.meta.url);
  const f = fetchFn || (typeof fetch === 'function' ? fetch : null);
  if (!f) fail(fn, 'no fetch available — pass the manifest object instead of an id');
  let res;
  try { res = await f(url); }
  catch (e) { fail(fn, `cannot fetch ${url.pathname} — ${e.message}. directions3d/ ships with the kit; if you copied only assets/, pass the manifest object`); }
  if (!res?.ok) fail(fn, `${url.pathname}: HTTP ${res?.status ?? '?'} — the direction did not load, so nothing will pretend it did`);
  let d;
  try { d = await res.json(); }
  catch (e) { fail(fn, `${url.pathname}: not valid JSON — ${e.message}`); }
  if (d.id !== id) fail(fn, `${url.pathname}: manifest id "${d.id}" ≠ requested "${id}" — refusing to stage the wrong look`);
  return checkManifest(fn, d);
}

/* ------------------------------------------------------------ light rigs */

// Each rig owns the look by replacing the runtime's default key+hemi — the
// pattern presets/*.js established. Lights a rig creates are tracked on the
// handle so disposeOwned can detach them; the runtime's replaced lights are
// gone by design (the stage IS the lighting decision, not a layer over it).
function clearEnvLights(lib) {
  for (const c of [...lib.roots.environment.children]) {
    if (c.isLight) lib.roots.environment.remove(c);
  }
}
function catcher(lib) { return lib.roots.environment.getObjectByName('ground-catcher'); }
function setCatcherOpacity(lib, opacity) {
  const g = catcher(lib);
  if (g && Number.isFinite(opacity)) g.material.opacity = opacity;
}

/** Custom-rig builder for rigs the three shipped presets do not cover.
    spec: { key, fill?, rim?, hemi?, shadowOpacity } — directional lights get
    {color, intensity, position, shadow?{radius, mapSize}}, hemi gets
    {sky, ground, intensity}. Returns the created lights for the handle. */
function installRig(lib, spec) {
  const { THREE } = lib;
  clearEnvLights(lib);
  const made = [];
  for (const name of ['key', 'fill', 'rim']) {
    const s = spec[name];
    if (!s) continue;
    const l = new THREE.DirectionalLight(s.color ?? 0xffffff, s.intensity ?? 1);
    l.position.fromArray(s.position || [3, 5, 2]);
    if (name === 'key' && s.shadow !== false) {
      l.castShadow = true;
      l.shadow.mapSize.set(s.shadow?.mapSize ?? 2048, s.shadow?.mapSize ?? 2048);
      l.shadow.radius = s.shadow?.radius ?? 4;
      l.shadow.bias = s.shadow?.bias ?? -0.0002;
    }
    l.name = `rig-${name}`;
    made.push(l);
  }
  if (spec.hemi) {
    const h = new THREE.HemisphereLight(spec.hemi.sky ?? 0xffffff, spec.hemi.ground ?? 0x8a8f99, spec.hemi.intensity ?? 0.4);
    h.name = 'rig-hemi';
    made.push(h);
  }
  lib.roots.environment.add(...made);
  setCatcherOpacity(lib, spec.shadowOpacity);
  return made;
}

/**
 * light_rig name → installer. Wrapped presets keep their tested defaults;
 * the option overrides only aim the rig at the direction's look. A name with
 * no entry is reported skipped — never approximated.
 */
// Presets return {key, fill, rim, hemi} — collect them so disposeOwned can
// detach the rig. Custom rigs return their lights directly from installRig.
const rigLights = (r) => [r?.key, r?.fill, r?.rim, r?.hemi].filter(Boolean);

export const RIGS = {
  // lacquer-toy — warm key sells the lacquer; rim keeps painted edges readable
  studio_3point_warm: (lib) => rigLights(applyStudioProduct(lib, {
    keyColor: 0xfff0d6, fillColor: 0xe2e8f2, rimColor: 0xfff4de, rimIntensity: 0.8, shadowOpacity: 0.2, exposure: 1.0,
  })),
  // stylised-pbr-product — neutral three-point; reflections describe the shape
  studio_3point_neutral: (lib) => rigLights(applyStudioProduct(lib, {
    keyColor: 0xffffff, keyIntensity: 2.4, fillColor: 0xe8edf4, rimColor: 0xffffff, rimIntensity: 0.55, shadowOpacity: 0.18, exposure: 1.0,
  })),
  // flat-lowpoly — one clear sun; facets do the shading, fill stays cool/thin
  flat_lowpoly_sun: (lib) => installRig(lib, {
    key: { color: 0xfff2dc, intensity: 2.8, position: [4, 6, 2], shadow: { radius: 2 } },
    hemi: { sky: 0xdfeaf5, ground: 0x8f9aa5, intensity: 0.5 },
    shadowOpacity: 0.28,
  }),
  // soft-clay — big soft source; clay reads through gentle gradients
  clay_softbox: (lib) => rigLights(applyStylizedMatte(lib, { shadowRadius: 10, shadowOpacity: 0.14 })),
  // toon-cel — flat frontal fill + a hard rim; bands, not light, carry shading
  cel_rim: (lib) => installRig(lib, {
    key: { color: 0xffffff, intensity: 1.4, position: [0, 3, 5], shadow: { radius: 1 } },
    rim: { color: 0xffffff, intensity: 2.4, position: [-2, 4, -4] },
    hemi: { sky: 0xffffff, ground: 0x9aa0a8, intensity: 0.6 },
    shadowOpacity: 0.12,
  }),
  // blueprint-technical — even, high-fill light so every assembly layer reads
  blueprint_even: (lib) => rigLights(applyTechnicalAssembly(lib, {})),
  // voxel — crisp sun; cell shadows must stay sharp to read the grid
  voxel_clear_sun: (lib) => installRig(lib, {
    key: { color: 0xfff4e0, intensity: 3.0, position: [5, 8, 3], shadow: { radius: 1 } },
    hemi: { sky: 0xcfe4ff, ground: 0x9aa48f, intensity: 0.5 },
    shadowOpacity: 0.3,
  }),
  // papercraft — soft window light from one side; paper shows form by falloff
  paper_window_soft: (lib) => rigLights(applyStylizedMatte(lib, {
    keyColor: 0xfff5e6, keyIntensity: 1.5, keyPosition: [-3, 4, 2], fillIntensity: 0.9, shadowRadius: 12, shadowOpacity: 0.12,
  })),
};

/* ---------------------------------------------------------- environments */

// Local PMREM environments — the vendored RoomEnvironment stands in for an
// external HDRI so installed kits never fetch one (§6.5: package a licensed
// local environment). The blur parameter is the look knob: higher blur reads
// flatter/more diffuse.
function roomEnv(lib, handle, blur) {
  const pmrem = new lib.THREE.PMREMGenerator(lib.renderer);
  const tex = pmrem.fromScene(new RoomEnvironment(), blur).texture;
  handle.owned.pmrems.push(pmrem);
  handle.owned.textures.push(tex);
  return tex;
}
function setEnv(lib, handle, tex) {
  const current = lib.scene.environment;
  // A rig preset may have installed its own PMREM since priorEnv was captured
  // — overwriting would orphan it untracked. It is neither the runtime's nor
  // one of ours, so dispose it rather than leak it.
  if (current && current !== handle.priorEnv && !handle.owned.textures.includes(current)) {
    current.dispose();
  }
  lib.scene.environment = tex;
}

export const ENVS = {
  'local-room-studio-v1': (lib, h) => setEnv(lib, h, roomEnv(lib, h, 0.04)),
  'local-room-neutral-v1': (lib, h) => setEnv(lib, h, roomEnv(lib, h, 0.06)),
  'local-room-flat-v1': (lib, h) => setEnv(lib, h, roomEnv(lib, h, 0.10)),
  'local-room-diffuse-v1': (lib, h) => setEnv(lib, h, roomEnv(lib, h, 0.16)),
  // toon-cel declares "none": reflection fill would fight the banded shading
  none: (lib, h) => setEnv(lib, h, null),
};

/* ---------------------------------------------------------------- ground */

// Ground placement follows the target's evaluated bounds — the contact plane
// sits at the content's own minimum, never floating or sinking to hide a
// construction defect (§6.5). opts.ground overrides the manifest's name;
// opts.ground === false declines the treatment and says so in skipped[].
function boundsOf(THREE, objOrBounds) {
  if (!objOrBounds) return null;
  if (objOrBounds.isObject3D) {
    const b = new THREE.Box3().setFromObject(objOrBounds);
    return b.isEmpty() ? null : b;
  }
  if (objOrBounds.isBox3) return objOrBounds.isEmpty() ? null : objOrBounds;
  const min = objOrBounds.min, max = objOrBounds.max;
  if (min && max) {
    const to3 = (v) => (Array.isArray(v) ? v : [v.x, v.y, v.z]);
    const b = new THREE.Box3(new THREE.Vector3().fromArray(to3(min)), new THREE.Vector3().fromArray(to3(max)));
    return b.isEmpty() ? null : b;
  }
  if (Array.isArray(objOrBounds.center) && Number.isFinite(objOrBounds.radius)) {
    return new THREE.Box3().setFromCenterAndSize(
      new THREE.Vector3().fromArray(objOrBounds.center),
      new THREE.Vector3().setScalar(objOrBounds.radius * 2));
  }
  return null;
}

function disc(lib, handle, target, { pad = 1.4, hFrac = 0.02, color = 0xcdc9c0 } = {}) {
  const box = boundsOf(lib.THREE, target);
  if (!box) { handle.skipped.push({ knob: 'ground', reason: 'disc needs a target to size and seat — pass {target}' }); return null; }
  const r = box.getBoundingSphere(new lib.THREE.Sphere()).radius;
  const size = box.getSize(new lib.THREE.Vector3());
  const h = Math.max(size.y * hFrac, r * 0.02, 0.001);
  const mesh = new lib.THREE.Mesh(
    new lib.THREE.CylinderGeometry(r * pad, r * pad * 1.02, h, 72),
    new lib.THREE.MeshStandardMaterial({ color, roughness: 0.95, metalness: 0 }));
  mesh.position.set(0, box.min.y - h / 2, 0);
  mesh.receiveShadow = true;
  mesh.name = 'stage-disc';
  mesh.userData.stageOwned = true;
  lib.roots.environment.add(mesh);
  const g = catcher(lib);
  if (g) g.position.y = box.min.y - h; // the shadow plane sits below the disc, not through it
  return mesh;
}

function plinth(lib, handle, target, { pad = 1.12, hFrac = 0.055 } = {}) {
  const box = boundsOf(lib.THREE, target);
  if (!box) { handle.skipped.push({ knob: 'ground', reason: 'plinth needs a target to size — pass {target}' }); return null; }
  const size = box.getSize(new lib.THREE.Vector3());
  const r = Math.max(size.x, size.z) * 0.5 * pad;
  const h = Math.max(size.y * hFrac, 0.004);
  const mesh = new lib.THREE.Mesh(
    new lib.THREE.CylinderGeometry(r, r * 1.04, h, 64),
    new lib.THREE.MeshStandardMaterial({ color: 0xd8d4cc, roughness: 0.8, metalness: 0 }));
  mesh.position.set(0, box.min.y - h / 2, 0);
  mesh.receiveShadow = true; mesh.castShadow = false;
  mesh.name = 'stage-plinth';
  mesh.userData.stageOwned = true;
  lib.roots.environment.add(mesh);
  const g = catcher(lib);
  if (g) g.position.y = box.min.y - h;
  return mesh;
}

function grid(lib, handle, target) {
  const box = boundsOf(lib.THREE, target);
  const r = box ? box.getBoundingSphere(new lib.THREE.Sphere()).radius : 1;
  const y = box ? box.min.y : 0;
  const g = new lib.THREE.GridHelper(Math.max(r * 4, 2), 20, 0x8a929c, 0xcdd3da);
  g.position.y = y;
  g.name = 'stage-grid';
  g.userData.stageOwned = true;
  lib.roots.environment.add(g);
  const c = catcher(lib);
  if (c) c.position.y = y - 0.001; // shadows land on the plane just under the lines
  return g;
}

export const GROUNDS = {
  'shadow-catcher': (lib, handle, target) => {
    const box = boundsOf(lib.THREE, target);
    const g = catcher(lib);
    if (!g) { handle.skipped.push({ knob: 'ground', reason: 'runtime has no ground-catcher to adjust' }); return null; }
    if (box) g.position.y = box.min.y; // seat the shadow plane on the content's own contact line
    g.material.opacity = 0.2;
    return null; // adjusts a runtime-owned mesh — nothing owned to dispose
  },
  'optional-designed-plinth': (lib, h, t) => plinth(lib, h, t, {}),
  'designed-diorama-base': (lib, h, t) => plinth(lib, h, t, { pad: 1.22, hFrac: 0.08 }),
  'designed-terrain-or-disc': (lib, h, t) => disc(lib, h, t, { pad: 1.6 }),
  'flat-disc-or-none': (lib, h, t) => disc(lib, h, t, { pad: 1.4 }),
  'soft-contact-disc': (lib, h, t) => disc(lib, h, t, { pad: 1.35, color: 0xe2ded6 }),
  'grid-or-none': (lib, h, t) => grid(lib, h, t),
  'grid-plane': (lib, h, t) => grid(lib, h, t),
  none: (lib, handle) => {
    const g = catcher(lib);
    if (g) { handle.hiddenCatcher = g.visible; g.visible = false; }
    return null;
  },
};

/* ------------------------------------------------------------------ post */

const TONES = {
  aces: 'ACESFilmicToneMapping',
  none: 'NoToneMapping',
};

/**
 * Bloom decision for a direction, as a knob the runtime can actually apply:
 * the scene module assigns the result to `module.post = {bloom}` during
 * build() (runtime.js picks it up at boot) or passes it to api.setBloom().
 * Returns { bloom, reason } — bloom:false is a stated decision, not silence.
 * strength honors the manifest's max_strength cap; above dpr 2 the same
 * strength blooms proportionally more pixels, so it scales down to keep the
 * effect inside the declared budget rather than brighter on denser screens.
 */
export function postFxBudget(direction, { dpr = 1 } = {}) {
  const bloom = direction?.post?.bloom;
  if (!bloom || bloom.enabled !== true) {
    return { bloom: false, reason: 'direction disables bloom — the look carries without a post pass' };
  }
  const cap = Number.isFinite(bloom.max_strength) ? bloom.max_strength : 0.4;
  if (cap <= 0) return { bloom: false, reason: 'bloom enabled with max_strength 0 — the cap is the budget' };
  const dprScale = dpr > 2 ? 2 / dpr : 1;
  const strength = Math.round(Math.min(cap, cap * dprScale) * 1000) / 1000;
  return {
    bloom: { strength, radius: 0.4, threshold: 0.85 },
    reason: `enabled ≤ direction cap ${cap}${dprScale < 1 ? ` (×${dprScale.toFixed(2)} at dpr ${dpr})` : ''}`,
  };
}

/* ------------------------------------------------------- the whole stage */

/**
 * Apply a direction's staging to the runtime: light rig → environment →
 * ground → tone/exposure → bloom budget. Call inside build({ lib }) AFTER
 * the model exists so ground can seat on real bounds.
 *   { target }  — Object3D or bounds used for ground seating (optional but
 *                 recommended; ground names that need bounds skip honestly)
 *   { ground }  — override the manifest's ground name, or false to decline
 * Returns the handle: { applied, skipped, bloom, owned, … } for reporting
 * and for disposeOwned().
 */
export function applyDirectionStage(lib, direction, { target = null, ground } = {}) {
  const fn = 'applyDirectionStage';
  if (!lib?.THREE || !lib?.roots?.environment || !lib?.renderer || !lib?.scene) {
    fail(fn, 'lib must be the runtime helpers object ({THREE, roots, scene, renderer, camera, controls}) — call inside build()');
  }
  const d = checkManifest(fn, direction);
  const handle = {
    direction: d.id, version: d.version,
    applied: [], skipped: [],
    owned: { lights: [], objects: [], textures: [], pmrems: [] },
    scene: lib.scene, roots: lib.roots,
    // Captured BEFORE rigs run — a preset can replace scene.environment, and
    // the runtime's own env is what disposeOwned hands back.
    priorEnv: lib.scene.environment, hiddenCatcher: false, bloom: false, disposed: false,
  };
  const apply = (knob, table, name, run) => {
    const impl = table[name];
    if (!impl) {
      handle.skipped.push({ knob, name, reason: `unknown ${knob} "${name}" — known: ${Object.keys(table).join(', ')}` });
      return;
    }
    const made = run(impl);
    handle.applied.push(`${knob}:${name}`);
    return made;
  };

  apply('light_rig', RIGS, d.light_rig, (impl) => {
    const made = impl(lib, handle) || [];
    handle.owned.lights.push(...[].concat(made).filter((o) => o && o.isObject3D));
  });
  apply('environment', ENVS, d.environment, (impl) => impl(lib, handle));

  const gname = ground === undefined ? d.ground : ground;
  if (gname === false) {
    handle.skipped.push({ knob: 'ground', reason: 'declined by the caller (ground:false) — the scene owns its support' });
  } else if (gname) {
    apply('ground', GROUNDS, gname, (impl) => {
      const made = impl(lib, handle, target);
      if (made) handle.owned.objects.push(...[].concat(made));
    });
  }

  const tone = d.post?.tone ?? 'aces';
  apply('post.tone', TONES, tone, (impl) => {
    lib.renderer.toneMapping = lib.THREE[impl];
  });
  if (Number.isFinite(d.post?.exposure)) {
    lib.renderer.toneMappingExposure = d.post.exposure;
    handle.applied.push(`post.exposure:${d.post.exposure}`);
  } else {
    handle.skipped.push({ knob: 'post.exposure', reason: 'no finite post.exposure — renderer default (1.0) kept' });
  }

  const fx = postFxBudget(d, { dpr: lib.renderer.getPixelRatio?.() || 1 });
  handle.bloom = fx.bloom;
  if (fx.bloom) handle.applied.push(`post.bloom:${fx.reason}`);
  else handle.skipped.push({ knob: 'post.bloom', reason: fx.reason });

  return handle;
}

/* ------------------------------------------------------------- framing */

const ANGLES = {
  'front': [0, 6],
  'three-quarter': [32, 20],
  'side': [90, 8],
  'back': [180, 10],
  'top': [0, 84],
};

/**
 * Fit an object/bounds into the viewport and return a view state — the same
 * shape api.applyViewState() and the module's `views` entries consume
 * ({position, target, fov}) plus near/far for callers that set the camera
 * directly. Both-axes fit matches runtime.js fitCamera(): the smaller of the
 * vertical/horizontal half-FOV decides distance so portrait crops nothing.
 *   margin — multiply the bounding radius (1.15 ≈ runtime default)
 *   angle  — 'front' | 'three-quarter' | 'side' | 'back' | 'top',
 *            { azimuth, elevation } in degrees, or a [x,y,z] direction
 */
export function frameObject(lib, objOrBounds, { margin = 1.18, angle = 'three-quarter' } = {}) {
  const fn = 'frameObject';
  const { THREE, camera } = lib || {};
  if (!THREE || !camera) fail(fn, 'needs {THREE, camera} — call inside build() or pass api._internal');
  numCheck(fn, 'margin', margin, (v) => v > 0);
  const box = boundsOf(THREE, objOrBounds);
  if (!box) fail(fn, 'empty or missing bounds — pass an Object3D, Box3, {min,max}, or {center,radius}');
  const center = box.getCenter(new THREE.Vector3());
  const radius = Math.max(box.getBoundingSphere(new THREE.Sphere()).radius, 1e-4);
  let dir;
  if (typeof angle === 'string') {
    const ae = ANGLES[angle];
    if (!ae) fail(fn, `unknown angle "${angle}" — known: ${Object.keys(ANGLES).join(', ')}, {azimuth,elevation}, or [x,y,z]`);
    dir = azEl(ae[0], ae[1]);
  } else if (Array.isArray(angle)) {
    dir = new THREE.Vector3().fromArray(angle);
    if (dir.lengthSq() < 1e-8) fail(fn, 'angle vector is zero-length');
    dir.normalize();
  } else if (angle && Number.isFinite(angle.azimuth) && Number.isFinite(angle.elevation)) {
    dir = azEl(angle.azimuth, angle.elevation);
  } else {
    fail(fn, `angle must be a name, {azimuth,elevation}, or [x,y,z] (got ${JSON.stringify(angle)})`);
  }
  const v = THREE.MathUtils.degToRad(camera.fov);
  const h = 2 * Math.atan(Math.tan(v / 2) * (camera.aspect || 1));
  const dist = (margin * radius) / Math.sin(Math.min(v, h) / 2);
  // azEl returns a plain [x,y,z] — normalize to Vector3 before the math.
  const dirV = Array.isArray(dir) ? new THREE.Vector3().fromArray(dir) : dir;
  const pos = center.clone().addScaledVector(dirV, dist);
  return {
    position: pos.toArray(), target: center.toArray(), fov: camera.fov,
    near: Math.max(dist / 1000, radius / 100), far: dist + radius * 20 + 50, zoom: 1,
  };
}
function azEl(azimuthDeg, elevationDeg) {
  const az = azimuthDeg * Math.PI / 180, el = elevationDeg * Math.PI / 180;
  return [
    Math.sin(az) * Math.cos(el), // x
    Math.sin(el),                // y
    Math.cos(az) * Math.cos(el), // z — azimuth 0 faces the front (+Z)
  ];
}
function numCheck(fn, name, v, ok) {
  if (!Number.isFinite(v) || (ok && !ok(v))) fail(fn, `${name} out of range (got ${v})`);
}

/* ------------------------------------------------------------- disposal */

/**
 * Release ONLY what applyDirectionStage created: tracked lights are detached
 * (a preset-installed rig removed the runtime's own lights by design — they
 * are not resurrected), stage meshes get disposeTree (geometry + materials +
 * textures), stage PMREM textures and generators are disposed, and the prior
 * scene.environment / ground-catcher visibility are handed back. The model,
 * renderer, controls and runtime roots belong to api.dispose() — never
 * touched here. Idempotent.
 */
export function disposeOwned(handle) {
  if (!handle || handle.disposed) return { ok: true, noop: true };
  handle.disposed = true;
  for (const l of handle.owned?.lights || []) {
    l.parent?.remove(l);
    l.dispose?.(); // Light.dispose() releases the shadow map in r180
  }
  for (const o of handle.owned?.objects || []) {
    o.parent?.remove(o);
    disposeTree(o);
  }
  for (const t of handle.owned?.textures || []) t.dispose?.();
  for (const p of handle.owned?.pmrems || []) p.dispose?.();
  if (handle.priorEnv !== undefined && handle.scene) handle.scene.environment = handle.priorEnv;
  if (handle.hiddenCatcher && handle.roots) {
    const g = handle.roots.environment.getObjectByName('ground-catcher');
    if (g) g.visible = true;
  }
  return { ok: true, disposed: true };
}

export default {
  SCENE_KIT_VERSION, RIGS, ENVS, GROUNDS,
  loadDirection, applyDirectionStage, frameObject, postFxBudget, disposeOwned,
};
