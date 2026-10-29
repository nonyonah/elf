import { readFileSync, writeFileSync, mkdirSync, copyFileSync, chmodSync, existsSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

// Development-only: never change production origins or broaden the public plugin manifest.
const root=fileURLToPath(new URL('../',import.meta.url));
const input=process.argv[2];
if(!input)throw new Error('Usage: node scripts/prepare-hosted-preview.mjs https://YOUR-HOST.ngrok-free.app');
const url=new URL(input);
if(url.protocol!=='https:'||url.username||url.password||url.port||url.search||url.hash||url.pathname!=='/'||
   !/^[a-z0-9-]+\.ngrok-free\.app$/.test(url.hostname))throw new Error('Supply the exact HTTPS ngrok-free.app origin, without a path or credentials.');
const origin=url.origin,production='https://elf-console.nonyonah.workers.dev';
const directory=join(root,'.elf','hosted-preview'),plugin=join(root,'dist','bridge-plugin-hosted-preview');
const values=parseEnv(readFileSync(join(root,'console','.dev.vars'),'utf8'));
if(!values.CLERK_SECRET_KEY?.startsWith('sk_')||!values.CLERK_PUBLISHABLE_KEY?.startsWith('pk_'))throw new Error('Set real Clerk credentials in console/.dev.vars first. Never use DEV_ONLY_FAKE_USER through a public tunnel.');
if(!existsSync(join(root,'console','dist','client','index.html')))throw new Error('Build the Console client first: npm --prefix console run build');
mkdirSync(directory,{recursive:true,mode:0o700});chmodSync(directory,0o700);
mkdirSync(plugin,{recursive:true});
const config={name:'elf-hosted-preview',main:join(root,'console','src','index.ts'),
  compatibility_date:'2026-10-17',compatibility_flags:['nodejs_compat'],
  assets:{directory:join(root,'console','dist','client'),binding:'ASSETS',not_found_handling:'single-page-application',run_worker_first:['/api/*','/mcp','/authorize','/oauth/*','/.well-known/*']},
  d1_databases:[{binding:'DB',database_name:'elf-hosted-preview',database_id:'00000000-0000-0000-0000-000000000000',migrations_dir:join(root,'console','migrations')}],
  kv_namespaces:[{binding:'OAUTH_KV',id:'00000000000000000000000000000000'}],
  vars:{HOSTED_MCP_ENABLED:'true',CONSOLE_ORIGIN:origin,CLERK_AUTHORIZED_PARTIES:origin,DEV_ONLY_FAKE_USER:''},
  dev:{ip:'127.0.0.1',port:8790,host:url.hostname,upstream_protocol:'https'},
  // Never write request logs for OAuth authorization codes or plugin responses.
  observability:{enabled:false},workers_dev:false,
};
writeFileSync(join(directory,'wrangler.json'),JSON.stringify(config,null,2)+'\n',{mode:0o600});
const secrets={CLERK_SECRET_KEY:values.CLERK_SECRET_KEY,CLERK_PUBLISHABLE_KEY:values.CLERK_PUBLISHABLE_KEY,
  SECRETS_KEY:randomBytes(32).toString('base64'),DEV_ONLY_FAKE_USER:'',CONSOLE_ORIGIN:origin,CLERK_AUTHORIZED_PARTIES:origin,HOSTED_MCP_ENABLED:'true'};
const secretPath=join(directory,'.dev.vars');
writeFileSync(secretPath,Object.entries(secrets).map(([key,value])=>`${key}=${JSON.stringify(value)}`).join('\n')+'\n',{mode:0o600});chmodSync(secretPath,0o600);
const manifest=JSON.parse(readFileSync(join(root,'bridge-plugin','manifest.public.json'),'utf8'));
manifest.name='Elf Bridge (Hosted Preview)';
manifest.networkAccess={allowedDomains:['ws://localhost:8765',origin],reasoning:'This test build connects only to your authenticated local Elf or the exact ngrok preview origin. No wildcard domains or account tokens are used.'};
writeFileSync(join(plugin,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
let code=readFileSync(join(root,'bridge-plugin','code.js'),'utf8');
if(!code.includes('const PUBLIC_FILE_LINK_REQUIRED = false;')||!code.includes(production))throw new Error('Build the current bridge plugin before preparing this preview.');
code=code.replace('const PUBLIC_FILE_LINK_REQUIRED = false;','const PUBLIC_FILE_LINK_REQUIRED = true;').replaceAll(production,origin);
writeFileSync(join(plugin,'code.js'),code);
const ui=readFileSync(join(root,'bridge-plugin','ui.html'),'utf8');
if(!ui.includes(`const HOSTED_ORIGIN = '${production}'`))throw new Error('Hosted UI origin marker missing');
writeFileSync(join(plugin,'ui.html'),ui.replaceAll(production,origin));
copyFileSync(join(root,'assets','brand','elf-mascot.png'),join(plugin,'plugin-icon.png'));
writeFileSync(join(directory,'preview.json'),JSON.stringify({origin,mcpUrl:origin+'/mcp',plugin:join(plugin,'manifest.json'),config:join(directory,'wrangler.json')},null,2)+'\n',{mode:0o600});
console.log('Prepared isolated hosted preview.');
console.log(`Connector: ${origin}/mcp`);
console.log(`Plugin: ${join(plugin,'manifest.json')}`);
console.log('Real Clerk sign-in required. Development sign-in bypass disabled. Production files unchanged.');
