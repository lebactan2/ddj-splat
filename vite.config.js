import { defineConfig } from 'vite';

export default defineConfig({
  // Relative base so the production build works under the GitHub Pages
  // project subpath (https://<user>.github.io/ddj-splat/) and in local dev.
  base: './',
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
});
