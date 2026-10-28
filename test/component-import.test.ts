import assert from 'node:assert/strict';
import {test} from 'node:test';
import {validateImportedComponent} from '../src/component-import.js';
const options={nodeId:'node',framework:'react' as const,library:'native',path:'ImportedAlert.tsx',reuse:[]};
test('component drafts parse without executing code and require the reviewed export and imports',()=>{
 const code="import React from 'react'; export function ImportedAlert(){return <section aria-label=\"Notice\">Hello</section>}";
 assert.equal(validateImportedComponent(code,options,'/project',[]),code);
 for(const source of ["export function Other(){return <div/>}","export function ImportedAlert( {", "import fs from 'node:fs'; export function ImportedAlert(){return <div/>}","export function ImportedAlert(){fetch('/private');return <div/>}","export function ImportedAlert(){return <div dangerouslySetInnerHTML={{__html:'x'}}/>}","export function ImportedAlert(){return <script/>}","export function ImportedAlert(){import('node:fs');return <div/>}"])assert.throws(()=>validateImportedComponent(source,options,'/project',[]));
 assert.throws(()=>validateImportedComponent('x'.repeat(128001),options,'/project',[]),/128 KB/);
});
test('component imports permit only the chosen library and explicitly reused local files',()=>{
 const code="import {Button} from './components/Button';export function ImportedAlert(){return <Button/>}";
 assert.equal(validateImportedComponent(code,options,'/project',['/project/components/Button.tsx']),code);
 assert.throws(()=>validateImportedComponent(code,options,'/project',[]),/confirmed/);
 const library="import {Button} from '@mui/material';export function ImportedAlert(){return <Button/>}";
 assert.equal(validateImportedComponent(library,{...options,library:'@mui/material'},'/project',[]),library);
 assert.throws(()=>validateImportedComponent(library,options,'/project',[]),/confirmed/);
});
