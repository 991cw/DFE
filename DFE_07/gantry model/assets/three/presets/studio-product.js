// studio-product preset (plan §3.9): named camera/light defaults for a single
// authored object on a surface. Applies env map + key/fill/rim to the runtime's
// `environment` root. No subject geometry here — build() owns that.
//
//   import { applyStudioProduct } from './assets/three/presets/studio-product.js';
//   applyStudioProduct(lib, { keyColor: 0xfff2e0, keyIntensity: 2.4 });
//
// `lib` is the helpers object the runtime passes to build(): { THREE, roots,
// scene, camera, controls, renderer, parts, fitCamera, seededRandom }.
export function applyStudioProduct(lib, opts = {}) {
  const { THREE, roots, scene, renderer } = lib;
  const o = {
    env: 'room',              // 'room' (RoomEnvironment) — metals need something to reflect
    keyColor: 0xfff4e2,
    keyIntensity: 2.6,
    keyPosition: [3, 5, 2],
    fillColor: 0xdfe6f0,
    fillIntensity: 0.5,
    fillPosition: [-3, 2, -1],
    rimColor: 0xffffff,
    rimIntensity: 0.7,
    rimPosition: [-1.5, 4, -4],
    background: null,         // null keeps the CSS gradient behind the transparent canvas
    shadowOpacity: 0.22,
    exposure: 1.0,
    groundY: 0,
    ...opts,
  };
  // Lights replace the runtime's minimal key+hemi so the recipe owns the look.
  for (const c of [...roots.environment.children]) {
    if (c.isLight) roots.environment.remove(c);
  }
  const key = new THREE.DirectionalLight(o.keyColor, o.keyIntensity);
  key.position.fromArray(o.keyPosition);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.radius = 4;
  key.shadow.bias = -0.0002;
  const fill = new THREE.DirectionalLight(o.fillColor, o.fillIntensity);
  fill.position.fromArray(o.fillPosition);
  const rim = new THREE.DirectionalLight(o.rimColor, o.rimIntensity);
  rim.position.fromArray(o.rimPosition);
  const hemi = new THREE.HemisphereLight(0xffffff, 0x8a8f99, 0.25);
  roots.environment.add(key, fill, rim, hemi);
  const ground = roots.environment.getObjectByName('ground-catcher');
  if (ground) { ground.material.opacity = o.shadowOpacity; ground.position.y = o.groundY; }
  if (o.background) scene.background = new THREE.Color(o.background);
  renderer.toneMappingExposure = o.exposure;
  return { key, fill, rim, hemi };
}
export default applyStudioProduct;
