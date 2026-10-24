<div align="center">

<img src="icons/icon128.png" alt="百度网盘文稿导出图标" width="80">

# 百度网盘文稿与字幕批量导出

**把网盘里的可读文稿和字幕，按课程目录整理成一份 Markdown ZIP。**

`文稿优先` · `字幕补提` · `原目录归档` · `失败可追踪` · `课程缓存管理`

[![Stars](https://img.shields.io/github/stars/9-GETOVER-9/baidu-netdisk-transcript-exporter?style=for-the-badge&color=d6a85c)](https://github.com/9-GETOVER-9/baidu-netdisk-transcript-exporter/stargazers)
[![Release](https://img.shields.io/github/v/release/9-GETOVER-9/baidu-netdisk-transcript-exporter?style=for-the-badge&color=607d8b)](https://github.com/9-GETOVER-9/baidu-netdisk-transcript-exporter/releases/latest)
[![CI](https://img.shields.io/github/actions/workflow/status/9-GETOVER-9/baidu-netdisk-transcript-exporter/ci.yml?branch=dev&style=for-the-badge&label=Checks)](https://github.com/9-GETOVER-9/baidu-netdisk-transcript-exporter/actions/workflows/ci.yml)

[下载安装包](https://github.com/9-GETOVER-9/baidu-netdisk-transcript-exporter/releases/latest) · [快速开始](#quick-start) · [导出结果](#results) · [缓存管理](#cache) · [使用边界](#limits)

</div>

---

> 适合整理网盘课程、讲座和长视频文字资料。扩展读取网页与播放器已经提供的文字，无需先把全部视频下载到本地。

## 能帮你做什么

| 你的需求 | 插件的处理方式 |
|:---|:---|
| 批量整理课程文字 | 递归扫描选中目录，逐个读取可用文稿；不可用时尝试字幕 |
| 视频格式不统一 | MP4、MOV 等走同一流程，不因 MOV 后缀直接跳过 |
| 不想每篇弹出保存窗口 | 提取时缓存文字，整批结束或暂停收尾后统一生成 MD ZIP |
| 需要定位缺失文件 | 离线报告按完整网盘路径列出状态、原因，支持搜索与筛选 |
| 中途失败后继续 | 保留成功缓存，分别重试失败与跳过的项目 |
| 控制浏览器缓存大小 | 查看文字份数与内容大小估算，按课程目录预览并确认清理 |

<a id="quick-start"></a>
## 快速开始

1. 从 [Releases](https://github.com/9-GETOVER-9/baidu-netdisk-transcript-exporter/releases/latest) 下载插件安装 ZIP 并解压至固定位置。
2. 打开 `chrome://extensions/` 或 `edge://extensions/`，开启开发者模式。
3. 点击“加载已解压的扩展程序”，选择直接包含 `manifest.json` 的目录。
4. 登录百度网盘网页版，进入需要处理的目录，刷新页面。
5. 扫描目录，建议首次少量视频、并发1试跑，再开始批量提取。
6. 提取时缓存文字，不逐篇下载TXT；结束后统一生成MD ZIP。暂停收尾后也可打包阶段成果。
7. 如浏览器启用了“每次下载都询问保存位置”，最终ZIP仍可能弹出一次保存对话框。

需要 Chrome / Edge 等 Chromium 120 或更新版本；扩展使用 Manifest V3，当前代码版本 **4.2.4**。更新现有扩展时，保留原加载目录并点击扩展管理页“重新加载”，避免清除已有缓存。

<a id="results"></a>
## 导出结果与重试

- 网页文稿、字幕补提、来源未标明的旧缓存分别计数；尚未取得包含失败、跳过、待处理等。
- 文稿“未检出/未知”是辅助观察，不等于最终没有取得文字；可能已有字幕补提。
- 失败和跳过分别重试，已成功缓存保留。ZIP按实际缓存内容核验数量。
- ZIP含 `.md` 文稿及 `_提取报告/总览.html`、未提取清单、统计与JSON清单，可查看完整路径和原因。
- 可批量下载扫描到的支持文档类型；以实际面板选项为准。

<a id="cache"></a>
## 课程缓存管理

点击插件图标 → **打开缓存管理**，查看当前浏览器的文字份数和内容大小估算。选择任务根目录及其子目录，点击“查看清理范围”，核对完整路径、数量和大小后再确认；取消不删除。

先暂停任务、等待收尾，并关闭网盘目录/视频页和 ZIP 打包页。管理页只清理所选任务目录下的文字缓存（含子目录），不会删除其他任务目录的缓存，也不会操作已下载的 ZIP、MD 或网盘视频。大小是记录的 UTF-8 内容估算，不含数据库索引和进度等开销。

清理后对应进度显示“本地文字缓存已由用户清理”，需要重新提取时回到原目录点“重试失败”。如果清理期间浏览器关闭，后台会从本地清理日志恢复剩余步骤。取消只能在最终确认前进行，确认清理无法撤销。

<a id="limits"></a>
## 能力边界

本扩展只保存页面或播放器实际提供的文字，不进行音频ASR，不绕过会员/预览权限。已保存不代表全文完整；部分内容会附核验提示。网页结构、字幕接口及账号权限变化可能影响兼容性。没有入口时会有限等待并尝试字幕，超时/加载失败与跳过有独立记录。

## 数据与权限

需要 `tabs`、`scripting`、`storage`、`downloads`，站点权限限于百度网盘及 baidupcs。依托当前浏览器登录状态工作；文字缓存位于扩展本地存储，最终ZIP下载到本机。本项目不配置第三方收集服务器，不提供账号Cookie或凭据导出功能。请勿将导出内容、登录信息或实际任务缓存提交到仓库。

## 开发与验证

<details>
<summary><b>开发环境、自动检查与打包命令</b></summary>


插件安装不需要 npm。下面的开发命令在克隆的源码仓库执行，安装 ZIP 不含测试和工具链。开发使用 Node 22/24、Python 3.12；Playwright 仅为开发依赖，已锁定版本。

```sh
npm ci --ignore-scripts
npm run check
npm test
npm run test:package
npx playwright install chromium
npm run test:browser
npm run package
npm run verify:package
```

CI 覆盖 Windows/Linux × Node 22/24，并在 Chromium 中从实际 ZIP 加载扩展，使用合成网盘响应验证缓存和单个 ZIP 下载。真实 Chrome 扩展 API 与 DOM 参与测试；没有访问实际百度账号，不等于在线兼容认证。

</details>

## 文档导航

- [安装、升级与排错](docs/INSTALL.md)
- [开发、回归测试与发布](docs/DEVELOPMENT.md)
- [贡献指南](CONTRIBUTING.md) · [安全报告](SECURITY.md) · [隐私与缓存](PRIVACY.md)
- [版本记录](CHANGELOG.md) · [上游授权核查](docs/LICENSING.md)

## 上游与授权说明

本项目基于 [moshuxv/pandownload](https://github.com/moshuxv/pandownload) 的本地改进版本，保留上游来源归属。新增字幕补提、MD ZIP归档、恢复及重试、任务核验和统计界面。

截至2026-10-21核查当前文件、全部25个公开提交、README、Issue/PR、Release及标签，未发现上游许可证或明确衍生分发授权，授权仍待确认。本仓库不以MIT等许可证重新授权上游代码；上游部分权利归其原作者。需要再分发或商用时，应先确认相应授权。项目与百度网盘官方无隶属关系。
