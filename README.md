# dsh-balance-pill

显示：
1. 在输入框下方显示 DeepSeek 平台钱包余额
2. 悬停时显示**本会话的估算消费**（自动获取最新官方费率）
3. 语言自适应中/EN

点击：
1. 点击后在应用内打开 Platform 充值页

示范：

<img width="584" height="185" alt="image" src="https://github.com/user-attachments/assets/c2e7b59e-3d12-4668-8507-13af8dafc7af" />

## 文件

- `index.js`：Host 半侧，注册 `/balance-pill/prices`（仅 loopback + same-origin），每 24 小时抓 `https://api-docs.deepseek.com/quick_start/pricing` 解析官方价目（peak / off-peak 两档，`deepseek-flash` 与 `deepseek-v4-pro`）；抓取失败时回退上一份缓存并标 `stale`，再失败回退内置的兜底价目。
- `client.js`：`window.__ModuleLoader__.load({ id: 'dsh-balance-pill', factory(require) { … } })`。
- `cordis.patch.yml`：插入 loader 行 `balance-pill / dsh-balance-pill`。
- `locale/zh.json`、`locale/en.json`：插件元数据标题、描述与 `meta.detail` 指向。
- `icon.svg`：Plugin Manager 里的行内图标（36×36，币形 + `¥`，与官方插件的描边风格一致）。
- `docs/DETAIL.md`、`docs/DETAIL.zh.md`、`docs/preview.svg`：插件详情页的功能图与说明文档（详情页只放一张功能图）。
