# Construction recipes

<!-- assets/three/recipes/ — round16 §6.1, work item R16-Q08. Reviewed,
     parameterized builders so the agent spends attention on proportions and
     decisions instead of re-deriving mesh math. Lower-level primitives
     (bevelBox, lathe, limb, trail, tube, instancedField, proportions,
     eyeDecals, faceTexture) live in ../parts.js; recipes compose them into
     structures that carry joins and roles. -->

A recipe turns a declared intent ("a hollow cup", "a fitted lid", "a hinge
with limits") into geometry with the structural knowledge already inside:
continuous walls, real thickness, deliberate clearances, named pivots. Reach
for a recipe before writing raw geometry — a recipe that cannot validate its
parameters cannot promise its output, so every function throws
`Error('recipes/<file>: …')` on invalid input rather than producing a
silently broken silhouette.

## The return contract

Every recipe is `(THREE, params) → { group, parts, materials, joins?, … }`:

- `group` — an Object3D root with **named children**. Add it under your
  scene root; it contains everything the recipe made.
- `parts` — a plain `name → Object3D` map (`{ body, handle, lid }`). Register
  the parts that matter with `lib.parts.add(part, 'vessel.body', 'Body')`
  inside `build()` so the checker, picker and exporter can find them. Dotted
  part ids are the caller's; recipe-local names stay simple because glTF
  animation binding sanitizes dots out of node names.
- `materials` — the `role → material` map actually used. Pass
  `params.materials = { role: THREE.Material }` to fill roles from the
  scene's palette; omitted roles get a neutral standard material so geometry
  review is never blocked on looks.
- `joins` — the documented fit/contact facts: `{ seat: {type:'plug-fit',
  plugR, clearance}, pivot:{type:'revolute', axis, range} }`. A join is the
  recipe's promise about where two things meet — the checker and the next
  recipe rely on it. **A deliberate overlap (embedded/butt join) is declared
  here so a reviewer can tell it from an accidental intersection.**
- recipes may add more (`seed`, `clip`, `set()`, `clamp()`,
  `constraints`) — documented per function.

## Material-role convention

`mesh.userData.role` names the material slot the part fills (`'body'`,
`'trim'`, `'lid'`, `'leg'`, `'link'`…). The direction manifest's
`materials.roles` list is the palette contract: build the `materials` block
in your scene module from those role names, pass it in, and every part lands
in its declared slot. A material the recipe invents carries
`material.userData.role` too, so lint can tell "no role assigned" apart from
"role the manifest never declared".

## Which recipe when

| Need | Recipe | Watch |
|---|---|---|
| Cup, pot, carafe — any hollow vessel | `vessels.hollowLathe` | wall < min radius; interior floor via `base` |
| Lip/edge bead on a round form | `vessels.rim` | cross-section relative to (r, y) |
| Foot that lifts a base off the table | `vessels.footRing` | declares a `contact-plane` join at y=0 |
| Spout on a wall | `vessels.pourSpout` | `attach` needs a radial direction (not the axis) |
| Lid that visibly fits an opening | `vessels.fittedLid` | `clearance` is the join — ≪ r, never 0 |
| Slab, plate, housing half | `hard-surface.beveledPanel` | `bevel` follows the direction's thickness fraction |
| Bracket, plaque, profile face | `hard-surface.profileExtrude` | `bevel < depth/2` |
| Furniture leg, strut to a mount | `hard-surface.taperedLeg` | origin at the TOP mount; taper reads as furniture |
| Frame from rectangular members | `hard-surface.joinedFrame` | `miter:true` trims to the bisector; butt joins are declared in `joins` |
| Handle that swells, tail that tapers | `sweeps.variableRadiusSweep` | one radius per control point |
| Strap/hem/edge band on a surface | `sweeps.fittedRibbon` | supply the path already offset from the surface |
| Bent tube, cord, rail | `sweeps.tubeSweep` / `parts.tube` | constant radius |
| Limb, neck, stem — tapered curve | `organic.taperedCurve` | r0 → r1 across the control points |
| Trunk with branches | `organic.branching` | `branches` count → seeded; array → explicit. Record `seed` in the plan |
| Gravel, foliage, moss, voxel cells | `organic.clump` / `parts.instancedField` | one draw call — the voxel budget depends on it |
| Jointed arm/appendage | `kinetic.pivotChain` | animate the `pivot_*` groups, never the links |
| Hinge with real limits | `kinetic.constrainedHinge` | `set(a)` clamps to `range`; the pin is fixed |
| Crank-slider that exports | `kinetic.cyclicDrive` | returns a baked `clip` — the GLB-carrying pattern |

## Working with recipes

- **Compose, don't fork.** A mug is `hollowLathe` + `variableRadiusSweep`
  (handle) + `footRing`; the recipes' `joins` tell you where parts meet. If
  no recipe fits, build with `parts.js` primitives and keep the same
  discipline: validated params, named meshes, declared roles.
- **Scale-aware, not unit-magical.** Recipes take real dimensions in the
  scene's units. `scale.reference_height` in the manifest is the sanity
  anchor — a 0.25 m toy and a 1 m diorama need different numbers.
- **Baked motion beats live curves for delivery.** `cyclicDrive` shows the
  pattern: bake tracks into a `THREE.AnimationClip` and return it as
  `clip` so `build()` can hand it to the runtime (`{root, clips}`), which
  exports it. A live `evaluatePose` curve is a viewer feature until baked
  (§6.6, §9).
- **Determinism is a feature.** Recipes that scatter or grow take `seed` and
  draw from mulberry32 — same seed, same form, every seek. Record the seed
  in the plan; do not re-roll to shop for a nicer accident.
