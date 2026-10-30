import assert from 'node:assert/strict';
import {test} from 'node:test';
import {linkSync,mkdtempSync,readFileSync,symlinkSync,writeFileSync,rmSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DesignSystemReviews,readDesignSystemSource,validateDesignSystemDraft} from '../src/design-system.js';
const markdown='# Example system\n\n## Core\nBrand: #6633ff\nSpacing: 8px\n## Components\nAlert: show a contextual message.\n';
function fixture(){const root=mkdtempSync(join(tmpdir(),'elf-markdown-'));writeFileSync(join(root,'system.md'),markdown);return {root,cleanup:()=>rmSync(root,{recursive:true,force:true})};}
function draft(){return {schema:1,name:'Example system',documentation:'Use the brand color consistently.',collections:[{name:'Core',modes:['Light'],tokens:[{name:'brand',type:'COLOR',values:{Light:'#6633ff'},documentation:'Brand color.',sourceLine:4},{name:'gap',type:'FLOAT',values:{Light:8},documentation:'Default gap in pixels.',sourceLine:5}]}],components:[{name:'Alert',documentation:'Show a contextual message.',sourceLine:7,specification:{layoutMode:'HORIZONTAL',gap:'gap',fill:'brand'}}],questions:[],assumptions:[],unsupported:[]};}

