import { writeFileSync, mkdirSync } from 'node:fs';
import { launchBrowser, serveLocalTarget, WEBGL_ARGS } from './.agents/skills/design-kit/scripts/lib-browser.mjs';
const {url,server}=await serveLocalTarget('index.html');
const browser=await launchBrowser({headless:true,args:WEBGL_ARGS});
try{
 const page=await browser.newPage({viewport:{width:1280,height:800}});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(url);await page.evaluate(()=>window.__1design.ready);
 const report=await page.evaluate(async()=>{
  const api=window.__1design.scene3d;api.setCaptureMode(true);await window.__seek(0);
  const THREE=await import('three');const {GLTFLoader}=await import('three/addons/loaders/GLTFLoader.js');
  const buffer=await api.exportGLB({scope:'model'});const gltf=await new GLTFLoader().parseAsync(buffer,'');
  const root=gltf.scene,clip=gltf.animations[0],mixer=new THREE.AnimationMixer(root);mixer.clipAction(clip).setLoop(THREE.LoopOnce,1).play();
  const names=['Gantry_Base','Column_FL','Column_FR','Column_RL','Column_RR','Rail_Left','Rail_Right','Bridge_Z','Carriage_X','Lift_Y','Gripper_Body','Finger_Left','Finger_Right','Motor_Bridge','Motor_Carriage','Motor_Lift','Cable_Chain','Limit_Sensors','Safety_Light'];
  const nodes=Object.fromEntries(names.map(n=>[n,root.getObjectByName(n)]));const assertions=[];
  const check=(name,pass,detail)=>assertions.push({name,pass,detail});
  check('Exact component names',names.every(n=>nodes[n]),names);
  const parents={Carriage_X:'Bridge_Z',Lift_Y:'Carriage_X',Gripper_Body:'Lift_Y',Finger_Left:'Gripper_Body',Finger_Right:'Gripper_Body',Motor_Bridge:'Bridge_Z',Motor_Carriage:'Carriage_X',Motor_Lift:'Carriage_X'};
  check('Mechanical parent chain',Object.entries(parents).every(([n,p])=>nodes[n]?.parent?.name===p),parents);
  const palette={'white':'f4f1ec','light grey':'a3a5a8','electric blue':'136dec','orange':'ed7e1d','white dark':'d7cebc','light grey dark':'7c7f83','white light':'f9f8f6','light grey light':'cccccc','soot black':'1b1b22','warm white':'f2ede2','mid grey':'7d828c','dark wood':'3d2a1c'};
  const mats=new Map();root.traverse(o=>{if(o.isMesh)for(const m of [o.material].flat())mats.set(m.uuid,m)});
  check('Only exact named palette materials',[...mats.values()].every(m=>palette[m.name]===m.color.getHexString()&&m.metalness===0),[...mats.values()].map(m=>({name:m.name,color:m.color.getHexString(),metalness:m.metalness})));
  check('Eight-second rigid baked clip',clip?.duration===8&&clip.tracks.length>0&&clip.tracks.every(t=>/\.(position|quaternion)$/.test(t.name)),{name:clip.name,duration:clip.duration,tracks:clip.tracks.length});
  const statics=names.slice(0,7),start=Object.fromEntries(names.map(n=>[n,{p:nodes[n].position.clone(),q:nodes[n].quaternion.clone(),s:nodes[n].scale.clone()}]));
  let drift=0,axisError=0,symmetry=0,gripError=0,scaleError=0,chainJointGap=0;
  const links=Array.from({length:32},(_,i)=>root.getObjectByName(`Cable_Link_${String(i+1).padStart(2,"0")}`));
  for(let f=0;f<=480;f++){
   const t=f/60;mixer.setTime(t);root.updateMatrixWorld(true);
   for(let i=0;i<links.length-1;i++){const out=links[i].localToWorld(new THREE.Vector3(0,0,.064)),entry=links[i+1].localToWorld(new THREE.Vector3(0,0,-.064));chainJointGap=Math.max(chainJointGap,out.distanceTo(entry))}
   for(const n of statics)drift=Math.max(drift,nodes[n].position.distanceTo(start[n].p),nodes[n].quaternion.angleTo(start[n].q));
   const b=nodes.Bridge_Z,c=nodes.Carriage_X,l=nodes.Lift_Y;
   axisError=Math.max(axisError,Math.abs(b.position.x-start.Bridge_Z.p.x),Math.abs(b.position.y-start.Bridge_Z.p.y),Math.abs(c.position.y-start.Carriage_X.p.y),Math.abs(c.position.z-start.Carriage_X.p.z),Math.abs(l.position.x-start.Lift_Y.p.x),Math.abs(l.position.z-start.Lift_Y.p.z));
   symmetry=Math.max(symmetry,Math.abs(nodes.Finger_Left.position.x+nodes.Finger_Right.position.x));
   for(const n of names)scaleError=Math.max(scaleError,nodes[n].scale.distanceTo(start[n].s));
   if(t>=2.05&&t<=5){const expected=nodes.Gripper_Body.localToWorld(new THREE.Vector3(0,-.29,0)),actual=root.getObjectByName('Demo_Workpiece').getWorldPosition(new THREE.Vector3());gripError=Math.max(gripError,expected.distanceTo(actual))}
  }
  check('Cable carrier pins bridge every rigid link joint',chainJointGap<.018,{maxJointGapMetres:chainJointGap,pinRadiusMetres:.018,samples:481});
  check('Frame and fixed rails stationary throughout',drift<1e-7,{maxTransformDrift:drift});
  check('Correct prismatic axes',axisError<1e-7,{maxOffAxisError:axisError});
  check('Symmetric independent fingers',symmetry<1e-7,{maxSymmetryError:symmetry});
  check('No stretching or mesh deformation',scaleError<1e-7&&!clip.tracks.some(t=>/morph|scale/.test(t.name)),{maxScaleDrift:scaleError});
  check('Workpiece follows grip without detachment',gripError<1e-5,{maxErrorMetres:gripError});
  mixer.setTime(0);const first=new Map();root.traverse(o=>first.set(o.uuid,{p:o.position.clone(),q:o.quaternion.clone()}));mixer.setTime(8);let seam=0;root.traverse(o=>{seam=Math.max(seam,o.position.distanceTo(first.get(o.uuid).p),o.quaternion.angleTo(first.get(o.uuid).q))});
  check('All rigid nodes close the loop',seam<1e-5,{maxSeamError:seam});
  const authored=root.getObjectByName('Robot_Factory_Gantry');check('Floor-centred origin and metre metadata',authored.position.length()===0&&authored.userData.units==='m'&&authored.userData.upAxis==='Y'&&authored.userData.meta?.notes.includes('5.0 m'),authored.userData.meta);
  const modelBounds=new THREE.Box3().setFromObject(root);check('Factory-scale envelope',Math.abs(modelBounds.max.y-3.2)<.05&&Math.abs(modelBounds.min.y)<1e-6&&Math.abs(modelBounds.max.x-modelBounds.min.x-5)<.1&&Math.abs(modelBounds.max.z-modelBounds.min.z-5.2)<.1,{min:modelBounds.min.toArray(),max:modelBounds.max.toArray()});
  check('lineSpeed metadata preserved',authored.userData.parameters.lineSpeed.min===0&&authored.userData.parameters.lineSpeed.max===1&&authored.userData.parameters.lineSpeed.default===.5,authored.userData.parameters);
  return {assertions,allPassed:assertions.every(x=>x.pass),diagnostics:api.getDiagnostics(),glbBase64:btoa(String.fromCharCode(...new Uint8Array(buffer).slice(0,0))),bytes:Array.from(new Uint8Array(buffer))};
 });
 const bytes=report.bytes;delete report.bytes;delete report.glbBase64;report.errors=errors;report.allPassed&&=errors.length===0;
 mkdirSync('exports',{recursive:true});writeFileSync('exports/robot-factory-gantry.glb',Buffer.from(bytes));writeFileSync('mechanical-verification.json',JSON.stringify(report,null,2));
 console.log(JSON.stringify({passed:report.allPassed,checks:report.assertions.map(x=>({name:x.name,pass:x.pass,detail:x.pass?undefined:x.detail})),render:report.diagnostics.render,errors},null,2));
 if(!report.allPassed)process.exitCode=2;
}finally{await browser.close();server.close()}

