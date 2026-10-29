import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {BridgeClient,type BridgeClientOptions} from './client.js';
import type {Logger} from './logger.js';

/** A dedicated authenticated socket tracks an initialized MCP session's lifetime. */
export function registerMcpPresence(server:McpServer,options:BridgeClientOptions,logger:Logger):void {
  let closed=false;
  let connection:BridgeClient|null=null;
  const initialized=server.server.oninitialized;
  const onclose=server.server.onclose;
  server.server.oninitialized=()=>{
    initialized?.();
    void (async()=>{
      const client=await BridgeClient.connect(options);
      connection=client;
      if(closed){await client.close();return;}
      const capabilities=await client.call<{mcpPresence?:number}>('__elf_capabilities');
      if(capabilities.mcpPresence!==1){await client.close();logger.log('Restart the updated shared bridge to show MCP status in Figma.');return;}
      if(!closed)await client.call('__elf_mcp_presence',{connected:true});
    })().catch(()=>{void connection?.close();logger.log('MCP status could not reach the bridge. Restart MCP after the bridge reconnects.');});
  };
  server.server.onclose=()=>{closed=true;void connection?.close();onclose?.();};
}
