import { defineConfig } from "vite";
import electron from "vite-plugin-electron/simple";
import path from "node:path";

const workspaceRoot = path.resolve(__dirname, "../..");

export default defineConfig({
  root: __dirname,
  publicDir: "public",
  plugins: [
    electron({
      main: {
        entry: "src/main/main.ts",
        onstart({ startup }) {
          startup([workspaceRoot, "--no-sandbox"], { cwd: workspaceRoot });
        },
        vite: {
          build: {
            outDir: "dist/main",
            emptyOutDir: true,
            sourcemap: true,
            target: "node16",
            rolldownOptions: {
              external: ["@libs/node-game-overlay"],
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
});
