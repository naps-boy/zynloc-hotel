import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          "vendor-react":  ["react", "react-dom"],
          "vendor-charts": ["recharts"],
          "vendor-socket": ["socket.io-client"],
          "vendor-qr":     ["qr-scanner"],
        },
      },
    },
  },
});
