import { Hono } from 'hono';
import { z } from 'zod';
import { getSession, type AppEnv } from '../auth.js';
import { takeRateLimit } from '../ratelimit.js';
import { hash, jsonBody, noStore, now, origin } from './common.js';
import { authenticatePlugin, connectPlugin, connection, disconnect, pairCode, poll, result } from './relay.js';

/** Bearer-only plugin routes. Never use a browser cookie as plugin authority. */
export function pluginRoutes() {
  const app=new Hono<AppEnv>();
  app.onError((_error,c)=>c.json({error:'Connection or operation rejected. Check pairing, file and approval.'},400));
  app.use('*',async(c,next)=>{
    if(c.env.HOSTED_MCP_ENABLED!=='true')return c.json({error:'Hosted preview is disabled'},404);
    const ip=c.req.header('CF-Connecting-IP')??'unknown';
    if(!(await takeRateLimit(c.env.DB,`hosted:plugin:${await hash(ip)}`,180)).allowed)return c.json({error:'Too many requests'},429);
    c.header('Cache-Control','no-store');
    // Figma's sandbox has an opaque origin. Credentials are explicit bearer headers.
    c.header('Access-Control-Allow-Origin','*');
    c.header('Access-Control-Allow-Headers','Authorization, Content-Type');
    c.header('Access-Control-Allow-Methods','POST, OPTIONS');
    if(c.req.method==='OPTIONS')return c.body(null,204);
    try{await next();}catch{return c.json({error:'Connection or operation rejected. Check pairing, file and approval.'},400);}
  });
  app.post('/connect',async c=>{
    const body=z.object({code:z.string().max(20).optional(),fileKey:z.string().regex(/^[A-Za-z0-9_-]{10,100}$/),fileName:z.string().max(200)}).strict().parse(await jsonBody(c.req.raw,2048));
    if(body.code && !(await takeRateLimit(c.env.DB,`hosted:pair:${await hash(c.req.header('CF-Connecting-IP')??'unknown')}`,10)).allowed)return c.json({error:'Too many pairing attempts'},429);
    return c.json(await connectPlugin(c.env,body,c.req.header('Authorization')??null));
  });
  app.post('/poll',async c=>{
    const body=z.object({generation:z.string().uuid(),snapshot:z.string().regex(/^[a-f0-9]{64}$/).optional(),busy:z.boolean().optional()}).strict().parse(await jsonBody(c.req.raw,2048));
    const plugin=await authenticatePlugin(c.env,c.req.header('Authorization')??null);
    return c.json(await poll(c.env,plugin,body.generation,body.snapshot,body.busy));
  });
  app.post('/result',async c=>{
    const body=z.object({generation:z.string().uuid(),id:z.string().uuid(),ok:z.boolean(),result:z.unknown().optional(),error:z.unknown().optional(),snapshot:z.string().regex(/^[a-f0-9]{64}$/).optional()}).strict().parse(await jsonBody(c.req.raw,1048576));
    const plugin=await authenticatePlugin(c.env,c.req.header('Authorization')??null);
    await result(c.env,plugin,body.generation,body.id,{ok:body.ok,result:body.result,error:body.error},body.snapshot);
    return c.json({ok:true});
  });
  app.post('/approve',async c=>{
    const body=z.object({generation:z.string().uuid()}).strict().parse(await jsonBody(c.req.raw,2048));
    const plugin=await authenticatePlugin(c.env,c.req.header('Authorization')??null);
    if(!plugin.owner.startsWith('plugin_')||plugin.generation!==body.generation)throw new Error('Connection changed');
    const approved=await c.env.DB.prepare('UPDATE hosted_plugin_consents SET approvedGeneration=? WHERE owner=? AND connectionId=? RETURNING owner').bind(body.generation,plugin.owner,plugin.id).first();
    if(!approved)throw new Error('Authorization unavailable');
    await c.env.DB.prepare('UPDATE hosted_connections SET approvedGeneration=? WHERE id=? AND generation=?').bind(body.generation,plugin.id,body.generation).run();
    return c.json({ok:true});
  });
  app.post('/disconnect',async c=>{
    const plugin=await authenticatePlugin(c.env,c.req.header('Authorization')??null);
    await disconnect(c.env,plugin.owner,plugin.id);
    return c.json({ok:true});
  });
  return app;
}

