import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
export default defineConfig({
  root:'client', plugins:[react(),tailwindcss()],
  // Shared Settings components must use the same React instance as the renderer.
  resolve:{dedupe:['react','react-dom'],alias:{'@':fileURLToPath(new URL('./client/src',import.meta.url))}},
  build:{outDir:'../dist/mcp',emptyOutDir:true,rollupOptions:{input:fileURLToPath(new URL('./client/settings.html',import.meta.url))}},
});
