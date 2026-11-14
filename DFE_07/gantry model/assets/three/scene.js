// Robot Factory G-04. Metres, Y-up. All motion is rigid and absolute-time.
import { bevelBox } from './parts.js';
import { applyDirectionStage } from './scene-kit.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const PALETTE={white:'#f4f1ec','light grey':'#a3a5a8','electric blue':'#136dec',orange:'#ed7e1d','white dark':'#d7cebc','light grey dark':'#7c7f83','white light':'#f9f8f6','light grey light':'#cccccc','soot black':'#1b1b22','warm white':'#f2ede2','mid grey':'#7d828c','dark wood':'#3d2a1c'};
const P=[-1.30,-1.35],D=[1.30,1.35],RAISED=1.95,LOW=1.07;
const smooth=x=>{x=Math.max(0,Math.min(1,x));return x*x*x*(x*(x*6-15)+10)};
const move=(t,a,b,x,y)=>x+(y-x)*smooth((t-a)/(b-a));
export function cyclePose(seconds){
 const t=((seconds%8)+8)%8;
 let x=0,z=.10,y=RAISED,g=.28;
 if(t<1.05){x=move(t,.1,1.05,0,P[0]);z=move(t,.1,1.05,.1,P[1]-.28)}
 else if(t<2.65){x=P[0];z=P[1]-.28;y=t<1.75?move(t,1.05,1.75,RAISED,LOW):t<2.05?LOW:move(t,2.05,2.65,LOW,RAISED);g=move(t,1.75,2.05,.28,.1925)}
 else if(t<4.35){x=move(t,2.65,4.35,P[0],D[0]);z=move(t,2.65,4.35,P[1]-.28,D[1]-.28);g=.1925}
 else if(t<5.95){x=D[0];z=D[1]-.28;y=t<5?move(t,4.35,5,RAISED,LOW):t<5.3?LOW:move(t,5.3,5.95,LOW,RAISED);g=move(t,5,5.3,.1925,.28)}
 else {x=move(t,5.95,7.65,D[0],0);z=move(t,5.95,7.65,D[1]-.28,.10)}
 let wp=[P[0],.78,P[1]],source=.66,dest=.66,shuttle=[D[0],.20,D[1]];
 if(t>=2.05&&t<=5){wp=[x,y-.29,z+.28]}
 else if(t>5&&t<5.3){wp=[D[0],.78,D[1]]}
 else if(t>=5.3&&t<5.85){dest=move(t,5.3,5.85,.66,.20);wp=[D[0],dest+.12,D[1]]}
 else if(t>=5.85&&t<7.15){const q=smooth((t-5.85)/1.3);wp=[D[0]+(P[0]-D[0])*q,.32,D[1]+(P[1]-D[1])*q];dest=.20;shuttle=[wp[0],.20,wp[2]];source=.20}
 else if(t>=7.15){source=move(t,7.15,7.85,.20,.66);dest=move(t,7.15,7.85,.20,.66);wp=[P[0],source+.12,P[1]];shuttle=[move(t,7.15,8,P[0],D[0]),.20,move(t,7.15,8,P[1],D[1])]}
 if(t>=5.3&&t<5.85)source=move(t,5.3,5.85,.66,.20);
 return {t,x,z,y,g,wp,source,dest,shuttle};
}

