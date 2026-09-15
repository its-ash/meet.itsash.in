import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  base: "/",
  plugins: [tailwindcss()],
  server: {
    port: 5173,
  },
  build: {
    target: "es2022",
    outDir: "dist",
  },
});
