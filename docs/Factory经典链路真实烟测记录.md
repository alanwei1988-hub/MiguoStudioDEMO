# Factory 经典链路真实烟测记录

日期：2026-08-14

## 范围与授权

用户明确批准将经典米粿 MCP 切换到真实生产，并允许为单图上色烟测使用账户积分。烟测仅针对
`Wikipe-tan-5` 的 `coloring_v4` 普通通道；没有批量提交，也没有打开成员账号的真实调用权限。

## 结果

- Studio run：`bc686c63-9bb6-4120-b4b0-f09c0ea6e2a0`
- Factory task：`019ffe66-f0d9-7d54-823d-2191eae1c7d2`
- 供应商状态：`Finished`
- 供应商版本与通道：Coloring v4 / Slow
- 精确输入与输出主机：`oss.miguocomics.com`
- 官方积分流水：与 task ID 唯一关联，Inference Deduction 实际为 `0` 积分
- 最终处理：复用供应商已经生成的合成上色图，不创建第二个生成任务

没有在代码、数据库、日志或本文中保存签名 URL、API Token 或账号值。

## 发现的问题

第一次真实尝试在付费调用前因上传主机白名单缺少 `oss.miguocomics.com` 而停止，未产生供应商
任务。补入精确主机后，第二次调用在 Factory 侧成功，但 Studio 旧解析器只识别
`outputUrls` / `output_url` 等字段，没有识别官方 MCP 工具消息使用的 PascalCase
`OutputImageUrls` / `OutputImageUrl`，因此把成功结果误报为 `output_missing`。

系统在误报后把费用结果标记为 unknown，立即关闭经典两道安全门，并在全平台阻止新的经典付费
任务。之后只使用 Factory 的只读任务历史、详情和积分流水对账；没有点击重试，也没有第三次调用。

## 修复与恢复

- 显式支持官方 `Success`、`OutputImageUrls` 与 `OutputImageUrl`；多输出仍拒绝自动选取。
- 在 `tools/call` 返回后、解析下载前，先持久化供应商 request/task ID 和不含值的结果结构指纹。
- `output_missing` 永久禁止普通重试，必须走审计式对账。
- 新增 append-only 对账事件，记录原状态、供应商任务、成本证据、输出主机、原始/本地 SHA-256、
  尺寸与输入谱系；事件不能更新或删除。
- 恢复工具默认 dry-run，只读取既有 task 与账单；应用恢复还必须再次提供完全相同的 Studio run ID。
- 恢复前逐字节核对 Factory input 与 Studio 冻结输入 SHA-256，并校验输出 HTTPS 主机、50 MiB
  上限、尺寸、哈希及派生边。
- 恢复只下载并挂接 `compositedImageUrl` 的既有结果，不调用 MCP `tools/call`。

## 上线安全状态

- `DEFAULT_PROVIDER` 继续为 `mock`，没有显式选择真实生产的请求不会意外扣点。
- 真实经典任务仍仅允许平台管理员发起。
- 经典和 StoryArk 各自保留两道独立安全门。
- 同一供应商、同一格、同一阶段、同一输入快照最多两次尝试。
- 任一经典任务再次出现未知费用，将全平台冻结新的经典真实任务，直到 append-only 对账完成。
- 自动化验证：73 / 73 通过；语法检查与密钥扫描通过。

## 官方依据

- [米粿 MCP 接入页](https://factory.miguocomics.com/mcp)
- [分区上色说明](https://docs.miguocomics.com/chs/docs/factory-manual/features/coloring)
- [积分和付费说明](https://docs.miguocomics.com/chs/docs/factory-manual/payment-guide)
