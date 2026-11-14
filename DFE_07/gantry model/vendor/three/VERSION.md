three.js r180 — vendored for 1DesignTool design-kit (round 4)

Source: npm package three@0.180.0 (MIT, see LICENSE).
Same version as apps/app/package.json pins — one three.js in the workspace.

Contents:
  three.module.js + three.core.js   ES module build (r167+ split)
  addons/                           controls, environments, loaders (GLTF+DRACO),
                                    geometries, exporters (GLTF+OBJ), postprocessing
                                    (bloom pipeline), shaders, capabilities, utils
  libs/draco/gltf/                  DRACO decoder for compressed .glb assets

Not vendored: KTX2/Basis textures, WebGPU builds, TSL, editors. Add a format
decoder here only when a shipped example needs it.
