import {createHash, randomUUID} from 'node:crypto';
import {closeSync, constants, fstatSync, openSync, readSync, realpathSync} from 'node:fs';
import {extname, relative} from 'node:path';
import {projectResource} from './onboarding.js';
import {validateSidecar} from '../batch/src/sidecar.js';

const LIMIT = 128_000;
export {designSystemDraftSchema, extractionInstructions} from './design-system-schema.js';
import {extractionInstructions, validateDesignSystemDraftData, type DesignSystemSource} from './design-system-schema.js';
export type {DesignSystemDraft, DesignSystemSource} from './design-system-schema.js';

/** Read a selected project-local Markdown file; no network, model calls or writes. */
export function readDesignSystemSource(root:string, input:unknown):DesignSystemSource {
  if(typeof input!=='string'||input.length>1024||extname(input).toLowerCase()!=='.md')throw new Error('Choose a project-relative .md file.');
  const file=projectResource(root,input);
  if(extname(file).toLowerCase()!=='.md')throw new Error('The selected source must be a Markdown file.');
  const fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try {
    const before=fstatSync(fd);
    if(!before.isFile()||before.nlink!==1||before.size>LIMIT)throw new Error('Choose a regular Markdown file under 128 KB, without hard links.');
    // Bound the read even if another process grows the file after stat.
    const buffer=Buffer.alloc(LIMIT+1);
    let size=0, count=0;
    do{count=readSync(fd,buffer,size,buffer.length-size,null);size+=count;}while(count&&size<buffer.length);
    const after=fstatSync(fd);
    if(size>LIMIT||before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ino!==after.ino||realpathSync(file)!==file)throw new Error('The Markdown source changed while reading. Prepare it again.');
    const markdown=new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,size));
    if(!markdown.trim()||markdown.includes('\0'))throw new Error('Choose a nonempty UTF-8 Markdown file.');
    return {path:relative(realpathSync(root),file),markdown,hash:createHash('sha256').update(buffer.subarray(0,size)).digest('hex'),lines:markdown.split(/\r?\n/).length};
  }finally{closeSync(fd);}
}

export function validateDesignSystemDraft(source:DesignSystemSource,input:unknown) {
  return validateDesignSystemDraftData(source,input,validateSidecar);
}

/** Short-lived, source-pinned extraction reviews, separate from sync/apply plans. */
export class DesignSystemReviews {
  private reviews=new Map<string,{path:string;hash:string;expires:number}>();
  constructor(private root:string,private now:()=>number=Date.now){}
  prepare(path:unknown){
    const source=readDesignSystemSource(this.root,path);
    for(const [id,item] of this.reviews)if(item.expires<=this.now())this.reviews.delete(id);
    if(this.reviews.size>=20)throw new Error('Too many extraction reviews. Wait for older reviews to expire.');
    const id=randomUUID(),expires=this.now()+30*60_000;this.reviews.set(id,{path:source.path,hash:source.hash,expires});
    const title=/^#\s+(.+)$/m.exec(source.markdown)?.[1]?.trim()||'Design system';
    return {id,source,instructions:extractionInstructions,expiresAt:new Date(expires).toISOString(),canApply:false,
      draft:{schema:1,name:title.slice(0,200),documentation:'',collections:[],components:[],questions:['Extract and review the resources described in the Markdown.'],assumptions:[],unsupported:[]}};
  }
  validate(id:string,draft:unknown){
    const review=this.reviews.get(id);if(!review||review.expires<=this.now())throw new Error('Extraction review expired. Prepare the Markdown again.');
    const source=readDesignSystemSource(this.root,review.path);if(source.hash!==review.hash)throw new Error('Markdown changed. Prepare a fresh extraction review.');
    return validateDesignSystemDraft(source,draft);
  }
}
