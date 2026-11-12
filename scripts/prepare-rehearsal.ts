import {cpSync,mkdirSync,mkdtempSync,existsSync,chmodSync} from 'node:fs';
import {join,resolve} from 'node:path';
mkdirSync('var',{recursive:true});
const target=mkdtempSync(resolve('var','交付 演练 '));mkdirSync(join(target,'docs'));
// Explicit allowlist: no user database, attachments, backups, logs or real credentials.
for(const name of ['package.json','package-lock.json','tsconfig.json','vitest.config.ts','eslint.config.js','playwright.config.ts','.node-version','.env.example','AGENTS.md','开发说明.md','开发实施细则.md','apps','packages','scripts','database','tests','README.md','启动系统.cmd','启动系统.command']){
 if(existsSync(name))cpSync(name,join(target,name),{recursive:true,filter:path=>!/(^|[\\/])(node_modules|dist|test-results|playwright-report)([\\/]|$)/.test(path)});
}
for(const name of ['开发决定.md','开发进度.md','验收记录.md','P0试运行清单.md']){
 if(existsSync(join('docs',name)))cpSync(join('docs',name),join(target,'docs',name));
}
cpSync('.env.example',join(target,'.env'));chmodSync(join(target,'.env'),0o600);
console.log(target);
