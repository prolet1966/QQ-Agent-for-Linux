# 数据面板接口（panel.* / action.* 通道）

> 面向「想给控制台加一个数据看板」的插件/技能开发者。
> 这套通道是**全兼容扩展点**：核心只负责「转发 + 渲染」，面板的数据与交互全部由
> 各插件/技能自己提供。以后新增面板**不需要改核心路由、不需要改 UI 渲染器**。

---

## 一句话

- 读：`panel.<key>` 能力 → 控制台「看板」页的 `GET /api/panels/:key` 自动展示。
- 写：`action.<name>` 能力 → 面板里声明的操作按钮经 `POST /api/action` 执行。
- 渲染：UI 里有**通用渲染器**（`ui/app/13-panels.js`），按统一结构画 summary 芯片、
  note / table / bars / donut / kv / actions，不挑面板内容。

---

## 1. 读通道

### 1.1 枚举：`GET /api/panels`

返回所有已声明 `panel.*` 能力的模块：

```json
{
  "ok": true,
  "panels": [
    {
      "key": "affinity", "name": "好感度态度层", "source": "affinity",
      "kind": "plugin",
      "loaded": true, "enabled": true, "active": true,
      "available": true, "usable": true, "reason": ""
    }
  ]
}
```

字段语义：
- `key` = 能力名的 `panel.` 后缀（如 `panel.affinity` → `affinity`）。
- `usable` = 当前**真正生效**（loaded + enabled + 依赖满足），`false` 时 `reason` 给出原因。
- 同一 `key` 有多个提供者（例如 `skills/` 与 `plugins/` 里各放了一份）时只保留一个：
  优先「生效中」的，避免侧栏出现同名面板。

### 1.2 取数：`GET /api/panels/:key`

带可选搜索参数 `?args=<urlencoded JSON 对象>`：

```
GET /api/panels/affinity
GET /api/panels/affinity?args=%7B%22q%22%3A%22Mio%22%7D   # args={"q":"Mio"}
```

返回：

```json
{
  "ok": true,
  "key": "affinity",
  "data": {
    "title": "好感度",
    "summary": [{ "label": "历史档案", "value": "961 人" }],
    "sections": [ /* 见 1.3 */ ],
    "actions":  [ /* 见 2.2 */ ]
  }
}
```

- 面板数据量大，响应带 `Cache-Control: no-store`，前端每次进入/搜索/刷新都重拉。
- 错误：能力不存在 / 无生效提供者 → `404 { reason }`；`args` 非法 JSON → `400`。

### 1.3 统一结构中的 section 类型

| type   | 字段                        | UI 渲染 |
| ------ | --------------------------- | ------- |
| `note` | `title`, `text`             | 说明/空态/告警块 |
| `table`| `title`, `columns[]`, `rows[][]` | 表格（列名可含 `#`/排名） |
| `bars` | `title`, `data:[{label,value,color}]` | 横向条形图 |
| `donut`| `title`, `data:[{label,value,color}]` | 环形图（SVG，无三方库） |
| `kv`   | `title?`, `rows:[[label,value]]`      | 键值网格 |

- `color` 为任意 CSS 颜色字符串，省略时用主题默认色。
- 数据少就少给 section；空数组等于不画，不用刻意填占位。

---

## 2. 写通道

### 2.1 端点：`POST /api/action`

```json
{ "capability": "action.affinity", "args": { "op": "adjust", "personId": "10001", "delta": 5 } }
```

- `capability` **必须**以 `action.` 开头（这是核心放行的**写白名单前缀**），且必须有生效中的提供者，
  否则 `400 / 404` 并给原因。
- 返回：`{ ok, capability, result }`。`result` 是提供者的原始返回值，
  出错时 `{ ok:false, error }` 透传给前端展示并**不刷新**面板。

### 2.2 面板里怎么声明操作

`data.actions` 数组，UI 会渲染成表单卡片：

```json
"actions": [
  {
    "type": "input", "label": "调整好感",
    "capability": "action.affinity",
    "args": { "op": "adjust" },
    "fields": [
      { "name": "personId", "placeholder": "QQ号" },
      { "name": "delta", "placeholder": "增减（正负）", "value": "5" }
    ],
    "submit": "调整",
    "confirm": ""   // 非空时点提交先弹确认框
  }
]
```

- 提交时把 `args` 与表单字段合并后 POST 到 `/api/action`。
- 执行成功 → 面板自动重拉（数据能自证）；失败 → 红字展示 `error`，不刷新。
- 写操作默认都进 `action.*`，**只读面板不要声明 actions**。

---

## 3. 怎么新增一个面板（三分钟上手）

1. 写一个插件或技能，manifest 的 `capabilities` 里加 `"panel.myboard"`。
2. 在 `providers` 里实现 `'panel.myboard': (args = {}) => ({ title, summary, sections })`。
   需要交互就再加 `actions` 与 `action.myboard` 能力。
3. 放到 `plugins/<id>/` 或 `skills/<id>/`，重启或热重载即可 ——
   控制台「看板」页自动出现新入口。**核心和 UI 一行都不用改。**

> 同 id 的旧模块与新版并存时的唯一边界：manifest `id` 相同 → 注册表只保留**后加载**的那个
> （当前扫描顺序 skills/ 在前、plugins/ 在后）。两个版本都实现 `panel.<key>` 时，
> 面板列表会去重，展示生效中的那个。

---

## 4. 兼容性承诺

- **旧插件无 `panel.*`** → 不出现在看板列表，不影响别的功能。
- **未启用 / 依赖缺失 / 加载失败** → 面板列表仍显示但标记不可用，`reason` 透传原因，不报错。
- **提供者抛错** → `/api/panels/:key` 返回 `500 { error }`，UI 显示错误块，其余面板不受影响。
- **section 类型不认识** → 渲染器回退为说明块，不崩溃。
- 面板能力命名空间 `panel.*` 与写通道 `action.*` 均不与核心内置 API 交叉，可安全演进。

---

## 5. 现网面板参考

| key         | 来源                        | 内容 |
| ----------- | --------------------------- | ---- |
| `affinity`  | `plugins/affinity`（活跃） / `skills/affinity`（只读移植版） | 档位 donut、分数段 bars、历史档案 Top20、现网排行、搜索、调整好感/轮回（写） |
| `knowledge` | `plugins/kb-growth`         | MongoDB/语义向量状态、chunks 计数、候选任务、近期文档 |
| `memory`    | `plugins/memory-growth`     | MongoDB 状态、已抽取/待审/已归档计数、候选列表 |
| `bodystate` | `plugins/body-state`        | 21 格情绪/主干三维状态 |
| `meme`      | `plugins/meme-engine`       | 梗库状态 |
| `tts`       | `skills/voice-tts-skill`    | 语音合成服务状态 |

数据来源约定：`DATA_DIR` 与核心共享（见 `plugins/affinity/index.js` 的 `DATA_DIR` 导入），
多实例下不会写错目录。