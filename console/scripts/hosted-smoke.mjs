import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

// Isolated protocol acceptance: the plugin is simulated, no real Figma file is accessed.
const base = process.argv[2] || 'https://elf.riftlabs.xyz';
assert.equal(new URL(base).protocol, 'https:');
const endpoint = base + '/mcp';
const fileKey = 'ElfAcceptance' + randomBytes(8).toString('hex');
let browserCookie = '', pluginToken = '', secondPluginToken = '', connectionId = '', assistantId = '', accessToken = '';
let client;
const request = (path, body, headers = {}) => fetch(base + path, {
  method: body === undefined ? 'GET' : 'POST',
  headers: {...(body === undefined ? {} : {'Content-Type':'application/json'}), ...headers},
  ...(body === undefined ? {} : {body:JSON.stringify(body)}), redirect:'manual', signal:AbortSignal.timeout(20000),
});
const browser = () => ({Cookie:browserCookie, Origin:base});
const plugin = () => ({Authorization:'Bearer ' + pluginToken});
const value = result => {
  const text = result.content?.find(item => item.type === 'text')?.text;
  assert.equal(typeof text, 'string'); return JSON.parse(text);
};
const summary = {host:base, simulatedPlugin:true, realFigmaWrites:0, checks:[]};
try {
  const health = await request('/api/health'); assert.equal(health.status,200);
  assert.equal((await health.json()).service,'elf-mcp'); summary.checks.push('health');
  const unauthorized = await request('/mcp'); assert.equal(unauthorized.status,401);
  assert.ok(unauthorized.headers.get('WWW-Authenticate')?.includes('oauth-protected-resource'));
  summary.checks.push('unauthenticated MCP fails closed');
  const metadata = await (await request('/.well-known/oauth-authorization-server')).json();
  assert.equal(metadata.issuer,base); assert.ok(metadata.code_challenge_methods_supported.includes('S256'));
  const protectedResource = await (await request('/.well-known/oauth-protected-resource/mcp')).json();
  assert.equal(protectedResource.resource,endpoint); summary.checks.push('OAuth and protected-resource metadata');
  const registration = await request('/oauth/register',{
    client_name:'Elf connector acceptance (simulated plugin)', redirect_uris:['https://example.invalid/elf-callback'],
    grant_types:['authorization_code','refresh_token'],response_types:['code'],token_endpoint_auth_method:'none',
  }); assert.equal(registration.status,201);
  const {client_id:clientId} = await registration.json();
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const state = randomBytes(16).toString('hex');
  const query = new URLSearchParams({client_id:clientId,redirect_uri:'https://example.invalid/elf-callback',response_type:'code',scope:'elf:read elf:write offline_access',resource:endpoint,state,code_challenge:challenge,code_challenge_method:'S256'}).toString();
  const start = await request('/api/hosted-auth/start',{query,url:`https://www.figma.com/design/${fileKey}/Protocol-test`},{Origin:base});
  assert.equal(start.status,200);
  const cookies = start.headers.getSetCookie();
  assert.ok(cookies.some(cookie=>cookie.startsWith('__Host-elf-settings=')));
  assert.ok(cookies.some(cookie=>cookie.startsWith('__Host-oauth-consent-')));
  browserCookie = cookies.map(cookie=>cookie.split(';')[0]).join('; ');
  const consent = await start.json(); connectionId = consent.connectionId;
  const finish = () => request('/api/hosted/consent/finish',{handle:consent.handle,approve:true},browser());
  assert.equal((await finish()).status,400); summary.checks.push('consent refuses unapproved plugin');
  const connected = await request('/api/hosted-bridge/connect',{code:consent.code,fileKey,fileName:'Protocol test (simulated)'});
  assert.equal(connected.status,200); const pairing = await connected.json(); pluginToken = pairing.session;
  assert.equal((await request('/api/hosted-bridge/approve',{generation:pairing.generation},plugin())).status,200);
  const finishResponse = await finish(); assert.equal(finishResponse.status,200);
  const redirect = new URL((await finishResponse.json()).redirectTo); assert.equal(redirect.searchParams.get('state'),state);
  const tokenResponse = await fetch(metadata.token_endpoint,{method:'POST',body:new URLSearchParams({grant_type:'authorization_code',client_id:clientId,redirect_uri:'https://example.invalid/elf-callback',code:redirect.searchParams.get('code'),code_verifier:verifier,resource:endpoint}),signal:AbortSignal.timeout(20000)});
  assert.equal(tokenResponse.status,200); accessToken = (await tokenResponse.json()).access_token;
  assert.equal((await finish()).status,400); summary.checks.push('browser binding, PKCE and single-use consent');
  await request('/api/hosted-bridge/poll',{generation:pairing.generation,snapshot:'a'.repeat(64)},plugin());
  client = new Client({name:'elf-live-acceptance',version:'1.0.0'});
  await client.connect(new StreamableHTTPClientTransport(new URL(endpoint),{requestInit:{headers:{Authorization:'Bearer '+accessToken}}}));
  assert.equal(client.getServerVersion().icons?.[0]?.src,base+'/elf-logo.png');
  const logo=await request('/elf-logo.png');
  assert.equal(logo.status,200);
  assert.match(logo.headers.get('content-type'),/^image\/png/);
  summary.checks.push('connector mascot metadata and public PNG');
  const tools = await client.listTools(); summary.tools = tools.tools.map(tool=>tool.name);
  assert.ok(summary.tools.includes('prepare_design_system')); assert.ok(summary.tools.includes('prepare_figma_changes'));
  summary.checks.push('real SDK initialize and tool discovery');
  const status = value(await client.callTool({name:'figma_onboarding_status',arguments:{}}));
  assert.equal(status.connections.length,1); assert.equal(status.connections[0].fileKey,fileKey);
  const read = value(await client.callTool({name:'list_collections',arguments:{connectionId}}));
  assert.equal(read.state,'queued');
  const pollResponse = await request('/api/hosted-bridge/poll',{generation:pairing.generation},plugin());
  const job = await pollResponse.json(); assert.equal(job.command.id,read.jobId); assert.equal(job.command.method,'list_collections');
  assert.equal((await request('/api/hosted-bridge/result',{generation:pairing.generation,id:read.jobId,ok:true,result:{collections:[]}},plugin())).status,200);
  const result = value(await client.callTool({name:'get_operation_result',arguments:{jobId:read.jobId}}));
  assert.equal(result.state,'complete'); assert.deepEqual(result.result.result.collections,[]);
  summary.checks.push('authenticated read relay round trip with simulated plugin');
  const plan = value(await client.callTool({name:'prepare_figma_changes',arguments:{connectionId,operations:[{method:'create_collection',params:{name:'Unapplied acceptance proposal'}}]}}));
  assert.ok(plan.planId);
  const apply = await client.callTool({name:'apply_figma_changes',arguments:{planId:plan.planId}});
  assert.equal(apply.isError,true); summary.checks.push('writes remain blocked without separate plan review');
  const secondFileKey='ElfAcceptance'+randomBytes(8).toString('hex');
  const secondUrl=`https://www.figma.com/design/${secondFileKey}/Other`;
  const review=value(await client.callTool({name:'get_figma_pairing_code',arguments:{url:secondUrl}}));
  assert.equal(review.approvalRequired,true);assert.equal(review.code,undefined);
  assert.equal(new URL(review.reviewUrl).searchParams.get('elf_add_file'),secondUrl);
  assert.equal((await request('/api/hosted/connections',{url:secondUrl},{Authorization:'Bearer '+accessToken,Origin:base})).status,401);
  const secondStart=await request('/api/hosted/connections',{url:secondUrl,expectedOwner:new URL(review.reviewUrl).searchParams.get('elf_assistant')},browser());
  assert.equal(secondStart.status,200);const second=await secondStart.json();
  assert.equal((await client.callTool({name:'list_collections',arguments:{connectionId:second.connectionId}})).isError,true);
  const secondConnect=await request('/api/hosted-bridge/connect',{code:second.code,fileKey:secondFileKey,fileName:'Second simulated file'});
  assert.equal(secondConnect.status,200);const secondPair=await secondConnect.json();secondPluginToken=secondPair.session;
  assert.equal((await client.callTool({name:'list_collections',arguments:{connectionId:second.connectionId}})).isError,true);
  assert.equal((await request('/api/hosted-bridge/approve',{generation:secondPair.generation},{Authorization:'Bearer '+secondPluginToken})).status,200);
  assert.ok(value(await client.callTool({name:'list_collections',arguments:{connectionId:second.connectionId}})).jobId);
  const originalPlan=await (await request(`/api/hosted/plans/${plan.planId}`,undefined,browser())).json();
  assert.equal(originalPlan.connectionId,connectionId);assert.equal(originalPlan.state,'review');
  assert.equal((await client.callTool({name:'apply_figma_changes',arguments:{planId:plan.planId}})).isError,true);
  const multiple=value(await client.callTool({name:'figma_onboarding_status',arguments:{}}));
  assert.equal(multiple.connections.length,2);
  assert.equal((await request('/api/hosted-bridge/disconnect',{}, {Authorization:'Bearer '+secondPluginToken})).status,200);secondPluginToken='';
  const remaining=value(await client.callTool({name:'figma_onboarding_status',arguments:{}}));
  assert.equal(remaining.connections.length,1);assert.equal(remaining.connections[0].connectionId,connectionId);
  summary.checks.push('second file requires browser and plugin approval, same OAuth token works, original plan stays scoped, independent removal');
  const assistants = await (await request('/api/hosted/assistants',undefined,browser())).json();
  assert.equal(assistants.assistants.length,1); assistantId = assistants.assistants[0].id;
  assert.equal((await request(`/api/hosted/assistants/${assistantId}/disconnect`,{},browser())).status,200);assistantId='';
  const revoked = await request('/mcp',{jsonrpc:'2.0',id:1,method:'tools/list'},{Authorization:'Bearer '+accessToken,Accept:'application/json, text/event-stream'});
  assert.equal(revoked.status,401);summary.checks.push('assistant revocation');
  summary.passed=true;
} finally {
  await client?.close();
  if(secondPluginToken)await request('/api/hosted-bridge/disconnect',{}, {Authorization:'Bearer '+secondPluginToken});
  if(assistantId)await request(`/api/hosted/assistants/${assistantId}/disconnect`,{},browser());
  if(pluginToken)assert.equal((await request('/api/hosted-bridge/disconnect',{},plugin())).status,200);
}
console.log(JSON.stringify(summary,null,2));
