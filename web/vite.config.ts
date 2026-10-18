import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'

// https://vite.dev/config/
export default defineConfig({
  plugins: [svelte()],
  // these ship their own web workers / wasm; let Vite serve them as-is
  optimizeDeps: { exclude: ['@duckdb/duckdb-wasm', 'maplibre-gl'] },
})
