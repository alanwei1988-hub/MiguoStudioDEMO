# 米粿Studio 选择性参考上色 Agent

> 历史方案说明：本文记录的是旧版 StoryArk／Nano 选择性合成路线，供已有任务恢复与审计。自 `nano-banana-2-provider-raw-resize-1` 起，Nano Banana 2 新任务仍使用 Agent 理解结果和透明编辑遮罩作为模型输入，但 Studio 不再执行对象级回贴、线稿恢复或“遮罩外像素不变”合成；它直接采用供应商返回的完整画面，并且只归一到原分镜画布尺寸、sRGB 和 PNG。旧任务继续按冻结路由执行本文方案，不能迁移成 Raw。

状态：MVP 实现稿  
日期：2026-08-14  
适用工作流：分镜到成稿工作流

## 1. 产品目标

这个 Agent 不再“选一个分镜格交给 StoryArk 重画”。它要完成四件事：

1. 理解完整分镜中哪些人物、服装、头发、皮肤、配件和道具确实存在于人设参考图。
2. 为命中要素生成紧贴轮廓的多边形遮罩，并为对白、文字、边框、背景和未匹配人物生成保护区。
3. 使用完整分镜与人设参考图调用一次 StoryArk `storyboard_inference`，取得参考渲染。
4. 按 Agent 给出的 `renderOrder` 逐个把渲染颜色合回命中遮罩；遮罩外像素必须与原分镜一致。

因此最终结果仍保留原分镜的构图、对白、线稿、未匹配角色和背景。参考图没有提供依据的内容不会被系统擅自改写。

## 2. 已核实的能力边界

StoryArk 3.0 MCP 当前只有：

- `list_projects`
- `storyboard_inference`
- `get_storyboard_task`

`storyboard_inference` 只接受项目、完整分镜 URL、单张参考图 URL、尺寸、候选数和移除背景开关；没有 mask、区域、对象绑定或局部重绘参数。

Factory MCP 的 `coloring_v4`、`refer_inference_v2` 与 `image_separation_v0` 也没有显式区域遮罩参数。因此对象匹配、遮罩、保护区和原位合成都必须由 Studio 完成，不能伪称为 StoryArk 自带的局部上色能力。

## 3. 模型路由

- 批量低成本初筛固定使用 `gpt-5.6-luna`，图片细节 low、推理强度 low。
- 用户单独点击生成、重新生成或再次生成固定使用 `gpt-5.6-terra`，图片细节 high、推理强度 medium。
- 服务端通过 OpenAI-compatible Responses API 发送两张图片并要求严格 JSON Schema。
- 浏览器不能传模型名称，也不能绕过 Terra 直接提交 StoryArk。
- 当前 prompt revision：`storyboard-selective-reference-color-v5`；结果 schema 为 `storyboard-analysis-v3`。
- 当前 schema revision：`storyboard-analysis-v2`。

2026-08-14 使用 Wikipe-tan 分镜与人设进行真实 Terra 分析：识别 3 个分镜格、14 个命中要素、21 个着色多边形、12 个保护区，整体置信度 0.94；没有触发 StoryArk 付费生成。

OpenAI 官方文档确认 Luna 和 Terra 都支持图片输入与 Structured Outputs；Luna 适合高吞吐低成本分析，Terra 适合兼顾质量与成本的交互任务。

## 4. 结构化输出

所有坐标均以完整分镜为基准，归一化到 0～1。

```json
{
  "schemaVersion": "storyboard-analysis-v2",
  "summary": "reference-backed elements and protected content",
  "overallConfidence": 0.94,
  "requiresConfirmation": false,
  "panels": [
    {
      "localId": "panel_1",
      "bbox": { "x": 0, "y": 0, "width": 0.5, "height": 0.5 },
      "composition": "close-up",
      "elements": [
        {
          "localId": "panel_1_hair",
          "kind": "hair",
          "bbox": { "x": 0.1, "y": 0.08, "width": 0.24, "height": 0.21 },
          "referenceMatch": "matched",
          "confidence": 0.98,
          "evidence": "same silhouette and hair accessories",
          "action": "apply_reference",
          "renderOrder": 2,
          "maskPolygons": [[
            { "x": 0.12, "y": 0.09 },
            { "x": 0.31, "y": 0.11 },
            { "x": 0.3, "y": 0.27 }
          ]]
        }
      ],
      "protectedRegions": [
        {
          "localId": "panel_1_dialogue",
          "kind": "speech_bubble",
          "bbox": { "x": 0.33, "y": 0.03, "width": 0.14, "height": 0.12 },
          "maskPolygons": [[
            { "x": 0.33, "y": 0.03 },
            { "x": 0.47, "y": 0.03 },
            { "x": 0.47, "y": 0.15 }
          ]]
        }
      ],
      "risks": []
    }
  ]
}
```

可着色 `kind`：character、hair、skin、garment、accessory、prop、other。  
保护区 `kind`：speech_bubble、text、panel_border、unmatched_character、background_detail、other。

规则：

