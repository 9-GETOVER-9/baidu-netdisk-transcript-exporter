# 参与维护

先读 [开发与验证](docs/DEVELOPMENT.md)、[隐私说明](PRIVACY.md) 和 [授权核查](docs/LICENSING.md)。当前上游授权未明确，不应将本仓库描述为已获 MIT 等许可的开源项目。

普通改动从 dev 创建任务分支，PR 指向 dev；发布时由 dev 合入 main。提交请描述具体问题、修复后的行为及验证范围。避免同时混入大范围格式化。

提交前运行 `npm ci --ignore-scripts`、`npm run check`、`npm test`、`npm run test:package` 和 `npm run test:browser`。浏览器测试的首次依赖安装见开发说明。网页结构适配应附不含真实正文、路径和凭据的最小合成夹具。CI 不得需要百度账号、Cookie 或付费接口。

提交测试时不要只复制实现逻辑作为断言；优先验证最终 MD/ZIP、错误分类、恢复和跨任务隔离。请勿上传课程、媒体、导出报告、浏览器用户目录或真实 trace。贡献者应确认有权提供所提交内容；提交 PR 本身不解决上游授权缺口。
