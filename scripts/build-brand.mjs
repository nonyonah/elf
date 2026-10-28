import {readFileSync,writeFileSync,copyFileSync,mkdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join,dirname} from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url));
const source=join(root,'assets/brand/elf-mascot.png');
const data=`data:image/png;base64,${readFileSync(source).toString('base64')}`;
for(const target of ['extension/media/elf-mascot.png','settings-next/public/brand/elf-mascot.png']){
 const path=join(root,target);mkdirSync(dirname(path),{recursive:true});copyFileSync(source,path);
}
for(const target of ['bridge-plugin/ui.html','plugin/ui.html']){
 const path=join(root,target),html=readFileSync(path,'utf8');
 const marker=/data-elf-mascot src="[^"]*"/g;
 if([...html.matchAll(marker)].length!==1)throw new Error(`Expected one mascot marker in ${target}`);
 writeFileSync(path,html.replace(marker,`data-elf-mascot src="${data}"`));
}
console.log('Elf mascot assets prepared locally.');
