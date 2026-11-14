// 1DesignTool design-kit — shared 3D helpers (round 7 §4.4, R7-04).
//
// The single source for the pure/rendering helpers every runtime consumes:
//   - assets/three/runtime.js (the standalone object-scene runtime) imports and
//     re-exports seededRandom / paramValues / makeParts, so its public surface
//     is unchanged.
//   - the 3d-website starter (assets/website/js/scene.js) imports makeParts,
//     disposeTree, and estimateResidentBytes for its scroll-driven lifecycle.
//
// Everything here is importable without pulling the addon stack (no
// OrbitControls/exporters/composer), so the website's critical path stays
// small. 'three' itself resolves through the host page's import map.
import * as THREE from 'three';

/** Deterministic PRNG for generated layouts/particles (mulberry32). */
export function seededRandom(seed) {
  let a = (seed >>> 0) || 1;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Resolve a declared parameter map to plain values (accepts {value,…} or scalars). */
export function paramValues(declared) {
  const out = {};
  for (const [k, v] of Object.entries(declared || {})) {
    out[k] = v && typeof v === 'object' && 'value' in v ? v.value : v;
  }
  return out;
}

/** Named-part registry a scene module can fill while building. */
export function makeParts() {
  const parts = new Map();
  return {
    map: parts,
    /** part(object, 'vessel.handle', 'Handle', {selectable:true}) */
    add(obj, id, label, opts = {}) {
      if (!id || parts.has(id)) throw new Error(`duplicate part id ${id}`);
      obj.userData.partId = id;
      obj.userData.partLabel = label || id;
      if (!obj.name) obj.name = id; // GLTFExporter serializes name, not userData
      parts.set(id, { id, label: label || id, object: obj, selectable: opts.selectable !== false });
      return obj;
    },
    list() {
      return [...parts.values()].map((p) => {
        const b = new THREE.Box3().setFromObject(p.object);
        return { id: p.id, label: p.label, selectable: p.selectable, visible: p.object.visible,
          bounds: b.isEmpty() ? null : { min: b.min.toArray(), max: b.max.toArray() } };
      });
    },
    find(id) { return parts.get(id) || null; },
    /** Object lookup used by picking: climb from the hit mesh to the tagged ancestor. */
    resolve(obj) {
      let o = obj;
      while (o) { if (o.userData && o.userData.partId && parts.has(o.userData.partId)) return parts.get(o.userData.partId); o = o.parent; }
      return null;
    },
  };
}

/* ----------------------------------------------------------- disposal -- */

const TEXTURE_PROPS = [
  'map', 'roughnessMap', 'metalnessMap', 'normalMap', 'bumpMap', 'aoMap',
  'emissiveMap', 'alphaMap', 'clearcoatMap', 'transmissionMap', 'specularMap',
  'specularColorMap', 'specularIntensityMap', 'envMap', 'lightMap', 'displacementMap',
];

/**
 * Dispose every GPU-owning resource under `root`: geometry, materials, the
 * textures those materials reference, and any __wireMat pass material. This
 * is the disposal the website lifecycle needs — removing a mesh alone does
 * not free any of these (three.js disposal guidance, round7 §6.4).
 * Shared resources must be owned by the caller: only call this on a subtree
 * whose resources are not referenced elsewhere.
 */
export function disposeTree(root) {
  const seenTex = new Set();
  const seenMat = new Set();
  root.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    for (const m of [o.material].flat()) {
      if (!m || seenMat.has(m)) continue;
      seenMat.add(m);
      for (const p of TEXTURE_PROPS) {
        const t = m[p];
        if (t && t.isTexture && !seenTex.has(t)) { seenTex.add(t); t.dispose(); }
      }
      m.dispose();
    }
    if (o.userData && o.userData.__wireMat) o.userData.__wireMat.dispose();
  });
}

/* ------------------------------------------------- resident-cost estimate */

/**
 * Rough resident-GPU estimate in bytes for the subtree + environment map.
 * Uncompressed RGBA8: width*height*4, mip chain ≈ +1/3, per cube face/layer.
 * Compressed formats would need real block math — this is the starter's
 * conservative floor, surfaced in diagnostics (round7 §6.4).
 */
export function estimateResidentBytes(root, environment = null) {
  let bytes = 0;
  const seenTex = new Set();
  const seenGeo = new Set();
  const countTexture = (t) => {
    if (!t || !t.isTexture || seenTex.has(t)) return;
    seenTex.add(t);
    const img = t.image || {};
    const w = img.width || 0;
    const h = img.height || 0;
    if (!w || !h) return;
    const faces = t.isCubeTexture ? 6 : (Array.isArray(img) ? img.length : 1);
    const mips = t.generateMipmaps !== false ? 1.333 : 1;
    bytes += Math.round(w * h * 4 * faces * mips);
  };
  root.traverse((o) => {
    if (o.geometry && !seenGeo.has(o.geometry)) {
      seenGeo.add(o.geometry);
      const g = o.geometry;
      for (const attr of Object.values(g.attributes || {})) {
        if (attr.array) bytes += attr.array.byteLength;
      }
      if (g.index) bytes += g.index.array.byteLength;
    }
    for (const m of [o.material].flat()) {
      if (!m) continue;
      for (const p of TEXTURE_PROPS) countTexture(m[p]);
    }
  });
  countTexture(environment);
  return bytes;
}