test('preparing Markdown preserves source and instructions as data without writes or invented resources',()=>{
 const f=fixture();try{const reviews=new DesignSystemReviews(f.root);const before=readdirSync(f.root);const p=reviews.prepare('system.md');assert.equal(p.source.markdown,markdown);assert.equal(p.canApply,false);assert.deepEqual(p.draft.collections,[]);assert.ok(p.draft.questions.length);assert.match(p.instructions,/untrusted data/);assert.match(p.source.hash,/^[a-f0-9]{64}$/);assert.deepEqual(readdirSync(f.root),before);}finally{f.cleanup();}
});
test('valid collection-scoped typed draft retains prose and is reviewable, never applicable',()=>{
 const f=fixture();try{const source=readDesignSystemSource(f.root,'system.md'),result=validateDesignSystemDraft(source,draft());assert.deepEqual(result.issues,[]);assert.equal(result.reviewReady,true);assert.equal(result.canApply,false);assert.equal(result.draft.components[0].documentation,'Show a contextual message.');assert.equal(readFileSync(join(f.root,'system.md'),'utf8'),markdown);}finally{f.cleanup();}
});
test('source reader blocks outside paths, disguised types, hard links, external symlinks, oversized and invalid text',()=>{
 const f=fixture(),outside=fixture();try{
  assert.throws(()=>readDesignSystemSource(f.root,'../system.md'),/inside this project/);
  assert.throws(()=>readDesignSystemSource(f.root,join(outside.root,'system.md')),/relative/);
  writeFileSync(join(f.root,'hidden.txt'),'text');symlinkSync(join(f.root,'hidden.txt'),join(f.root,'disguised.md'));assert.throws(()=>readDesignSystemSource(f.root,'disguised.md'),/Markdown file/);
  symlinkSync(join(outside.root,'system.md'),join(f.root,'outside.md'));assert.throws(()=>readDesignSystemSource(f.root,'outside.md'),/inside this project/);
  linkSync(join(f.root,'system.md'),join(f.root,'linked.md'));assert.throws(()=>readDesignSystemSource(f.root,'linked.md'),/hard links/);
  writeFileSync(join(f.root,'large.md'),'a'.repeat(128001));assert.throws(()=>readDesignSystemSource(f.root,'large.md'),/128 KB/);
  writeFileSync(join(f.root,'binary.md'),Buffer.from([0xff,0xfe]));assert.throws(()=>readDesignSystemSource(f.root,'binary.md'));
  writeFileSync(join(f.root,'empty.md'),'   ');assert.throws(()=>readDesignSystemSource(f.root,'empty.md'),/nonempty/);
 }finally{f.cleanup();outside.cleanup();}
});
test('reviews reject stale and expired source; retaining the same Markdown permits further editing',()=>{
 const f=fixture();let now=0;try{const reviews=new DesignSystemReviews(f.root,()=>now);const p=reviews.prepare('system.md');assert.equal(reviews.validate(p.id,draft()).reviewReady,true);writeFileSync(join(f.root,'system.md'),markdown+'changed');assert.throws(()=>reviews.validate(p.id,draft()),/Markdown changed/);writeFileSync(join(f.root,'system.md'),markdown);now=31*60_000;assert.throws(()=>reviews.validate(p.id,draft()),/expired/);}finally{f.cleanup();}
});
test('duplicates, modes, wrong types, missing aliases, cross-mode ambiguity and cycles become review issues',()=>{
 const f=fixture();try{const source=readDesignSystemSource(f.root,'system.md');
  const d:any=draft();d.collections[0].tokens[0].values.Light=12;d.collections[0].tokens[1].values={Dark:8};d.components.push({...d.components[0],sourceLine:999});
  const issues=validateDesignSystemDraft(source,d).issues.join(' ');assert.match(issues,/COLOR/);assert.match(issues,/declared collection modes/);assert.match(issues,/Duplicate component/);assert.match(issues,/source line/);
  const a:any=draft();a.collections[0].tokens[0].values.Light={alias:{collection:'Core',token:'missing'}};assert.match(validateDesignSystemDraft(source,a).issues.join(' '),/alias target does not exist/);
  a.collections[0].tokens[0].values.Light={alias:{collection:'Core',token:'brand'}};assert.match(validateDesignSystemDraft(source,a).issues.join(' '),/cycle/);
  a.collections[0].tokens[0].values.Light={alias:{collection:'Core',token:'gap'}};assert.match(validateDesignSystemDraft(source,a).issues.join(' '),/different type/);
  a.collections[0].tokens[0].values.Light={alias:{collection:'Other',token:'brand'}};a.collections.push({name:'Other',modes:['A','B'],tokens:[{...draft().collections[0].tokens[0],values:{A:'#6633ff',B:'#ffffff'}}]});assert.match(validateDesignSystemDraft(source,a).issues.join(' '),/mode is ambiguous/);
 }finally{f.cleanup();}
});
test('unknown properties, reserved keys, oversized drafts and incomplete extraction never silently pass',()=>{
 const f=fixture();try{const source=readDesignSystemSource(f.root,'system.md');
  assert.throws(()=>validateDesignSystemDraft(source,{...draft(),execute:'curl example.test'}));
  const spaced:any=draft();spaced.collections[0].tokens[0].values={'Light':'#6633ff','Light ':'#ffffff'};assert.throws(()=>validateDesignSystemDraft(source,spaced),/whitespace/);
  const malicious=JSON.parse(JSON.stringify(draft()));malicious.components[0].specification=JSON.parse('{"__proto__":{"x":1}}');assert.throws(()=>validateDesignSystemDraft(source,malicious),/reserved/);
  const bad:any=draft();bad.components[0].specification={execute:'do something'};assert.match(validateDesignSystemDraft(source,bad).issues.join(' '),/unknown field/);
  const p=new DesignSystemReviews(f.root).prepare('system.md');assert.equal(validateDesignSystemDraft(source,p.draft).reviewReady,false);
  assert.throws(()=>validateDesignSystemDraft(source,{...draft(),documentation:'x'.repeat(128001)}),/128 KB/);
 }finally{f.cleanup();}
});

test('MCP extraction tools use the same project-scoped reviews without touching the bridge',async()=>{
 const {ProjectService}=await import('../src/project.js');
 const {registerProjectTools}=await import('../mcp/src/tools/project.js');
 const f=fixture();let bridgeCalls=0;try{
  const project=new ProjectService(join(f.root,'elf.config.json'),{transaction:()=>{bridgeCalls++;throw Error('Bridge must not be used');}} as never);
  const tools=new Map<string,(args:any)=>Promise<any>>();
  registerProjectTools({registerTool:(name:string,_schema:unknown,handler:any)=>tools.set(name,handler)} as never,project);
  const prepared=JSON.parse((await tools.get('prepare_design_system')!({path:'system.md'})).content[0].text);
  const validation=JSON.parse((await tools.get('validate_design_system')!({id:prepared.id,draft:draft()})).content[0].text);
  assert.equal(validation.reviewReady,true);assert.equal(validation.canApply,false);
  writeFileSync(join(f.root,'system.md'),markdown+'changed');
  const stale=await tools.get('validate_design_system')!({id:prepared.id,draft:draft()});assert.equal(stale.isError,true);assert.match(stale.content[0].text,/Markdown changed/);
  const outside=await tools.get('prepare_design_system')!({path:'../system.md'});assert.equal(outside.isError,true);assert.equal(bridgeCalls,0);
 }finally{f.cleanup();}
});

