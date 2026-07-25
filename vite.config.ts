import { defineConfig } from 'vite'

export default defineConfig({
  // Relative base so the built site works from any static host subpath
  // (GitHub Pages project sites, Netlify previews, file://).
  base: './',
  server: {
    host: true,
    /**
     * Trystero derives its room topic with crypto.subtle, which only exists in
     * a secure context — so a LAN address like http://192.168.1.5:5173 cannot
     * work, only https:// or localhost. Testing with someone on another
     * machine therefore means putting the dev server behind an HTTPS tunnel,
     * and Vite rejects unrecognised Host headers unless they are listed here.
     */
    allowedHosts: ['.trycloudflare.com', '.ngrok-free.app', '.ngrok.io', '.loca.lt'],
  },
  preview: {
    host: true,
    allowedHosts: ['.trycloudflare.com', '.ngrok-free.app', '.ngrok.io', '.loca.lt'],
  },
  build: { target: 'es2022' },
})
