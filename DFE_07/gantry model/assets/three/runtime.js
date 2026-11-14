// 1DesignTool design-kit â€” shared 3D scene runtime (round 4, plan Â§4).
//
// The runtime owns renderer setup, sizing, controls, loading/error states,
// readiness, capture, quality tiers, inspection passes, export, and disposal.
// Authored content lives in the scene module (see scene.js / the kit examples):
//
//   export default {
//     id, family,
//     params:     { name: {value,min,max,step,unit} | number },   // editable parameters
//     materials:  { role: {color, roughness, metalness, â€¦} },     // material role palette
//     views:      { hero: {position:[x,y,z], target:[x,y,z], fov?}, side: â€¦ },
//     motion:     { duration, loop, rest },                       // optional
//     build({ THREE, params, lib }) -> { root, parts? },          // authored model root
//     evaluatePose({ THREE, root, parts, t, params }) {}          // absolute pose from rest
//   }
//
// The runtime merges an optional `scene.design.json` (the persistent parameter
// document, schemaVersion 1) over the module's declared params/materials/views.
//
// Contract for the host and the checker (three-check.mjs):
//   window.__1design.ready       Promise â€” resolves after required resources,
//                                layout, shader preparation, and a successful
//                                first render; rejects with a readable Error on
//                                failure. Initialized before async loading.
//   window.__1design.scene3d     versioned surface:
//     version, status(), setCaptureMode(on), setView(name), setPass(name),
//     setQuality(tier), setPlaying(bool), setSpeed(v), setBloom(opts|false),
//     getDiagnostics(), dispose(),
//     listParts(), listViews(), pick(x,y), focusPart(id),
//     getViewState(), applyViewState(v),
//     applyPreviewPatch(patch), restorePreviewState(),
//     exportGLB(opts), exportPNG(opts), exportOBJ()
//   Round 16 Â§9.1 negotiated extension (RUNTIME_VERSION stays 1 â€” old
//   runtimes simply lack these; the bridge treats absence as "unverified"):
//     listClips(), setClip(id|null), getDeliveryCapabilities(),
//     captureFrame({view?,pass?,clip?,clipTime?,width?,height?}),
//     bakeClip({id, durationSeconds, fps?, targets?})
//   window.__seek(t)             absolute-time seek; resolves after the exact
//                                frame is drawn. Safe to call out of order.
//
// Everything below is runtime plumbing. Subject geometry never lives here.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js';
import { OBJExporter } from 'three/addons/exporters/OBJExporter.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { paramValues, seededRandom, makeParts } from './shared.js';

// The pure helpers live in ./shared.js (round7 R7-04) so the website runtime
// can use them without pulling this module's addon stack. They remain part of
// this module's public surface â€” three-check and scene modules are unaffected.
export { paramValues, seededRandom, makeParts };

export const RUNTIME_VERSION = 1;

/* ---------------------------------------------------------------- helpers */

const CLAY = new THREE.MeshStandardMaterial({ color: 0xb8b4ac, roughness: 0.85, metalness: 0 });
const SILHOUETTE = new THREE.MeshBasicMaterial({ color: 0x111111 });

function isFiniteVec(v, n) {
  return Array.isArray(v) && v.length === n && v.every((x) => Number.isFinite(x));
}

/* ------------------------------------------------------------- runtime */

