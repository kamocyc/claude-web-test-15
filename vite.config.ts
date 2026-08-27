import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

/**
 * Where the production build is served from — GitHub Pages puts it under the
 * repository name. Exported because `playwright.config.ts` has to agree: the
 * E2E suite drives the *built* app through `vite preview`, so it has to ask
 * for the same path the built HTML asks its assets for.
 */
export const BASE_PATH = '/claude-web-test-15/';

/**
 * Keyed off `mode`, not `command`.
 *
 * `vite preview` runs with `command: 'serve'` — the same as the dev server —
 * but it serves the *built* files, whose asset URLs are already stamped with
 * the production base. Deciding on `command` therefore served the build at `/`
 * while its own HTML asked for `/claude-web-test-15/assets/…`, so every asset
 * 404'd, the app never booted, and the whole Playwright suite failed in
 * `waitReady` with nothing to point at. `mode` tells the two apart: production
 * for both build and preview, development for the dev server.
 */
export default defineConfig(({ mode }) => ({
  base: mode === 'production' ? BASE_PATH : '/',
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@e2e': fileURLToPath(new URL('./e2e', import.meta.url)),
    },
  },
  build: { outDir: 'dist', sourcemap: true },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          environment: 'node',
          include: ['src/**/*.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'dom',
          environment: 'jsdom',
          include: ['src/**/*.test.tsx'],
          setupFiles: ['src/testing/setupDom.ts'],
        },
      },
    ],
  },
}));