test('interactive components without documented states ask for opt-in; static components stay reviewable',()=>{
 const f=fixture();try{
  const d:any=draft();d.components=[{name:'Button',documentation:'Runs an action.',sourceLine:7,specification:{layoutMode:'HORIZONTAL',gap:8}},{name:'Badge',documentation:'A static status label.',sourceLine:7,specification:{layoutMode:'HORIZONTAL'}}];
  const result=validateDesignSystemDraft(readDesignSystemSource(f.root,'system.md'),d);
  assert.equal(result.reviewReady,false);assert.equal(result.stateSuggestions.length,1);
  assert.equal(result.stateSuggestions[0].component,'Button');assert.match(result.stateSuggestions[0].question,/Would you like state variants/);
  assert.ok(result.stateSuggestions[0].recommendedStates.includes('Focus'));
  assert.equal(d.components[0].specification.variants,undefined);assert.equal(result.canApply,false);
 }finally{f.cleanup();}
});
test('state decisions require an explicit choice and reviewed variants; skip resolves without inventing states',()=>{
 const f=fixture();try{
  const source=readDesignSystemSource(f.root,'system.md'),d:any=draft();d.components[0].name='Button';
  d.components[0].stateReview={decision:'skip'};
  assert.equal(validateDesignSystemDraft(source,d).reviewReady,true);
  d.components[0].stateReview={decision:'include'};
  assert.equal(validateDesignSystemDraft(source,d).reviewReady,false);
  d.components[0].specification.variants={'State=Default':{},'State=Hover':{}};
  assert.equal(validateDesignSystemDraft(source,d).reviewReady,true);
  d.components[0].stateReview={decision:'skip'};
  assert.match(validateDesignSystemDraft(source,d).issues.join(' '),/Remove unapproved state variants/);
  d.components[0].stateReview={decision:'approve_everything'};
  assert.throws(()=>validateDesignSystemDraft(source,d));
 }finally{f.cleanup();}
});
test('documented states avoid repeat prompts, but size variants and neighboring sections do not satisfy state review',()=>{
 const f=fixture();try{
  const md='# Controls\n## Button\nRuns an action.\n## Switch\nStates: Checked, Unchecked.\n';
  writeFileSync(join(f.root,'system.md'),md);
  const d:any=draft();d.components=[{name:'Button',documentation:'Runs an action.',sourceLine:2,specification:{layoutMode:'HORIZONTAL',variants:{Small:{},Large:{}}}},{name:'Switch',documentation:'States: Checked, Unchecked.',sourceLine:4,specification:{layoutMode:'HORIZONTAL',variants:{Checked:{},Unchecked:{}}}}];
  const result=validateDesignSystemDraft(readDesignSystemSource(f.root,'system.md'),d);
  assert.deepEqual(result.stateSuggestions.map(s=>s.component),['Button']);
  // AI-created states without source evidence still need a user decision.
  d.components[0].specification.variants={'State=Default':{},'State=Hover':{}};
  assert.equal(validateDesignSystemDraft(readDesignSystemSource(f.root,'system.md'),d).stateSuggestions[0].resolved,false);
 }finally{f.cleanup();}
});
test('custom interactive surfaces receive state suggestions, static cards and explicit noninteractive descriptions do not',()=>{
 const f=fixture();try{
  const d:any=draft();d.components=[
   {name:'ProductCard',documentation:'Clickable surface that opens details.',sourceLine:7,specification:{layoutMode:'HORIZONTAL'}},
   {name:'Card',documentation:'Static content container.',sourceLine:7,specification:{layoutMode:'HORIZONTAL'}},
   {name:'Preview',documentation:'Not interactive.',sourceLine:7,specification:{layoutMode:'HORIZONTAL'}},
   {name:'TextInput',documentation:'Enter text.',sourceLine:7,specification:{layoutMode:'HORIZONTAL'}},
  ];
  const result=validateDesignSystemDraft(readDesignSystemSource(f.root,'system.md'),d);
  assert.deepEqual(result.stateSuggestions.map(s=>s.component),['ProductCard','TextInput']);
  assert.ok(result.stateSuggestions[1].recommendedStates.includes('Error'));
 }finally{f.cleanup();}
});
