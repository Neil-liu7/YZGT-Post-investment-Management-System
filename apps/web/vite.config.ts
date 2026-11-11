import { defineConfig } from 'vite';
import 'dotenv/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
const backend = `http://127.0.0.1:${process.env.PORT ?? 8765}`;
export default defineConfig({ root: fileURLToPath(new URL('.', import.meta.url)), plugins: [react()], server: { host: '127.0.0.1', port: 5173, proxy: { '/api': backend, '/health': backend } }, build: { outDir: 'dist', emptyOutDir: true } });
