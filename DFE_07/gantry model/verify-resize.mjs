import {writeFileSync,mkdirSync}from'node:fs';
import{launchBrowser,serveLocalTarget,WEBGL_ARGS}from'./.agents/skills/design-kit/scripts/lib-browser.mjs';
import{decodePng,diffPng}from'./.agents/skills/design-kit/scripts/lib-png.mjs';
const{url,server}=await serveLocalTarget('index.html');const browser=await launchBrowser({headless:true,args:WEBGL_ARGS});
try{
 const page=await browser.newPage({viewport:{width:1280,height:800}});const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(url);await page.evaluate(()=>window.__1design.ready);await page.evaluate(()=>window.__1design.scene3d.setCaptureMode(true));
 const shots=[],states=[];
 for(const [i,w,h]of [[0,390,844],[1,1280,800],[2,360,780],[3,390,844]]){await page.setViewportSize({width:w,height:h});const r=await page.evaluate(async()=>{const a=window.__1design.scene3d;a.setView('hero');a.fit();await window.__seek(2);const c=document.getElementById('c');return{aspect:a.getDiagnostics().camera.aspect,layout:[c.clientWidth,c.clientHeight],buffer:[c.width,c.height],png:c.toDataURL('image/png')}});shots.push(Buffer.from(r.png.split(',')[1],'base64'));delete r.png;states.push({viewport:[w,h],...r});await page.screenshot({path:`review-evidence/repair-resize-${i}.png`})}
 const diff=diffPng(decodePng(shots[0]),decodePng(shots[3]));
 // Force a size change and seek in one JS task, before ResizeObserver can fire.
 const immediate=await page.evaluate(async()=>{const a=window.__1design.scene3d,c=document.getElementById('c'),r=c.closest('[data-scene-root]');r.style.width='300px';r.style.height='420px';a.fit();await window.__seek(2);return{aspect:a.getDiagnostics().camera.aspect,layout:[c.clientWidth,c.clientHeight],buffer:[c.width,c.height]}});
 const pass=diff.diffPixels===0&&[...states,immediate].every(s=>Math.abs(s.aspect-s.layout[0]/s.layout[1])<1e-10&&s.buffer[0]/s.buffer[1]===s.layout[0]/s.layout[1])&&errors.length===0;
 writeFileSync('resize-verification.json',JSON.stringify({pass,states,immediate,repeatDiff:diff,errors},null,2));console.log(JSON.stringify({pass,repeatDiff:diff,immediate,errors}));
 await page.setViewportSize({width:1280,height:800});await page.addStyleTag({content:'header,.title-block,.axis-legend,.footer,.scene-caption,#loading-poster{display:none!important}[data-scene-root]{inset:0!important;width:auto!important;height:auto!important}'});
 for(const [name,t]of [['chain-pickup',2],['chain-transfer',3.5],['chain-delivery',5],['carriage-guides',3.5]]){await page.evaluate(async({name,t})=>{const a=window.__1design.scene3d;await window.__seek(t);const{default:s}=await import('./assets/three/scene.js');let target,position;if(name==='carriage-guides'){const p=s._nodes.carriage.getWorldPosition((await import('three')).Vector3?new(await import('three')).Vector3():null);target=[p.x,p.y-.35,p.z+.28];position=[p.x+1.0,p.y+.40,p.z+1.8]}else{const links=s._nodes.chainLinks;const fold=links.reduce((best,x)=>x.position.z>best.position.z?x:best,links[0]).position;target=[fold.x,3.06,fold.z-.25];position=[fold.x-1.45,4.05,fold.z+1.0]}a.applyViewState({position,target,fov:36});await window.__seek(t)},{name,t});await page.screenshot({path:`review-evidence/repair-${name}.png`})}
 if(!pass)process.exitCode=2;
}finally{await browser.close();server.close()}
