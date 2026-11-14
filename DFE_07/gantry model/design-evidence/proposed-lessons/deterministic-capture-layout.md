---
id: deterministic-capture-layout
type: lesson
status: proposed
applies_to: [3d]
tags: [capture, resize, camera, determinism]
source: Gantry repair and resize-verification.json, 2026-11-14
---
# Synchronize capture layout and fit a fixed motion envelope

Before an exact seek, synchronize the renderer backing buffer with current canvas client dimensions. A fit invoked in the same task as a resize must read the current aspect ratio rather than wait for ResizeObserver. Fit automated machines against their full mechanical envelope so an axis pose does not change camera framing. Verify portrait → desktop → narrow → portrait produces identical pixels for the same view and time. The gantry regression test reports 0 differing pixels and also checks a 300 × 420 resize and seek in one task. This lesson remains proposed.
