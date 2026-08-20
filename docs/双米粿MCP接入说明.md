# 双米粿 MCP 接入说明

## 已接入的两条连接

米粿 Studio 对外仍统一显示“米粿”供应商，服务端内部固定为两条相互隔离的连接：

| 连接 | 固定端点 | 当前用途 | 已探查工具 |
|---|---|---|---|
| `factory_classic` | `https://factory.miguocomics.com/api/mcp/v1` | 草稿勾线、线稿上色、光影塑造，以及后续拆层/参考生成能力 | 9 项 |
| `storyark_v3` | `https://storyark.miguocomics.com/api/mcp/v1` | 项目读取、分镜草稿与人物参考图驱动的成稿生成、异步任务查询 | 3 项 |

浏览器不能提交 MCP 地址、工具名、账号或 Token。端点、上传路径、工具映射和契约指纹由服务端代码固定；凭据只通过服务器环境变量注入。

## 当前工作台体验

- 原有四格流水线继续由米粿经典连接执行：草稿 → 线稿 → 上色 → 光影。
- 管理员可在草稿卡片点击“3.0 分镜成稿”，选择 StoryArk 项目、上传人物参考图、选择 1K/2K/4K 和 1～4 个候选。
- 3.0 任务进入独立持久化队列；供应商返回 `processing` 时保存任务 ID并定时查询，不会再次提交付费生成。
- 返回的签名 URL 会立即下载为本地不可变素材，页面刷新后仍可查看。
- 如果付费提交阶段断线且无法确认结果，任务冻结为 `unknown_outcome`，全平台停止新的 3.0 付费提交，等待人工对账。
- 全平台同一时刻最多一个 3.0 任务在途，避免多个批次并发消耗同一账号积分。
- MVP 每批次最多请求 4 张 3.0 结果；该限制按请求数计算，不伪装成已核实的米粿积分价格。

只读“检查两路 MCP”会执行 `initialize`、`tools/list`，并读取 StoryArk 项目列表；不会调用绘图工具。探查时两条连接分别维护 MCP Session，鉴权不会串用。

## 探查结果

经典连接已确认的主要工具：

- `line_art_extract_v1`
- `line_art_beautify_v4`
- `coloring_v4`
- `shadowing_v7`
- `refer_inference_v2`
- `full_coloring_v1`
- `image_gen_v1`
- `image_separation_v0`
- `lineart_facial_separation_v1`

3.0 连接已确认：

- `list_projects`
- `storyboard_inference`
- `get_storyboard_task`

3.0 账号现已创建项目“米粿Studio 测试开发”，项目读取和真实单任务链路均已验证。

## Schema 固定与变更处理

两路 MCP 的 `tools/list` 输入 Schema 均已形成已批准指纹。每次首次使用连接时会重新读取工具清单：

- 工具缺失：该连接不可用；
- 已批准工具的字段、类型、枚举或必填项发生变化：返回 `capability_schema_drift` 并停止真实调用；
- 路由版本和契约指纹在任务入队时永久写入数据库；
- 后续代码升级不会改变已经排队或已经完成任务的连接归属。

## 服务端配置

```dotenv
# 米粿经典
MIGUO_ACCOUNT_ID=
MIGUO_API_TOKEN=
MIGUO_MCP_URL=https://factory.miguocomics.com/api/mcp/v1
MIGUO_OUTPUT_HOSTS=factory.miguocomics.com,oss.miguocomics.com
ALLOW_REAL_PROVIDER=false
P0_INTERNAL_USE_ACK=false

# 米粿 3.0 / StoryArk
MIGUO_STORYARK_ACCOUNT_ID=
MIGUO_STORYARK_API_TOKEN=
MIGUO_STORYARK_MCP_URL=https://storyark.miguocomics.com/api/mcp/v1
MIGUO_STORYARK_OUTPUT_HOSTS=storyark.miguocomics.com,static-02.miguocomics.com
STORYARK_MAX_RESULTS_PER_BATCH=20
ALLOW_STORYARK_GENERATION=false
STORYARK_INTERNAL_USE_ACK=false
```

两条真实生成链路各有两道独立安全门。部署凭据不会自动开启付费调用；只读能力检查在凭据存在时即可工作。

`MIGUO_OUTPUT_HOSTS` 和 `MIGUO_STORYARK_OUTPUT_HOSTS` 必须填写供应商真实签名 URL 的精确主机名，不支持通配符。2026-08-13 的 StoryArk 单图烟测确认上传与结果均使用 `static-02.miguocomics.com`；2026-08-14 的经典链路非生成上传探查确认素材使用 `oss.miguocomics.com`。两个主机均已分别加入对应精确白名单，未放宽到通配域名。

## 安全与恢复边界

- MCP RPC 与上传请求固定 HTTPS Host/Path，禁止带鉴权的跨域重定向。
- 输出下载不携带 MCP 鉴权头，每一跳重新验证主机，最多 4 次跳转，单文件最大 50 MiB。
- API 响应、公开配置、日志、数据库业务参数和前端均不包含 Token。
- 上传前失败可以安全重试；`tools/call` 可能已经送达后的断流一律按未知结果处理。
- 已获得 3.0 `task_id` 后，下载失败通过 `get_storyboard_task` 获取新签名 URL，不重新运行 `storyboard_inference`。
- 自动化测试全部使用假 MCP，不访问真实网络、不产生费用。

### 经典任务的审计式恢复

如果经典 `tools/call` 已完成，但旧版结果解析器漏掉成品字段，禁止点击重试。先保持
`ALLOW_REAL_PROVIDER=false` 与 `P0_INTERNAL_USE_ACK=false`，用恢复命令做只读核验：

```powershell
npm run recover:classic -- --run-id <Studio run UUID> --task-id <Factory task UUID>
```

默认命令只读取固定的 Factory 任务详情、积分流水及任务既有输入/输出，不调用任何 MCP
生成工具，也不修改任务。它会同时核验：type 2、v4、Slow、Finished、积分流水唯一关联且
扣点为 0、输入与 Studio 冻结素材逐字节 SHA-256 一致、输入/输出均为精确
`oss.miguocomics.com` HTTPS 主机、输出不超过 50 MiB且尺寸完全一致。

确认审计输出后，才可显式挂接已存在的供应商结果：

```powershell
npm run recover:classic -- --run-id <Studio run UUID> --task-id <Factory task UUID> `
  --apply --confirm-run-id <同一个 Studio run UUID>
```

挂接不会创建新 run，也不会再次调用 `tools/call`。本地候选按相同 SHA-256 与完整输入谱系
复用；对账记录写入不可更新、不可删除的事件表，保留 task ID、积分证据引用、原始/本地
SHA-256、尺寸和输出主机，但不保存或打印签名 URL。`output_missing` 即使确认未扣点，也仍
永久禁止自动重试。

## 当前开放状态与剩余动作

1. StoryArk 已完成一次经用户批准的 `1K × 1` 真实烟测，任务成功、结果完整，精确 CDN Host 已确认；详见 [StoryArk 真实烟测记录](StoryArk-真实烟测记录.md)。
2. StoryArk 与经典 Factory 均已完成单图真实烟测；线上两路真实能力都只向平台管理员开放，并分别受两道安全门保护。
3. Studio 暂时不能读取 StoryArk 真实积分余额，管理员仍应从供应商账户核对调用前后积分。
4. 经典 `coloring_v4` 已验证普通通道、`oss.miguocomics.com` 精确主机和官方积分流水；扩大到批量勾线/上色/光影前仍须按代表性样本逐步验收。
