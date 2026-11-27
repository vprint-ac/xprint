# 工单约定

规格与实施工单均使用 [vprint-ac/xprint 的 GitHub Issues](https://github.com/vprint-ac/xprint/issues)。用 GitHub CLI 操作，在仓库外运行时传入 `--repo vprint-ac/xprint`。

- 阅读工单时，用 `gh issue view <number> --comments` 同时检查正文和讨论。
- 规格单独建一张父工单。发布时用 `gh issue create --body-file <file>` 保留原文格式。
- 每张实施工单交付一个可独立演示、验收的行为。用 `gh issue create --parent <number>` 将它关联到规格，分流标签按[标签表](triage-labels.md)选择。
- 用 GitHub 原生阻塞关系记录依赖。向依赖方的 `issues/<number>/dependencies/blocked_by` 端点提交前置工单的数据库 ID。发布后回读子工单列表和依赖关系。
- 领取工作时，选仍开放、无人认领、标有 `ready-for-agent` 且所有前置工单已关闭的实施工单。

**PRs as a request surface: no.**
