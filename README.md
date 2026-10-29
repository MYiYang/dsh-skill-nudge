# dsh-skill-nudge

[![npm](https://img.shields.io/npm/v/dsh-skill-nudge.svg)](https://www.npmjs.com/package/dsh-skill-nudge)
[![license](https://img.shields.io/npm/l/dsh-skill-nudge.svg)](LICENSE)

把 WorkBuddy 的「干完活顺手沉淀成 skill」搬进 DSH。

WorkBuddy 靠一段每轮注入的 `<memory_and_skills_reminder>` 提醒模型：多步任务（8+ 次工具调用）、修过棘手错误、发现非平凡流程，就该把它写成 skill。DSH 的 skill 子系统（`dsh-skill-filesystem` 发现 + `dsh-tool-skill` 目录投影 + 按需加载）早就齐了，唯独缺这句提醒——这个插件补的就是这一环。

## 它做什么

- 监听 `tools/result`，按会话累加工具调用次数与失败次数。
- 监听 `agent/pre-step`，跨过阈值时往本步追加一条 `<system-reminder data-role="skill-nudge">` 用户消息。
- 提醒内容包含：什么时候该沉淀、写到哪、frontmatter 的硬性规则（`name` kebab-case、`description` 必填、布尔只认严格写法）、正文四段结构、写完不用重启。
- 注入后按 `recheckEvery` 再等一批调用；每个会话最多 `maxNudges` 次。
- 子 agent 会话默认不计数，也不提醒。

它**不写文件、不改技能**，只负责提醒；落盘仍然由模型用 `write` 完成——这一点和 WorkBuddy 的 `SkillManage` 一致（那个工具也只给路径和模板）。

## 为什么提醒里要写 frontmatter 规则

`dsh-skill-filesystem` 对 frontmatter 是严格校验、**失败静默**：`name` 不是 kebab-case、`description` 缺失、布尔写成 `True`/`maybe`，整个 skill 会被丢弃，模型侧只看到目录里没有它。提醒里把这几条写死，比让模型自己猜要省事。

## 安装

已发布到 npm，直接装即可：

```bash
dsh plugin --profile desktop add dsh-skill-nudge
```

改源码或本地调试时，改用 link 依赖：

```bash
dsh plugin --profile desktop add link:F:/ssdwork/vscode/work/zs/work/plugins/dsh-skill-nudge
```

或者手动改 `~/.dsh/profiles/desktop/package.json`：

```jsonc
{
  "dependencies": {
    "dsh-skill-nudge": "link:F:/ssdwork/vscode/work/zs/work/plugins/dsh-skill-nudge"
  },
  "dsh": {
    "profile": {
      "bundles": ["...", "dsh-skill-nudge"]
    }
  }
}
```

Host 插件改动**需要重启 dsh** 才生效（client bundle 才支持热更新）。

## 配置

全部可在 profile 的 `cordis.patch.yml` 里覆盖：

```yaml
- id: skill-nudge
  name: 'dsh-skill-nudge'
  config:
    enabled: true
    threshold: 8
    errorThreshold: 2
    minCallsWithErrors: 4
    recheckEvery: 12
    maxNudges: 3
    trackSubagents: false
    skillHome: '~/.dsh/skills'
```

| 字段 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `threshold` | `8` | 第一次提醒前需要的工具调用数 |
| `errorThreshold` | `2` | 失败调用达到这个数也可以触发 |
| `minCallsWithErrors` | `4` | 但整轮至少要跑到这么多调用 |
| `recheckEvery` | `12` | 两次提醒之间至少再发生多少次调用 |
| `maxNudges` | `3` | 单会话提醒上限 |
| `trackSubagents` | `false` | 是否连子 agent 一起计数 |
| `skillHome` | `~/.dsh/skills` | 提醒文案里展示的技能根目录 |

嫌吵就把 `threshold` 调到 20，或者把 `maxNudges` 设成 1；彻底关掉用 `enabled: false`。

## 停用与回滚

改 `enabled: false` 后重启即可，不动代码。要彻底移除，删 `cordis.patch.yml` 里那条 insert 和 `package.json` 里的依赖。

## 开发

```bash
# 单文件跑测，避免 sandbox 下的 spawn EPERM
node --test --test-isolation=none test/nudge.test.js
```

`lib/nudge.js` 是纯逻辑（计数状态机 + 文案渲染），`index.js` 只做事件接线与错误兜底。任何一条失败路径都返回原始 decision，保证提醒挂了不会拖垮一轮对话。
