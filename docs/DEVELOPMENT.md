# 开发、测试和打包

运行插件本身无需 Node/npm。开发推荐 Node 22 或 24、Python 3.12；CI 覆盖 Windows/Linux × Node 22/24。`PYTHON` 环境变量可指定解释器路径。

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

浏览器测试还使用 OpenSSL 临时生成测试证书（Linux 通常已有；Windows 可用 Git 自带版本或 `OPENSSL` 指定路径）。仅临时测试浏览器信任该证书，不修改系统证书。

Linux 首次浏览器安装可用 `npx playwright install --with-deps chromium`。无 npm 运行依赖，Playwright 仅是开发依赖并锁定版本。没有测试账号或环境密钥要求。

## 验证层次

- Node 测试：纯逻辑及 DOM/Chrome/网络替身，覆盖异常、超时、身份隔离、缓存和归档等；不能证明网页实时兼容。
- Playwright：从**实际安装 ZIP**解压加载真实 Chromium 扩展，使用真实 Service Worker、消息、存储、DOM 和下载 API。本机 HTTPS 服务器提供虚构网盘目录/视频/字幕响应；浏览器代理只隧道连接本机夹具，其余目标全部拒绝，包括扩展创建标签页的首次导航及后台字幕请求。测试弹窗设置、手动视频不被操作、慢文稿/预览标记、MOV 字幕、标签关闭失败、恢复和一个 ZIP 的实际内容。不是线上百度服务测试。
- 包验证：显式 allowlist、根 manifest、版本、引用、语法、CRC、逐文件内容、SHA-256；重复打包必须字节相同，混入额外文件必须失败。
- 缓存管理：逻辑测试覆盖目录边界、来源权限、确认签名、忙碌保护和清理日志中断恢复。真实 Chromium 验证 IndexedDB UTF-8 大小估算、取消/确认、按子目录删除、邻近目录保留、已经下载的 ZIP/MD 字节不变、进度修正和重新提取。

浏览器失败时查看 `output/playwright/report/index.html`，或 `npx playwright show-trace 路径/trace.zip`。CI 上传合成截图/trace，14 天自动过期。

## 可重复安装包

`scripts/package-files.json` 是发布边界。新运行文件需要同时更新清单和引用检查，测试、开发依赖、日志、课程及缓存不入包。标准库 ZIP_STORED 固定排序、时间戳、权限，文本 UTF-8/LF，因此不依赖 zlib 版本或 Windows 换行。包略大，但同一源内容可得到同一 SHA-256。

产物在 dist：安装 ZIP 与 SHA256SUMS.txt；`npm run verify:package` 不重建包，专门核验现有附件。构建脚本可通过 `npm run package -- --output 其他目录` 指定输出，默认忽略 dist，不提交生成物。

## 发布

1. 在任务分支更新 manifest/package 版本、界面版本标识、CHANGELOG 和 docs/releases/v版本.md；更新 lockfile。
2. 通过 PR 合入 dev，再通过发布 PR 合入 main；确认所有 CI 检查通过。
3. 对 main 的已验证提交打 `v版本` 标签并推送。release.yml 会再次跑完整检查，仅在全部成功后创建带安装 ZIP/校验和的 Release。
4. 发布作业检查标签与 manifest 相同、提交属于 main 历史。已存在的 Release 不覆盖；失败先查原因，不强推改写已有标签。
5. 下载 GitHub 附件，运行校验并做小样本安装验证。CI 成功不代替真实账号兼容验收。

## 可选真实账号验收记录

由账号持有人自行小批量执行，记录日期、浏览器版本、插件版本、网页入口、有文稿/仅字幕/无文字各类结果、完整性抽检和错误分类。用合成别名公开结果，不提交实际路径/正文/凭据。未执行的项目标“未测”，不要填成通过。
