import { existsSync } from 'node:fs';
if(!existsSync('dist/server.mjs')){console.error('尚未构建。请依次执行 npm ci、npm run db:migrate、npm run build');process.exit(1);}
await import('../dist/server.mjs');
