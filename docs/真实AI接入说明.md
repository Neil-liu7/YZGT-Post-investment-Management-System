# 真实 AI 提取接入说明

第三项开发已于 2026-11-12 在 Mac 完成：接入通用 Chat Completions 模型配置，使用用户本机保存的 Key 完成 DeepSeek 合成协议真实联调，并验证人工审核与期限落账。

## 本机当前配置

`.env` 已配置 `openai_compatible`、`https://api.deepseek.com` 和 `deepseek-flash`，密钥仅保存在本机忽略文件中。按 2026-11-12 核对的[官方模型文档](https://api-docs.deepseek.com/quick_start/pricing/)，该模型名当前对应 DeepSeek-V4.1-Flash-1017；另见[官方发布说明](https://api-docs.deepseek.com/news/news261017/)。模型别名后续可能由服务商更新。

主服务保持 `LLM_MODE=mock`、`ALLOW_EXTERNAL_MODEL=false`、`OUTBOUND_MODE=mock`、`SCHEDULER_ENABLED=false`。真实调用仅在合成验证脚本的隔离子进程中启用，符合本次「仅使用合成协议」范围。在浏览器打开「数据与维护」可看到 DeepSeek、模型名、配置检查通过和当前模拟模式。刷新状态只读取本机配置，不调用模型。

## 配置方式

DeepSeek 配置示例，Key 用自己的值填写：

```dotenv
LLM_PROVIDER=openai_compatible
LLM_API_KEY=填入自己的DeepSeek密钥
LLM_BASE_URL=https://api.deepseek.com
LLM_MODEL=deepseek-flash
LLM_JSON_MODE=true
LLM_TIMEOUT_MS=120000
LLM_MAX_TOKENS=8192
LLM_REASONING_EFFORT=none
LLM_MODE=mock
ALLOW_EXTERNAL_MODEL=false
OUTBOUND_MODE=mock
SCHEDULER_ENABLED=false
```

本次按官方 [JSON 输出说明](https://api-docs.deepseek.com/guides/json_mode/)和[请求参数说明](https://api-docs.deepseek.com/api/create-chat-completion/)启用 JSON 输出并关闭思考模式。`LLM_TEMPERATURE` 可留空，避免向不支持的模型强加参数。

| 服务 | 必要配置 | 适用范围 |
|---|---|---|
| 智谱 GLM | `LLM_PROVIDER=glm`，通用 `LLM_*` 三项或原 `GLM_API_KEY/GLM_MODEL/GLM_BASE_URL` | 通用非空值优先，缺项才回退旧 GLM 配置 |
| DeepSeek 或其他 Chat Completions 兼容服务 | `LLM_PROVIDER=openai_compatible`，`LLM_API_KEY/LLM_MODEL/LLM_BASE_URL` | 使用该服务自己的 Key、接口地址和模型名，不继承 GLM Key |

兼容服务需要支持 Bearer 鉴权、`messages` 请求和 `choices[].message.content` 响应。Base URL 可包含 `/v1` 等服务前缀，也可填写完整 `/chat/completions` 地址，程序只补齐一次路径；仅接受 HTTPS，不允许地址携带凭据、查询参数或片段，不跟随重定向。服务不支持 `response_format` 时，可设置 `LLM_JSON_MODE=false`，本地仍严格验证 JSON 和业务 schema。切换服务时同时检查或清空 `LLM_REASONING_EFFORT`、`LLM_MAX_TOKENS` 和 `LLM_TEMPERATURE`，这些参数是否支持由所选服务决定。

原生 Anthropic Messages、原生 Gemini、仅有 Responses 的接口未直接实现，不能只替换 Key 使用。提供 Chat Completions 兼容入口时可按兼容服务配置；实际兼容性须另行联调。本轮只对 DeepSeek 完成真实验证。

配置修改后重启服务。以后获得真实合同发送授权时，业务提取还需同时启用 `LLM_MODE=live`、`ALLOW_EXTERNAL_MODEL=true`；模型候选仍需人工审核，不会自动成为正式事项。

## 可重复验证入口

使用项目 Node 22.22.2 和已安装依赖：

```sh
npm run llm:verify
npm run build
npm run llm:verify -- --live
```

第一条不联网，只验证配置格式，写入 `docs/模型配置检查.json`，不覆盖真实联调记录。`configured` 表示配置完整，不能证明 Key 有效或已经真实调用；`ready` 还要求外发开关，主服务保留为 false 符合当前范围。

带 `--live` 的脚本只允许 DeepSeek 官方 `/chat/completions` 接口和固定 `tests/fixtures/agreement.txt`，不接受任意文件或数据库参数。样例为 328 字节，SHA-256 为 `4c6ad986e42644093ad2a2d0321d620680a520b3810c5f603bc816675e2951a1`。脚本启动临时生产服务和临时数据库，通知模拟、定时关闭，结束清理临时数据；不会读写主数据库或改写主服务的模型模式。重复执行会产生真实 API 用量，并更新最新联调报告。

## 已执行的真实结果

| 上海时间 | 报告 | 用量 | 结果 |
|---|---|---|---|
| 2026-11-12 11:16:13 | [首次联调](真实AI联调首次.json) | 输入 1402、输出 766、共 2168 tokens | live_passed |
| 2026-11-12 11:22:16 | [最终构建复验](真实AI联调.json) | 输入 1389、输出 755、共 2144 tokens | live_passed，4829 毫秒 |

两次均发送同一固定合成协议。最终请求标识为 `103bb2cd-5f33-40a4-a442-2d6d47c1e410`，提示版本为 `obligations-v2`。

最终复验从 5 段条款提取 6 条候选，同一条款的「提交申请」和「提供文件」分别成项。每条通过 schema、原文子串和定位校验，均保留人工审核状态；审核前正式义务数为 0。模型独立输出 1 条固定日期规则（2029-12-31），另外 5 条相对/周期规则保留 null 和待确认事项，未伪造事件、日历或首期日期。

验证脚本随后按确定性合成样例模拟人工补齐已知事件、工作日日历和周期首期，确认 6 条义务、7 条执行任务，并核对期限：

| 场景 | 模型规则 | 人工确认后截止日 |
|---|---|---|
| 固定日期实缴 | fixed | 2029-12-31 |
| 签署后 3 个月提交登记材料 | null | 2026-11-07 |
| 收到款项后 5 个工作日提供凭证 | null | 2026-11-13 |
| 同条款提交申请 | null | 2026-08-17 |
| 同条款提供文件 | null | 2026-11-21 |
| 季度报送财务报表 | null | 2026-10-30、2027-01-30 |

这些日期证明人工审核后的计算和落账闭环；null 规则不计作模型自主生成了正确期限。重复确认未新增义务或任务。合成样例通过不代表真实合同复杂条款准确率已经验收。

## 开发验证与边界

最终 `typecheck`、`lint`、生产构建通过，自动测试 195/195、18 个文件（12.01 秒），Chrome E2E 19/19（29.7 秒）。模型协议与旧集成定向测试 69/69，使用内存 fetcher；设置与提取来源 HTTP 回归 3/3。自动测试阻断真实网络传输，真实调用由上述显式脚本单独执行。

主服务更新前备份已封口，更新后用 Chrome 实际核对维护页，DeepSeek 配置检查通过、主服务仍为模拟模式，刷新成功且无页面异常；对交付文件、构建产物和本轮日志精确扫描未发现本机模型 Key，`.env` 被 Git 忽略。证据见[模型接入本机验证.json](模型接入本机验证.json)。

实现涵盖参数检查、JSON/schema/原文校验、瞬时失败最多 3 次尝试、超时、拒答、截断及空响应等失败区分。失败不会回退为模拟成功；提取记录保留服务商、模型、提示版本、用量、请求标识及稳定错误码，不保存原始错误响应或思考过程。设置接口只返回安全配置状态；误将密钥填为模型名会在请求和持久化前拒绝。

真实合同、长合同准确率、GLM 真实调用、其他兼容服务、SMTP、飞书和 Windows 本轮变更尚未真实复验。未公开部署，主服务只监听本机。
