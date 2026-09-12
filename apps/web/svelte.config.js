import adapter from '@sveltejs/adapter-node';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
  // Consult https://svelte.dev/docs/kit/integrations for more information
  // about preprocessors.
  preprocess: vitePreprocess(),

  kit: {
    // adapter-node produces a standalone Node server (`build/index.js`) that
    // apps/web's Dockerfile runs directly - see PLAN.md section 2.2.
    adapter: adapter()
  }
};

export default config;
