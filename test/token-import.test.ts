import assert from 'node:assert/strict';
import {test} from 'node:test';
import {importedTokenDocument,parseImportedTokens} from '../src/token-import.js';
import {parseTokensJson} from '../src/codebase/tokens-json.js';
import {diffTokens} from '../src/core/diff.js';

function snapshot() {return {collections:[{id:'c',name:'Colors',defaultModeId:'l',modes:[{modeId:'l',name:'Light'},{modeId:'d',name:'Dark'}]}],variables:[
{id:'a',name:'color/base',collectionId:'c',resolvedType:'COLOR',valuesByMode:{Light:{type:'COLOR',value:'#ffffff'},Dark:{type:'COLOR',value:'#111111'}}},
{id:'b',name:'color/surface',collectionId:'c',resolvedType:'COLOR',valuesByMode:{Light:{type:'VARIABLE_ALIAS',id:'a'},Dark:{type:'VARIABLE_ALIAS',id:'a'}}},
]};}
test('import retains aliases, source IDs and all modes while resolving comparable code values',()=> {
 const source=snapshot();const plan=importedTokenDocument(source,'file',new Set());const data=JSON.parse(plan.content);
 assert.equal(data.tokens['color-surface'].aliases.Dark,'{color-base}');
 assert.equal(data.tokens['color-surface'].modes.Dark,'#111111');
 assert.equal(data.source.variables[1].valuesByMode.Dark.id,'a');
 const code=parseTokensJson('unused',plan.content);
 const figma=[{name:'color-surface',category:'color' as const,value:'#111111',mode:'Dark',source:'figma' as const}];
 assert.equal(diffTokens(figma,code,{}).valueMismatches.length,0);
 const dark=code.find(item => item.name==='color-surface' && item.mode==='Dark')!;dark.value='#333333';
 assert.equal(diffTokens(figma,code,{}).valueMismatches[0].codeValue,'#333333');
 assert.equal(parseImportedTokens(data).filter(item => !item.mode).length,2);
});
test('import skips existing code names and rejects ambiguous names, missing targets and cycles',()=> {
 const source=snapshot();assert.deepEqual(importedTokenDocument(source,'file',new Set(['color-base'])).names,['color-surface']);
 assert.equal(importedTokenDocument({...source,variables:[...source.variables,{...source.variables[0],id:'collision',name:'color-base'}]},'file',new Set()).names.length,3);
 source.variables[0].valuesByMode.Light={type:'VARIABLE_ALIAS',id:'b'} as any;
 assert.throws(()=>importedTokenDocument(source,'file',new Set()),/Cyclic/);
 const missing=snapshot();missing.variables.pop();missing.variables[0].valuesByMode.Light={type:'VARIABLE_ALIAS',id:'absent'} as any;
 assert.throws(()=>importedTokenDocument(missing,'file',new Set()),/missing/);
});

test('duplicate names in separate collections retain collection identity and cross-collection aliases',()=>{
 const source=snapshot();source.collections.push({...source.collections[0],id:'other',name:'Semantic'});
 source.variables.push({...source.variables[0],id:'other-base',collectionId:'other'});
 source.variables[1].valuesByMode.Dark.id='other-base';
 const data=JSON.parse(importedTokenDocument(source,'file',new Set()).content);
 assert.equal(data.tokens['colors-color-base'].collectionId,'c');
 assert.equal(data.tokens['semantic-color-base'].collectionId,'other');
 assert.equal(data.tokens['color-surface'].aliases.Dark,'{semantic-color-base}');
 assert.equal(data.tokens['color-surface'].modes.Dark,'#111111');
});

test('collection-aware imported names match live bridge reads',async()=>{
 const {fetchBridgeVariables}=await import('../src/figma/bridge.js');
 const source=snapshot();source.collections.push({...source.collections[0],id:'other',name:'Semantic'});
 source.variables.push({...source.variables[0],id:'other-base',collectionId:'other'});
 const caller={close(){},async call<T>(method:string):Promise<T>{return (method==='list_collections'?{collections:source.collections}:{variables:source.variables}) as T;}};
 const code=parseImportedTokens(JSON.parse(importedTokenDocument(source,'file',new Set()).content));
 const live=await fetchBridgeVariables(caller,{modeName:'all',collectionAwareNames:true});
 const drift=diffTokens(live,code,{});
 assert.equal(drift.valueMismatches.length,0);
 assert.equal(drift.missingInCode.length,0);
 assert.equal(drift.missingInFigma.length,0);
});
test('collection prefixes do not change numeric token categories',()=>{
 const source={collections:[{id:'c',name:'Colors',defaultModeId:'v',modes:[{modeId:'v',name:'Value'}]},{id:'d',name:'Typography',defaultModeId:'v',modes:[{modeId:'v',name:'Value'}]}],variables:[{id:'a',name:'radius/md',collectionId:'c',resolvedType:'FLOAT',valuesByMode:{Value:{type:'FLOAT',value:8}}},{id:'b',name:'radius/md',collectionId:'d',resolvedType:'FLOAT',valuesByMode:{Value:{type:'FLOAT',value:12}}}]};
 const data=JSON.parse(importedTokenDocument(source,'file',new Set()).content);
 assert(parseImportedTokens(data).every(item=>item.category==='radius'));
});
