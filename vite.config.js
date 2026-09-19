import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// During `npm run dev`, Vite serves the UI on 5173 and proxies /api to the
// Express server on 3001. In production the Express server serves the built
// files from dist/ and there is no proxy.
export default defineConfig({
    plugins: [react()],
    server: {
        port: 5173,
        proxy: {
            '/api': 'http://localhost:3001',
        },
    },
    build: {
        outDir: 'dist',
    },
})