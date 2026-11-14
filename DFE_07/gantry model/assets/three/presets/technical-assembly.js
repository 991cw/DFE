// technical-assembly preset (plan §3.9): exploded diagrams and mechanisms.
// Brighter neutral environment, even fill so every layer reads, tighter shadow.
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

export function applyTechnicalAssembly(lib, opts = {}) {
  const { THREE, roots, renderer } = lib;
  const o = {
    keyColor: 0xffffff, keyIntensity: 2.0, keyPosition: [4, 6, 3],
    fillColor: 0xe8edf4, fillIntensity: 0.9, fillPosition: [-4, 3, -2],
    hemiIntensity: 0.55,
    shadowOpacity: 0.12, exposure: 1.0, groundY: 0, ...opts,
  };
  for (const c of [...roots.environment.children]) {
    if (c.isLight) roots.environment.remove(c);
  }
  const key = new THREE.DirectionalLight(o.keyColor, o.keyIntensity);
  key.position.fromArray(o.keyPosition);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.radius = 3;
  key.shadow.bias = -0.0002;
  const fill = new THREE.DirectionalLight(o.fillColor, o.fillIntensity);
  fill.position.fromArray(o.fillPosition);
  const hemi = new THREE.HemisphereLight(0xffffff, 0x9097a0, o.hemiIntensity);
  roots.environment.add(key, fill, hemi);
  const ground = roots.environment.getObjectByName('ground-catcher');
  if (ground) { ground.material.opacity = o.shadowOpacity; ground.position.y = o.groundY; }
  renderer.toneMappingExposure = o.exposure;
  const pmrem = new THREE.PMREMGenerator(renderer);
  lib.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.06).texture;
  pmrem.dispose();
  return { key, fill, hemi };
}
export default applyTechnicalAssembly;
