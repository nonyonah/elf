import assert from 'node:assert/strict';
import {test} from 'node:test';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {Bridge} from '../src/bridge.js';
import {BridgeClient} from '../src/client.js';
import {registerMcpPresence} from '../src/presence.js';
import {silentLogger} from '../src/logger.js';
import {FakePlugin,waitFor} from './helpers/plugin-connection.js';

test('only initialized MCP sessions contribute presence; closing one cannot remove another',async()=>{
 const token='mcp-presence-test-token',bridge=new Bridge({token,port:0});
 const port=await bridge.start();
 const plugin=await FakePlugin.connect({port,token});
 const messages:any[]=[];(plugin as any).socket.on('message',(data:any)=>messages.push(JSON.parse(data.toString())));
 const servers:McpServer[]=[],clients:Client[]=[];
 const ordinary=await BridgeClient.connect({port,token});
 const count=()=>messages.filter(message=>message.type==='mcp-presence').at(-1)?.count;
 async function connect(){
  const server=new McpServer({name:'presence-test',version:'1'});servers.push(server);
  registerMcpPresence(server,{port,token},silentLogger);
  const client=new Client({name:'test-assistant',version:'1'});clients.push(client);
  const [local,remote]=InMemoryTransport.createLinkedPair();
  await server.connect(remote);
  assert.notEqual(count(),servers.length);
  await client.connect(local);
  await waitFor(()=>count()===servers.length);
 }
 try{
  assert.equal(count(),undefined);
  await connect();await connect();
  await ordinary.close();assert.equal(count(),2);
  await clients[0].close();await waitFor(()=>count()===1);
  await clients[1].close();await waitFor(()=>count()===0);
 }finally{for(const client of clients)await client.close();for(const server of servers)await server.close();await ordinary.close();plugin.terminate();await bridge.stop();}
});
