"use client";
import { Heart } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SUPPORT_PAYMENT_LINK } from "@/lib/support";

export function SupportFooter() {
  return <footer className="border-t-[0.5px] border-border pt-3">
    <Button variant="ghost" className="mx-auto flex h-auto gap-1.5 px-0 py-0 text-[12px] font-normal text-muted-foreground hover:bg-transparent hover:text-foreground" render={<a href={SUPPORT_PAYMENT_LINK} target="_blank" rel="noopener noreferrer" />}>
      <Heart className="size-3.5" aria-hidden="true" />Help support this project
    </Button>
    <p className="mt-1.5 text-center text-[11px] leading-[1.55] text-faint">One-time support through Bachs. Payment options depend on your currency.</p>
  </footer>;
}
