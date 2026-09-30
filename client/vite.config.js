import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev-mode only: the React app and the Node backend run as two processes (see root README).
// These three paths are the backend's — everything else is served by Vite.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5175,
    proxy: {
      "/api": "http://localhost:8080",
      "/connect": "http://localhost:8080",
      "/callback": "http://localhost:8080",
    },
  },
});
