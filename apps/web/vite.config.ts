import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";

// En desarrollo (y en preview) la app habla con el servidor a través de /api, como en producción.
const api = { "/api": { target: process.env.API_TARGET ?? "http://127.0.0.1:3000", changeOrigin: true } };

export default defineConfig({
  server: { proxy: api },
  preview: { proxy: api },
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["icon.svg", "apple-touch-icon.png"],
      manifest: {
        name: "Mis Ventas",
        short_name: "Mis Ventas",
        description: "Vender, cobrar y controlar el stock del kiosco, con o sin internet.",
        lang: "es-AR",
        start_url: ".",
        display: "standalone",
        background_color: "#f4f5f2",
        theme_color: "#0e7a4f",
        icons: [
          { src: "icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,png,woff2}"],
        // Solo alfabeto latino para usar sin conexión; el resto de la fuente no hace falta en es-AR.
        globIgnores: ["**/inter-{cyrillic,cyrillic-ext,greek,greek-ext,vietnamese}-*.woff2"],
        // La API nunca se cachea: los datos offline viven en IndexedDB.
        navigateFallbackDenylist: [/^\/api\//],
      },
    }),
  ],
});
