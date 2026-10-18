import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// P-12: the API runs on 8787 in dev; dev and preview both forward /api and /auth to it (W-2).
const api = `http://127.0.0.1:${process.env.API_PORT ?? 8787}`;
const proxy = { "/api": api, "/auth": api };

export default defineConfig({
  plugins: [react()],
  build: { target: "es2022", sourcemap: true },
  server: { port: 5173, proxy },
  preview: { port: 4173, proxy },
});
