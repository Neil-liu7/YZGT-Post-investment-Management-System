# 亦庄国投投后管理系统（本机 P0）

需要 Node.js 22.22.2 或更高受维护 LTS 和 npm。Windows、Mac 各自安装依赖，不复制 node_modules。应用仅监听 127.0.0.1，数据库为空时不会自动插入演示数据。

首次安装，在项目目录执行：

```text
npm ci
npm run doctor
npm run db:migrate
npm run build
npm start
```

浏览器打开 http://127.0.0.1:8765 。日常只需 `npm start`，Ctrl+C 停止。Windows 可双击 `启动系统.cmd`；Mac 首次 `chmod +x 启动系统.command` 后双击，或终端执行 `sh 启动系统.command`。中文与带空格目录使用引号。端口冲突时不终止其他程序，在 `.env` 中设置 `PORT=8766`，访问对应端口。

开发模式 `npm run dev` 同时运行 API 和 Vite，浏览器地址 http://127.0.0.1:5173 。生产构建统一由 API 服务托管。

复制 `.env.example` 为 `.env` 可调整本地配置。没有任何凭据也可以完整操作模拟流程：新建项目→登记已知事件→上传 PDF/DOCX/TXT/MD→查看原文→提取候选→逐条核对规则并导入→跟踪事项→完成/重开→预览提醒→确认模拟发送→查看日志。模拟结果明确显示“模拟完成”，不代表真实消息送达。手工义务可独立创建，工作日日历先导入和确认，未知事件保持空值。

期限编辑均先预览后提交，人工截止日保留到明确解除；周期事项独立生成、独立完成。筛选后的上移/下移只更改排序。已完成和取消的历史记录保留。外部消息结果未知时先核查，再标记成功或确认重发。

真实渠道配置入口在 `.env`；网页“提醒中心”只显示配置状态并管理计划，不回显密码或 Webhook。

- 模型：`LLM_MODE=live`、`GLM_API_KEY`、`GLM_MODEL`、`GLM_BASE_URL` 和 `ALLOW_EXTERNAL_MODEL=true`。这是显式允许向该外部模型提交文本，启用前确认数据范围。
- 邮件：`OUTBOUND_MODE=live`，配置 `SMTP_HOST/PORT/SECURE/USER/PASS/FROM`、`MAIL_TO`。SMTP 使用 TLS 证书校验。
- 飞书：`OUTBOUND_MODE=live`，配置自定义群机器人 `FEISHU_WEBHOOK_URL`、`FEISHU_KEYWORD`，采用机器人关键字安全设置。首版只发送群提醒，签名校验机器人暂不支持。
- 自动发送还需要 `SCHEDULER_ENABLED=true`、网页对应渠道计划启用和有效目标。仅填凭据不会自动打开计划。手动模拟扫描固定使用 mock。

本次交付不会开启真实渠道、提交真实协议或公开部署。真实模型、SMTP、飞书需要用户配置后单独联调。关机/休眠期间无法按时提醒，恢复时只补当前档位；周报仅补当前周。

验证：

```text
npm run typecheck
npm run lint
npm test
npx playwright install chromium
npm run test:e2e
npm run benchmark
```

领域、API、浏览器测试使用独立临时数据库和合成文件，自动测试不发送真实消息。具体已执行结果见 `docs/验收记录.md`，Windows 实测与 Mac 未实测分开记录。

备份恢复：

```text
npm run backup
npm run restore -- --from "backups/backup-时间戳" --to "恢复数据 新目录"
```

备份包含 SQLite 一致性快照、原件与摘要清单，不含 `.env` 密钥。恢复目标必须尚不存在，先验证摘要及关联，不覆盖使用中的目录。恢复后将 `DATABASE_FILE` 指向新目录 `app.sqlite`、`STORAGE_DIR` 指向新目录 `storage`，再启动核对；不要直接覆盖运行中的库。未封口备份不能用作恢复点。

旧版迁移：在维护页上传/粘贴获准的旧 JSON，填写固定命名空间，先预览异常和数量再确认。相同命名空间与旧 ID 去重，内容改变报冲突。历史期限是待核定估算，缺失原件显示待补传，完成日期未知时保持空。不会读取或继承旧 `.env`。需要撤回时从导入批次填写原因，先预览再确认；后续人工修改或新增关联会阻挡自动撤回，已撤回的映射保留，不静默再次导入。

P0 限制：本机单人，无多用户权限、OCR、复杂指标承诺和审批回写；持续义务记录有效期间和人工检查，不自动证明合规。日历需业务人员提供并确认来源和覆盖范围。数据文件位于 var/storage，需妥善保管；共享部署需另行实现认证和访问控制。
