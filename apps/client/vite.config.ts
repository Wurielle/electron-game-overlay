import { defineConfig } from "vite";
import electron from "vite-plugin-electron/simple";
import path from "node:path";
import { buildElectronDevArguments } from "./src/main/dev-launch";

const workspaceRoot = path.resolve(__dirname, "../..");

export default defineConfig(({ mode }) => ({
  root: __dirname,
  publicDir: "public",
  plugins: [
    electron({
      main: {
        entry: "src/main/main.ts",
        async onstart({ startup }) {
          await startup(buildElectronDevArguments(workspaceRoot, mode), {
            cwd: workspaceRoot,
          });
        },
        vite: {
          resolve: {
            conditions: ["gelectron"],
          },
          build: {
            outDir: "dist/main",
            emptyOutDir: true,
            sourcemap: true,
            target: "node16",
            rolldownOptions: {
              external: ["electron-game-overlay"],
            },
          },
        },
      },
      renderer: {
        prebuildEsm: true,
      },
    }),
  ],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
    target: "chrome96",
    rolldownOptions: {
      input: {
        index: path.resolve(__dirname, "index/index.html"),
      },
      output: {
        entryFileNames: "renderer/renderer.js",
        chunkFileNames: "renderer/[name].js",
        assetFileNames: "assets/[name][extname]",
      },
    },
  },
}));
