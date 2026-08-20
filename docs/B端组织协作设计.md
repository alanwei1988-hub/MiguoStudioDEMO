# 米粿Studio B 端组织协作设计

## 产品原则

米粿Studio 的 B 端协作采用“个人工作分支 + 组织共享版本 + 组织积分账本”，而不是让多人共用一个账号或直接共享供应商 Token。

1. 每位同事使用独立账号，用户可以加入一个或多个组织，并显式选择当前组织。
2. 尚未提交的工作默认只有本人可见；“提交到组织”后，同事看到的是一个不可变的已确认版本快照。
3. 接手不覆盖原成果，而是从提交快照创建新的个人工作分支；谱系可追溯到提交人和上游版本。
4. 组织共享平台积分额度。真实供应商密钥始终在服务端托管，不进入浏览器，也不直接分发给成员。
5. 费用、版本、审批、指派和权限变化都写入追加式审计事件，避免靠聊天记录还原生产过程。

## 身份与权限

平台身份与组织身份分开：

| 层级 | 角色 | 建议权限 |
|---|---|---|
| 平台 | Platform Admin | 管理供应商、模型、全局安全门、封禁与事故处置 |
| 组织 | Owner | 组织所有权、账单、成员与安全设置 |
| 组织 | Admin | 邀请成员、项目配置、额度与权限 |
| 组织 | Producer | 建项目、分配/交接任务、查看成本和进度 |
| 组织 | Artist | 执行生产、提交已确认版本、接手任务 |
| 组织 | Reviewer | 审阅、通过、退回并给出修改意见 |
| 组织 | Viewer | 只读查看已提交的组织内容 |

一个用户通过 `organization_memberships` 关联多个组织。组织角色存在 membership 上，不能复用 `users.role`；后者只保留平台级 `platform_admin` 与普通用户的区分。

## 工作可见性与交接状态

建议给工作分支设置以下可见性：

- `private`：仅作者可见，可反复生成和淘汰候选。
- `submitted`：已提交不可变快照，组织成员按权限可见。
- `in_review`：等待 Reviewer 审阅。
- `changes_requested`：退回原作者或重新指派，保留审阅意见。
- `approved`：成为组织项目的当前基线。
- `superseded`：被后续已批准版本替代，但仍可追溯。

“提交到组织”必须冻结一个 manifest，记录当前 source/ink/color/light 的资产 ID、哈希、谱系、参数、作者、时间和说明。提交不是简单地把 `private` 改成公开，也不能让后续个人重做悄悄改变已提交结果。

接手流程：

```text
个人分支 → 提交快照 → 组织审阅/待接手 → 同事认领 → 从快照建立新分支 → 再提交
```

认领和指派使用带版本号的乐观锁；两人同时点击接手时只有一人成功。Producer 可以强制转派，但必须填写原因并产生审计事件。

## 共享积分不是共享 Token

组织积分建议使用不可变双向账本，而不是只维护一个可直接增减的 `balance` 字段：

- `grant`：充值、套餐或管理员授予；
- `reserve`：任务排队前按最坏情况预占；
- `settle`：供应商返回明确成本后结算；
- `release`：取消或未调用供应商时释放预占；
- `adjust`：有理由、操作者和关联单据的人工调账；
- `hold_unknown`：调用结果不确定时冻结预占，等待对账，禁止自动重试造成重复扣费。

每次生成同时记录 `organization_id`、`project_id`、`actor_user_id`、`work_item_id`、供应商成本与组织计费积分。数据库事务需原子完成“额度检查 + 预占 + 入队”，并使用幂等键防止双击扣两次。

组织可配置：总额度、月度预算、单项目预算、单成员上限、真实供应商使用角色、超额审批人和低余额提醒。成员看到组织积分余额和自己的消费明细，但供应商 API Token 永远不可见。

## 核心数据模型

建议从当前 `users` 与 `batches.owner_user_id` 平滑扩展：

