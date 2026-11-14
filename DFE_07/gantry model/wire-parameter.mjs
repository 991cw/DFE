import {readFileSync,writeFileSync}from'node:fs';
let s=readFileSync('assets/three/scene.js','utf8');s=s.replace('build({THREE,parts,lib}){','build({THREE,parts,lib,params}){\n  window.__1design?.scene3d?.setSpeed(2 * Math.max(0,Math.min(1,params.lineSpeed)));');s=s.replace('default:.5,value:.5,animation:', 'default:.5,value:params.lineSpeed,animation:');writeFileSync('assets/three/scene.js',s);
