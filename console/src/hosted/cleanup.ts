import type { Env } from '../env.js';
import { now } from './common.js';

export async function cleanupHosted(env:Env) {
  const time=now();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM hosted_consents WHERE expires<=?').bind(time),
    env.DB.prepare('DELETE FROM hosted_sources WHERE expires<=?').bind(time),
    env.DB.prepare('DELETE FROM hosted_operations WHERE expires<?').bind(time-86400000),
    env.DB.prepare('DELETE FROM hosted_plans WHERE expires<?').bind(time-86400000),
    env.DB.prepare('DELETE FROM hosted_connections WHERE (sessionExpires IS NOT NULL AND sessionExpires<=?) OR (sessionHash IS NULL AND codeExpires<=?)').bind(time,time),
    env.DB.prepare("DELETE FROM rate_limits WHERE scope LIKE 'hosted:%' AND windowStart<?").bind(Math.floor(time/1000)-86400),
  ]);
}
