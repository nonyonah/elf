import type { Env } from '../env.js';
import { hash, now, secret } from './common.js';
import { validateOperation, type Operation } from './operations.js';

export interface Connection {
  id: string; owner: string; fileKey: string; fileName: string | null;
  generation: string | null; approvedGeneration: string | null; heartbeat: number | null; snapshot: string | null;
}
export async function connection(env: Env, owner: string, id: string, ready = false) {
  const c = await env.DB.prepare('SELECT id,owner,fileKey,fileName,generation,approvedGeneration,heartbeat,snapshot FROM hosted_connections WHERE id=? AND owner=?')
    .bind(id, owner).first<Connection>();
  if (!c) throw new Error('Connection not found');
  if (ready && (!c.generation || c.generation !== c.approvedGeneration || !c.heartbeat || c.heartbeat < now() - 15000)) throw new Error('Open Elf Bridge and approve this document connection in Elf');
  return c;
}
export async function pairCode(env: Env, owner: string, fileKey: string) {
  if (!/^[A-Za-z0-9_-]{10,100}$/.test(fileKey)) throw new Error('Invalid Figma file key');
  const count = await env.DB.prepare('SELECT count(*) AS n FROM hosted_connections WHERE owner=?').bind(owner).first<{n:number}>();
  if ((count?.n ?? 0) >= 20) throw new Error('Disconnect an old file before pairing another');
  const id = crypto.randomUUID(), code = secret(6), expires = now() + 300000;
  await env.DB.prepare('INSERT INTO hosted_connections(id,owner,fileKey,codeHash,codeExpires,createdAt) VALUES(?,?,?,?,?,?)')
    .bind(id, owner, fileKey, await hash(code), expires, now()).run();
  return { connectionId: id, code, expiresAt: expires, fileKey, hostedOrigin: env.CONSOLE_ORIGIN, manageUrl:`${env.CONSOLE_ORIGIN}/?elf_connection=${id}`,
    instructions: 'Open this file in Figma, choose Hosted Elf in Elf Bridge, paste this code, then approve the exact document in the Elf connection page.' };
}
export async function authenticatePlugin(env: Env, authorization: string | null) {
  const token = authorization?.match(/^Bearer (elfh_[a-f0-9]{64})$/)?.[1];
  if (!token) throw new Error('Plugin authentication required');
  const row = await env.DB.prepare('SELECT id,owner,fileKey,fileName,generation,approvedGeneration,heartbeat,snapshot FROM hosted_connections WHERE sessionHash=? AND sessionExpires>?')
    .bind(await hash(token), now()).first<Connection>();
  if (!row) throw new Error('Plugin session expired or revoked');
  return row;
}
export async function connectPlugin(env: Env, input: {code?: string; fileKey: string; fileName: string}, authorization: string | null) {
  const generation = crypto.randomUUID(), time = now();
  let row: Connection | null;
  let session: string | undefined;
  if (input.code) {
    const code = input.code.replace(/-/g, '').toLowerCase();
    if (!/^[a-f0-9]{12}$/.test(code)) throw new Error('Pairing code is invalid or expired');
    session = 'elfh_' + secret();
    // Atomic consumption: simultaneous submissions cannot both receive credentials.
    row = await env.DB.prepare(`UPDATE hosted_connections SET sessionHash=?,sessionExpires=?,codeHash=NULL,codeExpires=NULL,
      generation=?,approvedGeneration=NULL,fileName=?,heartbeat=? WHERE codeHash=? AND codeExpires>? AND fileKey=? AND sessionHash IS NULL RETURNING *`)
      .bind(await hash(session), time + 30 * 86400000, generation, input.fileName.slice(0, 200), time, await hash(code), time, input.fileKey).first<Connection>();
    if (!row) throw new Error('Pairing code is invalid, expired or for another file');
  } else {
    row = await authenticatePlugin(env, authorization);
    if (row.fileKey !== input.fileKey) throw new Error('Paired file does not match');
    await env.DB.prepare('UPDATE hosted_connections SET generation=?,approvedGeneration=NULL,fileName=?,heartbeat=? WHERE id=?')
      .bind(generation, input.fileName.slice(0, 200), time, row.id).run();
  }
  // A running command may have executed already. Never queue it again on reconnect.
  await env.DB.batch([
    env.DB.prepare("UPDATE hosted_operations SET state=CASE WHEN state='running' THEN 'unknown' ELSE 'cancelled' END WHERE connectionId=? AND state IN ('running','queued')").bind(row.id),
    env.DB.prepare("UPDATE hosted_plans SET state='stale' WHERE connectionId=? AND state IN ('review','approved','applying')").bind(row.id),
  ]);
  return { connectionId: row.id, generation, session, approvalUrl: `${env.CONSOLE_ORIGIN}/?elf_connection=${row.id}`, authorization: 'plugin' };
}
export async function disconnect(env: Env, owner: string, id: string) {
  await connection(env, owner, id);
  await env.DB.batch([
    env.DB.prepare("UPDATE hosted_operations SET state=CASE WHEN state='running' THEN 'unknown' ELSE 'cancelled' END WHERE connectionId=? AND owner=? AND state IN ('running','queued')").bind(id, owner),
    env.DB.prepare("UPDATE hosted_plans SET state='stale' WHERE connectionId=? AND owner=? AND state IN ('review','approved','applying')").bind(id, owner),
    env.DB.prepare('DELETE FROM hosted_connections WHERE id=? AND owner=?').bind(id, owner),
  ]);
}
export async function queueRead(env: Env, owner: string, id: string, input: unknown) {
  const c = await connection(env, owner, id, true), op = validateOperation(input, false);
  await queueCapacity(env, c.id);
  const jobId = crypto.randomUUID(), time = now();
  await env.DB.prepare('INSERT INTO hosted_operations(id,owner,connectionId,generation,method,params,createdAt,expires) VALUES(?,?,?,?,?,?,?,?)')
    .bind(jobId, owner, id, c.generation, op.method, JSON.stringify(op.params), time, time + 120000).run();
  return { jobId, state: 'queued', next: 'Call get_operation_result with this jobId. Queued is not success.' };
}
async function queueCapacity(env: Env, id: string) {
  const count = await env.DB.prepare("SELECT count(*) AS n FROM hosted_operations WHERE connectionId=? AND state IN ('running','queued') AND expires>?").bind(id, now()).first<{n:number}>();
  if ((count?.n ?? 0) >= 50) throw new Error('Wait for pending operations to finish');
}
export async function preparePlan(env: Env, owner: string, id: string, inputs: unknown[], sourceHash?: string) {
  const c = await connection(env, owner, id, true);
  if (!c.snapshot) throw new Error('Wait for the plugin to inspect the current page before preparing changes');
  if (!inputs.length || inputs.length > 50) throw new Error('Review 1–50 operations at a time');
  const operations = inputs.map(input => validateOperation(input, true));
  const text = JSON.stringify(operations);
  if (new TextEncoder().encode(text).length > 512000) throw new Error('Plan exceeds 512 KB');
  const pending = await env.DB.prepare("SELECT count(*) AS n FROM hosted_plans WHERE owner=? AND state IN ('review','approved') AND expires>?").bind(owner, now()).first<{n:number}>();
  if ((pending?.n ?? 0) >= 10) throw new Error('Too many pending plans');
  const planId = crypto.randomUUID(), digest = await hash(text);
  await env.DB.prepare('INSERT INTO hosted_plans(id,owner,connectionId,generation,hash,operations,expires,sourceHash,snapshot,createdAt) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .bind(planId, owner, id, c.generation, digest, text, now() + 600000, sourceHash ?? null, c.snapshot, now()).run();
  return { planId, hash: digest, operationCount: operations.length, reviewUrl: `${env.CONSOLE_ORIGIN}/?elf_plan=${planId}`, next: 'The user must review and approve this exact plan in Elf. Then call apply_figma_changes. No writes have run.' };
}
export async function applyPlan(env: Env, owner: string, planId: string) {
  const plan = await env.DB.prepare("SELECT * FROM hosted_plans WHERE id=? AND owner=? AND expires>?").bind(planId, owner, now())
    .first<{connectionId:string;generation:string;operations:string;state:string;hash:string;snapshot:string;sourceHash:string|null}>();
  if (!plan) throw new Error('Plan expired or not found');
  // Retries return the existing job IDs; they never enqueue duplicates.
  if (plan.state === 'applying' || plan.state === 'complete' || plan.state === 'failed') return planJobs(env, owner, planId);
  if (plan.state !== 'approved') throw new Error('Approve this exact plan in the Elf review page first');
  if (plan.sourceHash && !await env.DB.prepare('SELECT id FROM hosted_sources WHERE owner=? AND hash=? AND expires>?').bind(owner,plan.sourceHash,now()).first()) throw new Error('Markdown source review expired. Prepare it again');
  const c = await connection(env, owner, plan.connectionId, true);
  if (c.generation !== plan.generation || c.snapshot !== plan.snapshot || await hash(plan.operations) !== plan.hash) throw new Error('Plan is stale');
  await queueCapacity(env, c.id);
  const operations: Operation[] = JSON.parse(plan.operations), time = now();
  // Conditional inserts plus state transition in one D1 transaction prevent duplicate apply.
  await env.DB.batch([
    ...operations.map((op, index) => env.DB.prepare(`INSERT INTO hosted_operations(id,owner,connectionId,generation,planId,ordinal,method,params,createdAt,expires)
      SELECT ?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM hosted_plans WHERE id=? AND owner=? AND state='approved' AND generation=?)`)
      .bind(crypto.randomUUID(), owner, c.id, c.generation, planId, index, op.method, JSON.stringify(op.params), time, time + 600000, planId, owner, c.generation)),
    env.DB.prepare("UPDATE hosted_plans SET state='applying' WHERE id=? AND owner=? AND state='approved'").bind(planId, owner),
  ]);
  return planJobs(env, owner, planId);
}
async function planJobs(env: Env, owner: string, planId: string) {
  const jobs = await env.DB.prepare('SELECT id,state,ordinal,method FROM hosted_operations WHERE planId=? AND owner=? ORDER BY ordinal').bind(planId, owner).all();
  return { planId, jobs: jobs.results, next: 'Poll get_operation_result; inspect partial failures and read back resources before reporting success.' };
}
export async function poll(env: Env, c: Connection, generation: string, snapshot?: string, busy = false) {
  if (c.generation !== generation) throw new Error('Connection replaced. Reconnect the plugin');
  await env.DB.prepare('UPDATE hosted_connections SET heartbeat=?,snapshot=COALESCE(?,snapshot) WHERE id=? AND generation=?').bind(now(), snapshot ?? null, c.id, generation).run();
  await env.DB.prepare("UPDATE hosted_operations SET state=CASE WHEN state='running' THEN 'unknown' ELSE 'expired' END WHERE connectionId=? AND state IN ('running','queued') AND expires<=?").bind(c.id, now()).run();
  // Block dependent writes after any failed or uncertain operation, including timeouts.
  await env.DB.prepare(`UPDATE hosted_operations SET state='cancelled' WHERE connectionId=? AND state='queued' AND planId IN
    (SELECT planId FROM hosted_operations WHERE connectionId=? AND state IN ('failed','unknown','expired'))`).bind(c.id, c.id).run();
  const approved = c.generation === c.approvedGeneration;
  const activity=await env.DB.prepare('SELECT mcpSeenAt FROM hosted_connections WHERE id=?').bind(c.id).first<{mcpSeenAt:number|null}>();
  const assistantActive=!!activity?.mcpSeenAt&&activity.mcpSeenAt>now()-60000;
  if (!approved || busy) return { approved, command: null, assistantActive };
  const command = await env.DB.prepare(`UPDATE hosted_operations SET state='running',startedAt=? WHERE id=(
    SELECT id FROM hosted_operations WHERE connectionId=? AND generation=? AND state='queued' AND expires>?
    ORDER BY createdAt,ordinal,id LIMIT 1) AND NOT EXISTS(SELECT 1 FROM hosted_operations WHERE connectionId=? AND state='running') RETURNING id,method,params`)
    .bind(now(), c.id, generation, now(), c.id).first<{id:string;method:string;params:string}>();
  const expected=command?await env.DB.prepare('SELECT snapshot FROM hosted_plans WHERE id=(SELECT planId FROM hosted_operations WHERE id=?)').bind(command.id).first<{snapshot:string}>():null;
  return { approved: true, assistantActive, command: command ? { ...command, type: 'request', expectedSnapshot:expected?.snapshot, params: JSON.parse(command.params) } : null };
}
export async function result(env: Env, c: Connection, generation: string, id: string, payload: {ok:boolean;result?:unknown;error?:unknown}, snapshot?: string) {
  if (c.generation !== generation || c.approvedGeneration !== generation) throw new Error('Connection approval expired');
  const text = JSON.stringify(payload);
  if (new TextEncoder().encode(text).length > 1000000) throw new Error('Plugin result too large');
  // upsert_variables can return partial failures inside an otherwise successful envelope.
  const partialFailure = typeof payload.result === 'object' && payload.result !== null && 'errors' in payload.result && Array.isArray(payload.result.errors) && payload.result.errors.length > 0;
  const row = await env.DB.prepare("UPDATE hosted_operations SET state=?,result=? WHERE id=? AND connectionId=? AND generation=? AND state='running' AND expires>? RETURNING planId")
    .bind(payload.ok && !partialFailure ? 'complete' : 'failed', text, id, c.id, generation, now()).first<{planId:string|null}>();
  if (!row) throw new Error('Operation is no longer awaiting this result; inspect before retrying');
  if (row.planId && snapshot && payload.ok && !partialFailure) {
    await env.DB.batch([
      env.DB.prepare('UPDATE hosted_plans SET snapshot=? WHERE id=? AND owner=?').bind(snapshot,row.planId,c.owner),
      env.DB.prepare('UPDATE hosted_connections SET snapshot=? WHERE id=? AND generation=?').bind(snapshot,c.id,generation),
    ]);
  }
  if (row.planId) await env.DB.prepare(`UPDATE hosted_plans SET state=CASE WHEN EXISTS(SELECT 1 FROM hosted_operations WHERE planId=? AND state='failed') THEN 'failed' ELSE 'complete' END
    WHERE id=? AND (EXISTS(SELECT 1 FROM hosted_operations WHERE planId=? AND state='failed') OR NOT EXISTS(SELECT 1 FROM hosted_operations WHERE planId=? AND state!='complete'))`)
    .bind(row.planId, row.planId, row.planId, row.planId).run();
}