- 角色先按实例识别：原角色不低于 0.75；强相似角色不低于 0.70，且至少有两个身份线索和一个非通用造型线索。同一格可以有多个获准实例。
- 每个获准角色都必须完成头发、脸颈皮肤、手臂和手、腿部、服装、鞋袜、发饰、随身包等十组覆盖清单。`referenceMatch=matched`、`action=apply_reference` 且部件置信度不低于 0.60 的要素进入显式语义遮罩。
- 获准角色的完整轮廓是权限包络；合成器只允许 Nano 在包络内的可靠新增色彩证据补齐被模型漏掉的小块或分离部件，未匹配人物、对白、格线和包络外像素仍严格不变。
- uncertain 和 not_present 自动转为保护区。
- 保护区优先级高于着色区。
- 遮罩必须是轮廓多边形，不允许使用整个 panel bbox 冒充对象遮罩。
- 没有安全命中要素时拒绝准备付费任务。
- Agent 遮罩覆盖页面超过 78% 时拒绝合成，防止整页误改。

## 5. 生成与合成链路

```text
完整分镜 ─┐
          ├─> Luna/Terra 对象匹配 ─> 着色区 + 保护区 ─> 用户确认
人设参考 ─┘                                      │
                                                  ▼
完整分镜 + 人设 ──> StoryArk 单次参考渲染 ──> 按 renderOrder 逐对象合成
                                                  │
                                                  ▼
                           原线稿乘回 + 遮罩外逐像素不变校验 ──> 成稿
```

后端不再创建 Agent panel crop。`generation_source_asset_version_id` 固定指向分析时的完整 approved source，并冻结 source SHA、画布尺寸、对象顺序、着色多边形与保护多边形。

StoryArk 返回后：

1. 校验输出可解码且宽高比与原分镜误差不超过 3.5%。
2. 将候选渲染安全缩放到原画布尺寸。
3. 按 `renderOrder` 逐个应用对象遮罩。
4. 把原分镜线稿以 multiply 方式覆盖回着色区域。
5. 对所有遮罩外像素逐像素比对 RGBA；有任何变化则拒绝落盘。
6. 输出 metadata 记录源资产、源 SHA、供应商渲染 SHA、遮罩覆盖率、对象顺序及 `preservedOutsideMask=true`。

## 6. 前端确认

第三步名称为“对象匹配与保护”。

- 绿色实线多边形：将应用人设参考色。
- 红色虚线多边形：强制保持原样。
- 卡片显示分镜格数、命中要素、待确认要素、置信度、着色区数和保护区数。
- 付费确认弹窗明确写明完整分镜输入、候选数量和“仅修改绿色遮罩”。
- 旧 `storyboard-analysis-v1` 裁切分析显示为失效，不能解锁真实任务。
- 再次生成会创建新的 Terra 分析与新幂等键；刷新或网络恢复仍查询同一 StoryArk task，不会盲目重复提交。

## 7. 成本与安全

- 默认候选上限从演示期每批 4 张调整为 20 张，使“再次生成”可用；单次仍限制 1～4 张。
- 生产继续全局只允许一个 StoryArk 在途任务。
- 供应商结果未知时冻结全局 StoryArk 付费提交。
- StoryArk 输出签名 URL 只在 Worker 内读取；浏览器只访问 Studio 本地 output content 路由。
- 主模型 API Key 与两路米粿凭据只存在于服务器受保护环境。
- StoryArk 的 `remove_bg` 在选择性合成路径固定为 false，避免透明背景破坏几何对齐。

## 8. 现阶段限制

多边形来自视觉模型，不能等同于专业人工抠图。当前 MVP 用以下办法降低风险：

- 付费前可视化遮罩；
- 高置信度门槛；
- 保护区覆盖文字、边框和未匹配人物；
- 最大覆盖率；
- 输出宽高比检查；
- 遮罩外像素不变的硬校验。

下一阶段应加入可拖动顶点、画笔增删遮罩、对象逐个开关以及组织级审核。若需要头发丝、交叉肢体或复杂遮挡的生产级精度，还应接入专业实例分割模型或由米粿 MCP 提供原生 mask/layer 输出。

## 9. 验收标准

1. Terra 能在示例整页中识别同一参考设计在多个分镜、以及同一分镜内多个相似人物上的出现位置。
2. 每个命中人物应完整覆盖可见头发、脸/颈/手臂/手、服装分件、鞋袜与参考图支持的手提包等随身配件，不因部件较小或与躯干分离而遗漏。
3. 头发、皮肤、服装、配件和道具分开列出，未匹配人物与对白进入保护区。
4. StoryArk 只收到一次完整分镜 + 参考图真实任务。
5. Worker 按对象顺序合成，不直接展示供应商整页重绘。
6. 遮罩外随机抽样与完整逐像素断言均等于原图。
7. 输出保留原分镜尺寸、线稿、对白和边框。
8. 失败、超时或输出错位时不重复付费调用。
9. “再次生成”在额度内可用，并重新走 Terra 分析与付费确认。
