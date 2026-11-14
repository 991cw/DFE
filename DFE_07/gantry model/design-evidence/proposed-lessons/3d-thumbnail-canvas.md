---
id: 3d-thumbnail-canvas
type: lesson
status: proposed
applies_to: [3d]
tags: [capture, silhouette, responsive, canvas]
source: Gantry build visual review, 2026-11-14
---
# Isolate the canvas for thumbnail diagnostics

A responsive 3D page can hide its canvas when the entire browser is resized to 128 pixels. A screenshot non-blank check may pass on UI pixels while the model is absent. For thumbnail silhouettes, hide page chrome, set the scene root to inset: 0, refit the camera, then seek and inspect the model. Verify front and side thumbnails visually before scoring recognition. Evidence: review-evidence/current-silhouette-front.png and current-silhouette-side.png. This lesson remains proposed; it was not installed or accepted into the shared kit.
