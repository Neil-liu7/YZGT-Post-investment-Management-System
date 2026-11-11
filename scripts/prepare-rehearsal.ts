import {cpSync,mkdirSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
const target=resolve('var','交付 演练 '+Date.now());mkdirSync(target,{recursive:true});mkdirSync(join(target,'docs'));
for(const name of ['package.json','package-lock.json','tsconfig.json','vitest.config.ts','eslint.config.js','playwright.config.ts','.node-version','.env.example','apps','packages','scripts','database','tests','README.md','启动系统.cmd','启动系统.command']){
 if(existsSync(name))cpSync(name,join(target,name),{recursive:true,filter:path=>!/(^|[\\/])(node_modules|dist|test-results|playwright-report)([\\/]|$)/.test(path)});
}
console.log(target);
