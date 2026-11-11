import {it,expect} from 'vitest';
import request from 'supertest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {createApp} from '../../apps/server/src/app';
it('ordinary obligation edits update open tasks without resetting reminder revision or closed snapshots',async()=>{const root=mkdtempSync(join(tmpdir(),'yzgt-edits-'));const {app,store,business}=createApp({database_file:join(root,'app.sqlite'),storage_dir:join(root,'storage')});try{const p=store.create('projects',{name:'合成',company:'合成'});const o=business.createObligation(p.id,{title:'合成义务',owner_label:'原负责人',source_type:'manual',source_description:'人工',rule:{schema_version:1,kind:'fixed',date:'2029-12-31',confirmation_status:'confirmed',original_expression:'固定',convention:{end_day_adjustment:'none',month_end:'clamp',calendar_id:null,calendar_version:null}}});const t=o.tasks[0];const r=await request(app).patch(`/api/v1/obligations/${o.id}`).send({version:o.version,owner_label:'新负责人',title:'修订标题'});expect(r.status).toBe(200);expect(store.require('tasks',t.id)).toMatchObject({owner_label:'新负责人',title:'修订标题',schedule_revision:1});}finally{store.close();if(resolve(root).startsWith(resolve(tmpdir())+sep))rmSync(root,{recursive:true,force:true});}});
