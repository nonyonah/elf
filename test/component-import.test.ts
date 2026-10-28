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

import {resolveDescriptionToken} from '../batch/src/sidecar.js';
import type {TokenIndex} from '../batch/src/tokens.js';
test('description token aliases preserve exact names, reject ambiguity and never guess absent tokens',()=>{
 const token={name:'spacing-2',codeKey:'spacing-2',type:'FLOAT' as const,literal:8};
 const index:TokenIndex=new Map([['spacing-2',token]]);
 assert.equal(resolveDescriptionToken('spacing.2',index),token);
 assert.equal(resolveDescriptionToken('{spacing/2}',index),token);
 assert.equal(resolveDescriptionToken('spacing.99',index),undefined);
 const other={...token,name:'spacing/2',codeKey:'spacing/2'};index.set('spacing/2',other);
 assert.throws(()=>resolveDescriptionToken('spacing.2',index),/Ambiguous/);
 assert.equal(resolveDescriptionToken('spacing/2',index),other);
});

import {componentLibraryChoices} from '../src/component-library.js';
test('library selections distinguish local shadcn from versioned HeroUI v3 packages',()=>{
 const empty=componentLibraryChoices([]);
 assert(empty.some(item=>item.id==='shadcn'&&!item.installed));
 assert(empty.some(item=>item.id==='@heroui/react'&&item.label==='HeroUI v3'&&!item.installed));
 assert.equal(componentLibraryChoices(['@heroui/react'],{versions:{'@heroui/react':'^2.8.0'}}).find(item=>item.id==='@heroui/react')?.installed,false);
 assert.equal(componentLibraryChoices(['@heroui/react'],{versions:{'@heroui/react':'^3.2.6','@heroui/styles':'^3.2.6'}}).find(item=>item.id==='@heroui/react')?.installed,true);
 assert.equal(componentLibraryChoices([],{shadcnConfigured:true}).find(item=>item.id==='shadcn')?.installed,true);
 const local="import {Button} from './components/Button';export function ImportedAlert(){return <Button/>}";
 assert.equal(validateImportedComponent(local,{...options,library:'shadcn'},'/project',['/project/components/Button.tsx']),local);
 assert.throws(()=>validateImportedComponent("import {Button} from 'shadcn';export function ImportedAlert(){return <Button/>}",{...options,library:'shadcn'},'/project',[]),/confirmed/);
 assert.throws(()=>validateImportedComponent("import {HeroUIProvider as Provider} from '@heroui/react';export function ImportedAlert(){return <Provider/>}",{...options,library:'@heroui/react'},'/project',[]),/v3/);
});