/** Signed-in human review. MCP bearer tokens cannot approve their own plans. */
export function hostedRoutes() {
  const app=new Hono<AppEnv>();
  app.onError((_error,c)=>c.json({error:{message:'Review expired, changed, or unavailable. Start again in your assistant.'}},400));
  app.use('*',async(c,next)=>{
    if(c.env.HOSTED_MCP_ENABLED!=='true')return c.json({error:{message:'Hosted preview is disabled'}},404);
    const requestOrigin=c.req.header('Origin');
    if((getSession(c).userId.startsWith('plugin_')&&c.req.method!=='GET'&&requestOrigin!==origin(c.env))||(requestOrigin&&requestOrigin!==origin(c.env)))return c.json({error:{message:'Origin rejected'}},403);
    if(!(await takeRateLimit(c.env.DB,`hosted:human:${getSession(c).userId}`,90)).allowed)return c.json({error:{message:'Too many requests'}},429);
    for(const [k,v]of Object.entries(noStore))c.header(k,v);
    try{await next();}catch{return c.json({error:{message:'Review expired, changed, or unavailable. Start again in your assistant.'}},400);}
  });
  app.get('/assistants',async c=>{
    const oauth=c.env.OAUTH_PROVIDER;if(!oauth)throw new Error('OAuth unavailable');
    const owner=getSession(c).userId,cursor=c.req.query('cursor');
    if(cursor&&cursor.length>2000)throw new Error('Invalid cursor');
    const grants=await oauth.listUserGrants(owner,{limit:50,...(cursor?{cursor}:{})});
    const assistants=[];
    for(const grant of grants.items){
      const resource=`${origin(c.env)}/mcp`;
      if(grant.expiresAt&&grant.expiresAt*1000<=now())continue;
      if(grant.resource!==resource&&!(Array.isArray(grant.resource)&&grant.resource.includes(resource)))continue;
      const client=await oauth.lookupClient(grant.clientId);
      const activity=await c.env.DB.prepare('SELECT lastSeen FROM hosted_assistant_activity WHERE owner=? AND clientId=?').bind(owner,grant.clientId).first<{lastSeen:number}>();
      assistants.push({id:grant.id,name:client?.clientName?.slice(0,200)||'MCP assistant',connected:true,connectedAt:grant.createdAt*1000,lastUsedAt:activity?.lastSeen??null});
    }
    return c.json({assistants,cursor:grants.cursor??null,connectorUrl:`${origin(c.env)}/mcp`});
  });
  app.post('/assistants/:id/disconnect',async c=>{
    const oauth=c.env.OAUTH_PROVIDER;if(!oauth)throw new Error('OAuth unavailable');
    const owner=getSession(c).userId,id=c.req.param('id');
    // Find the grant under this owner before touching its client or pending work.
    let cursor:string|undefined,found:{id:string;clientId:string}|undefined;
    for(let page=0;page<5&&!found;page++){
      const grants=await oauth.listUserGrants(owner,{limit:50,...(cursor?{cursor}:{})});
      found=grants.items.find(g=>g.id===id);cursor=grants.cursor;
      if(!cursor)break;
    }
    if(!found)throw new Error('Assistant not found');
    await oauth.revokeGrant(found.id,owner);
    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE hosted_operations SET state=CASE WHEN state='running' THEN 'unknown' ELSE 'cancelled' END WHERE owner=? AND clientId=? AND state IN ('running','queued')").bind(owner,found.clientId),
      c.env.DB.prepare("UPDATE hosted_plans SET state='stale' WHERE owner=? AND clientId=? AND state IN ('review','approved','applying')").bind(owner,found.clientId),
      c.env.DB.prepare('DELETE FROM hosted_assistant_activity WHERE owner=? AND clientId=?').bind(owner,found.clientId),
    ]);
    return c.json({ok:true});
  });
  app.get('/connections/:id',async c=>{
    const row=await connection(c.env,getSession(c).userId,c.req.param('id'));
    return c.json({...row,authorization:'plugin',approvalInPlugin:getSession(c).userId.startsWith('plugin_'),connected:!!row.heartbeat&&row.heartbeat>now()-15000});
  });
  app.get('/connections',async c=>{
    const rows=await c.env.DB.prepare('SELECT id,fileKey,fileName,generation,approvedGeneration,heartbeat FROM hosted_connections WHERE owner=? ORDER BY createdAt DESC').bind(getSession(c).userId).all();
    return c.json({connections:rows.results.map(row=>({...row,connected:typeof row.heartbeat==='number'&&row.heartbeat>now()-15000,approved:!!row.generation&&row.generation===row.approvedGeneration}))});
  });
  // Browser authority and a separate plugin click are both required for every new file.
  app.post('/connections',async c=>{
    const owner=getSession(c).userId;
    if(!owner.startsWith('plugin_'))throw new Error('Use the hosted plugin authorization flow');
    const body=z.object({url:z.string().url().max(2000),expectedOwner:z.string().max(100).optional()}).strict().parse(await jsonBody(c.req.raw,4096));
    if(body.expectedOwner&&body.expectedOwner!==owner)throw new Error('Use the browser connected to this assistant');
    const url=new URL(body.url);
    if(url.protocol!=='https:'||!['figma.com','www.figma.com'].includes(url.hostname)||url.port||url.username||url.password)throw new Error('Invalid URL');
    const fileKey=/^\/(?:design|file)\/([A-Za-z0-9_-]{10,100})(?:\/|$)/.exec(url.pathname)?.[1];
    if(!fileKey)throw new Error('Invalid URL');
    const oauth=c.env.OAUTH_PROVIDER;if(!oauth)throw new Error('OAuth unavailable');
    const grants=await oauth.listUserGrants(owner,{limit:1});
    if(!grants.items.some(grant=>!grant.expiresAt||grant.expiresAt*1000>now()))throw new Error('Reconnect your assistant first');
    const consent=await c.env.DB.prepare('SELECT clientName,redirectHost,scopes FROM hosted_plugin_consents WHERE owner=? ORDER BY expires DESC LIMIT 1').bind(owner).first<{clientName:string;redirectHost:string;scopes:string}>();
    if(!consent)throw new Error('Reconnect your assistant first');
    const paired=await pairCode(c.env,owner,fileKey);
    await c.env.DB.prepare('INSERT INTO hosted_plugin_consents(owner,connectionId,clientName,redirectHost,scopes,expires) VALUES(?,?,?,?,?,?)').bind(owner,paired.connectionId,consent.clientName,consent.redirectHost,consent.scopes,now()+600000).run();
    return c.json({...paired,details:{clientName:consent.clientName,redirectHost:consent.redirectHost}});
  });
  app.post('/connections/:id/approve',async c=>{
    if(getSession(c).userId.startsWith('plugin_'))throw new Error('Approve this connection in Elf Bridge');
    const body=z.object({generation:z.string().uuid(),fileKey:z.string(),trust:z.literal('plugin')}).strict().parse(await jsonBody(c.req.raw,2048));
    const row=await connection(c.env,getSession(c).userId,c.req.param('id'));
    if(row.generation!==body.generation||row.fileKey!==body.fileKey||!row.heartbeat||row.heartbeat<now()-15000)throw new Error('Connection changed');
    await c.env.DB.prepare('UPDATE hosted_connections SET approvedGeneration=? WHERE id=? AND owner=? AND generation=?').bind(body.generation,row.id,row.owner,body.generation).run();
    return c.json({ok:true});
  });
  app.post('/connections/:id/disconnect',async c=>{await disconnect(c.env,getSession(c).userId,c.req.param('id'));return c.json({ok:true});});
  app.get('/plans/:id',async c=>{
    const plan=await c.env.DB.prepare('SELECT id,connectionId,generation,hash,operations,state,expires,sourceHash FROM hosted_plans WHERE id=? AND owner=?').bind(c.req.param('id'),getSession(c).userId).first<{connectionId:string;operations:string}>();
    if(!plan)throw new Error('Plan not found');
    const target=await connection(c.env,getSession(c).userId,plan.connectionId);
    return c.json({...plan,operations:JSON.parse(plan.operations),fileKey:target.fileKey,fileName:target.fileName});
  });
  app.post('/plans/:id/approve',async c=>{
    const body=z.object({hash:z.string().regex(/^[a-f0-9]{64}$/),generation:z.string().uuid()}).strict().parse(await jsonBody(c.req.raw,2048));
    const plan=await c.env.DB.prepare("SELECT connectionId FROM hosted_plans WHERE id=? AND owner=? AND hash=? AND generation=? AND state='review' AND expires>?")
      .bind(c.req.param('id'),getSession(c).userId,body.hash,body.generation,now()).first<{connectionId:string}>();
    if(!plan)throw new Error('Plan changed');
    const target=await connection(c.env,getSession(c).userId,plan.connectionId,true);
    if(target.generation!==body.generation)throw new Error('Connection changed');
    await c.env.DB.prepare("UPDATE hosted_plans SET state='approved' WHERE id=? AND owner=? AND hash=? AND generation=? AND state='review' AND expires>?")
      .bind(c.req.param('id'),getSession(c).userId,body.hash,body.generation,now()).run();
    return c.json({ok:true,next:'Return to your assistant to apply this approved plan.'});
  });
  app.post('/consent/start',async c=>{
    if(getSession(c).userId.startsWith('plugin_'))throw new Error('Start a fresh plugin authorization from Settings');
    const input=z.object({query:z.string().max(16000)}).strict().parse(await jsonBody(c.req.raw,20000));
    const oauth=c.env.OAUTH_PROVIDER;
    if(!oauth)throw new Error('OAuth unavailable');
    const auth=await oauth.parseAuthRequest(new Request(`${origin(c.env)}/authorize?${input.query}`));
    if(auth.codeChallengeMethod!=='S256'||!auth.codeChallenge)throw new Error('PKCE S256 required');
    const details=await oauth.describeConsent(auth),consent=await oauth.beginConsent(auth);
    await c.env.DB.prepare('INSERT INTO hosted_consents(handleHash,owner,expires) VALUES(?,?,?)').bind(await hash(consent.handle),getSession(c).userId,now()+600000).run();
    consent.headers.set('Content-Type','application/json');
    return new Response(JSON.stringify({details,handle:consent.handle}),{headers:consent.headers});
  });
  app.post('/consent/finish',async c=>{
    const body=z.object({handle:z.string().max(500),approve:z.boolean()}).strict().parse(await jsonBody(c.req.raw,2048));
    const oauth=c.env.OAUTH_PROVIDER;if(!oauth)throw new Error('OAuth unavailable');
    if(body.approve && getSession(c).userId.startsWith('plugin_')){
      const approved=await c.env.DB.prepare(`SELECT c.id FROM hosted_connections c JOIN hosted_plugin_consents p ON p.connectionId=c.id
        WHERE p.owner=? AND p.expires>? AND p.approvedGeneration=c.generation AND c.approvedGeneration=c.generation AND c.heartbeat>?`).bind(getSession(c).userId,now(),now()-15000).first();
      if(!approved)throw new Error('Approve the assistant and file in Elf Bridge first');
    }
    const consumed=await c.env.DB.prepare('DELETE FROM hosted_consents WHERE handleHash=? AND owner=? AND expires>? RETURNING owner').bind(await hash(body.handle),getSession(c).userId,now()).first();
    if(!consumed)throw new Error('Consent expired');
    if(!body.approve){const denied=await oauth.denyConsent(c.req.raw,body.handle);return new Response(JSON.stringify({redirectTo:denied.headers.get('Location')}),{headers:{...noStore,'Content-Type':'application/json'}});}
    const approval=await oauth.approveConsent(c.req.raw,body.handle);
    const grant=await oauth.completeAuthorization({request:approval.request,userId:getSession(c).userId,metadata:{},scope:approval.request.scope,props:{userId:getSession(c).userId}});
    approval.headers.set('Content-Type','application/json');
    return new Response(JSON.stringify(grant),{headers:approval.headers});
  });
  return app;
}
