# 安装、升级与排错

1. 从本仓库 Releases 下载 `baidu-netdisk-transcript-exporter-v版本.zip`，不是 GitHub 自动提供的 Source code ZIP。
2. 解压到固定目录；确认 manifest.json 就在所选文件夹第一层。
3. Chrome/Edge 120+：打开 chrome://extensions/ 或 edge://extensions/，开启开发者模式，点击“加载已解压的扩展程序”。安装包不是签名 CRX，不是双击安装。
4. 登录网盘，进入目标目录并刷新，先用少量视频、并发 1 验证。文稿优先，无正文时尝试字幕，MOV 正常参与。
5. 中途文字保存在本机缓存，结束统一下载 MD ZIP；下载询问开启时最终 ZIP 仍可能询问一次。

## 升级

先暂停任务，等正在处理的视频收尾，导出一次阶段 ZIP。将新包解压覆盖到**原加载目录**，在扩展页点“重新加载”，刷新网盘页。不卸载，不随意更换加载路径；本版不迁移或清空旧存储。

## 常见情况

- “清单文件缺失”：选错了文件夹层级，检查根 manifest.json。
- 界面仍显示旧版本：重新加载扩展并刷新已打开的网盘页，检查是否同时启用了旧插件/脚本。
- 已缓存与 ZIP 份数不同：ZIP 按实际正文缓存核验；旧版本仅记录成功但没有正文的文件会列为缺少缓存。
- 文稿未检出不等于没有文字：可能已由字幕补提；检查最终来源统计。未知或失败可以重试，有限等待不证明永久没有文稿。
- 每篇 TXT 仍弹窗：视频提取不会逐篇下载 TXT；检查是否启动了“文档下载”，或另有旧插件在运行。
- 大批量中断：保留原扩展目录，重新打开目录恢复，优先重试失败/跳过；不要直接删除扩展数据。

下载校验（PowerShell）：`Get-FileHash .\baidu-netdisk-transcript-exporter-v4.2.3.zip -Algorithm SHA256`，与附件 SHA256SUMS.txt 比较。Linux/macOS 使用 `sha256sum -c SHA256SUMS.txt`（macOS 可用 shasum）。
