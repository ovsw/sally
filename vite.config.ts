import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const web = fileURLToPath(new URL("./web", import.meta.url));

// The web app. `pnpm build` writes it to dist/web, which `sally app` serves.
// `pnpm dev:web` serves it with hot reload and sends /api to a running
// `sally app` (SALLY_API, default http://127.0.0.1:4517).
export default defineConfig({
  root: web,
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": `${web}/src` } },
  build: {
    outDir: fileURLToPath(new URL("./dist/web", import.meta.url)),
    emptyOutDir: true,
    // Served from this machine only, so one bundle is fine.
    chunkSizeWarningLimit: 2000,
  },
  server: {
    host: "127.0.0.1",
    // The app answers only requests addressed to it from its own pages, so
    // the proxy readdresses them and drops the dev server's origin.
    proxy: {
      "/api": {
        target: process.env.SALLY_API ?? "http://127.0.0.1:4517",
        changeOrigin: true,
        configure: (proxy) => proxy.on("proxyReq", (request) => request.removeHeader("origin")),
      },
    },
  },
});
