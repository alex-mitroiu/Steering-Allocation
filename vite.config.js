import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const API = `http://127.0.0.1:${process.env.PORT || 3101}`;

export default defineConfig({
  root: "client",
  plugins: [react()],
  resolve: { alias: { "@shared": fileURLToPath(new URL("./shared", import.meta.url)) } },
  server: { port: Number(process.env.WEB_PORT || 5183), strictPort: true, proxy: { "/api": API }, fs: { allow: [".."] } },
  build: { outDir: "../dist", emptyOutDir: true },
});
