# MVP 部署与运维

## 线上入口

- 地址：<https://leoandfriends.cool/miguo-studio/>
- 访问保护：应用内账号、HttpOnly 会话、CSRF 与成员数据隔离
- 管理员登录信息：用户本机工作区外的受限凭据文件
- 默认供应商：Mock；管理员可在界面显式选择真实生产
- 真实米粿：经典与 3.0 两路凭据仅保存在服务器受限环境文件；两路均已完成单图真实烟测，并仅向平台管理员开放

不要把管理员密码、SSH 口令或米粿 Token 复制到源码、工单、截图或日志中。服务器只保存密码的加盐哈希，不保存明文。

## 服务器结构

| 路径或服务 | 用途 |
|---|---|
| `/opt/miguo-studio/releases/<版本>` | 不可变发布版本 |
| `/opt/miguo-studio/current` | 当前版本软链接 |
| `/opt/miguo-studio/runtime/current` | 隔离的 Node 24 运行时 |
| `/var/lib/miguo-studio` | SQLite、素材和排版导出持久化数据 |
| `/etc/miguo-studio/miguo-studio.env` | 服务端运行配置，不进入发布包 |
| `miguo-studio.service` | systemd 进程守护 |
| `/etc/nginx/snippets/miguo-studio.conf` | HTTPS 子路径反向代理 |

后端只监听 `127.0.0.1:4317`，没有新增公网端口。公网请求经现有域名的 HTTPS 和 Nginx 进入 `/miguo-studio/`；原域名主页仍由既有应用处理。

## 资源限制

- 单批最多 12 张草稿；
- 单图最大 15 MiB；
- Worker 并发为 1，适配当前 2 核、约 4 GB 内存的服务器；
- systemd 内存上限 2.5 GB；
- 单批积分安全上限仍为 2880，但 Mock 不产生真实账单；
- 同一格、阶段和输入快照最多两次尝试。

## 常用只读检查

```bash
sudo systemctl status miguo-studio.service
sudo journalctl -u miguo-studio.service --since "30 minutes ago" --no-pager
curl -fsS http://127.0.0.1:4317/api/v1/health
sudo nginx -t
```

健康接口应显示 `defaultProvider: mock`、`auth.required: true`、两路连接的 `configured: true`；经典 `miguo.realEnabled`、`factoryClassic.executionEnabled`、StoryArk `realEnabled` 与 `storyarkV3.executionEnabled` 均为 `true`。批次接口在未登录时应返回 401。不要在排障输出中附带任何凭据或 `.env` 内容。

## 更新与回滚

每次发布会创建新的 `/opt/miguo-studio/releases/<版本>`，通过 `current` 软链接切换。更新前应在本地完成语法检查、自动测试和密钥扫描，服务端会再次执行相同检查，全部通过后才切换。

如新版本有问题，可把 `/opt/miguo-studio/current` 指回上一个发布目录，然后执行：

```bash
sudo systemctl restart miguo-studio.service
```

不要通过删除 `/var/lib/miguo-studio` 回滚；该目录保存用户上传、素材版本、任务记录和导出结果。

## 开启真实米粿前

线上已经部署两路凭据，但凭据不代表调用授权。StoryArk 与经典 Factory 均已完成一次最小真实烟测并仅向平台管理员开放；经典烟测和恢复证据见 [Factory 经典链路真实烟测记录](Factory经典链路真实烟测记录.md)。以后扩大样本或批量执行前，应确认：

1. 凭据只写入服务器受限环境文件；
2. 经典链路只在 `ALLOW_REAL_PROVIDER=true` 与 `P0_INTERNAL_USE_ACK=true` 同时成立时开放；
3. 3.0 链路只在 `ALLOW_STORYARK_GENERATION=true` 与 `STORYARK_INTERNAL_USE_ACK=true` 同时成立时开放；
4. 客户端不选择或显示分镜成稿供应商与模型；内部路线由受保护环境中的 `STUDIO_STORYBOARD_RENDER_PROVIDER` 管理。默认图像路线只在 `STUDIO_IMAGE_MODEL_ENABLED=true`、`ALLOW_STUDIO_IMAGE_GENERATION=true` 与 `STUDIO_IMAGE_INTERNAL_USE_ACK=true` 三项同时成立时开放。新任务冻结当前服务器路线，完整成稿仅做方向、精确画布尺寸、sRGB 与 PNG 归一；旧任务继续执行自身冻结路线，禁止静默迁移历史任务；
5. 只读“检查两路 MCP”不需要打开上述付费门；
6. StoryArk 与 Factory 的真实结果 CDN Host 均已经单图验证并加入各自精确白名单；
7. 管理员账号已启用强密码并轮换所有活跃会话；
8. 积分上限、素材授权和超时未知结果处理已经复核；
9. 先跑 1 格，再扩到代表性样本，不能直接批量跑整章。

部署脚本的可选第五参数是一次性 MCP bootstrap 文件，只允许以下四行，必须为 UTF-8 无 BOM、LF 换行，并放在 `/tmp/miguo-studio-mcp-bootstrap-*`：

```dotenv
MIGUO_ACCOUNT_ID=...
MIGUO_API_TOKEN=...
MIGUO_STORYARK_ACCOUNT_ID=...
MIGUO_STORYARK_API_TOKEN=...
```

脚本把四项原子合并到 `root:miguo-studio 0640` 的环境文件，随后销毁 bootstrap 文件，并强制把四道付费门重置为 `false`。轮换时使用新的完整四行文件重新部署；不得把值写进发布包、命令行参数或日志。

可选第六参数是一次性的 Studio 主模型 bootstrap 文件，只允许以下两行，同样必须使用 UTF-8 无 BOM、LF 换行，并放在 `/tmp/miguo-studio-main-model-bootstrap-*`：

```dotenv
STUDIO_MAIN_MODEL_BASE_URL=https://ai-hub.miguocomics.co/v1
STUDIO_MAIN_MODEL_API_KEY=...
```

安装会验证精确中转站地址、原子写入受保护环境并销毁该文件，同时把 `STUDIO_MAIN_MODEL_ENABLED` 重置为 `false`。完成健康检查后再单独开启。生产路由固定为批量 `gpt-5.6-luna`、单格生成/再次生成前 `gpt-5.6-terra`；浏览器不能覆盖模型名。
