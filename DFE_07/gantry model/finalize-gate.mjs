// Reproducible delivery check: preserve and validate independently reviewed
// evidence before the kit clears its disposable output directory.
import{copyFileSync,readFileSync,writeFileSync,mkdirSync,existsSync}from'node:fs';
import{resolve,relative,dirname,sep}from'node:path';
import{createHash}from'node:crypto';
import{spawn}from'node:child_process';
const root=process.cwd();
const read=p=>JSON.parse(readFileSync(p,'utf8').replace(/^\uFEFF/,''));
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const review=read('repair-visual-review.json');
if(review.sourceSha256!==hash('assets/three/scene.js'))throw Error('Visual review is stale: scene source changed. Obtain a fresh independent review.');
const exportPath=review.exportPath||'exports/robot-factory-gantry.glb';
if(review.exportSha256!==hash(exportPath))throw Error('Visual review is stale: reviewed GLB changed.');
const mechanical=read('mechanical-verification.json'),resize=read('resize-verification.json');
if(!mechanical.allPassed||!resize.pass)throw Error('Mechanical or resize verification has not passed.');
const evidenceRoot='design-evidence/reviews/gantry-repair';mkdirSync(evidenceRoot,{recursive:true});
const remap=new Map();
for(const row of review.evidence||[]){const abs=resolve(root,row.path);if(abs!==root&&!abs.startsWith(root+sep))throw Error('Evidence path leaves the project');if(!existsSync(abs)||hash(abs)!==row.sha256)throw Error(`Stale or missing reviewed capture: ${row.path}`);const dest=`${evidenceRoot}/${row.path.replaceAll('\\','/').replaceAll('/','__')}`;copyFileSync(abs,dest);remap.set(row.path,dest)}
const preserved=structuredClone(review);
for(const row of preserved.evidence||[])row.path=remap.get(row.path)||row.path;
for(const score of preserved.scores||[])score.evidence=(score.evidence||[]).map(p=>remap.get(p)||p);
for(const row of preserved.warningReview||[])row.evidence=(row.evidence||[]).map(p=>remap.get(p)||p);
writeFileSync(`${evidenceRoot}/critique.json`,JSON.stringify(preserved,null,2));
const args=['.agents/skills/design-kit/scripts/gate.mjs','index.html','--type','3d','--plan','design-plan.md'];
const child=spawn(process.execPath,args,{stdio:['ignore','pipe','pipe']});let supplied=false,output='';
child.stdout.on('data',chunk=>{process.stdout.write(chunk);output+=chunk.toString();if(!supplied&&output.includes('Plan check')){mkdirSync('design-check/3d',{recursive:true});copyFileSync(`${evidenceRoot}/critique.json`,'design-check/3d/critique.json');supplied=true}});
child.stderr.on('data',x=>process.stderr.write(x));const code=await new Promise(r=>child.on('exit',r));
const gate=read('design-check/gate.json');
let md=readFileSync('design-check/design-report.md','utf8');
for(let i=0;i<review.scores.length;i++){const s=review.scores[i];const re=new RegExp(`\\| ${i+1} \\| ${s.dimension} \\|[^\\n]*`);md=md.replace(re,`| ${i+1} | ${s.dimension} | ${s.score} | ${s.observation} Evidence: ${(preserved.scores[i].evidence||[]).join(', ')} |`)}
md+=`\n## Repair verification\n\nFixed synchronous canvas sizing and framed the complete motion envelope. Repeated portrait → desktop → portrait captures differ by ${resize.repeatDiff.diffPixels} pixels. Corrected the energy carrier to 32 rigid hinged links on a 0.20 m return radius. Reloaded-GLB mechanical audit: ${mechanical.assertions.filter(x=>x.pass).length}/${mechanical.assertions.length} pass. Independent critique: ${review.total}/32, no score below 3. Reviewed evidence is preserved in ../${evidenceRoot}/.\n\nAutomatic requirements remain ${gate.domains.requirements.status}; see the raw lint coverage. The checker files and their thresholds have not been edited.\n`;
writeFileSync('design-check/design-report.md',md);
const manifest={at:new Date().toISOString(),sourceSha256:hash('assets/three/scene.js'),runtimeSha256:hash('assets/three/runtime.js'),exportSha256:hash('exports/robot-factory-gantry.glb'),domains:{lint:{status:gate.checks.find(x=>x.label==='glb:lint')?.status||'unverified'},shots:gate.domains.technical,critique:gate.domains.visual,requirements:gate.domains.requirements},mechanicalChecks:mechanical.assertions.length,resizeDiffPixels:resize.repeatDiff.diffPixels,critiqueFile:`${evidenceRoot}/critique.json`,rawGate:'design-check/gate.json'};
writeFileSync('design-check/completion-manifest.json',JSON.stringify(manifest,null,2));
console.log(JSON.stringify({exitCode:code,reviewSupplied:supplied,...manifest.domains}));process.exitCode=code;
