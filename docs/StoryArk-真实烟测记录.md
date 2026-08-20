# StoryArk 3.0 真实烟测记录

日期：2026-08-13

## 授权与范围

用户明确批准一次最小付费烟测，并要求通过后上线服务器。测试仅调用 StoryArk 3.0；经典勾线、上色和光影 MCP 没有开放或调用。

固定参数：

- 项目：`米粿Studio 测试开发`
- 分镜草稿：CC-BY-SA 演示资源 `wikipetan-5.jpg`
- 人物参考：CC-BY-SA 演示资源 `wikipetan-4.png`
- 输出：`1K`
- 候选：`1`
- 移除背景：`false`

## 付费前预检

- 只读能力检查：StoryArk 3 项工具可用，项目数为 1。
- 数据库：历史 StoryArk run 为 0、活动 run 为 0、未知费用 run 为 0。
- 非生成上传预检：两张素材均上传成功，HTTPS 主机为 `static-02.miguocomics.com`。
- 精确白名单：`storyark.miguocomics.com,static-02.miguocomics.com`；没有使用通配符。
- 已备份生产 SQLite 和受限环境文件。

## 结果

- 提交次数：1 次 `storyboard_inference`
- 最终状态：`succeeded`
- Provider task ID：已持久化；本文不记录其值
- 用时：50,132 ms
- 输出数量：1
- 输出格式：PNG
- 输出尺寸：896 × 1195
- 文件大小：630,937 bytes
- 完整性：数据库 SHA-256 与实际文件 SHA-256 一致；数据库尺寸与 PNG IHDR 一致
- 真实结果主机：`static-02.miguocomics.com`
- 页面恢复：刷新后显示“查看 3.0 成稿”，灯箱可打开
- 恢复状态：没有 `unknown`、没有遗留 `processing`、没有第二次 inference

完整签名 URL、API Token、账号值和 task ID 均未写入本文、源码或日志。

## 已知费用限制

当前 Studio 将 StoryArk 成功任务记录为 `cost_source=unpriced`，不能自动读取或核对供应商账户的真实积分变化。因此本次只能证明恰好发生一次付费生成，不能由 Studio 证明具体扣分数；真实积分仍需以 StoryArk 账户记录为准。

## 上线边界

- 只开放 StoryArk 的 `ALLOW_STORYARK_GENERATION` 与 `STORYARK_INTERNAL_USE_ACK`。
- 经典 `ALLOW_REAL_PROVIDER` 与 `P0_INTERNAL_USE_ACK` 继续关闭。
- 真实调用仍仅允许平台管理员。
- 全平台同一时刻最多一个 StoryArk 任务在途；任一批次出现未知费用后，全平台冻结新的 3.0 付费提交。
- 每批最多请求 4 张候选；该上限不是积分价格或组织预算。
