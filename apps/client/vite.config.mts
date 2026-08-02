import { defineConfig } from 'vite';
import electron from 'vite-plugin-electron/simple';
import { copyFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { buildElectronDevArguments } from './src/main/dev-launch.mts';

const clientRoot = import.meta.dirname;
const workspaceRoot = path.resolve(clientRoot, '../..');
const processWatcherSource = path.resolve(
  clientRoot,
  'process-watcher/index.cjs',
);
const processWatcherOutput = path.resolve(
  clientRoot,
  'dist/process-watcher/index.cjs',
);

export default defineConfig(({ mode }) => ({
  root: clientRoot,
  publicDir: 'public',
  plugins: [
    electron({
      main: {
        entry: 'src/main/main.ts',
        async onstart({ startup }) {
          await startup(buildElectronDevArguments(workspaceRoot, mode), {
            cwd: workspaceRoot,
          });
        },
        vite: {
          resolve: {
            conditions: ['gelectron'],
          },
          build: {
            outDir: 'dist/main',
            emptyOutDir: true,
            sourcemap: true,
            target: 'node22',
            rolldownOptions: {
              external: ['electron-game-overlay'],
            },
          },
        },
      },
      renderer: {
        prebuildEsm: true,
      },
    }),
    {
      name: 'copy-demo-process-watcher',
      apply: 'build',
      closeBundle() {
        mkdirSync(path.dirname(processWatcherOutput), { recursive: true });
        copyFileSync(processWatcherSource, processWatcherOutput);
      },
    },
  ],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    target: 'chrome142',
    rolldownOptions: {
      input: {
        index: path.resolve(clientRoot, 'index/index.html'),
      },
      output: {
        entryFileNames: 'renderer/renderer.js',
        chunkFileNames: 'renderer/[name].js',
        assetFileNames: 'assets/[name][extname]',
      },
    },
  },
}));
