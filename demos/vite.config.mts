import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import electron from 'vite-plugin-electron/simple';

const DEMOS = new Set([
  'basic-window',
  'exact-process-attachment',
  'input-interception',
  'multiple-windows',
  'target-follow-and-telemetry',
  'steam-auto-attach',
]);

const demosRoot = path.dirname(fileURLToPath(import.meta.url));
const demoName = process.env.ELECTRON_GAME_OVERLAY_DEMO;

if (!demoName || !DEMOS.has(demoName)) {
  throw new Error(
    `Set ELECTRON_GAME_OVERLAY_DEMO to one of: ${Array.from(DEMOS).join(', ')}`,
  );
}

const demoRoot = path.join(demosRoot, demoName);
const outputRoot = path.join(demosRoot, 'dist', demoName);

export default defineConfig({
  root: demoRoot,
  publicDir: false,
  plugins: [
    electron({
      main: {
        entry: path.join(demoRoot, 'main.ts'),
        vite: {
          resolve: {
            conditions: ['gelectron'],
          },
          build: {
            outDir: path.join(outputRoot, 'main'),
            emptyOutDir: true,
            sourcemap: true,
            target: 'node22',
            rolldownOptions: {
              external: ['electron-game-overlay', 'wql-process-monitor'],
              output: {
                entryFileNames: 'main.js',
              },
            },
          },
        },
      },
      preload: {
        input: path.join(demoRoot, 'preload.ts'),
        vite: {
          build: {
            outDir: path.join(outputRoot, 'preload'),
            emptyOutDir: true,
            sourcemap: true,
            target: 'node22',
            rolldownOptions: {
              output: {
                entryFileNames: 'preload.js',
              },
            },
          },
        },
      },
      renderer: {},
    }),
  ],
  build: {
    outDir: path.join(outputRoot, 'renderer'),
    emptyOutDir: true,
    sourcemap: true,
    target: 'chrome142',
    rolldownOptions: {
      input: path.join(demoRoot, 'index.html'),
      output: {
        entryFileNames: 'renderer.js',
        chunkFileNames: '[name].js',
        assetFileNames: 'assets/[name][extname]',
      },
    },
  },
});
