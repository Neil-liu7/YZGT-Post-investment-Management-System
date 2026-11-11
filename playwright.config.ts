import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';
const port = process.env.E2E_PORT ?? '8887';
const channel = process.env.PLAYWRIGHT_CHANNEL ?? (existsSync('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe') ? 'msedge' : undefined);
export default defineConfig({ testDir: './tests/e2e', timeout: 45000, expect: { timeout: 10000 }, use: { baseURL: `http://127.0.0.1:${port}`, channel, trace: 'retain-on-failure', screenshot: 'only-on-failure' }, reporter: 'list', workers: 1, webServer: { command: 'npx vite build --config apps/web/vite.config.ts && npx tsx tests/e2e/server.ts', url: `http://127.0.0.1:${port}/health`, reuseExistingServer: false, timeout: 90000 } });
