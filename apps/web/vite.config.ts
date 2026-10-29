import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Relative file URLs, so that the built UI also works under a reverse proxy path prefix.
// Built files go under ui/, since the server's /assets/ route serves project assets.
export default defineConfig({
  base: "./",
  build: { assetsDir: "ui" },
  plugins: [react()],
});
