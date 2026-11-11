import { describe,it,expect,afterEach } from 'vitest';
import request from 'supertest';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../apps/server/src/app';
const roots:string[]=[];const stores:any[]=[];
function setup(){ const root=mkdtempSync(join(tmpdir(),'yzgt-api-'));roots.push(root);const result=createApp({database_file:join(root,'app.sqlite'),storage_dir:join(root,'storage'),clock:()=>new Date('2026-11-11T02:00:00Z')});stores.push(result.store);return result; }
afterEach(()=>{for(const store of stores.splice(0))if(store.db.open)store.close();for(const p of roots.splice(0))rmSync(p,{recursive:true,force:true});});
const fixed={schema_version:1,kind:'fixed',date:'2026-11-18',confirmation_status:'confirmed',original_expression:'测试固定日期',convention:{end_day_adjustment:'none',month_end:'clamp',calendar_id:null,calendar_version:null}};
describe('人工闭环事务 API',()=>{
it('空库、创建幂等、冲突与局部排序保留所有事项',async()=>{const {app,store}=setup();
expect((await request(app).get('/api/v1/projects')).body.data.total).toBe(0);
const body={name:'合成项目',company:'合成公司',owner_label:'负责人'};
const p=(await request(app).post('/api/v1/projects').set('Idempotency-Key','p1').send(body)).body.data;
expect((await request(app).get('/api/v1/audit?action=nonexistent_action')).body.data.total).toBe(0);
expect((await request(app).post('/api/v1/projects').set('Idempotency-Key','p1').send(body)).body.data.id).toBe(p.id);
expect((await request(app).post('/api/v1/projects').set('Idempotency-Key','p1').send({...body,name:'不同'})).status).toBe(409);
const tasks=[];for(let n=0;n<3;n++){const r=await request(app).post(`/api/v1/projects/${p.id}/obligations`).send({title:`事项${n}`,source_type:'manual',source_description:'人工录入',rule:fixed});expect(r.status).toBe(201);tasks.push(r.body.data.tasks[0]);}
expect((await request(app).patch(`/api/v1/tasks/${tasks[0].id}`).send({version:1,owner_label:'甲'})).status).toBe(200);
expect((await request(app).patch(`/api/v1/tasks/${tasks[0].id}`).send({version:1,owner_label:'乙'})).status).toBe(409);
expect((await request(app).patch(`/api/v1/projects/${p.id}/task-order`).send({version:1,visible_order:[tasks[2].id,tasks[0].id]})).status).toBe(200);
const all=(await request(app).get(`/api/v1/tasks?project_id=${p.id}`)).body.data.items;expect(all.map((x:any)=>x.id)).toEqual([tasks[2].id,tasks[1].id,tasks[0].id]);
store.close();});
it('人工改期预览不生效、提交保护覆盖、过期依赖拒绝',async()=>{const {app,store}=setup();const p=(await request(app).post('/api/v1/projects').send({name:'改期测试',company:'合成'})).body.data;
const o=(await request(app).post(`/api/v1/projects/${p.id}/obligations`).send({title:'人工改期',source_type:'manual',source_description:'测试',rule:fixed})).body.data;const t=o.tasks[0];
const plan=(await request(app).post('/api/v1/change-plans/preview').send({operation:'manual_due',entity_id:t.id,version:t.version,changes:{manual_due_on:'2026-12-01'},reason:'协商改期'})).body.data;
expect(store.get('tasks',t.id).effective_due_on).toBe('2026-11-18');
expect((await request(app).post(`/api/v1/change-plans/${plan.id}/commit`).send({})).status).toBe(200);expect(store.get('tasks',t.id).effective_due_on).toBe('2026-12-01');
expect(store.all('audit_logs').length).toBeGreaterThan(0);store.close();});
});
