import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Relative file URLs, so that the built UI also works under a reverse proxy path prefix.
export default defineConfig({
  base: "./",
  plugins: [react()],
});
