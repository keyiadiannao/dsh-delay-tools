# dsh-schedule-reminder

延迟唤醒：让 agent 在 **N 分钟后、在同一个会话里** 主动醒来并向你发消息。

> 「3 分钟后提醒我提交实验记录」这类需求，用普通后台 shell 定时器做不到——
> DSH 的后台任务绑定 agent turn 的生命周期，turn 一结束就被 teardown 杀掉
> （`ctx.jobs` 的 owner-scoped dispose，进程以 `0xC000013A` 退出，且取消会被误报成
> 完成）。本插件用**宿主级定时器**（不绑定任何 turn）持有到期时间，再用官方
> `followup()` 唤醒通道把消息投回**同一会话**。

## 安装

```bash
dsh plugin add github:keyiadiannao/dsh-schedule-reminder#master
```

## 用法

对 agent 说：

> 请调用 schedule_reminder 工具，设置 30 秒后提醒我"该喝水了"。

agent 会调用工具并返回预计触发时间；到期后 agent 自动醒来，在同一个会话中
把提醒内容发给你。期间无论发生过多少轮其他对话（包括你中途插入的新消息），
提醒都会准时送达。

### 工具参数

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `delay_ms` | number | 否 | 延迟毫秒数，默认 60000；夹取在 `minDelayMs`..`maxDelayMs` |
| `message` | string | 是 | 到期后 agent 要投递给你的文本 |

### 返回值

`scheduled` / `due_at` / `delay_ms` / `pending`（该 agent 尚在等待中的提醒数）。

## 第二种模式：`wait`（闸门）

`schedule_reminder` 是「到点唤醒，期间 agent 继续干活」；`wait` 是相反的语义——
**阻塞当前 turn**，计时结束后 agent 才继续手上的工作：

> 请调用 wait 工具等待 30 秒，然后再继续。

| 模式 | 工具 | 等待期间 agent | 等待期间用户消息 | 典型用途 |
|---|---|---|---|---|
| 提醒（wake） | `schedule_reminder` | 可继续处理其他消息 | 照常处理 | 「3 分钟后提醒我 X」 |
| 闸门（gate） | `wait` | 无法做任何事（turn 阻塞） | 进入队列，计时结束后处理 | 「等 30 秒再继续」「冷却时间」 |

`wait` 的参数只有 `delay_ms`；返回 `waited_ms` / `elapsed_until` / `note`。
闸门期间用户发来的消息会排进 inbox（composer 显示「N 条排队消息」），
计时结束后自动进入下一轮处理——这使它成为测试消息队列/合并类插件
（如 dsh-queue-merge）的可靠触发器。

`wait` 遵守工具契约观察 `exec.signal`：等待期间点右下角的**停止生成**会立即
中断闸门（返回 `note: 'Wait interrupted by the user (stop).'`），不会挂满整个
delay。

## 配置

```yaml
- id: dsh-schedule-reminder
  config:
    defaultDelayMs: 60000       # 未传 delay_ms 时的默认延迟
    maxDelayMs: 3600000         # 单次提醒/等待延迟上限
    minDelayMs: 1000            # 最小延迟，防止误触发瞬时重入
```

| 配置项 | 默认 | 说明 |
|---|---|---|
| `defaultDelayMs` | 60000 | 未传 `delay_ms` 时的默认延迟 |
| `maxDelayMs` | 3600000 | 单次提醒延迟上限 |
| `minDelayMs` | 1000 | 最小延迟，防止误触发瞬时重入 |

## 原理

```
user: "3 分钟后告诉我 X"
  ↓
schedule_reminder(delay_ms, message)
  ↓
host setTimeout(delay).unref()      ← 不绑定任何 turn 生命周期
  ↓ (turn 结束、teardown、后续多轮对话都不影响它)
due → agent.followup(userMessage)   ← 官方唤醒通道
  ↓
agent (idle) 打开新 turn → 同一会话内回复提醒
```

关键点：

- 定时器创建在**插件 apply 的作用域**，不是 `ctx.jobs`（后者随 owner turn 销毁）。
- `setTimeout().unref()` 让进程在只剩定时器时也能正常退出，不阻塞 DSH 生命周期。
- `agent.followup()` 是运行时官方的 wake 通道：agent 空闲时提交 wake 必定打开
  新的 turn 边界（见 runtime-types 注释），因此跨轮次唤醒是受支持的语义。

## 测试

`tests/` 下含配置校验测试（`pnpm test`）。端到端验证方式：

1. 新会话 → 让 agent 调用 `schedule_reminder` 设 30 秒提醒；
2. 等 agent 完成当前回合后**再发一条打断消息**；
3. ~30 秒后确认 agent 醒来并送达提醒 → 跨轮次存活成立。

`wait` 的打断验证：让 agent 调用 `wait` 设 40 秒，中途点停止生成 →
确认 turn 立即终止而非挂满 40 秒。

## License

MIT
