import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

// Dev/preview server port. Falls back to Vite's own default (5173) when
// WEB_PORT isn't set, e.g. when running `pnpm --filter @katnor/web dev`
// outside of docker-compose/.env.
const webPort = Number(process.env.WEB_PORT) || 5173;

export default defineConfig({
  plugins: [sveltekit()],
  server: {
    port: webPort
  },
  preview: {
    port: webPort
  }
});
