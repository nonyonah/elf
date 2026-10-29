import { Hono } from 'hono';
import { z } from 'zod';
import { getSession, type AppEnv } from '../auth.js';
import { takeRateLimit } from '../ratelimit.js';
import { hash, jsonBody, noStore, now, origin } from './common.js';
import { authenticatePlugin, connectPlugin, connection, disconnect, poll, result } from './relay.js';

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
    if(requestOrigin&&requestOrigin!==origin(c.env))return c.json({error:{message:'Origin rejected'}},403);
    if(!(await takeRateLimit(c.env.DB,`hosted:human:${getSession(c).userId}`,90)).allowed)return c.json({error:{message:'Too many requests'}},429);
    for(const [k,v]of Object.entries(noStore))c.header(k,v);
    try{await next();}catch{return c.json({error:{message:'Review expired, changed, or unavailable. Start again in your assistant.'}},400);}
  });
  app.get('/connections/:id',async c=>{
    const row=await connection(c.env,getSession(c).userId,c.req.param('id'));
    return c.json({...row,authorization:'plugin',connected:!!row.heartbeat&&row.heartbeat>now()-15000});
  });
  app.post('/connections/:id/approve',async c=>{
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
