# 上游授权核查记录

核查日期：2026-10-21。对象：[moshuxv/pandownload](https://github.com/moshuxv/pandownload)，公开主分支提交 `fa76a411ea58227a08bd76dc78a24dbbf5a01524`。

## 发现

- GitHub repository API：license=null，fork=false，没有 parent 仓库。
- 公开 refs：main 分支；没有公开标签。当前文件树无 LICENSE/COPYING/NOTICE，README 未声明许可证。
- 镜像读取全部 25 个可达提交；全部历史文件路径未出现许可证文件；对代码/文档变更检索 license、License、MIT、Apache、copyright、Copyright、许可证、许可、授权，未发现匹配。
- 核查时公开 Issue/PR 列表为空，Release 列表为空。未发现公开的额外授权。
- 没有取得作者的私下许可；本核查没有代用户联系作者。检查仅限这些公开证据，不能证明作者从未在别处授权。

结论：**在上述范围内未找到明确的使用/衍生分发许可证，授权状态仍待作者确认。** 本次不能为原代码任意添加 MIT、Apache 或其他许可，也不把安装说明或公开可下载视为许可证。GitHub 官方说明区分了公开查看/fork 与软件许可：[Licensing a repository](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/licensing-a-repository)。

## 本项目的处理

保留上游归属，package.json 使用 UNLICENSED 表示没有授予统一许可证，而非宣称所有上游著作权属于本项目。安装 ZIP 包含本说明与 UPSTREAM.md。自动发布和公开源码不意味着上游已授权，不作可自由再分发/商用的承诺。

早期另参考过“一字幕”发布包的字幕工作方式；当前 subtitle-capture.js/subtitle-core.js 为本地独立实现，不打包那个发布包的 JS、图标或依赖。没有将“参考工作方式”冒充第三方源码许可证。图标沿用 pandownload 来源，其权利也未另获确认。

下一步需要上游作者提供许可文本或书面授权，并明确包含衍生修改、安装包分发及图标范围。取得证据后记录具体许可、适用版本和固定链接，再决定本仓库授权方案；如无法取得，须评估移除/独立替换涉及上游的部分。当前不宣称已经解决这一缺口。

## 可复查命令

```sh
gh api repos/moshuxv/pandownload --jq '{license,fork,parent,default_branch}'
git clone --mirror https://github.com/moshuxv/pandownload.git upstream.git
git --git-dir=upstream.git rev-list --all --count
git --git-dir=upstream.git log --all --format= --name-only
git --git-dir=upstream.git log --all -G 'license|License|MIT|Apache|copyright|Copyright|许可证|许可|授权' -- .
gh api 'repos/moshuxv/pandownload/issues?state=all' --paginate
gh api repos/moshuxv/pandownload/releases
```

固定证据入口：[文件树](https://github.com/moshuxv/pandownload/tree/fa76a411ea58227a08bd76dc78a24dbbf5a01524)、[README](https://github.com/moshuxv/pandownload/blob/fa76a411ea58227a08bd76dc78a24dbbf5a01524/README.md)。
