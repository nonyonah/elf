import assert from "node:assert/strict";
import {test} from "node:test";
import {settingsJson} from "../settings-next/src/lib/settings-api.js";

test("old server plain-text errors become actionable restart instructions", async () => {
  await assert.rejects(settingsJson(new Response("Not found", {status: 404})), /Stop Elf with Ctrl\+C/);
  await assert.rejects(settingsJson(new Response(JSON.stringify({error: "Unknown project action."}), {status: 400, headers: {"Content-Type": "application/json"}})), /running Elf server/);
});
test("current server errors preserve their useful message and malformed JSON stays readable", async () => {
  await assert.rejects(settingsJson(new Response(JSON.stringify({error: "No drift report yet."}), {status: 404, headers: {"Content-Type": "application/json"}})), /No drift report yet/);
  await assert.rejects(settingsJson(new Response("Not JSON", {headers: {"Content-Type": "application/json"}})), /unreadable response/);
  assert.deepEqual(await settingsJson(new Response(JSON.stringify({ok: true}), {headers: {"Content-Type": "application/json"}})), {ok: true});
});
