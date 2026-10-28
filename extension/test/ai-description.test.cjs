const assert = require('node:assert/strict');
const { test } = require('node:test');
const { generateDescription, parseDraft, promptFor } = require('../src/ai-description.cjs');
const prepared = { name: 'Button', file: 'Button.tsx', source: 'export function Button(){return <button/>}', tokens: [{name:'color.primary',type:'COLOR'}], sidecar: {}, variantProps: [] };
function harness(consent = true, text = '{"description":{"layoutMode":"HORIZONTAL"},"assumptions":["Width inferred"],"unsupported":["Hover behavior"]}') {
  let calls = 0;
  const model = { name: 'Test model', vendor: 'test', sendRequest: async () => { calls++; return {text:(async function*(){yield text;})()}; } };
  const vscode = { workspace:{isTrusted:true}, lm:{selectChatModels:async()=>[model]}, ProgressLocation:{Notification:1}, LanguageModelChatMessage:{User:content=>({content})}, window:{showQuickPick:async()=>({model}),showWarningMessage:async()=>consent?'Send context and generate':undefined,withProgress:async(_,work)=>work({}, {isCancellationRequested:false})} };
  return {vscode,calls:()=>calls};
}
test('generation requires source-sharing consent before any request', async () => {
  const h=harness(false);assert.equal(await generateDescription(h.vscode,prepared),null);assert.equal(h.calls(),0);
});
test('generation returns a bounded editable draft with explicit uncertainty', async () => {
  const h=harness();const draft=await generateDescription(h.vscode,prepared);
  assert.equal(h.calls(),1);assert.equal(draft.description.layoutMode,'HORIZONTAL');assert.deepEqual(draft.assumptions,['Width inferred']);
  assert.match(promptFor(prepared),/untrusted source data/);
});
test('missing models, malformed output, and untrusted workspaces fail without applying anything', async () => {
  const h=harness(true,'not json');await assert.rejects(generateDescription(h.vscode,prepared),/No project files/);
  h.vscode.workspace.isTrusted=false;await assert.rejects(generateDescription(h.vscode,prepared),/Trust this workspace/);
  assert.throws(()=>parseDraft('{"description":{}}'),/assumptions/);
  assert.throws(()=>parseDraft('x'.repeat(128001)),/too large/);
});

test('documentation generation requests prose without visual specs and rejects visual output',async()=>{
 const docs={...prepared,documentationMode:true,documentation:'Existing usage notes'};
 const h=harness(true,JSON.stringify({description:{documentation:'Immediate action. Label describes the result.'},assumptions:[],unsupported:[]}));
 const result=await generateDescription(h.vscode,docs);
 assert.equal(result.description.documentation,'Immediate action. Label describes the result.');
 assert.match(promptFor(docs),/human-readable Figma component documentation/);
 assert.match(promptFor(docs),/not a visual specification/);
 const bad=harness();await assert.rejects(generateDescription(bad.vscode,docs),/No project files/);
});
