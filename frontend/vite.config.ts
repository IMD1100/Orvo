import { fileURLToPath, URL } from "node:url";
import tailwind from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  plugins: [tailwind()],
  esbuild: { jsx: "automatic" },
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  server: { host: "127.0.0.1", port: 28420, strictPort: true },
  build: { target: "chrome122", modulePreload: { polyfill: false } },
});
