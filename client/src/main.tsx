import { ClerkProvider } from "@clerk/react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App, DevApp } from "./App";
import { ToastProvider } from "./components/ui/toast";
import { ConfigNotice } from "./screens/landing";
import "./index.css";

const publishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;
const devSession = import.meta.env.VITE_DEV_SESSION === "1";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ToastProvider>
      {devSession ? (
        <DevApp />
      ) : publishableKey ? (
        <ClerkProvider publishableKey={publishableKey}>
          <App />
        </ClerkProvider>
      ) : (
        <ConfigNotice />
      )}
    </ToastProvider>
  </StrictMode>,
);
