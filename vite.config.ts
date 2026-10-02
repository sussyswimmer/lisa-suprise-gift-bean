/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  server: { port: 5173, strictPort: true },
  plugins: [react()],
  test: { setupFiles: ["src/test/setup.ts"] },
});
