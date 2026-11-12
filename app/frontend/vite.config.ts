import { fileURLToPath } from 'node:url'
import { defineConfig, searchForWorkspaceRoot } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// The palette lives in config/palette.json at the repository root: it is shared
// with the backend (Terraform passes it to the functions), so the dev server must
// be allowed to serve that folder.
const sharedConfigDir = fileURLToPath(new URL('../../config', import.meta.url))

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
  ],
  server: {
    // CORS on the gateway only allows http://localhost:3000
    port: 3000,
    strictPort: true,
    fs: {
      allow: [searchForWorkspaceRoot(process.cwd()), sharedConfigDir],
    },
  },
  build: {
    rollupOptions: {
      output: {
        // Firebase is large and changes rarely: keep it in its own cacheable chunk
        manualChunks(id) {
          if (id.includes('node_modules/firebase') || id.includes('node_modules/@firebase')) return 'firebase'
          if (id.includes('node_modules/react') || id.includes('node_modules/scheduler')) return 'react'
        },
      },
    },
  },
})
