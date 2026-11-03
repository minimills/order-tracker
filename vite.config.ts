import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  // The app lives at the root of its own domain: https://order.minimills.net/
  base: '/',
  plugins: [react(), tailwindcss()],
})
