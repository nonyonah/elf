"use client";
import { useEffect, useState } from 'react';
import { settingsFetch } from '@/lib/settings-api';
import { Card } from '@/components/ui/card';

export function McpConnections() {
  const [status,setStatus]=useState<{connected:boolean;count:number;available:boolean}|null>(null);
  useEffect(()=>{
    let active=true,timer:ReturnType<typeof setTimeout>;
    const refresh=async()=>{
      try{const response=await settingsFetch('/api/mcp-status');if(!response.ok)throw new Error();const data=await response.json();if(active)setStatus(data);}
      catch{if(active)setStatus({connected:false,count:0,available:false});}
      finally{if(active)timer=setTimeout(refresh,5000);}
    };
    void refresh();return()=>{active=false;clearTimeout(timer);};
  },[]);
  return <section aria-labelledby="mcp-heading" className="mb-5">
    <h2 id="mcp-heading" className="mb-2.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">MCP assistants</h2>
    <Card className="gap-0 rounded-2xl border-[0.5px] p-3.5 shadow-none before:hidden">
      <p className="text-[13px] font-medium" role="status">{!status?'Checking…':!status.available?'Status unavailable':status.connected?`Connected${status.count>1?` · ${status.count} assistants`:''}`:'Not connected'}</p>
      <p className="mt-1 text-xs text-muted-foreground">{status?.connected?'Your local MCP session is connected to Elf. Manage or disconnect it in your assistant.':status?.available===false?'Restart updated Elf and MCP sessions to show live activity.':'Connect Elf in your assistant to work with your paired Figma file.'}</p>
    </Card>
  </section>;
}