| 实体 | 关键字段 |
|---|---|
| `organizations` | id, name, status, billing_policy, created_by |
| `organization_memberships` | organization_id, user_id, role, status, joined_at |
| `projects` | organization_id, name, status, producer_id |
| `work_items` | project_id, kind, assignee_id, state, version, due_at |
| `work_branches` | work_item_id, owner_user_id, based_on_submission_id, visibility |
| `submissions` | branch_id, manifest_hash, note, submitted_by, submitted_at |
| `reviews` | submission_id, reviewer_id, decision, note, created_at |
| `credit_accounts` | organization_id, currency, policy_version |
| `credit_ledger_entries` | account_id, type, amount, run_id, idempotency_key, actor_id |
| `audit_events` | organization_id, actor_id, action, target_type, target_id, metadata |

当前批次可继续保留 `owner_user_id` 作为个人作者，并新增可空的 `organization_id`、`project_id` 与 `visibility`。旧批次保持个人私有，不需要一次性迁移或改写资产谱系。

## 建议 API 边界

- `POST /organizations`、`POST /organizations/:id/invitations`
- `GET /organizations/:id/members`、`PATCH /organizations/:id/members/:userId`
- `POST /work-branches/:id/submissions`
- `POST /submissions/:id/reviews`
- `POST /work-items/:id/claim`、`POST /work-items/:id/reassign`
- `GET /organizations/:id/credits`、`GET /organizations/:id/credit-ledger`

所有组织资源都从登录会话解析 membership，不能相信前端传入的角色或组织归属。写操作继续使用 CSRF；邀请、角色调整、额度调整和供应商配置需要二次确认与审计。

## 分阶段落地

### P1A：组织与可见性

- 组织、成员邀请、角色；
- 当前组织切换；
- 个人批次与组织项目；
- 提交不可变快照、组织动态流、审阅与退回。

### P1B：交接与生产管理

- 工作项、指派、认领、转派、截止时间；
- Producer 看板、按人/阶段/异常聚合；
- 通知、评论、@成员与审计导出。

### P1C：共享积分

- 组织信用账户与追加式账本；
- 任务预占/结算/释放/未知费用冻结；
- 项目和成员预算、审批与告警。

### P2：企业化

- 企业 SSO、SCIM、强制 MFA、IP 策略；
- 对象存储、PostgreSQL、独立 Worker 与灾备；
- 数据保留策略、版权水印、合规导出和企业 SLA。

## 当前 MVP 的兼容决策

当前试点已经提前落地以下最小闭环：

- 每个新账号自动获得一个个人工作室；平台管理员可建立组织，并按邮箱把账号关联为 `owner`、`scheduler` 或 `member`。MVP 暂时只允许每个账号有一个有效组织 membership，多组织切换仍属于 P1。
- 分镜任务可多选并批量设置 `deadline_at`；日期、修改人和修改时间持久化到服务端，不依赖浏览器缓存。
- “提报”会冻结当前采用的 `storyboard_output_id`、组织、提交人、提交时间和当时的截止日期，并写入不可更新、不可删除的 `panel_submission_events`。作者之后重新生成不会改变公司看到的版本，必须显式“更新提报”。
- 同组织账号可通过独立的公司提报列表读取该冻结成稿；不同组织账号得到空列表或 404，不能借输出 ID 越权读取作者的其他批次和素材。
- 对应 API 为 `POST /api/v1/batches/:batchId/panel-deadlines`、`POST /api/v1/panels/:panelId/submit`、`GET /api/v1/organization/submissions`，以及平台管理员使用的最小组织创建/成员关联接口。

当前批次本身仍保持作者私有；“提报”共享的是一个明确的成稿快照，不是把整个工作区公开。组织项目、邀请、审阅、退回、接手、共享积分和多组织切换仍按 P1A–P1C 实施。平台管理员能看历史与全部批次，但这不等同于组织管理员；平台权限与 membership 权限继续保持分离。
