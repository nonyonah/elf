import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  root: "client",
  plugins: [react(), tailwindcss()],
  resolve: {
    dedupe: ["react", "react-dom"],
    alias: {
      "@": fileURLToPath(new URL("./client/src", import.meta.url)),
    },
  },
  server: {
    proxy: {
      "/api": "http://127.0.0.1:8787",
    },
  },
  build: {
    rollupOptions: {input:{console:fileURLToPath(new URL('./client/index.html',import.meta.url)),settings:fileURLToPath(new URL('./client/settings.html',import.meta.url))}},
    outDir: "../dist/client",
    emptyOutDir: true,
  },
});
