import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";

type Health = { ok: boolean; service: string; version: string };

function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/health")
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error(String(response.status)))))
      .then((body: Health) => setHealth(body))
      .catch((cause: Error) => setError(cause.message));
  }, []);

  return (
    <main>
      <h1>elf console</h1>
      <p className="muted">The shared truth for design tokens and components — coming together.</p>
      <p className="status">
        {health && `API ${health.ok ? "ok" : "down"} · ${health.service} v${health.version}`}
        {error && `API unreachable (${error})`}
        {!health && !error && "…"}
      </p>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
