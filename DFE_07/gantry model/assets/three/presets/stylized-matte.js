// stylized-matte preset (plan §3.9): flat-ish soft look for clay/craft/diorama
// work. Softer shadows, warm fill, no rim outline, matte materials expected.
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

export function applyStylizedMatte(lib, opts = {}) {
  const { THREE, roots, renderer } = lib;
  const o = {
    keyColor: 0xfff1dd, keyIntensity: 1.7, keyPosition: [2.5, 4, 2.5],
    fillColor: 0xcfd8e6, fillIntensity: 0.85, fillPosition: [-2.5, 1.5, 1],
    hemiSky: 0xfff8ec, hemiGround: 0x9aa3ad, hemiIntensity: 0.5,
    shadowOpacity: 0.16, shadowRadius: 8, exposure: 1.05,
    groundY: 0, ...opts,
  };
  for (const c of [...roots.environment.children]) {
    if (c.isLight) roots.environment.remove(c);
  }
  const key = new THREE.DirectionalLight(o.keyColor, o.keyIntensity);
  key.position.fromArray(o.keyPosition);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.radius = o.shadowRadius;
  key.shadow.bias = -0.0003;
  const fill = new THREE.DirectionalLight(o.fillColor, o.fillIntensity);
  fill.position.fromArray(o.fillPosition);
  const hemi = new THREE.HemisphereLight(o.hemiSky, o.hemiGround, o.hemiIntensity);
  roots.environment.add(key, fill, hemi);
  const ground = roots.environment.getObjectByName('ground-catcher');
  if (ground) { ground.material.opacity = o.shadowOpacity; ground.position.y = o.groundY; }
  renderer.toneMappingExposure = o.exposure;
  // Softer environment: a gentler PMREM keeps matte surfaces readable.
  const pmrem = new THREE.PMREMGenerator(renderer);
  lib.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.12).texture;
  pmrem.dispose();
  return { key, fill, hemi };
}
export default applyStylizedMatte;
