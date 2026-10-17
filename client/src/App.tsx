import { useAuth } from "@clerk/react";
import { CircleAlert } from "lucide-react";
import * as React from "react";
import { AppShell } from "@/components/app-shell";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ApiProvider, useApi } from "@/lib/api-context";
import { createApi } from "@/lib/api";
import { useRoute } from "@/lib/router";
import type { OverviewResponse } from "@/lib/types";
import { useQuery } from "@/lib/use-query";
import { ConfigNotice, LandingScreen, SplashScreen } from "@/screens/landing";
import { OverviewScreen } from "@/screens/overview";
import { ProjectScreen } from "@/screens/project";

function Console(): React.ReactElement {
  const api = useApi();
  const route = useRoute();
  const query = useQuery<OverviewResponse>(() => api.get("/projects"), []);

  if (query.loading && !query.data) return <SplashScreen />;

  if (!query.data) {
    return (
      <div className="mx-auto flex min-h-screen max-w-md items-center px-6">
        <Alert variant="error">
          <CircleAlert />
          <AlertTitle>Could not reach the console API</AlertTitle>
          <AlertDescription>
            <span>{query.error ?? "Unknown error."}</span>
            <div>
              <Button onClick={query.reload} size="sm" variant="outline">
                Retry
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <AppShell
      onRefresh={query.reload}
      overview={query.data}
      refreshing={query.loading}
      route={route}
    >
      {route.name === "overview" ? (
        <OverviewScreen
          overview={query.data}
          reloadOverview={query.reload}
        />
      ) : (
        <ProjectScreen
          key={route.projectId}
          projectId={route.projectId}
          view={route.view}
        />
      )}
    </AppShell>
  );
}

export function App(): React.ReactElement {
  const { getToken, isLoaded, isSignedIn } = useAuth();
  const api = React.useMemo(() => createApi(() => getToken()), [getToken]);

  if (!isLoaded) return <SplashScreen />;

  return (
    <ApiProvider client={api}>
      {isSignedIn ? <Console /> : <LandingScreen />}
    </ApiProvider>
  );
}

export { ConfigNotice };
