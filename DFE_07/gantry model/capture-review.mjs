import { writeFileSync } from 'node:fs';
import { launchBrowser, serveLocalTarget, WEBGL_ARGS } from './.agents/skills/design-kit/scripts/lib-browser.mjs';
const {url,server}=await serveLocalTarget('index.html');
const browser=await launchBrowser({headless:true,args:WEBGL_ARGS});
try{
 const page=await browser.newPage({viewport:{width:1280,height:800}});await page.goto(url);await page.evaluate(()=>window.__1design.ready);
 await page.evaluate(async()=>{const a=window.__1design.scene3d;a.setCaptureMode(true);a.setView('hero');a.fit();await window.__seek(3.5)});await page.screenshot({path:'review-evidence/current-desktop.png'});
 await page.setViewportSize({width:390,height:844});await page.evaluate(async()=>{const a=window.__1design.scene3d;a.setView('hero');a.fit();await window.__seek(3.5)});await page.screenshot({path:'review-evidence/current-portrait.png'});
 await page.setViewportSize({width:1280,height:800});await page.addStyleTag({content:'header,.title-block,.axis-legend,.footer,.scene-caption{visibility:hidden!important}[data-scene-root]{inset:0!important}'});
 await page.evaluate(async()=>{const a=window.__1design.scene3d;await window.__seek(3.5);const {default:s}=await import('./assets/three/scene.js');const p=s._nodes.wp.position;a.applyViewState({position:[p.x-1.2,p.y+.9,p.z+2.1],target:[p.x,p.y+.25,p.z],fov:36});await window.__seek(3.5)});await page.screenshot({path:'review-evidence/gripper-transfer-detail.png'});
 await page.setViewportSize({width:256,height:256});
 for(const view of ['hero','front','side']){await page.evaluate(async v=>{const a=window.__1design.scene3d;a.setPass('silhouette');a.setView(v);a.fit();await window.__seek(0)},view);await page.screenshot({path:`review-evidence/current-silhouette-${view}.png`})}
 console.log('Captured current desktop, portrait, transfer contact and three clean silhouettes.');
}finally{await browser.close();server.close()}
