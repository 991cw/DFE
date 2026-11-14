// Bake the existing checked craft compiler into native editable rigid meshes.
// Does not certify deforming rigs, walking, support mass, or Blender parity.
import { compilePerformance, evaluateSchedule } from './craft-motion.js';
import { buildHumanoidRig, applyPose } from './craft.js';
export function craftToNative(THREE,bundle,performance,{id='doc_craft',fps=60}={}) {
 const {schedule,diagnostics}=compilePerformance(bundle,performance);
 const errors=diagnostics.filter(d=>d.severity==='error');
 if(!schedule||errors.length)throw new Error(errors.map(d=>d.message).join('; ')||'Craft schedule unavailable');
 if(!Number.isInteger(fps)||fps<1||fps>120||schedule.seconds*fps>20000)throw new Error('Rigid bake exceeds sample budget');
 const c=performance.construction||{};
 const rig=buildHumanoidRig(THREE,bundle,{variant:c.variant||schedule.packDef.preset,level:c.level,subject:performance.subject,jointOffsets:c.jointOffsets||{},jointCovers:c.jointCovers||{},packCovers:schedule.packDef.covers||{},face:schedule.packDef.face?.kind==='painted'});
 const resources=new Set();rig.group.traverse(n=>{if(n.geometry)resources.add(n.geometry);for(const m of Array.isArray(n.material)?n.material:n.material?[n.material]:[])resources.add(m);});
 try{
  if(c.placement?.position)rig.group.position.fromArray(c.placement.position);rig.group.rotation.y=(c.placement?.yawDeg||0)*Math.PI/180;
  const nodes=[],ids=new Map();rig.group.traverse(n=>{ids.set(n,`obj_craft${nodes.length}`);nodes.push(n);});
  const doc={schemaVersion:2,documentId:id,revision:'rev_0',coordinates:{up:'Y',handedness:'right',metersPerUnit:1},objects:{},geometries:{},materials:{},assets:{},collections:{},views:{},animations:{},render:{background:[.07,.07,.08],grid:true,shadows:true,exposure:1,toneMapping:'agx',ground:'none',environment:{intensity:1,rotation:0}},extensions:{}};
  const materialIds=new Map();
  const trs=n=>({position:n.position.toArray(),rotation:n.quaternion.toArray(),scale:n.scale.toArray()});
  for(const [i,n]of nodes.entries()){
   const oid=ids.get(n),slots=[];let geometry=null;
   if(n.isMesh){if(Array.isArray(n.material)&&n.material.length>1)throw new Error('Rigid adapter requires one material per mesh');const m=Array.isArray(n.material)?n.material[0]:n.material;
    let mid=materialIds.get(m);if(!mid){mid=`mat_craft${materialIds.size}`;materialIds.set(m,mid);const color=m.color.clone().convertLinearToSRGB(),emissive=m.emissive?.clone().convertLinearToSRGB();doc.materials[mid]={id:mid,label:n.name||mid,baseColor:[...color.toArray(),m.opacity],metalness:m.metalness??0,roughness:m.roughness??.5,emissive:emissive?.toArray()??[0,0,0],emissiveIntensity:m.emissiveIntensity??1,opacity:m.opacity,doubleSided:m.side===THREE.DoubleSide,textureSlots:{}};}slots.push(mid);
    geometry=`geo_craft${i}`;const g=n.geometry;doc.geometries[geometry]={id:geometry,kind:'mesh',positions:Array.from(g.attributes.position.array),indices:g.index?Array.from(g.index.array):Array.from({length:g.attributes.position.count},(_,j)=>j),...(g.attributes.normal?{normals:Array.from(g.attributes.normal.array)}:{}),...(g.attributes.uv?{uvs:Array.from(g.attributes.uv.array)}:{})};
   }
   doc.objects[oid]={id:oid,label:n.name||oid,parent:ids.get(n.parent)??null,collection:null,transform:trs(n),visible:n.visible,selectable:true,geometry,materialSlots:slots,modifiers:[]};
  }
  const moving=new Set([...rig.joints.values()].map(j=>j.pivot));if(rig.chest)moving.add(rig.chest);for(const lid of Object.values(rig.lids))moving.add(lid);
  const clip={id:'anim_craft',label:'Rigid craft performance',fps:[fps,1],tracks:{}};
  const count=Math.ceil(schedule.seconds*fps);if(count*moving.size*3>1000000)throw new Error('Rigid bake key budget exceeded');
  for(let i=0;i<=count;i++){
   // Restore every baseline: a missing channel must not inherit the previous seek.
   for(const n of nodes){const b=doc.objects[ids.get(n)].transform;n.position.fromArray(b.position);n.quaternion.fromArray(b.rotation);n.scale.fromArray(b.scale);}
   const t=i/count*schedule.seconds;applyPose(THREE,rig,evaluateSchedule(schedule,t));
   for(const n of moving)for(const channel of ['position','rotation','scale']){const oid=ids.get(n),tid=`trk_${oid.replaceAll('_','')}${channel}`;clip.tracks[tid]??={id:tid,object:oid,channel,muted:false,locked:false,keys:[]};clip.tracks[tid].keys.push({t,v:trs(n)[channel],ease:'linear'});}
  }
  doc.animations[clip.id]=clip;
  doc.extensions['craft-native']={version:1,bundle:`${bundle.schema.bundleId}@${bundle.schema.bundleVersion}`,contentHash:bundle.contentHashFull??null,performance,seed:performance.seed,fps,joints:Object.fromEntries([...rig.joints].map(([name,j])=>[name,ids.get(j.pivot)])),capabilities:{rigid:'baked',deforming:'unsupported',massSupport:'unverified',blenderParity:'unverified'}};
  return doc;
 }finally{for(const r of resources)r.dispose();}
}
