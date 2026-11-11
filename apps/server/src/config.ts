import 'dotenv/config';
import { resolve } from 'node:path';
export const config={database_file:resolve(process.env.DATABASE_FILE||'var/app.sqlite'),storage_dir:resolve(process.env.STORAGE_DIR||'storage'),backup_dir:resolve(process.env.BACKUP_DIR||'backups'),host:'127.0.0.1',port:Number(process.env.PORT||8765),max_upload_bytes:Number(process.env.MAX_UPLOAD_BYTES||20971520),llm_mode:process.env.LLM_MODE||'mock',outbound_mode:process.env.OUTBOUND_MODE||'mock',scheduler_enabled:process.env.SCHEDULER_ENABLED==='true'};
