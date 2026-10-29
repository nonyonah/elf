import OAuthProvider, { type OAuthResourceContext } from '@cloudflare/workers-oauth-provider';
import type { Hono } from 'hono';
import type { AppEnv } from '../auth.js';
import type { Env } from '../env.js';
import { hostedMcp } from './mcp.js';
import { noStore, origin } from './common.js';
import { takeRateLimit } from '../ratelimit.js';

export async function hostedFetch(request: Request, env: Env, ctx: ExecutionContext, app: Hono<AppEnv>) {
  const url=new URL(request.url);
  const oauthPath=url.pathname==='/mcp'||url.pathname==='/authorize'||url.pathname.startsWith('/oauth/')||url.pathname.startsWith('/.well-known/');
  if(env.HOSTED_MCP_ENABLED!=='true'||!env.OAUTH_KV){
    if(oauthPath)return new Response('Hosted MCP preview is disabled',{status:404,headers:noStore});
    return app.fetch(request,env,ctx);
  }
  const serviceOrigin=origin(env);
  if(url.origin!==serviceOrigin)return new Response('Host not allowed',{status:400,headers:noStore});
  if(url.pathname==='/oauth/register'||url.pathname==='/oauth/token'){
    const key=request.headers.get('CF-Connecting-IP')??'unknown';
    if(!(await takeRateLimit(env.DB,`hosted:oauth:${key}`,30)).allowed)return new Response('Too many requests',{status:429,headers:{...noStore,'Retry-After':'60'}});
  }
  const provider=new OAuthProvider<Env>({
    apiRoute:'/mcp',authorizeEndpoint:'/authorize',tokenEndpoint:'/oauth/token',clientRegistrationEndpoint:'/oauth/register',
    scopesSupported:['elf:read','elf:write','offline_access'],requiredScopes:['elf:read','elf:write'],
    resourceMetadata:{resource:`${serviceOrigin}/mcp`,authorization_servers:[serviceOrigin]},
    accessTokenTTL:900,refreshTokenTTL:30*86400,
    // Metadata documents are disabled until SSRF protections and client-specific acceptance are verified.
    clientIdMetadataDocumentEnabled:false,
    apiHandler:{async fetch(req,bindings,execution){
      const context=execution as OAuthResourceContext<{userId?:string}>;
      if(typeof context.props?.userId!=='string'||!context.auth?.scope.includes('elf:read'))return new Response('Unauthorized',{status:401});
      try{return await hostedMcp(req,bindings,context.props.userId,context.auth.scope);}
      catch{return Response.json({error:'Invalid hosted MCP request'},{status:400,headers:noStore});}
    }},
    defaultHandler:{fetch(req,bindings,execution){
      const target=new URL(req.url);
      if(target.pathname==='/authorize'){
        if(req.method!=='GET')return new Response('Method not allowed',{status:405});
        return new Response(null,{status:302,headers:{...noStore,Location:`${serviceOrigin}/?elf_authorize=${encodeURIComponent(target.search.slice(1))}`}});
      }
      return Promise.resolve(app.fetch(req,bindings,execution)).then(response=>{
        const headers=new Headers(response.headers);
        headers.set('Referrer-Policy','no-referrer');
        headers.set('X-Frame-Options','DENY');
        headers.set('Content-Security-Policy',"frame-ancestors 'none'; base-uri 'self'; object-src 'none'");
        return new Response(response.body,{status:response.status,headers});
      });
    }},
  });
  return provider.fetch(request,env,ctx);
}