const views={hero:{position:[-9,6.3,11.5],target:[0,1.3,0],fov:36},front:{position:[0,3.3,13.8],target:[0,1.5,0],fov:36},side:{position:[13.8,3.6,0],target:[0,1.5,0],fov:36},top:{position:[0,14,.001],target:[0,0,0],fov:36}};
export default {
 id:'robot-factory-gantry',autoRotate:false,family:'abstract-kinetic',
 meta:{notes:'Industrial overhead Cartesian gantry: approximately 5.0 m wide × 3.2 m high × 5.2 m deep. Units: metres. Y-up. Model origin is the centre of the base at floor level. Exact named rigid motion nodes; baked eight-second Pick_Place_8s clip. lineSpeed range 0–1, default 0.5; playback multiplier 2 × lineSpeed. Demonstration station lift tables and a low return shuttle reset the single workpiece continuously.'},
 params:{lineSpeed:{value:.5,min:0,max:1,step:.01}},
 materials:Object.fromEntries(Object.entries(PALETTE).map(([name,color])=>[name,{color,roughness:.94,metalness:0,flatShading:true}])),
 views,motion:{duration:8,loop:true,rest:0},
 build({THREE,parts,lib,params}){
  window.__1design?.scene3d?.setSpeed(2 * Math.max(0,Math.min(1,params.lineSpeed)));
  const mat={};for(const [name,color]of Object.entries(PALETTE)){mat[name]=new THREE.MeshStandardMaterial({name,color,roughness:.94,metalness:0,flatShading:true});mat[name].userData.role=name}
  const root=new THREE.Group();root.name='Robot_Factory_Gantry';parts.add(root,'gantry','Robot Factory gantry');root.userData={...root.userData,meta:this.meta,units:'m',upAxis:'Y',parameters:{lineSpeed:{min:0,max:1,default:.5,value:params.lineSpeed,animation:'Pick_Place_8s',playbackMultiplier:2}}};
  const buckets=new Map();
  const group=(name,id,parent=root,pos=[0,0,0])=>{const g=new THREE.Group();g.name=name;g.position.fromArray(pos);parent.add(g);parts.add(g,id,name);buckets.set(g,new Map());return g};
  const addGeo=(g,geo,color,pos=[0,0,0],rot=[0,0,0])=>{const matrix=new THREE.Matrix4().compose(new THREE.Vector3().fromArray(pos),new THREE.Quaternion().setFromEuler(new THREE.Euler(...rot)),new THREE.Vector3(1,1,1));geo.applyMatrix4(matrix);const b=buckets.get(g);if(!b.has(color))b.set(color,[]);b.get(color).push(geo);};
  const box=(g,w,h,d,p,color='white',r=[0,0,0])=>addGeo(g,bevelBox(THREE,{w,h,d,r:0,seg:1}),color,p,r);
  const cyl=(g,r,h,p,color='light grey',rot=[0,0,0],n=8)=>addGeo(g,new THREE.CylinderGeometry(r,r,h,n,1),color,p,rot);
  const strut=(g,a,b,w,d,color)=>{const va=new THREE.Vector3().fromArray(a),vb=new THREE.Vector3().fromArray(b),dir=vb.clone().sub(va);const geo=bevelBox(THREE,{w,h:dir.length(),d,r:0,seg:1});geo.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0,1,0),dir.normalize()));addGeo(g,geo,color,va.add(vb).multiplyScalar(.5).toArray())};
  const base=group('Gantry_Base','gantry.base');base.userData.joins={feet:'floor contact y=0',columns:'bolted butt joints',rails:'supported at both column tops'};
  for(const [tag,x,z]of [['FL',-2.25,2.35],['FR',2.25,2.35],['RL',-2.25,-2.35],['RR',2.25,-2.35]]){
   const col=group(`Column_${tag}`,`gantry.base.column_${tag.toLowerCase()}`,base,[x,0,z]);
   box(col,.50,.055,.50,[0,.0275,0],'light grey dark');box(col,.34,.065,.34,[0,.0875,0],'light grey');
   box(col,.20,2.65,.20,[0,1.445,0],'white');box(col,.13,2.48,.012,[0,1.42,.106],'light grey');
   box(col,.32,.10,.36,[0,2.78,0],'light grey');
   for(const dx of [-.18,.18])for(const dz of [-.18,.18]){cyl(col,.027,.025,[dx,.068,dz],'soot black');cyl(col,.013,.05,[dx,.092,dz],'light grey')}
   for(const sx of [-1,1]){strut(col,[sx*.10,.15,0],[sx*.21,.07,0],.04,.12,'light grey');strut(col,[0,2.61,0],[0,2.78,-Math.sign(z)*.42],.10,.12,'white')}
   box(col,.22,.15,.022,[0,.29,.117],'orange');for(let i=0;i<3;i++)box(col,.035,.15,.024,[-.066+i*.066,.29,.12],'soot black',[0,0,-.22]);
  }
  for(const [side,x]of [['Left',-2.25],['Right',2.25]]){
   const rail=group(`Rail_${side}`,`gantry.base.rail_${side.toLowerCase()}`,base,[x,2.83,0]);
   box(rail,.23,.25,5.0,[0,0,0],'white');box(rail,.27,.045,5.0,[0,-.13,0],'light grey');box(rail,.105,.045,4.64,[0,.15,0],'light grey dark');box(rail,.063,.025,4.64,[0,.18,0],'light grey light');
   box(rail,.018,.065,4.5,[side==='Left'?.127:-.127,.045,0],'soot black');
   for(const z of [-2.24,2.24]){box(rail,.28,.14,.12,[0,.14,z],'orange');box(rail,.15,.08,.05,[0,.15,z-Math.sign(z)*.08],'soot black')}
  }
  // End ties preserve the portal geometry without occupying the working envelope.
  for(const z of [-2.35,2.35]){box(base,4.5,.16,.14,[0,2.69,z],'white');box(base,4.45,.025,.06,[0,2.78,z],'light grey')}
  const bridge=group('Bridge_Z','gantry.bridge',root,[0,3.02,.10]);bridge.userData.joint={type:'prismatic',axis:[0,0,1],limits:[-1.7,1.7]};
  box(bridge,4.50,.28,.28,[0,0,0],'electric blue');box(bridge,4.35,.035,.055,[0,-.07,.171],'light grey light');box(bridge,4.35,.035,.055,[0,.08,.171],'light grey light');box(bridge,4.25,.025,.035,[0,.005,.177],'soot black');
  for(const x of [-2.25,2.25]){box(bridge,.32,.12,.63,[x,.035,0],'electric blue');for(const z of [-.19,.19]){box(bridge,.18,.07,.13,[x,-.075,z],'light grey dark');box(bridge,.25,.025,.16,[x,-.025,z],'light grey light')};box(bridge,.05,.25,.31,[x+Math.sign(x)*.17,-.04,0],'orange')}
  const carriage=group('Carriage_X','gantry.bridge.carriage',bridge,[0,0,0]);carriage.userData.joint={type:'prismatic',axis:[1,0,0],limits:[-1.75,1.75]};
  box(carriage,.52,.38,.16,[0,0,.23],'electric blue');box(carriage,.60,.06,.39,[0,.16,.10],'electric blue');
  for(const x of [-.20,.20])for(const y of [-.08,.08])box(carriage,.13,.07,.08,[x,y,.17],'light grey dark');
  // Fixed guide sleeve with a long bearing overlap at the lowest lift position.
  box(carriage,.32,.74,.23,[0,-.43,.28],'electric blue');for(const x of [-.12,.12])box(carriage,.045,.70,.035,[x,-.43,.414],'light grey light');
  const lift=group('Lift_Y','gantry.bridge.carriage.lift',carriage,[0,RAISED-3.02,.28]);lift.userData.joint={type:'prismatic',axis:[0,1,0],limits:[LOW-3.02,RAISED-3.02]};
  box(lift,.14,1.22,.14,[0,.61,0],'light grey light');box(lift,.045,1.18,.015,[0,.61,.078],'soot black');box(lift,.25,.055,.24,[0,.0275,0],'orange');
  const grip=group('Gripper_Body','gantry.bridge.carriage.lift.gripper',lift);
  box(grip,.43,.14,.25,[0,-.07,0],'light grey dark');box(grip,.44,.045,.265,[0,-.025,0],'orange');box(grip,.36,.03,.10,[0,-.155,0],'soot black');
  for(const [side,sign]of [['Left',-1],['Right',1]]){
   const f=group(`Finger_${side}`,`gantry.bridge.carriage.lift.gripper.finger_${side.toLowerCase()}`,grip,[sign*.28,0,0]);f.userData.joint={type:'prismatic',axis:[sign,0,0],limits:[.1925,.28]};
   box(f,.075,.21,.13,[0,-.225,0],'orange');box(f,.11,.065,.13,[-sign*.02,-.35,0],'orange');box(f,.025,.16,.12,[-sign*.05,-.245,0],'soot black');
  }
  const motor=(name,id,parent,pos,rot=[0,0,0])=>{const m=group(name,id,parent,pos);m.rotation.fromArray(rot);box(m,.20,.20,.20,[0,0,0],'light grey dark');cyl(m,.088,.23,[0,0,.18],'soot black',[Math.PI/2,0,0]);cyl(m,.095,.04,[0,0,.31],'light grey dark',[Math.PI/2,0,0]);for(const x of [-.065,0,.065])box(m,.014,.16,.18,[x,0,.19],'light grey dark');box(m,.07,.06,.09,[0,.12,.16],'soot black');return m};
  motor('Motor_Bridge','gantry.bridge.motor',bridge,[-2.04,-.04,-.32]);motor('Motor_Carriage','gantry.bridge.carriage.motor',carriage,[.35,.015,.17],[0,Math.PI/2,0]);motor('Motor_Lift','gantry.bridge.carriage.motor_lift',carriage,[.25,-.48,.29],[Math.PI/2,0,0]);
  const chain=group('Cable_Chain','gantry.cable_chain');chain.userData.notes='Constant-length articulated U-fold Z-axis energy chain; individual rigid link transforms baked.';
  const chainLinks=[];for(let i=0;i<32;i++){const link=group(`Cable_Link_${String(i+1).padStart(2,'0')}`,`gantry.cable_chain.link_${i}`,chain);box(link,.105,.045,.128,[0,0,0],'soot black');cyl(link,.018,.105,[0,0,.064],'soot black',[0,0,Math.PI/2]);chainLinks.push(link)}
  const sensors=group('Limit_Sensors','gantry.base.sensors',base);for(const x of [-2.25,2.25])for(const z of [-2.14,2.14]){box(sensors,.095,.08,.075,[x,2.97,z],'soot black');box(sensors,.05,.04,.012,[x,2.97,z-Math.sign(z)*.045],'orange')}
  const light=group('Safety_Light','gantry.base.light',base,[2.25,2.83,2.35]);box(light,.12,.08,.14,[0,.05,0],'soot black');cyl(light,.032,.17,[0,.16,0],'light grey dark');cyl(light,.067,.115,[0,.285,0],'orange');cyl(light,.07,.022,[0,.35,0],'soot black');
  // Machine cabinet, fixed to rear column; its controls face the aisle.
  box(base,.38,.63,.22,[2.00,1.13,-2.35],'light grey light');box(base,.34,.58,.035,[2.00,1.13,-2.22],'white');box(base,.18,.11,.018,[2.00,1.27,-2.19],'soot black');cyl(base,.027,.025,[2.08,.99,-2.18],'orange',[Math.PI/2,0,0]);
  const conveyor=group('Source_Conveyor','gantry.conveyor',root,[P[0],0,P[1]]);
  for(const x of [-.44,.44]){box(conveyor,.07,.16,1.70,[x,.58,0],'white');for(const z of [-.60,.60]){box(conveyor,.075,.50,.075,[x,.28,z],'light grey');box(conveyor,.16,.035,.18,[x,.0175,z],'light grey dark')}}
  // Open central scissor table interrupts the source rollers at the pickup point.
  for(const z of [-.74,-.59,-.44,.44,.59,.74])cyl(conveyor,.045,.78,[0,.615,z],'light grey dark',[0,0,Math.PI/2],10);
  const sourceTable=group('Source_Lift_Table','gantry.conveyor.table',conveyor,[0,.66,0]);box(sourceTable,.75,.035,.62,[0,-.0175,0],'light grey light');box(conveyor,.55,.10,.52,[0,.10,0],'soot black');
  const boxGroup=group('Destination_Box','gantry.box',root,[D[0],0,D[1]]);
  for(const x of [-.49,.49]){box(boxGroup,.06,.44,1.06,[x,.69,0],'white dark');box(boxGroup,.075,.035,1.08,[x,.925,0],'orange')}
  for(const z of [-.50,.50]){box(boxGroup,.94,.23,.06,[0,.805,z],'white dark');box(boxGroup,1.05,.035,.075,[0,.925,z],'orange')}
  for(const x of [-.43,.43])for(const z of [-.43,.43]){box(boxGroup,.075,.43,.075,[x,.235,z],'light grey');box(boxGroup,.17,.035,.17,[x,.0175,z],'light grey dark')}
  const destTable=group('Receiving_Lift_Table','gantry.box.table',boxGroup,[0,.66,0]);box(destTable,.92,.035,.92,[0,-.0175,0],'light grey light');
  const returnTrack=group('Return_Shuttle_Track','gantry.return_track');const a=new THREE.Vector3(P[0],.14,P[1]),b=new THREE.Vector3(D[0],.14,D[1]);const delta=b.clone().sub(a),perp=new THREE.Vector3(delta.z,0,-delta.x).normalize().multiplyScalar(.20);for(const s of [-1,1])strut(returnTrack,a.clone().addScaledVector(perp,s).toArray(),b.clone().addScaledVector(perp,s).toArray(),.055,.05,'light grey dark');for(const q of [0,.5,1]){const c=a.clone().lerp(b,q);box(returnTrack,.52,.055,.52,[c.x,.0275,c.z],'light grey')}
  const shuttle=group('Return_Shuttle','gantry.return_track.shuttle',root,[D[0],.20,D[1]]);box(shuttle,.48,.05,.48,[0,-.025,0],'electric blue');
  const wp=group('Demo_Workpiece','gantry.workpiece',root,[P[0],.78,P[1]]);box(wp,.26,.24,.25,[0,0,0],'white light');box(wp,.16,.06,.17,[0,.15,0],'electric blue');box(wp,.11,.08,.015,[0,.02,.133],'soot black');for(const x of [-.07,.07])cyl(wp,.028,.022,[x,.11,0],'light grey dark');
  // Compact rigid subassemblies share a mesh per palette material, while every
  // controllable node and all its rigid children remain separate and named.
  for(const [g,bucket]of buckets){let i=0;for(const [color,geos]of bucket){const geo=mergeGeometries(geos,false);const mesh=new THREE.Mesh(geo,mat[color]);mesh.name=`${g.name}_${color.replaceAll(' ','_')}`;mesh.castShadow=mesh.receiveShadow=true;mesh.userData.role=color;parts.add(mesh,`${g.userData.partId}.mesh_${i++}`,mesh.name);g.add(mesh);geos.forEach(x=>x.dispose())}}
  this._nodes={bridge,carriage,lift,grip,fleft:parts.find('gantry.bridge.carriage.lift.gripper.finger_left').object,fright:parts.find('gantry.bridge.carriage.lift.gripper.finger_right').object,chainLinks,wp,sourceTable,destTable,shuttle};
  const animate=t=>this._pose(t);
  const animated=[bridge,carriage,lift,this._nodes.fleft,this._nodes.fright,wp,sourceTable,destTable,shuttle,...chainLinks];
  const samples=animated.map(()=>({times:[],values:[],quats:[]}));
  for(let f=0;f<=480;f++){const t=f/60;animate(t);animated.forEach((o,i)=>{samples[i].times.push(t);samples[i].values.push(...o.position.toArray());samples[i].quats.push(...o.quaternion.toArray())})}
  const tracks=[];animated.forEach((o,i)=>{tracks.push(new THREE.VectorKeyframeTrack(`${o.name}.position`,samples[i].times,samples[i].values));if(chainLinks.includes(o))tracks.push(new THREE.QuaternionKeyframeTrack(`${o.name}.quaternion`,samples[i].times,samples[i].quats))});
  const clip=new THREE.AnimationClip('Pick_Place_8s',8,tracks);animate(0);
  const dir={schemaVersion:1,id:'flat-lowpoly',version:'1.0.0',signature:'Readable uniform facets and silhouette-first engineering',construction:{recipes:['beveled-panel']},light_rig:'flat_lowpoly_sun',environment:'local-room-studio-v1',ground:false,post:{tone:'aces',exposure:.90,bloom:{enabled:false}}};
  this._stage=applyDirectionStage(lib,dir,{target:root,ground:false});
  lib.scene.background=new THREE.Color('#f4f1ec');
  // Broad neutral fill and a scene-sized shadow frustum retain all four feet.
  lib.roots.environment.traverse(o=>{if(o.isDirectionalLight){o.intensity=2.0;o.position.set(-3,7,5);o.shadow.camera.left=-5;o.shadow.camera.right=5;o.shadow.camera.top=5;o.shadow.camera.bottom=-5;o.shadow.camera.near=.1;o.shadow.camera.far=25;o.shadow.bias=-.0004}if(o.name==='ground-catcher')o.position.y=-.005});
  const fill=new THREE.DirectionalLight('#f9f8f6',.65);fill.position.set(4,3,-4);lib.roots.environment.add(fill);
  lib.scene.environmentIntensity=.60;
  lib.controls.autoRotate=false;
  // Frame the full mechanical travel envelope rather than the current pose.
  // This object is never attached to the scene or model export.
  const envelope=new THREE.Mesh(new THREE.BoxGeometry(5,3.24,5.2),mat.white);
  envelope.position.y=1.62;envelope.visible=false;
  return {root,envelope,clips:[clip]};
 },
 _pose(t){if(!this._nodes)return;const s=cyclePose(t),n=this._nodes;n.bridge.position.z=s.z;n.carriage.position.x=s.x;n.lift.position.y=s.y-3.02;n.fleft.position.x=-s.g;n.fright.position.x=s.g;n.wp.position.fromArray(s.wp);n.sourceTable.position.y=s.source;n.destTable.position.y=s.dest;n.shuttle.position.fromArray(s.shuttle);
  // Equal-arclength rigid links along a fixed-length folded cable carrier.
  const length=4.20,R=.20,start=-2.18,fold=(length+start+s.z-Math.PI*R)/2,leg=fold-start;
  n.chainLinks.forEach((link,i)=>{const u=(i+.5)*length/n.chainLinks.length;let y=2.77,z,angle;if(u<leg){z=start+u;angle=0}else if(u<leg+Math.PI*R){const a=(u-leg)/R;z=fold+Math.sin(a)*R;y=2.77+R*(1-Math.cos(a));angle=-a}else{z=fold-(u-leg-Math.PI*R);y=2.77+2*R;angle=-Math.PI}link.position.set(-2.43,y,z);link.rotation.x=angle});
 },
 evaluatePose({t}){this._pose(t)}
};





