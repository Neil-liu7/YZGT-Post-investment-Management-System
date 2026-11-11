import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { sqliteTable,text,integer } from 'drizzle-orm/sqlite-core';
import { eq } from 'drizzle-orm';
import { mkdirSync,readFileSync,readdirSync } from 'node:fs';
import { dirname,resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
export const tables=['projects','documents','clauses','events','obligations','tasks','evidence','extractions','drafts','calendars','change_plans','idempotency_requests','reminders','notifications','attempts','scheduler_runs','digest_runs','settings','snapshots','legacy_mappings','imports','audit_logs'] as const;
export class AppError extends Error {constructor(public code:string,message:string,public status=422,public details:unknown=null){super(message);}}
export class Store {
 db:Database.Database; orm; schemas:Record<string,any>={};
 constructor(public file:string,public clock=()=>new Date()){
 mkdirSync(dirname(file),{recursive:true});this.db=new Database(file);this.db.pragma('foreign_keys = ON');this.db.pragma('journal_mode = WAL');this.db.pragma('busy_timeout = 5000');
 this.db.exec('CREATE TABLE IF NOT EXISTS migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
 for(const name of readdirSync(resolve('database/migrations')).filter(n=>/^\d+.*\.sql$/.test(n)).sort()){const version=Number(name.split('_')[0]);if(!this.db.prepare('SELECT 1 FROM migrations WHERE version=?').get(version))this.db.transaction(()=>{this.db.exec(readFileSync(resolve('database/migrations',name),'utf8'));this.db.prepare('INSERT INTO migrations VALUES(?,?)').run(version,this.clock().toISOString());})();}
 const check=this.db.pragma('quick_check') as any[];if(check[0].quick_check!=='ok')throw new Error('数据库完整性检查失败，请保留原文件并从备份恢复');
 for(const name of tables)this.schemas[name]=sqliteTable(name,{id:text('id').primaryKey(),version:integer('version').notNull(),data:text('data').notNull(),created_at:text('created_at').notNull(),updated_at:text('updated_at').notNull()});this.orm=drizzle(this.db);
 }
 private schema(table:string){if(!this.schemas[table])throw new Error('Unknown table');return this.schemas[table];}
 private decode(row:any){return row?{...JSON.parse(row.data),id:row.id,version:row.version,created_at:row.created_at,updated_at:row.updated_at}:null;}
 all(table:string,where:Record<string,any>={}){return (this.orm.select().from(this.schema(table)).all() as any[]).map(x=>this.decode(x)).filter(x=>Object.entries(where).every(([k,v])=>x[k]===v));}
 get(table:string,id:string):any{return this.decode(this.orm.select().from(this.schema(table)).where(eq(this.schema(table).id,id)).get());}
 require(table:string,id:string){const x=this.get(table,id);if(!x)throw new AppError('NOT_FOUND','记录不存在',404);return x;}
 create(table:string,input:Record<string,any>):any{const now=this.clock().toISOString();const row={...input,id:input.id||randomUUID(),version:1,created_at:now,updated_at:now};this.orm.insert(this.schema(table)).values({id:row.id,version:1,data:JSON.stringify(row),created_at:now,updated_at:now}).run();return row;}
 update(table:string,id:string,version:number,changes:Record<string,any>){const old=this.require(table,id);if(old.version!==version)throw new AppError('VERSION_CONFLICT','记录已被修改，请刷新后重试',409,{current_version:old.version});const next={...old,...changes,id,version:version+1,created_at:old.created_at,updated_at:this.clock().toISOString()};const r=this.db.prepare(`UPDATE ${this.schema(table)&&table} SET data=?,version=?,updated_at=? WHERE id=? AND version=?`).run(JSON.stringify(next),next.version,next.updated_at,id,version);if(!r.changes)throw new AppError('VERSION_CONFLICT','记录已被修改',409);return next;}
 audit(entity:string,id:string,action:string,before:any,after:any,reason=''){return this.create('audit_logs',{entity,entity_id:id,project_id:after?.project_id||before?.project_id||(entity==='projects'?id:null),action,before,after,reason,operator:'local_operator'});}
 transaction<T>(fn:()=>T):T{return this.db.transaction(fn)();}
 close(){this.db.close();}
}
