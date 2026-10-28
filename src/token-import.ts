import {categoryFromName, cssColorToHex, slugify} from './core/normalize.js';
import type {Token} from './core/types.js';
import {pickTargetMode} from './figma/variables.js';

export interface ImportSnapshot {collections:any[];variables:any[];}
/** Lossless source metadata accompanies resolved values for code and drift checks. */
export function importedTokenDocument(snapshot:ImportSnapshot, fileKey:string, existing:Set<string>, ids?:string[], mapping:Record<string,string>={}):{content:string;names:string[];issues:string[]} {
  if (!Array.isArray(snapshot.collections) || !Array.isArray(snapshot.variables) || snapshot.variables.length > 5000 || snapshot.collections.length > 500) throw new Error('Figma token import exceeds the supported review size.');
  const nameOf=(variable:any):string => {const raw=slugify(variable.name); const name=mapping[raw] ?? raw; if (typeof name!=='string' || name!==slugify(name)) throw new Error('Token import requires normalized code names in nameMapping.');return name;};
  const byId = new Map(snapshot.variables.map(variable => [variable.id,variable]));
  const collections = new Map(snapshot.collections.map(collection => [collection.id,collection]));
  const names = new Map<string,string>(); const issues:string[]=[];
  for (const variable of snapshot.variables) {
    if (typeof variable.id !== 'string' || typeof variable.name !== 'string') throw new Error('Figma returned an invalid variable.');
    const name = nameOf(variable);
    if (!name || ['__proto__','constructor','prototype'].includes(name) || names.has(name)) throw new Error(`Ambiguous Figma token name: ${name || '(empty)'}. Rename it before importing.`);
    names.set(name,variable.id);
  }
  if (ids && (ids.length > 5000 || ids.some(id => !byId.has(id)))) throw new Error('Select existing Figma variables.');
  const resolveValue = (variable:any, modeName:string, seen:Set<string>):unknown => {
    if (seen.size>=64) throw new Error('Alias chain exceeds the supported import depth.');
    const stamp = `${variable.id}:${modeName}`;
    if (seen.has(stamp)) throw new Error(`Cyclic alias in ${variable.name}.`);
    const entry = variable.valuesByMode?.[modeName];
    if (!entry) throw new Error(`Missing mode ${modeName} in ${variable.name}.`);
    if (entry.type !== 'VARIABLE_ALIAS') return entry.value;
    const target = byId.get(entry.id); if (!target) throw new Error(`Alias target missing for ${variable.name}.`);
    const collection = collections.get(target.collectionId);
    const modeId = pickTargetMode(collection,{modeId:entry.modeId,modeName,hint:modeName});
    const mode = collection?.modes?.find((item:any) => item.modeId === modeId)?.name;
    if (!mode) throw new Error(`Alias mode could not be resolved for ${variable.name}.`);
    return resolveValue(target,mode,new Set([...seen,stamp]));
  };
  const tokens:Record<string,unknown> = Object.create(null);
  for (const variable of snapshot.variables) {
    if (ids && !ids.includes(variable.id)) continue;
    const name = nameOf(variable);
    if (existing.has(name)) {issues.push(`${name}: already exists in code; kept unchanged.`);continue;}
    if (!['COLOR','FLOAT','STRING','BOOLEAN'].includes(variable.resolvedType)) {issues.push(`${name}: unsupported variable type.`);continue;}
    const collection = collections.get(variable.collectionId);
    if (!collection?.modes?.length || collection.modes.length > 100) throw new Error(`Invalid collection modes for ${name}.`);
    const modes:Record<string,unknown> = Object.create(null); const aliases:Record<string,string> = Object.create(null);
    for (const mode of collection.modes) {
      let value = resolveValue(variable,mode.name,new Set());
      if (variable.resolvedType === 'COLOR') {value = cssColorToHex(String(value)); if (!value) throw new Error(`Invalid color for ${name}.`);}
      if (variable.resolvedType === 'FLOAT' && (typeof value !== 'number' || !Number.isFinite(value))) throw new Error(`Invalid number for ${name}.`);
      if (variable.resolvedType === 'STRING' && typeof value !== 'string' || variable.resolvedType === 'BOOLEAN' && typeof value !== 'boolean') throw new Error(`Invalid value for ${name}.`);
      if (Object.hasOwn(modes,mode.name)) throw new Error(`Duplicate mode in ${name}.`);
      modes[mode.name]=value;
      const entry = variable.valuesByMode[mode.name];
      if (entry.type === 'VARIABLE_ALIAS') aliases[mode.name]=`{${nameOf(byId.get(entry.id))}}`;
    }
    const defaultName = collection.modes.find((mode:any) => mode.modeId === collection.defaultModeId)?.name;
    if (!defaultName) throw new Error(`Missing default mode for ${name}.`);
    tokens[name]={value:modes[defaultName],type:variable.resolvedType,collection:collection.name,defaultMode:defaultName,modes,aliases,figmaId:variable.id};
  }
  const document={$elfFigmaImport:1,fileKey,tokens,source:snapshot};
  const content=JSON.stringify(document,null,2)+'\n';
  if (Buffer.byteLength(content)>2*1024*1024) throw new Error('Imported tokens exceed the 2 MB review limit.');
  return {content,names:Object.keys(tokens),issues};
}

export function parseImportedTokens(data:any):Token[] {
  if (data.$elfFigmaImport !== 1 || !data.tokens || typeof data.tokens !== 'object' || Array.isArray(data.tokens)) throw new Error('Invalid Elf Figma token import.');
  const result:Token[]=[];
  for (const [name,item] of Object.entries(data.tokens) as [string,any][]) {
    if (!item || typeof item !== 'object') throw new Error('Invalid imported token.');
    const named = categoryFromName(name);
    const category = item.type === 'COLOR' ? 'color' : item.type === 'STRING' ? 'typography' : named !== 'other' && named !== 'shadow' ? named : null;
    if (!category || item.type === 'BOOLEAN') continue;
    const entries = Object.entries(item.modes ?? {});
    if (!entries.length) throw new Error(`Missing modes for ${name}.`);
    for (const [mode,value] of entries) {
      const normalized = item.type === 'COLOR' ? cssColorToHex(String(value)) : item.type === 'FLOAT' ? typeof value === 'number' && Number.isFinite(value) ? `${value}px` : null : typeof value === 'string' ? value : null;
      if (normalized === null) throw new Error(`Invalid imported value for ${name}.`);
      if (mode === item.defaultMode) result.push({name,category,value:normalized,source:'code'});
      result.push({name,category,value:normalized,source:'code',mode});
    }
  }
  return result;
}
