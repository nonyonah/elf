import { Hono, type MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import type { AppEnv } from '../auth.js';
import { hash, jsonBody, noStore, now, origin, secret } from './common.js';
import { pairCode } from './relay.js';
import { takeRateLimit } from '../ratelimit.js';
import { z } from 'zod';

const cookie='__Host-elf-settings';
/** This capability grants only hosted Settings access, never Console/workspaces. */
export const requireHostedBrowser:MiddlewareHandler<AppEnv>=async(c,next)=>{
  const token=getCookie(c,cookie);
  if(!token||!/^[a-f0-9]{64}$/.test(token))return c.json({error:{message:'Open Settings from the browser used to connect your assistant.'}},401);
  const owner=c.req.header('X-Elf-Assistant');
  if(owner&&!/^plugin_[a-f0-9-]{36}$/.test(owner))return c.json({error:{message:'Invalid assistant connection. Open a fresh link from your assistant.'}},400);
  const digest=await hash(token);
  const session=owner
    ?await c.env.DB.prepare('SELECT owner FROM hosted_browser_sessions WHERE tokenHash=? AND owner=? AND expires>?').bind(digest,owner,now()).first<{owner:string}>()
    :await c.env.DB.prepare('SELECT owner FROM hosted_browser_sessions WHERE tokenHash=? AND expires>? ORDER BY expires DESC LIMIT 1').bind(digest,now()).first<{owner:string}>();
  if(!session)return c.json({error:{message:owner?'This browser is not connected to that assistant. Reconnect the assistant in this browser, then request a fresh link.':'Settings access expired. Reconnect your assistant.'}},401);
  c.set('session',{userId:session.owner});
  await next();
};

/** Browser-only bootstrap. A pairing code alone never issues an OAuth grant. */
export function pluginAuthorizationRoutes(){
  const app=new Hono<AppEnv>();
  app.onError((_e,c)=>c.json({error:{message:'Could not start authorization. Check the file URL or restart the connection in your assistant.'}},400));
  app.post('/start',async c=>{
    if(c.env.HOSTED_MCP_ENABLED!=='true')return c.json({error:{message:'Preview disabled'}},404);
    if(c.req.header('Origin')!==origin(c.env))return c.json({error:{message:'Origin rejected'}},403);
    const ip=await hash(c.req.header('CF-Connecting-IP')??'unknown');
    if(!(await takeRateLimit(c.env.DB,`hosted:bootstrap:${ip}`,10)).allowed)return c.json({error:{message:'Too many requests. Wait before retrying.'}},429);
    const body=z.object({query:z.string().max(16000),url:z.string().url().max(2000)}).strict().parse(await jsonBody(c.req.raw,20000));
    const url=new URL(body.url);
    if(url.protocol!=='https:'||!['figma.com','www.figma.com'].includes(url.hostname)||url.port||url.username||url.password)throw new Error('Invalid URL');
    const fileKey=/^\/(?:design|file)\/([A-Za-z0-9_-]{10,100})(?:\/|$)/.exec(url.pathname)?.[1];
    if(!fileKey)throw new Error('Invalid URL');
    const oauth=c.env.OAUTH_PROVIDER;if(!oauth)throw new Error('OAuth unavailable');
    const auth=await oauth.parseAuthRequest(new Request(`${origin(c.env)}/authorize?${body.query}`));
    if(auth.codeChallengeMethod!=='S256'||!auth.codeChallenge)throw new Error('PKCE required');
    const details=await oauth.describeConsent(auth),consent=await oauth.beginConsent(auth);
    const prior=getCookie(c,cookie);
    const known=prior&&/^[a-f0-9]{64}$/.test(prior)&&await c.env.DB.prepare('SELECT owner FROM hosted_browser_sessions WHERE tokenHash=? AND expires>? LIMIT 1').bind(await hash(prior),now()).first();
    const owner='plugin_'+crypto.randomUUID(),token=known?prior!:secret(),expires=now()+600000;
    const paired=await pairCode(c.env,owner,fileKey);
    await c.env.DB.batch([
      c.env.DB.prepare('INSERT INTO hosted_browser_sessions(tokenHash,owner,expires) VALUES(?,?,?)').bind(await hash(token),owner,now()+30*86400000),
      c.env.DB.prepare('INSERT INTO hosted_plugin_consents(owner,connectionId,clientName,redirectHost,scopes,expires) VALUES(?,?,?,?,?,?)').bind(owner,paired.connectionId,details.clientName,details.redirectHost,JSON.stringify(details.scope),expires),
      c.env.DB.prepare('INSERT INTO hosted_consents(handleHash,owner,expires) VALUES(?,?,?)').bind(await hash(consent.handle),owner,expires),
    ]);
    // Retain the OAuth provider's browser-bound anti-CSRF cookie as well as our own.
    const headers=new Headers(consent.headers);
    headers.set('Content-Type','application/json');
    for(const [key,value]of Object.entries(noStore))headers.set(key,value);
    // Keep both cookies on the returned response. Mutating c.res here makes
    // Hono replace the provider's anti-CSRF Set-Cookie during response merging.
    headers.append('Set-Cookie',`${cookie}=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${30*86400}`);
    return new Response(JSON.stringify({owner,handle:consent.handle,details,...paired,expiresAt:Math.min(expires,paired.expiresAt)}),{headers});
  });
  return app;
}
