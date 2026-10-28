"use client";
import { useEffect, useState } from "react";
import { RESTART_ELF_MESSAGE, settingsFetch, settingsJson } from "@/lib/settings-api";

export function ServerNotice() {
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void settingsFetch("/api/runtime").then(settingsJson).then(status => {
      if (active && status.apiVersion < 13) setError(RESTART_ELF_MESSAGE);
    }).catch(cause => { if (active) setError((cause as Error).message); });
    return () => {active = false;};
  }, []);
  return error ? <p role="alert" className="mb-5 rounded-xl border-[0.5px] border-border bg-card px-3.5 py-3 text-[12px] leading-[1.55] text-warning">{error}</p> : null;
}
