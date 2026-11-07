import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * The address of the development server.
 *
 * In development the client runs on its own port and forwards the API and the
 * collaboration socket to the backend, so the browser talks to one origin and
 * no CORS or cookie handling is needed.
 */
const BACKEND = 'http://localhost:3030';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    host: '127.0.0.1',
    proxy: {
      '/api': {
        target: BACKEND,
        changeOrigin: true,
      },
      // The collaboration socket is a WebSocket, so the proxy has to speak
      // the WebSocket protocol rather than plain HTTP.
      '/ws': {
        target: BACKEND,
        ws: true,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
