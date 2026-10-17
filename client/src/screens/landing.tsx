import { SignIn } from "@clerk/react";
import { Boxes, GitCompareArrows, Hourglass } from "lucide-react";
import type * as React from "react";
import { Card } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";

const BULLETS = [
  {
    icon: Boxes,
    title: "One source of truth",
    description:
      "Tokens and components from Figma and code, compared on every push.",
  },
  {
    icon: GitCompareArrows,
    title: "Drift at a glance",
    description:
      "Value mismatches, missing tokens, and stale components per project.",
  },
  {
    icon: Hourglass,
    title: "Deprecations with a clock",
    description:
      "A removal list that rides the remote config every elf push reads.",
  },
];

function BrandPanel(): React.ReactElement {
  return (
    <div className="hidden flex-col justify-between border-r bg-muted/40 p-10 lg:flex">
      <div className="flex items-center gap-2.5">
        <div className="flex size-8 items-center justify-center rounded-lg bg-primary font-heading font-semibold text-primary-foreground">
          e
        </div>
        <span className="font-heading font-semibold">elf console</span>
      </div>
      <div className="flex max-w-md flex-col gap-8">
        <h1 className="font-heading font-semibold text-2xl leading-snug tracking-tight">
          The shared truth for design tokens and components.
        </h1>
        <ul className="flex flex-col gap-5">
          {BULLETS.map((bullet) => (
            <li className="flex gap-3" key={bullet.title}>
              <bullet.icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <div>
                <div className="font-medium text-sm">{bullet.title}</div>
                <div className="mt-0.5 text-muted-foreground text-sm">
                  {bullet.description}
                </div>
              </div>
            </li>
          ))}
        </ul>
      </div>
      <p className="text-muted-foreground text-xs">
        elf · the design-system sync layer
      </p>
    </div>
  );
}

export function LandingScreen(): React.ReactElement {
  return (
    <div className="grid min-h-screen lg:grid-cols-2">
      <BrandPanel />
      <div className="flex items-center justify-center p-6">
        <div className="flex w-full max-w-sm flex-col items-center gap-8">
          <div className="flex items-center gap-2.5 lg:hidden">
            <div className="flex size-8 items-center justify-center rounded-lg bg-primary font-heading font-semibold text-primary-foreground">
              e
            </div>
            <span className="font-heading font-semibold">elf console</span>
          </div>
          <SignIn
            appearance={{
              variables: {
                borderRadius: "0.625rem",
                colorPrimary: "#262626",
                fontFamily:
                  "Inter, ui-sans-serif, system-ui, sans-serif",
              },
            }}
            routing="hash"
          />
        </div>
      </div>
    </div>
  );
}

export function ConfigNotice(): React.ReactElement {
  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <Card className="max-w-md gap-3 p-6">
        <div className="font-heading font-semibold">Connect Clerk</div>
        <p className="text-muted-foreground text-sm">
          The console signs requests with a Clerk session token. Set the
          publishable key and reload:
        </p>
        <pre className="overflow-x-auto rounded-lg bg-muted px-4 py-3 font-mono text-xs">
          VITE_CLERK_PUBLISHABLE_KEY=pk_test_…
        </pre>
        <p className="text-muted-foreground text-xs">
          Without it the dashboard API answers 401 — and this screen is all you
          get.
        </p>
      </Card>
    </div>
  );
}

export function SplashScreen(): React.ReactElement {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <Spinner className="size-6 text-muted-foreground" />
    </div>
  );
}
