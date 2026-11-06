import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { buildInfo } from "./scripts/build-info.js";

// P-12: the API runs on 8787 in dev; dev and preview both forward /api and /auth to it (W-2).
const api = `http://127.0.0.1:${process.env.API_PORT ?? 8787}`;
const proxy = { "/api": api, "/auth": api };

export default defineConfig({
  plugins: [react()],
  // S-17 / W-25: Settings → About links the source at the commit this build was made from.
  define: { __BUILD_INFO__: JSON.stringify(buildInfo()) },
  // W-25: production source maps are published next to the chunks. U-1g: a font is always a
  // hashed file; the 1.3 KB symbols files would otherwise inline as data: URIs, once per
  // @font-face that names them (eight copies in the CSS every theme loads).
  build: {
    target: "es2022",
    sourcemap: true,
    assetsInlineLimit: (file) => (file.endsWith(".woff2") ? false : undefined),
  },
  server: { port: 5173, proxy },
  // "localhost" can resolve to ::1 only; Playwright (and its webServer probe) use 127.0.0.1.
  preview: { host: "127.0.0.1", port: 4173, proxy },
});
