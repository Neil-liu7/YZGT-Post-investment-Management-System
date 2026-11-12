# Mac本地运行验证

日期：2026-11-12，业务时区Asia/Shanghai。范围为用户授权的第一项：Mac初始化、构建启动、自动化与浏览器回归、完整业务链路及备份恢复。全部使用合成协议、隔离测试库和mock渠道。

## 环境和执行结果

macOS26.3.1(a) / build25D771280a，arm64；Node22.22.2、npm10.9.7；Google Chrome157.0.8103.78、Playwright1.52.0。

| 命令或操作 | 实际结果 |
|---|---|
| npm ci --no-audit --no-fund | 425包安装成功，SQLite及esbuild原生模块检查通过 |
| npm run doctor | Node/SQLite/目录/8765正常，模型mock、通知mock、定时false |
| npm run db:migrate | 首次空库迁移至4，未注入示例项目 |
| npm run lint | 通过 |
| npm run typecheck / npm run build | 通过，最终按production构建，前端及dist/server.mjs生成 |
| npm test | 15文件、121/121，9.77秒 |
| PLAYWRIGHT_CHANNEL=chrome npm run test:e2e | 11/11，51.0秒，覆盖原有全部浏览器场景 |
| node --import tsx scripts/smoke.ts | 生产启动、页面、私有路径404、端口冲突、TXT/DOCX/PDF实际解析通过 |
| node --import tsx scripts/verify-local.ts | 隔离生产业务链路、重启、一致性备份、CLI新目录恢复通过 |
| 全新中文空格目录 | 独立安装425包、doctor、迁移4、build、生产空库启动全部通过 |
| 默认Node25下npm start | 自动转用固定nvm Node22，本机8765提供页面及API |

测试命令均在Node22环境运行；本机.env来自示例，默认mock且自动计划关闭。原始日志在被忽略的var/mac-unit.log、mac-e2e.log、mac-lint.log、mac-build.log、mac-smoke.log及mac-rehearsal-*.log。Windows结果保留为2026-11-11历史基线，未用本轮Mac结果替代Windows复验。

## 本轮发现及修复

1. 示例.env的空MAIL_TO阻止无凭据模拟邮件入队，首轮118/119。改为仅在mock且未显式指定目标时使用合成邮箱；显式清空及live空目标仍拒绝。新增2条回归，HTTP/队列定向25项及最终121项全部通过。
2. 默认Node25与按Node22安装的SQLite原生依赖ABI不同。启动共享模块在加载原生依赖前优先选.node-version指定的已安装nvm运行时，并以脚本位置定位项目目录，不修改全局Node默认值。
3. 原启动器可能把已有健康服务当成本次启动。现在launch/dev先探测端口，失败返回非零码；Vite固定端口，退出清理自己创建的子进程，健康通过后才调用浏览器。
4. 环境HTTP代理导致Playwright将空闲端口误判为已使用。测试配置保留既有代理排除项并补充本机地址，继续拒绝复用已有服务。
5. 浏览器迁移回退用例的status定位可能同时命中成功和加载提示，首轮10/11。改为精确定位成功内容，最终11/11；未放宽断言或增加重试。

## 完整业务与恢复

[Mac业务验证.json](Mac业务验证.json)记录生产bundle的实际执行：创建项目、上传中文协议、解析及下载、mock提取两条候选、逐条确认期限、幂等导入、上传凭证并完成一项、自动提醒排除完成项、当前阶段去重、手动模拟发送、重启后数据一致、API备份封口及CLI恢复。

恢复到全新中文带空格目录后，逐表数据、协议和凭证摘要、原文/条款、完成状态、通知记录及自动提醒去重关系全部一致。合成库含1项目、2份原件、2义务/事项、2模拟通知和1自动提醒明细。该验证不使用主var/app.sqlite，结束后清理临时实例与数据。

[Mac新目录验证.json](Mac新目录验证.json)记录独立交付目录 `var/交付 演练 1794451092589` 从源码复制后npm ci --offline、doctor、迁移、build和18766空库生产启动的结果；原安装缓存来自此前实际联网安装，不依赖另一平台node_modules。演练实例已停止，生成的演练目录在验证后清理。

## Mac启动入口

安装依赖、迁移和构建后，可以执行 `npm start`，或从终端执行 `sh 启动系统.command`。入口为 http://127.0.0.1:8765 。使用nvm时，维护命令先执行 `nvm use 22.22.2`；启动入口会优先使用已安装的固定nvm版本。Ctrl+C停止服务。

启动专项实际验证：Node25调用start和launch自动转22；任意cwd和中文空格路径下生产页面200；Mac.command在health成功后调用浏览器替身；已有health=200服务时launch/dev退出1，不打开浏览器、不创建业务库、不终止原服务；dev后端与5173就绪，SIGTERM后两端口释放。专项使用独立临时目录和随机端口，未占用8765。

## 范围限制

Mac本机模拟范围已验证；Finder双击、启动器调用真实浏览器自动打开未单独执行（浏览器交互本身已由Chrome E2E验证）。真实GLM、SMTP、飞书、真实旧库迁移仍未联调。5000事项性能为Windows历史结果，本轮未重跑。OCR、多用户、复杂期限/日历表单改进不在本轮范围。
