import {createHash} from 'node:crypto';
import {slugify} from './normalize.js';

/** Collection-aware names shared by imports and live bridge comparisons. */
export function variableCodeNames(variables:{id:string;name:string;collectionId:string}[],collections:{id:string;name:string}[]):Map<string,string> {
  const groups=new Map<string,typeof variables>();
  const collectionById=new Map(collections.map(item=>[item.id,item]));
  const suffix=(id:string)=>createHash('sha256').update(id).digest('hex').slice(0,12);
  for (const variable of variables) {
    if (typeof variable.id!=='string' || typeof variable.name!=='string') throw new Error('Figma returned an invalid variable.');
    const key=slugify(variable.name);const group=groups.get(key)??[];group.push(variable);groups.set(key,group);
  }
  const names=new Map<string,string>();
  for (const [raw,group] of groups) for (const variable of group) {
    const collection=collectionById.get(variable.collectionId);
    if (!collection) throw new Error(`Missing collection for ${variable.name}.`);
    names.set(variable.id,group.length>1?`${slugify(collection.name)||'collection'}-${raw}`:raw);
  }
  const collisions=new Map<string,string[]>();
  for (const [id,name] of names) {const ids=collisions.get(name)??[];ids.push(id);collisions.set(name,ids);}
  for (const [name,ids] of collisions) if (ids.length>1) for (const id of ids) names.set(id,`${name}-${suffix(id)}`);
  const final=new Set<string>();
  for (const name of names.values()) {if (!name || final.has(name) || ['constructor','prototype','__proto__'].includes(name)) throw new Error('Could not assign unique safe token names.');final.add(name);}
  return names;
}
