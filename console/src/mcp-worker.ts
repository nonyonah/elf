import { Hono } from 'hono';
import type { AppEnv } from './auth.js';
import { hostedFetch } from './hosted/oauth.js';
import { pluginAuthorizationRoutes, requireHostedBrowser } from './hosted/plugin-auth.js';
import { hostedRoutes, pluginRoutes } from './hosted/routes.js';
import { cleanupHosted } from './hosted/cleanup.js';

/** Dedicated connector: no Console, Clerk, Slack or Figma-account credentials. */
export function createMcpApp() {
  const app = new Hono<AppEnv>();
  app.get('/api/health', c => c.json({ok:true,service:'elf-mcp',version:'1.0.0-beta.1'}));
  app.route('/api/hosted-bridge', pluginRoutes());
  app.route('/api/hosted-auth', pluginAuthorizationRoutes());
  app.use('/api/hosted/*', requireHostedBrowser);
  app.route('/api/hosted', hostedRoutes());
  app.all('/api/*', c => c.json({error:{message:'Unknown endpoint'}},404));
  app.get('/', c => c.redirect('/settings',302));
  app.get('/settings', c => c.env.ASSETS.fetch(c.req.raw));
  app.all('*', c => c.json({error:{message:'Not found'}},404));
  return app;
}
const app = createMcpApp();
export default {
  fetch(request:Request, env:HostedBindings, ctx:ExecutionContext) {return hostedFetch(request,env,ctx,app);},
  async scheduled(_controller:ScheduledController, env:HostedBindings) {await cleanupHosted(env);},
} satisfies ExportedHandler<HostedBindings>;
