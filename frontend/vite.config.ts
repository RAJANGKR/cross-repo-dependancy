import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // The backend CORS allowlist expects exactly this origin.
    port: 5173,
    strictPort: true,
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}'],
    // Threads start faster than forked processes, which matters when the
    // project sits in a synced folder and jsdom is slow to load from disk.
    pool: 'threads',
    testTimeout: 20_000,
  },
})