export function startScene({ canvas, scene: sceneModule, document: docUrl = null, mount = null, onError = null } = {}) {
  if (!canvas) throw new Error('startScene: canvas required');
  const root = canvas.closest('[data-scene-root]') || canvas.parentElement || document.body;

  /* --- readiness is armed before any async work so a hung load is observable */
  let resolveReady, rejectReady;
  const ready = new Promise((res, rej) => { resolveReady = res; rejectReady = rej; });
  window.__1design = window.__1design || {};
  const prior1d = window.__1design;
  window.__1design.ready = ready;

  /* --- an authored page often parks the status/error paragraph as a sibling of
     the scene root rather than inside it; scoping the lookup to the root alone
     would miss it and leave a full-bleed overlay sitting on the model forever. */
  const findChrome = (sel) => root.querySelector(sel) || document.querySelector(sel);
  const ui = {
    status: findChrome('[data-scene-status]'),
    error: findChrome('[data-scene-error]'),
  };
  const setStatus = (msg, phase) => {
    if (ui.status) { ui.status.textContent = msg; ui.status.hidden = !msg; }
    state.phase = phase || state.phase;
  };
  const showError = (msg) => {
    if (ui.error) { ui.error.textContent = msg; ui.error.hidden = false; }
    else if (ui.status) { ui.status.textContent = msg; ui.status.hidden = false; }
    state.phase = 'error';
  };

  const state = {
    phase: 'loading',            // loading | ready | error | disposed
    playing: true,
    time: 0,
    speed: 1,
    pass: 'beauty',              // beauty | clay | silhouette | wireframe | explode
    quality: 'high',             // high | low | static
    capture: null,               // {live} snapshot while a capture owns the frame
    clipId: null,                // selected action id (clipReg) or null = all stopped
    bloom: false,                // UnrealBloomPass engaged
    pausedAutoRotate: false,     // auto-orbit suspended by Pause
    reduced: false,
    userMovedCamera: false,
    error: null,
    seed: 1,
    generation: 0,               // invalidates late async completions
    contextLost: false,
  };

  /* --- renderer --------------------------------------------------------- */
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
  } catch (e) {
    showError(`WebGL is unavailable: ${e.message}. The scene needs WebGL; try a browser with hardware or software GL enabled.`);
    rejectReady(new Error(`webgl-unavailable: ${e.message}`));
    return deadSurface();
  }
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(35, 1, 0.01, 500);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.maxPolarAngle = Math.PI * 0.495;
  controls.autoRotateSpeed = 0.6;

  /* Named roots: authored model (export scope) inside a presentation wrapper,
     plus environment and helpers that never export with the model. */
  const roots = {
    presentation: new THREE.Group(), // display transform (centering/grounding)
    model: new THREE.Group(),        // authored, exportable content
    environment: new THREE.Group(),  // floor, shadow catchers, backdrop
    helpers: new THREE.Group(),      // grids, axes, selection outlines
  };
  roots.presentation.name = 'presentation';
  roots.model.name = 'model';
  roots.environment.name = 'environment';
  roots.helpers.name = 'helpers';
  roots.presentation.add(roots.model);
  scene.add(roots.presentation, roots.environment, roots.helpers);
  roots.helpers.visible = false;

  /* --- default studio environment; presets replace this ------------------ */
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envMap = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environment = envMap;
  const key = new THREE.DirectionalLight(0xffffff, 2.2);
  key.position.set(3, 5, 2);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.radius = 4;
  const hemi = new THREE.HemisphereLight(0xffffff, 0x8a8f99, 0.4);
  roots.environment.add(key, hemi);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.ShadowMaterial({ opacity: 0.18 }));
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  ground.name = 'ground-catcher';
  roots.environment.add(ground);

  /* --- scene document merge --------------------------------------------- */
  // The persistent document is opt-in: the page declares it with
  // <link rel="scene-design" href="scene.design.json"> so an absent file never
  // costs a 404 in the capture log.
  if (docUrl == null) {
    docUrl = document.querySelector('link[rel="scene-design"]')?.getAttribute('href') || null;
  }
  let sceneDoc = null;
  let parts = makeParts();
  const moduleParams = sceneModule?.params || {};
  let params = paramValues(moduleParams);

  const docPromise = docUrl
    ? fetch(docUrl).then((r) => (r.ok ? r.json() : null)).catch(() => null)
    : Promise.resolve(null);

  /* --- camera fit: both axes, after real dimensions are known ------------ */
  const fitState = { margin: 1.15, safeRect: null }; // safeRect: [x0,y0,x1,y1] in NDC
  function boundingSphere(object) {
    const box = new THREE.Box3().setFromObject(object);
    if (box.isEmpty()) return { center: new THREE.Vector3(), radius: 1 };
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    return { center: sphere.center.clone(), radius: Math.max(sphere.radius, 1e-4), box };
  }
  /** Fit the camera so `object`'s bounds sit inside the viewport on BOTH axes. */
  function fitCamera(object, { keepDirection = true, margin = fitState.margin, target = null } = {}) {
    // A capture can request a fit in the same task as a viewport change,
    // before ResizeObserver delivers. Use the current layout immediately.
    const width = canvas.clientWidth, height = canvas.clientHeight;
    if (width > 0 && height > 0) {
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    }
    const { center, radius, box } = boundingSphere(object);
    const aim = target ? new THREE.Vector3().fromArray(target) : center.clone();
    const v = THREE.MathUtils.degToRad(camera.fov);
    const h = 2 * Math.atan(Math.tan(v / 2) * camera.aspect);
    let dist = (margin * radius) / Math.sin(Math.min(v, h) / 2);
    const dir = keepDirection
      ? camera.position.clone().sub(controls.target).normalize()
      : new THREE.Vector3(0.62, 0.5, 1).normalize();
    if (dir.lengthSq() < 1e-6) dir.set(0.62, 0.5, 1).normalize();
    // Fit actual projected box corners; a sphere wastes most of the frame on
    // wide portal machines, especially in portrait. Both axes remain bounded.
    if (box) {
      const right = new THREE.Vector3().crossVectors(camera.up, dir).normalize();
      if (right.lengthSq() < 1e-6) right.set(1, 0, 0);
      const up = new THREE.Vector3().crossVectors(dir, right).normalize();
      dist = 0;
      for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
        const rel = new THREE.Vector3(x, y, z).sub(aim);
        dist = Math.max(dist, rel.dot(dir) + margin * Math.abs(rel.dot(right)) / Math.tan(h / 2), rel.dot(dir) + margin * Math.abs(rel.dot(up)) / Math.tan(v / 2));
      }
    }
    controls.target.copy(aim);
    camera.position.copy(aim).addScaledVector(dir, dist);
    camera.near = Math.max(dist / 1000, radius / 100);
    camera.far = dist + radius * 20 + 50;
    camera.updateProjectionMatrix();
    controls.minDistance = Math.max(radius * 0.4, 0.01);
    controls.maxDistance = dist * 4;
    controls.update();
  }

  /* --- passes ------------------------------------------------------------ */
  // Per-mesh swaps (not scene.overrideMaterial) so the ShadowMaterial floor
  // keeps catching contact shadows in clay and wireframe passes. 'explode'
  // offsets parts outward from the model centroid â€” an assembly check, not a
  // material change.
  const savedMaterials = new Map();
  const PASS_MATERIAL = { clay: CLAY, silhouette: SILHOUETTE };
  const explode = { on: false, orig: new Map() };
  function setExplode(on) {
    if (on === explode.on) return;
    explode.on = on;
    if (!on) {
      for (const [o, p] of explode.orig) o.position.copy(p);
      explode.orig.clear();
      return;
    }
    explode.orig.clear();
    const { center, radius } = boundingSphere(roots.model);
    for (const p of parts.map.values()) {
      const o = p.object;
      if (!o.parent || o.parent === roots.model) continue; // the authored root stays put
      const b = new THREE.Box3().setFromObject(o);
      if (b.isEmpty()) continue;
      const dir = b.getCenter(new THREE.Vector3()).sub(center);
      if (dir.lengthSq() < 1e-8) dir.set(0, 1, 0);
      dir.normalize().multiplyScalar(radius * 0.35);
      if (!explode.orig.has(o)) explode.orig.set(o, o.position.clone());
      o.position.add(dir);
    }
  }
  // Pose evaluation writes absolute transforms, so explode must re-offset after.
  function reapplyExplode() {
    if (!explode.on) return;
    for (const [o, p] of explode.orig) o.position.copy(p);
    explode.on = false;
    setExplode(true);
  }
  function setPass(pass) {
    state.pass = pass;
    roots.environment.visible = pass !== 'silhouette';
    roots.helpers.visible = false;
    setExplode(pass === 'explode');
    roots.model.traverse((o) => {
      if (!o.isMesh) return;
      if (pass === 'beauty' || pass === 'explode') {
        if (savedMaterials.has(o)) { o.material = savedMaterials.get(o); savedMaterials.delete(o); }
        return;
      }
      if (!savedMaterials.has(o)) savedMaterials.set(o, o.material);
      if (pass === 'wireframe') {
        if (!o.userData.__wireMat) {
          const src = Array.isArray(o.material) ? o.material[0] : o.material;
          o.userData.__wireMat = new THREE.MeshBasicMaterial({ color: src?.color?.clone?.() || 0x888888, wireframe: true });
        }
        o.material = o.userData.__wireMat;
      } else {
        o.material = PASS_MATERIAL[pass] || o.material;
      }
    });
    renderNow();
  }

  /* --- views -------------------------------------------------------------- */
  function currentViews() {
    const v = { ...(sceneModule?.views || {}), ...(sceneDoc?.views || {}) };
    if (!v.hero) v.hero = { position: [3.2, 2.2, 4.2], target: [0, 0.45, 0] };
    return v;
  }
  function setView(name) {
    const v = currentViews()[name];
    if (!v) return { ok: false, error: `unknown view ${name}`, views: Object.keys(currentViews()) };
    if (isFiniteVec(v.position, 3)) camera.position.fromArray(v.position);
    if (isFiniteVec(v.target, 3)) controls.target.fromArray(v.target);
    if (Number.isFinite(v.fov)) { camera.fov = v.fov; camera.updateProjectionMatrix(); }
    renderNow();
    return { ok: true };
  }
  function getViewState() {
    return {
      position: camera.position.toArray(), target: controls.target.toArray(),
      fov: camera.fov, near: camera.near, far: camera.far, zoom: camera.zoom,
      time: state.time, pass: state.pass, quality: state.quality, seed: state.seed,
    };
  }
  function applyViewState(v) {
    if (!v || typeof v !== 'object') return { ok: false, error: 'view state required' };
    if (isFiniteVec(v.position, 3)) camera.position.fromArray(v.position);
    if (isFiniteVec(v.target, 3)) controls.target.fromArray(v.target);
    if (Number.isFinite(v.fov)) { camera.fov = v.fov; camera.updateProjectionMatrix(); }
    if (Number.isFinite(v.zoom)) camera.zoom = v.zoom;
    if (Number.isFinite(v.time)) setTime(v.time);
    if (typeof v.pass === 'string') setPass(v.pass);
    renderNow();
    return { ok: true };
  }

  /* --- deterministic time -------------------------------------------------- */
  function setTime(t) {
    state.time = t;
    if (typeof sceneModule?.evaluatePose === 'function' && built) {
      sceneModule.evaluatePose({ THREE, root: roots.model, parts: parts.map, t, params, lib: helpers });
    }
    if (built?.mixer) built.mixer.setTime(t);
    reapplyExplode();
  }

  /* --- clip registry (round 16 Â§9.1) ---------------------------------------
     One entry per AnimationClip the runtime can play or export. `source`
     keeps authored (returned by build()), imported (?model= GLB) and baked
     (bakeClip) clips apart â€” listClips() reports it and the delivery
     verifier distinguishes promised vs. real animation. Ids are the runtime
     handle; `clip.name` is what GLTFExporter serializes â€” both are kept
     unique so an exportâ†’reload round-trip reproduces the same list. */
  const clipReg = []; // {id, clip:THREE.AnimationClip, source, loop}
  let clipSeq = 0;
  function registerClip(clip, source, { loop = true } = {}) {
    let id = (clip.name || '').trim() || `clip-${++clipSeq}`;
    if (clipReg.some((e) => e.id === id)) {
      let i = 2;
      while (clipReg.some((e) => e.id === `${id}-${i}`)) i++;
      id = `${id}-${i}`;
    }
    if (!clip.name) clip.name = id;
    else if (clipReg.some((e) => e.clip.name === clip.name)) {
      // A second clip with the same exported name would collide on re-import
      // â€” rename deterministically so the reloaded list matches this one.
      let i = 2;
      while (clipReg.some((e) => e.clip.name === `${clip.name}-${i}`)) i++;
      clip.name = `${clip.name}-${i}`;
    }
    clipReg.push({ id, clip, source, loop });
    return id;
  }
  function clipInfo(e) {
    return {
      id: e.id, name: e.clip.name,
      // `duration` is the contract field (Scene3dClipInfoSchema);
      // `durationSeconds` is the alias lint/shot tooling already uses.
      duration: e.clip.duration, durationSeconds: e.clip.duration,
      loop: e.loop, channels: e.clip.tracks.length, source: e.source,
    };
  }
  function listClips() { return clipReg.map(clipInfo); }
  /** Exclusive action selection: stop the current action, start the chosen
      clip synced to the scene clock so __seek(t)/captureFrame stay absolute
      (clip time = scene time, wrapping by the clip's own duration). `null`
      stops every action. */
  function setClip(id) {
    if (!built) return { ok: false, error: 'scene not built' };
    if (id === null || id === undefined) {
      built.mixer?.stopAllAction();
      state.clipId = null;
      setTime(state.time); // re-evaluate so a stopped action can't freeze a pose
      invalidate();
      return { ok: true, clip: null };
    }
    const entry = clipReg.find((e) => e.id === id || e.clip.name === id);
    if (!entry) return { ok: false, error: `unknown clip ${id}`, clips: clipReg.map((e) => e.id) };
    if (!built.mixer) built.mixer = new THREE.AnimationMixer(built.root);
    built.mixer.stopAllAction();
    const action = built.mixer.clipAction(entry.clip);
    action.setLoop(entry.loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
    action.clampWhenFinished = !entry.loop;
    action.reset().play();
    built.mixer.setTime(state.time);
    state.clipId = entry.id;
    invalidate();
    return { ok: true, clip: entry.id };
  }

  const CAP_TEXTURE_PROPS = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap', 'alphaMap', 'bumpMap'];
  /** What this scene can actually deliver â€” measured off the built model,
      not claimed (round16 Â§3.4/Â§8.1). The `exports`/`glb`/`clipSource` shape
      matches Scene3dDeliveryCapsSchema; the flat fields are raw detail for
      shot/lint tooling that consumes the call result unvalidated. */
  function getDeliveryCapabilities() {
    let skins = false, morphs = false, textures = false;
    roots.model.traverse((o) => {
      if (o.isSkinnedMesh) skins = true;
      if (o.isMesh && o.morphTargetInfluences?.length) morphs = true;
      for (const m of [o.material].flat()) {
        if (!m) continue;
        for (const p of CAP_TEXTURE_PROPS) if (m[p]) { textures = true; break; }
      }
    });
    const procedural = typeof sceneModule?.evaluatePose === 'function';
    const active = clipReg.find((e) => e.id === state.clipId);
    const src = active?.source ?? clipReg[0]?.source ?? null;
    // Scene3dDeliveryCapsSchema's enum is the delivery mechanism
    // (procedural | imported | baked | none) â€” it has no 'authored'
    // variant, and emitting one would fail validation of the whole field.
    // The field stays unset for authored clips; listClips().source keeps
    // the true per-clip provenance.
    const clipSource = src === 'authored' ? undefined : (src ?? (procedural ? 'procedural' : 'none'));
    return {
      exports: ['glb', 'png', 'obj'],
      glb: {
        // bakeClip turns any procedural pose into a real AnimationClip, so
        // the GLB path supports animation whenever clips or evaluatePose exist.
        animations: clipReg.length > 0 || procedural,
        skins, morphTargets: morphs, textures,
      },
      clipSource,
      animations: { rigidTransformClips: true, skeletalClips: skins, morphClips: morphs },
      textures: { embedded: true, external: false },
      formats: ['glb', 'png', 'obj'],
      skins, morphTargets: morphs,
    };
  }

  /* --- post: optional bloom ------------------------------------------------- */
  // Off by default. The composer is created lazily the first time bloom is
  // enabled so scenes without it pay nothing. Bloom runs in linear space and
  // OutputPass applies tone mapping + sRGB at the end.
  let composer = null;
  let bloomPass = null;
  function ensureComposer() {
    if (composer) return;
    composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    bloomPass = new UnrealBloomPass(new THREE.Vector2(canvas.clientWidth || 1, canvas.clientHeight || 1), 0.0, 0.4, 0.9);
    composer.addPass(bloomPass);
    composer.addPass(new OutputPass());
    composer.setSize(canvas.clientWidth || 1, canvas.clientHeight || 1);
    composer.setPixelRatio(renderer.getPixelRatio());
  }
  function renderFrame() {
    if (state.bloom) {
      ensureComposer();
      // Accumulate all passes for one frame so diagnostics stay honest â€”
      // otherwise renderer.info only reflects the final output quad.
      renderer.info.autoReset = false;
      renderer.info.reset();
      composer.render();
      renderer.info.autoReset = true;
    } else renderer.render(scene, camera);
  }
  function setBloom(opts) {
    if (!opts || opts === false) { state.bloom = false; invalidate(); return { ok: true, bloom: false }; }
    state.bloom = true;
    ensureComposer();
    if (Number.isFinite(opts.strength)) bloomPass.strength = opts.strength;
    if (Number.isFinite(opts.radius)) bloomPass.radius = opts.radius;
    if (Number.isFinite(opts.threshold)) bloomPass.threshold = opts.threshold;
    invalidate();
    return { ok: true, bloom: true, strength: bloomPass.strength, radius: bloomPass.radius, threshold: bloomPass.threshold };
  }

  /* --- RAF owner ------------------------------------------------------------ */
  let raf = 0;
  let needsRender = true;
  let frameId = 0;
  const clock = new THREE.Clock();
  function invalidate() { needsRender = true; }
  function renderNow() {
    if (state.capture) {
      // Exclusive ownership: capture-state changes render exactly once, here.
      controls.update();
      renderFrame();
      frameId++;
      needsRender = false;
    } else {
      invalidate();
    }
  }
  function loop() {
    raf = requestAnimationFrame(loop);
    if (document.visibilityState !== 'visible') { clock.getDelta(); return; }
    if (state.capture) return; // the capture transaction owns the frame
    const dt = Math.min(clock.getDelta(), 0.05);
    const autonomous = state.playing && state.quality !== 'static';
    if (autonomous) {
      state.time += dt * state.speed;
      if (typeof sceneModule?.evaluatePose === 'function' && built) {
        sceneModule.evaluatePose({ THREE, root: roots.model, parts: parts.map, t: state.time, params, lib: helpers });
      }
      if (built?.mixer) built.mixer.update(dt * state.speed);
      reapplyExplode();
      needsRender = true;
    }
    if (controls.autoRotate || controls.enableDamping) {
      // update() returns false once damping settles; without it idle frames still render
      if (controls.update()) needsRender = true;
    }
    if (needsRender) {
      renderFrame();
      needsRender = false;
      frameId++;
    }
  }

  /* --- capture mode: exclusive frame-state ownership ------------------------
     The snapshot covers every channel a capture can touch: camera pose,
     pass, clock time, the selected clip (with its mixer time) and helper/
     environment visibility â€” a captureFrame that switches clips or passes
     must leave the live scene exactly as it found it (round16 Â§9.1). */
  function setCaptureMode(on) {
    if (on && !state.capture) {
      state.capture = {
        playing: state.playing, autoRotate: controls.autoRotate, controlsEnabled: controls.enabled,
        damping: controls.enableDamping, time: state.time,
        view: getViewState(), clockWasRunning: true,
        clip: state.clipId,
        helpersVisible: roots.helpers.visible,
        envVisible: roots.environment.visible,
      };
      state.playing = false;
      controls.enabled = false;
      controls.autoRotate = false;
      controls.enableDamping = false;
      clock.getDelta(); // discard accumulated elapsed so resume has no jump
      return { ok: true };
    }
    if (!on && state.capture) {
      const snap = state.capture;
      state.capture = null;
      // Restore the captured view+time so a capture can't nudge the live scene.
      if (snap.view) {
        if (isFiniteVec(snap.view.position, 3)) camera.position.fromArray(snap.view.position);
        if (isFiniteVec(snap.view.target, 3)) controls.target.fromArray(snap.view.target);
        // Clip selection first â€” setClip re-syncs the action to the scene
        // clock, then setTime lands the restored time on it.
        if (snap.clip !== undefined && snap.clip !== state.clipId) setClip(snap.clip);
        if (Number.isFinite(snap.view.time)) setTime(snap.view.time);
        if (typeof snap.view.pass === 'string' && snap.view.pass !== state.pass) setPass(snap.view.pass);
        if (typeof snap.helpersVisible === 'boolean') roots.helpers.visible = snap.helpersVisible;
        if (typeof snap.envVisible === 'boolean') roots.environment.visible = snap.envVisible;
        controls.update();
      }
      // Re-enable motion only after applying the saved camera. Updating with
      // autoRotate already enabled advances the restored pose by one tick.
      state.playing = snap.playing;
      controls.enabled = snap.controlsEnabled;
      controls.autoRotate = snap.autoRotate && !state.reduced;
      controls.enableDamping = snap.damping;
      clock.getDelta();
      invalidate();
      return { ok: true };
    }
    return { ok: true, noop: true };
  }

  async function seekAndRender(t) {
    // Capture seeks are absolute: pose is evaluated from rest every time, so
    // out-of-order and repeated seeks land on the same frame. Entering capture
    // only for the call keeps the checker's explicit setCaptureMode() honored.
    const entered = !state.capture;
    if (entered) setCaptureMode(true);
    // Synchronize the backing buffer as well as the camera before the exact
    // frame is drawn; observer timing must not affect a deterministic seek.
    resize();
    setTime(t);
    controls.update();
    renderFrame();
    frameId++;
    await new Promise((r) => requestAnimationFrame(r));
    if (entered) setCaptureMode(false);
    return { t, frame: frameId };
  }

  /* --- picking / parts ------------------------------------------------------ */
  const raycaster = new THREE.Raycaster();
  function pick(nx, ny) {
    // nx, ny in normalized canvas coords [0..1] (y down, DOM-style)
    const rect = canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2((nx) * 2 - 1, -(ny) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const hits = raycaster.intersectObject(roots.model, true).filter((h) => h.object.visible);
    if (!hits.length) return { hit: false };
    const h = hits[0];
    const part = parts.resolve(h.object);
    const local = part ? part.object.worldToLocal(h.point.clone()) : null;
    return {
      hit: true, partId: part?.id || h.object.name || null, label: part?.label || h.object.name || null,
      point: h.point.toArray(), localPoint: local ? local.toArray() : null,
      instanceId: h.instanceId ?? null, distance: h.distance,
      rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
    };
  }
  function focusPart(id) {
    const p = parts.find(id);
    if (!p) return { ok: false, error: `no part ${id}` };
    fitCamera(p.object, { margin: 1.6 });
    return { ok: true };
  }

  /* --- preview patches (transient; the host persists commits) ---------------- */
  let previewSnapshot = null;
  async function applyPreviewPatch(patch) {
    if (!previewSnapshot) previewSnapshot = JSON.parse(JSON.stringify({ params, doc: sceneDoc }));
    const next = { ...params, ...(patch?.parameters || {}) };
    return rebuildWith(next);
  }
  async function restorePreviewState() {
    if (!previewSnapshot) return { ok: true, noop: true };
    const snap = previewSnapshot; previewSnapshot = null;
    return rebuildWith(snap.params, snap.doc);
  }

  /* --- (re)build ------------------------------------------------------------ */
  let built = null;
  function disposeObjectTree(obj) {
    obj.traverse((o) => {
      if (o.isMesh) { o.geometry?.dispose?.(); for (const m of [o.material].flat()) { m?.dispose?.(); } }
      o.userData.__wireMat?.dispose?.();
    });
  }
  async function rebuildWith(nextParams, nextDoc = sceneDoc) {
    const wasBuilt = built;
    try {
      parts = makeParts();
      const result = await sceneModule.build({ THREE, params: nextParams, lib: helpers, parts, doc: nextDoc, seed: state.seed });
      const newRoot = result?.root || result;
      if (!newRoot || !newRoot.isObject3D) throw new Error('build() must return an Object3D or {root}');
      disposeObjectTree(roots.model);
      roots.model.clear();
      roots.model.add(newRoot);
      if (wasBuilt?.mixer) { wasBuilt.mixer.stopAllAction(); }
      built = { root: newRoot, mixer: result?.mixer || null, envelope: result?.envelope || null };
      clipReg.length = 0; state.clipId = null;
      for (const c of result?.clips ?? []) {
        const cid = registerClip(c, 'authored', { loop: sceneModule?.motion?.loop !== false });
        if (!state.clipId) state.clipId = cid; // the module's first clip is the default action
      }
      params = nextParams; sceneDoc = nextDoc;
      if (typeof sceneModule.evaluatePose === 'function') {
        sceneModule.evaluatePose({ THREE, root: roots.model, parts: parts.map, t: state.time, params, lib: helpers });
      }
      if (state.pass !== 'beauty') setPass(state.pass);
      invalidate();
      return { ok: true };
    } catch (e) {
      showError(`Rebuild failed: ${e.message}`);
      return { ok: false, error: e.message };
    }
  }

  /* --- quality --------------------------------------------------------------- */
  function setQuality(tier) {
    state.quality = tier;
    if (tier === 'high') {
      renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
      if (composer) composer.setPixelRatio(Math.min(devicePixelRatio, 2));
      renderer.shadowMap.enabled = true;
      startLoop();
    } else if (tier === 'low') {
      renderer.setPixelRatio(1);
      if (composer) composer.setPixelRatio(1);
      renderer.shadowMap.enabled = false;
      startLoop();
    } else if (tier === 'static') {
      renderer.setPixelRatio(1);
      if (composer) composer.setPixelRatio(1);
      renderer.shadowMap.enabled = false;
      stopLoop();
      renderFrame();
    }
    resize();
    invalidate();
    return { ok: true, quality: tier };
  }

  /* --- resize ------------------------------------------------------------------ */
  const renderSize = new THREE.Vector2();
  function resize() {
    const w = canvas.clientWidth || canvas.parentElement?.clientWidth || 0;
    const h = canvas.clientHeight || canvas.parentElement?.clientHeight || 0;
    if (w === 0 || h === 0) return;
    renderer.getSize(renderSize);
    // Assigning the same canvas dimensions can clear the presented frame.
    // Keep it intact when the initial ResizeObserver notification arrives.
    if (renderSize.x === w && renderSize.y === h && camera.aspect === w / h) return;
    renderer.setSize(w, h, false);
    if (composer) composer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    // Refit only when the user has not deliberately aimed the camera.
    if (built && !state.userMovedCamera && !state.capture) fitCamera(built.envelope || built.root);
    invalidate();
    // Offscreen previews can suspend RAF. Present the resized frame now so
    // a ready canvas cannot remain blank while waiting for a live loop.
    if (built && state.phase === 'ready') {
      controls.update();
      renderFrame();
      frameId++;
    }
  }
  const ro = new ResizeObserver(resize);

  /* --- input ------------------------------------------------------------------- */
  controls.addEventListener('start', () => {
    controls.autoRotate = false;
    state.userMovedCamera = true;
  });

  /* --- reduced motion ------------------------------------------------------------- */
  const motionQuery = matchMedia('(prefers-reduced-motion: reduce)');
  function applyMotionPref() {
    state.reduced = motionQuery.matches;
    if (state.reduced) {
      controls.autoRotate = false;
      state.playing = false;
      setTime(sceneModule?.motion?.rest ?? 0);
      invalidate();
    }
    api.motionPreference = state.reduced ? 'reduce' : 'no-preference';
  }
  motionQuery.addEventListener?.('change', applyMotionPref);

  /* --- context loss --------------------------------------------------------------- */
  let contextRetries = 0;
  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    state.contextLost = true;
    stopLoop();
    showError('The 3D context was lost. Attempting to restoreâ€¦');
  });
  canvas.addEventListener('webglcontextrestored', () => {
    state.contextLost = false;
    if (contextRetries < 1) {
      contextRetries++;
      renderer.compile(scene, camera);
      startLoop();
      if (ui.error) ui.error.hidden = true;
      setStatus('', 'ready');
    } else {
      showError('The 3D context could not be restored. Reload the page or use the static view.');
    }
  });

  /* --- export ---------------------------------------------------------------------- */
  async function exportGLB({ scope = 'model', binary = true } = {}) {
    const entered = !state.capture;
    if (entered) setCaptureMode(true);
    const previousPass = state.pass;
    const geometries = new Set(), materials = new Set(), materialCopies = new Map();
    try {
      if (state.pass !== 'beauty') setPass('beauty');
      const snapshot = cloneSkeleton(scope === 'scene' ? scene : roots.model);
      snapshot.traverse(object => {
        if (!object.isMesh) return;
        object.geometry = object.geometry.clone(); geometries.add(object.geometry);
        const cloned = (Array.isArray(object.material) ? object.material : [object.material]).map(material => {
          if (!materialCopies.has(material)) { const copy = material.clone(); materials.add(copy); materialCopies.set(material, copy); } return materialCopies.get(material);
        });
        object.material = Array.isArray(object.material) ? cloned : cloned[0];
      });
      // Clip buffers belong to the same frozen snapshot as geometry/materials.
      return await new GLTFExporter().parseAsync(snapshot, {
        binary, animations: clipReg.map(entry => entry.clip.clone()), onlyVisible: false,
      });
    } finally {
      for (const geometry of geometries) geometry.dispose();
      for (const material of materials) material.dispose();
      try { if (state.pass !== previousPass) setPass(previousPass); }
      finally { if (entered) setCaptureMode(false); }
    }
  }
  function exportPNG({ view = null, time = null, background = null, minWidth = 1280 } = {}) {
    const entered = !state.capture;
    if (entered) setCaptureMode(true);
    const previousView = getViewState(), previousBackground = scene.background;
    const cw = canvas.clientWidth || 1, ch = canvas.clientHeight || 1;
    const scale = Math.max(1, Math.min(4096, Number(minWidth) || 1280) / cw);
    try {
      if (view) setView(view);
      if (time != null) setTime(time);
      if (background) scene.background = new THREE.Color(background);
      controls.update();
      if (scale > 1) {
        renderer.setSize(Math.round(cw * scale), Math.round(ch * scale), false);
        composer?.setSize(Math.round(cw * scale), Math.round(ch * scale));
      }
      renderFrame();
      return canvas.toDataURL('image/png');
    } finally {
      scene.background = previousBackground;
      try { if (scale > 1) resize(); }
      finally {
        if (entered) setCaptureMode(false);
        else { applyViewState(previousView); controls.update(); }
      }
    }
  }
  function exportOBJ() {
    // Geometry-only by design â€” OBJExporter cannot write material (.mtl) data.
    return new OBJExporter().parse(roots.model);
  }

  /* --- clip-aware capture + procedural baking (round16 Â§9.1) ------------- */

  /** One frame inside the capture transaction â€” every override (view, pass,
      clip, clipTime, size) is snapshotted and restored so the live scene
      keeps its camera, pass, clock, selected clip and mixer time. Returns
      the PNG data-URL like exportPNG; {ok:false} on a bad view/clip arg. */
  async function captureFrame({ view = null, pass = null, clip, clipTime = null, width = null, height = null } = {}) {
    if (!built) return { ok: false, error: 'scene not built' };
    const entered = !state.capture;
    if (entered) setCaptureMode(true);
    // When the caller already holds a transaction (the checker's own
    // setCaptureMode(true)), these overrides are ours to restore by hand.
    const local = entered ? null : { view: getViewState(), pass: state.pass, clip: state.clipId };
    const cw = canvas.clientWidth || 1, ch = canvas.clientHeight || 1;
    const w = Math.max(1, Math.round(Number(width) || cw));
    const h = Math.max(1, Math.round(Number(height) || ch));
    const resized = w !== cw || h !== ch;
    try {
      if (view) { const r = setView(view); if (!r.ok) return { ok: false, error: r.error }; }
      if (pass) setPass(pass);
      if (clip !== undefined) { const r = setClip(clip); if (!r.ok) return { ok: false, error: r.error }; }
      if (Number.isFinite(clipTime)) setTime(clipTime);
      if (resized) {
        renderer.setSize(w, h, false);
        composer?.setSize(w, h);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
      }
      controls.update();
      renderFrame();
      frameId++;
      return canvas.toDataURL('image/png');
    } finally {
      // resize() restores canvas size + aspect; the capture still being held
      // suppresses its camera refit, and the transaction restores the pose.
      if (resized) resize();
      if (entered) setCaptureMode(false);
      else if (local) {
        if (local.clip !== state.clipId) setClip(local.clip);
        if (local.pass !== state.pass) setPass(local.pass);
        applyViewState(local.view);
        controls.update();
        renderFrame();
        frameId++;
      }
    }
  }

  /** Name-collision guard for export binding â€” trackâ†’node resolution goes
      through PropertyBinding.findNode, which matches by NAME, so two nodes
      sharing a name would both drive the first match after re-import.
      Suffixes are deterministic (document order) so a reload assigns the
      same ids. */
  function ensureUniqueExportName(o, taken) {
    let name = o.name || o.userData?.partId || 'part';
    if (!taken.has(name)) { taken.add(name); o.name = name; return; }
    let i = 2;
    while (taken.has(`${name}-${i}`)) i++;
    o.name = `${name}-${i}`;
    taken.add(o.name);
  }

  const BAKE_EPS = 1e-5;
  /** Sample evaluatePose over [0, durationSeconds] at `fps` into a real
      AnimationClip â€” Vector/Quaternion KeyframeTracks per target part,
      consecutive duplicate keys within epsilon dropped. The result is a
      registered 'baked' clip, so it exports through GLTFExporter like an
      authored one. */
  async function bakeClip({ id, durationSeconds, fps = 30, targets = null } = {}) {
    if (!built) return { ok: false, error: 'scene not built' };
    if (typeof sceneModule?.evaluatePose !== 'function') {
      return { ok: false, error: 'no evaluatePose â€” only procedural motion can be baked' };
    }
    const dur = Number(durationSeconds);
    if (!Number.isFinite(dur) || dur <= 0) return { ok: false, error: 'durationSeconds must be > 0' };
    const rate = Number.isFinite(fps) && fps > 0 ? fps : 30;
    const wanted = targets?.length ? targets : [...parts.map.keys()];
    const nodes = [];
    for (const pid of wanted) {
      const p = parts.find(pid);
      if (!p?.object) return { ok: false, error: `no part ${pid}` };
      nodes.push(p.object);
    }
    if (!nodes.length) return { ok: false, error: 'no bakeable parts' };
    // Uniqueness is enforced over the whole export scope â€” a name shared
    // with an unsampled node would still misbind on reload. `taken` holds
    // names owned by nodes outside the bake set plus names this pass
    // already assigned; a bake node's own name never counts against itself.
    const nodeSet = new Set(nodes);
    const taken = new Set();
    roots.model.traverse((o) => { if (!nodeSet.has(o) && o.name) taken.add(o.name); });
    for (const o of nodes) ensureUniqueExportName(o, taken);

    const frames = Math.max(2, Math.round(dur * rate) + 1);
    const entered = !state.capture;
    if (entered) setCaptureMode(true);
    try {
      const samples = nodes.map(() => ({ t: [], p: [], q: [], s: [] }));
      for (let f = 0; f < frames; f++) {
        const t = Math.min(f / rate, dur);
        sceneModule.evaluatePose({ THREE, root: roots.model, parts: parts.map, t, params, lib: helpers });
        for (let i = 0; i < nodes.length; i++) {
          const o = nodes[i], s = samples[i];
          s.t.push(t);
          s.p.push(o.position.x, o.position.y, o.position.z);
          // Quaternion neighborhood: q and -q are the same rotation â€” keep
          // dot(prev, cur) >= 0 or slerp takes the long way between keys.
          const q = o.quaternion;
          const n = s.q.length;
          const flip = n >= 4 && s.q[n - 4] * q.x + s.q[n - 3] * q.y + s.q[n - 2] * q.z + s.q[n - 1] * q.w < 0;
          s.q.push(flip ? -q.x : q.x, flip ? -q.y : q.y, flip ? -q.z : q.z, flip ? -q.w : q.w);
          s.s.push(o.scale.x, o.scale.y, o.scale.z);
        }
      }
      const tracks = [];
      const pushKeys = (Ctor, name, s, width) => {
        const times = [], values = [];
        for (let f = 0; f < s.t.length; f++) {
          const src = f * width;
          const val = [];
          for (let k = 0; k < width; k++) val.push(s.arr[src + k]);
          const last = values.length ? values.slice(-width) : null;
          const isEnd = f === 0 || f === s.t.length - 1;
          const dup = last && (width === 4
            ? Math.abs(last[0] * val[0] + last[1] * val[1] + last[2] * val[2] + last[3] * val[3]) > 1 - BAKE_EPS
            : val.every((x, k) => Math.abs(x - last[k]) <= BAKE_EPS));
          if (dup && !isEnd) continue;
          times.push(s.t[f]);
          values.push(...val);
        }
        if (times.length) tracks.push(new Ctor(name, times, values));
      };
      for (let i = 0; i < nodes.length; i++) {
        const s = samples[i], name = nodes[i].name;
        pushKeys(THREE.VectorKeyframeTrack, `${name}.position`, { t: s.t, arr: s.p }, 3);
        pushKeys(THREE.QuaternionKeyframeTrack, `${name}.quaternion`, { t: s.t, arr: s.q }, 4);
        pushKeys(THREE.VectorKeyframeTrack, `${name}.scale`, { t: s.t, arr: s.s }, 3);
      }
      if (!tracks.length) return { ok: false, error: 'bake produced no tracks' };
      const clip = new THREE.AnimationClip(
        (typeof id === 'string' && id.trim()) || `baked-${++clipSeq}`, dur, tracks);
      const cid = registerClip(clip, 'baked', { loop: true });
      return { ok: true, clip: clipInfo(clipReg.find((e) => e.id === cid)) };
    } finally {
      // The bake wrote poses directly â€” re-land the live clock so sampling
      // can't leak into the scene. The capture transaction's own restore
      // covers the entered-by-us case.
      if (entered) setCaptureMode(false);
      else setTime(state.time);
    }
  }

  /* --- diagnostics ------------------------------------------------------------------- */
  function getDiagnostics() {
    const { center, radius } = boundingSphere(roots.model);
    const info = renderer.info;
    return {
      phase: state.phase, error: state.error,
      version: RUNTIME_VERSION, three: THREE.REVISION,
      seed: state.seed, time: state.time, frame: frameId,
      pass: state.pass, quality: state.quality, playing: state.playing,
      bloom: state.bloom ? { strength: bloomPass?.strength ?? 0, radius: bloomPass?.radius ?? 0, threshold: bloomPass?.threshold ?? 0 } : false,
      reducedMotion: state.reduced, capture: !!state.capture,
      camera: { position: camera.position.toArray(), target: controls.target.toArray(), fov: camera.fov, near: camera.near, far: camera.far, aspect: camera.aspect },
      bounds: { center: center.toArray(), radius },
      render: { calls: info.render.calls, triangles: info.render.triangles, points: info.render.points, lines: info.render.lines },
      memory: { geometries: info.memory.geometries, textures: info.memory.textures },
      programs: info.programs?.length ?? 0,
      parts: parts.list().map((p) => ({ id: p.id, label: p.label, visible: p.visible })),
      views: Object.keys(currentViews()),
    };
  }

  /* --- public surface ----------------------------------------------------------------- */
  const api = {
    version: RUNTIME_VERSION,
    status: () => ({ phase: state.phase, error: state.error }),
    setCaptureMode, setView, setPass, setQuality, setBloom,
    setPlaying(on) {
      state.playing = !!on;
      if (on) {
        // Restore the auto-orbit the pause suspended (unless reduced motion or
        // a user drag already cancelled it).
        controls.autoRotate = state.pausedAutoRotate && !state.reduced;
        state.pausedAutoRotate = false;
        clock.getDelta();
        startLoop();
      } else {
        // Pause stops every autonomous channel: pose time, mixers, auto-orbit.
        state.pausedAutoRotate = controls.autoRotate;
        controls.autoRotate = false;
      }
      invalidate();
      return { ok: true, playing: state.playing };
    },
    setSpeed(v) { if (Number.isFinite(v)) state.speed = v; return { ok: true, speed: state.speed }; },
    getDiagnostics, dispose,
    listParts: () => parts.list(),
    listViews: () => Object.keys(currentViews()),
    pick, focusPart,
    getViewState, applyViewState,
    applyPreviewPatch, restorePreviewState,
    exportGLB, exportPNG, exportOBJ,
    // Round 16 Â§9.1 negotiated surface â€” see SCENE3D_NEGOTIATED in the bridge.
    listClips, setClip, getDeliveryCapabilities, captureFrame, bakeClip,
    fit: () => { if (built) fitCamera(built.envelope || built.root); return { ok: true }; },
    resetView() { state.userMovedCamera = false; if (built) fitCamera(built.envelope || built.root); return { ok: true }; },
    /** Reload the persistent scene document after the host committed an edit. */
    async reloadDocument() {
      if (!docUrl) return { ok: false, error: 'no scene document' };
      try {
        const r = await fetch(docUrl, { cache: 'no-store' });
        if (!r.ok) return { ok: false, error: `${docUrl}: HTTP ${r.status}` };
        const doc = await r.json();
        const nextParams = { ...params, ...paramValues(doc.parameters || {}) };
        return rebuildWith(nextParams, doc);
      } catch (e) { return { ok: false, error: e.message }; }
    },
    motionPreference: 'no-preference',
    _internal: { roots, scene, camera, renderer, controls, setTime },
  };
  window.__1design.scene3d = api;
  window.__seek = seekAndRender;

  function startLoop() { if (!raf) { clock.getDelta(); raf = requestAnimationFrame(loop); } }
  function stopLoop() { if (raf) { cancelAnimationFrame(raf); raf = 0; } }

  function dispose() {
    const gen = ++state.generation;
    stopLoop();
    ro.disconnect();
    controls.dispose();
    disposeObjectTree(roots.model);
    disposeObjectTree(roots.environment);
    envMap.dispose(); pmrem.dispose();
    sceneModule?.dispose?.(built?.root);
    composer?.dispose();
    renderer.dispose();
    if (window.__1design?.scene3d === api) delete window.__1design.scene3d;
    if (window.__seek === seekAndRender) delete window.__seek;
    state.phase = 'disposed';
    return { ok: true, generation: gen };
  }

  function deadSurface() {
    const api = { version: RUNTIME_VERSION, status: () => ({ phase: 'error', error: 'webgl-unavailable' }) };
    window.__1design.scene3d = api;
    window.__seek = () => Promise.reject(new Error('webgl-unavailable'));
    return api;
  }

  /* --- boot ----------------------------------------------------------------------------- */
  const helpers = { THREE, parts, seededRandom, fitCamera, setStatus, roots, scene, camera, renderer, controls };

  async function boot() {
    const gen = ++state.generation;
    try {
      setStatus('Loading sceneâ€¦', 'loading');
      sceneDoc = await docPromise;
      if (gen !== state.generation) return; // a newer boot superseded this one
      if (sceneDoc) {
        if (sceneDoc.schemaVersion !== 1) showError(`scene.design.json schemaVersion ${sceneDoc.schemaVersion} is not supported (expected 1)`);
        params = { ...params, ...paramValues(sceneDoc.parameters || {}) };
        if (Number.isFinite(sceneDoc.seed)) state.seed = sceneDoc.seed;
        if (sceneDoc.motion && sceneModule && !sceneModule.motion) sceneModule.motion = sceneDoc.motion;
      }
      const modelUrl = new URLSearchParams(location.search).get('model');
      if (modelUrl) {
        const draco = new DRACOLoader().setDecoderPath('./vendor/three/libs/draco/gltf/');
        const loader = new GLTFLoader().setDRACOLoader(draco);
        const gltf = await loader.loadAsync(modelUrl);
        if (gen !== state.generation) return;
        const model = gltf.scene;
        model.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
        parts.add(model, 'model.root', 'Model', { selectable: true });
        // GLTFLoader sanitizes node names (dots stripped) but preserves glTF
        // `extras` as userData â€” so authored partId/partLabel round-trip there.
        const nameSeen = new Map(); // base id â†’ occurrence count (dup names)
        model.traverse((o) => {
          if (o.userData?.partId && !parts.map.has(o.userData.partId)) {
            parts.add(o, o.userData.partId, o.userData.partLabel || o.name);
          } else if (o.name && !o.userData.partId) {
            // Duplicate node names are legal in glTF â€” ids get a deterministic
            // ordinal suffix so a re-exported file's listParts() matches (Â§9.1).
            const base = `model.${o.name}`;
            const n = (nameSeen.get(base) ?? 0) + 1;
            nameSeen.set(base, n);
            const id = n === 1 ? base : `${base}.${n}`;
            if (!parts.map.has(id)) parts.add(o, id, o.name);
          }
        });
        built = { root: model, mixer: null, envelope: null };
        roots.model.add(model);
        if (gltf.animations?.length) {
          // Round 16 Â§9.1 â€” retain every imported clip in the registry so
          // listClips() and exportGLB see the full set, but play only the
          // default (first) action; setClip() selects the rest.
          built.mixer = new THREE.AnimationMixer(model);
          for (const c of gltf.animations) registerClip(c, 'imported');
          const first = clipReg[0];
          if (first) {
            const action = built.mixer.clipAction(first.clip);
            action.setLoop(first.loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
            action.play();
            state.clipId = first.id;
          }
        }
      } else {
        const result = await sceneModule.build({ THREE, params, lib: helpers, parts, doc: sceneDoc, seed: state.seed });
        const newRoot = result?.root || result;
        if (!newRoot?.isObject3D) throw new Error('scene module build() must return an Object3D or {root}');
        built = { root: newRoot, mixer: result?.mixer || null, envelope: result?.envelope || null, clips: result?.clips || [] };
        for (const c of built.clips) {
          const cid = registerClip(c, 'authored', { loop: sceneModule?.motion?.loop !== false });
          if (!state.clipId) state.clipId = cid; // first authored clip is the default action
        }
        if (clipReg.length && !built.mixer) {
          // Clips declared but no module mixer â€” give them a default action so
          // they play (and so captureFrame/setClip have a bound mixer).
          built.mixer = new THREE.AnimationMixer(newRoot);
          const action = built.mixer.clipAction(clipReg[0].clip);
          action.setLoop(clipReg[0].loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
          action.play();
        }
        roots.model.add(newRoot);
      }
      setTime(sceneModule?.motion?.rest ?? 0);
      resize();
      ro.observe(canvas.parentElement || canvas);
      // Shader preparation before the first presented frame, then one real render.
      renderer.compile(scene, camera);
      if (gen !== state.generation) return;
      if (sceneModule?.post?.bloom) setBloom(sceneModule.post.bloom);
      renderFrame();
      applyMotionPref();
      if (state.reduced) { state.playing = false; }
      controls.autoRotate = !state.reduced && sceneModule?.autoRotate !== false;
      setStatus('', 'ready');
      state.phase = 'ready';
      startLoop();
      resolveReady({ phase: 'ready', diagnostics: getDiagnostics() });
    } catch (e) {
      state.error = e.message;
      showError(`Scene failed: ${e.message}`);
      rejectReady(e);
      onError?.(e);
    }
  }

  // Defer one task so `__1design.ready` exists before any awaited work lands.
  queueMicrotask(boot);
  return api;
}

export default startScene;



