# OMO Republic 常驻团队编排器规划

## 核心判断

你的方向可以概括为一句话：

> 多 Agent 不应该只是按需启动的临时工，而应该是跟随项目存在的常驻工程团队。

当前 Republic 已经有 Git-native Commons、ledger、contract、native-git audit、主动 dispatch、`republic_wait`、supervisor review 等基础能力。它已经从“留言板”前进到“可等待的主动异步协作”。但它还不是完整的常驻团队系统，因为 seat 仍然主要依赖单次 background session，生命周期、阶段状态和任务恢复还没有被一个专门的 orchestrator 管住。

这份规划的目标，是把 Republic 从“协作记录层”升级为“项目团队操作系统”。

## 产品目标

1. **团队常驻**
   - 每个项目可以拥有稳定 team。
   - 每个 seat 有固定身份、职责、记忆、inbox cursor、当前任务状态和可恢复 session handle。
   - seat 不一定持续占用模型 token，但它在项目状态中始终存在，可以被调度器唤醒。

2. **阶段明确**
   - Planning Phase 通过多 seat 并行研究、互审和辩论，产出 conference report 和 contract。
   - Execution Phase 按 contract 拆任务，多 workgroup 并行实现。
   - Review Phase 自动汇总 Git changes、Commons、contracts、tests，由 reviewer/supervisor 审查。

3. **主动沟通**
   - seat 可以发布 `question`、`answer`、`objection`、`proposal`、`revision`、`handoff`、`consensus`。
   - 被问到的 seat 自动被调度，而不是等用户手动提醒。
   - 发问方可以通过 `republic_wait` 阻塞等待回复。
   - supervisor 看到争议、阻塞、偏离 contract 或风险路径时主动介入。

4. **Git-native 可追踪**
   - 每个 seat 的讨论、决策、合同、文件变更、调度事件都写入 Git common dir。
   - 工作区不因为协作记录而 dirty。
   - 可选导出会议纪要、review report、release report 到版本化文档。

5. **可选启用**
   - 简单任务不强迫复杂团队。
   - 大型任务可以显式进入 `parliament`、`squad`、`parliament_squad`。

## 非目标

第一版常驻团队不追求真正的“模型进程常开”。LLM 调用仍然是离散的。所谓常驻，第一阶段应定义为：

- seat identity 常驻
- memory 常驻
- inbox cursor 常驻
- task state 常驻
- session handle 可恢复
- orchestrator 能按事件唤醒 seat

真正的 daemon 和持续监听可以作为后续增强，不应该阻塞第一版落地。

## 模式设计

建议新增 Republic team model：

```jsonc
{
  "republic": {
    "team_model": "parliament_squad",
    "team": {
      "seat_memory": true,
      "persistent_sessions": true,
      "max_parallel_seats": 4,
      "default_runtime_agent": "general"
    },
    "seats": {
      "planners": ["api-seat", "db-seat", "arch-seat", "test-seat"],
      "executors": ["api-seat", "db-seat", "test-seat"],
      "reviewers": ["review-seat", "security-seat"],
      "supervisors": ["republic-supervisor"]
    }
  }
}
```

| 模式 | 行为 | 适用场景 |
| --- | --- | --- |
| `single` | 传统单 Agent，不启用 Republic 编排 | 小修改、简单问答 |
| `advisory` | 当前兼容模式，记录、提醒、主动 dispatch，但不强制完整团队流程 | 希望透明可追踪但不想被流程打断 |
| `parliament` | 只在 Planning Phase 启用多 seat 议会 | 复杂设计、架构选择、方案比较 |
| `squad` | 只在 Execution Phase 启用多 workgroup 执行小队 | 明确方案下的大量编码任务 |
| `parliament_squad` | Planning 用议会制，Execution 用执行小队 | 大型项目、长期维护、团队协作 |

## 数据模型

保留现有 Git common-dir 布局，并新增 team state：

```text
.git/omo/republic/
  commons.jsonl
  ledger.jsonl
  contracts/
    <workgroup-id>.md
  agents/
    <seat-id>.md
  team/
    manifest.json
    phase.json
    task-graph.json
    conference-report.md
    seats/
      <seat-id>/
        state.json
        memory.md
        inbox-cursor.json
        session.json
        current-task.md
```

### `team/manifest.json`

记录项目团队结构：

- team model
- seat 列表
- seat 对应 runtime agent
- seat 所属 phase
- seat 所属 workgroup
- supervisor 关系
- 并发上限
- 用户配置来源

### `team/phase.json`

记录当前阶段：

```json
{
  "phase": "planning",
  "status": "in-progress",
  "deliberation_id": "order-system-20260505",
  "active_round": 1,
  "locked_contracts": [],
  "blocked_by": []
}
```

### `team/seats/<seat-id>/state.json`

记录 seat 的可恢复状态：

```json
{
  "seat_id": "api-seat",
  "role": "planner-executor",
  "runtime_agent": "general",
  "conceptual_agent": "atlas",
  "status": "waiting",
  "phase": "execution",
  "workgroup_id": "api-workgroup",
  "module": "src/api",
  "task_id": "api-orders-endpoints",
  "waiting_on": ["docs-seat"],
  "last_message_id": "msg-123",
  "session_id": "ses_...",
  "last_seen_commons_offset": 1024
}
```

### `memory.md`

每个 seat 的长期工作记忆。不是聊天全文，而是压缩后的工程记忆：

- 当前负责什么
- 已接受的 contract
- 已知 blockers
- 与其他 seat 的接口约定
- 最近决策
- 不要重复踩的坑

## 运行时架构

### 1. Republic Orchestrator

新增一个轻量编排器，第一版可以不是常驻进程，而是由以下事件触发：

- `republic_publish`
- `republic_wait`
- session idle hook
- `/republic-plan`
- `/republic-execute`
- `/republic-status`

后续可以演进为 daemon：

```text
while active:
  scan commons + team state + native-git audit
  detect blocked seats and new targeted messages
  dispatch target seats or supervisor
  update seat state and cursors
  compact seat memory
  enforce phase and contract policy
```

### 2. Seat Runtime

Seat 是稳定身份，不等同于 OpenCode runtime agent。

- `api-seat` 是 Republic 身份。
- `general`、`explore`、`hephaestus` 等是可执行 OpenCode agent。
- 当目标 OMO agent 在当前 runtime registry 不存在时，orchestrator 使用可用 runtime agent fallback，同时把 requested role 写入 prompt、ledger、state。

这样可以解决真实 App/CLI 中 agent registry 不一致的问题。

### 3. Session Handle

当 seat 被第一次调度时，记录 session id：

```text
team/seats/api-seat/session.json
```

后续如果 OpenCode 支持 resume，就复用该 session。若不支持或 session 失效，则新建 session，并通过 `memory.md`、`current-task.md`、`commons` 恢复上下文。

这就是第一阶段现实可行的“常驻”：状态常驻，session 尽量复用，失效可恢复。

## Planning Phase: 规划议会

### 目标

写代码之前，让多个同级 planner seats 独立研究、互相挑战、最后合成方案。

### 流程

1. 用户执行：

```text
/republic-plan 做一个订单系统
```

2. orchestrator 初始化 deliberation：

- 创建 team manifest
- 创建 planner seats
- 创建 phase state
- 给每个 seat 分配研究角度

3. Round 0: independent proposals

并行启动：

- `api-seat`: API shape
- `db-seat`: data model
- `test-seat`: test boundary
- `arch-seat`: architecture risk

每个 seat 输出 `proposal`，写入 Commons。

4. Round 1: cross-examination

orchestrator 要求每个 seat 至少引用一个其他 seat 的 proposal：

- 提问用 `question`
- 反对用 `objection`
- 修改用 `revision`

5. Supervisor review

supervisor 扫描：

- unresolved question
- unresolved objection
- mutually incompatible proposals
- high-risk files/modules
- missing test boundary

如果有争议，supervisor 发布 `supervisor-policy` 或直接调度相关 seats 继续协商。

6. Conference report

当 quorum 满足且 objections 解决后，synthesis seat 产出：

```text
.git/omo/republic/team/conference-report.md
```

7. Contract lock

将方案转成 workgroup contracts：

```text
.git/omo/republic/contracts/api-workgroup.md
.git/omo/republic/contracts/db-workgroup.md
.git/omo/republic/contracts/test-workgroup.md
```

阶段切到 execution。

## Execution Phase: 执行小队

### 目标

多个 seat 按 contract 并行编码，同时允许受控协商。

### 流程

1. `/republic-execute`

读取：

- conference report
- contracts
- task graph
- native-git baseline

2. task graph 拆分：

```json
{
  "tasks": [
    {
      "task_id": "api-orders-endpoints",
      "seat_id": "api-seat",
      "workgroup_id": "api-workgroup",
      "module": "src/api",
      "depends_on": ["db-order-model"]
    },
    {
      "task_id": "db-order-model",
      "seat_id": "db-seat",
      "workgroup_id": "db-workgroup",
      "module": "src/db",
      "depends_on": []
    },
    {
      "task_id": "orders-integration-tests",
      "seat_id": "test-seat",
      "workgroup_id": "test-workgroup",
      "module": "tests/orders",
      "depends_on": ["api-orders-endpoints", "db-order-model"]
    }
  ]
}
```

3. 并行启动可运行 tasks

orchestrator 按依赖关系和并发上限调度。

4. 执行中协商

如果 `api-seat` 发现 contract 不完整：

- 发布 `question` 给 `docs-seat` 或 `db-seat`
- 调用 `republic_wait`
- 收到 `answer/revision/objection`
- 必要时要求 `republic_contract` 修订

如果 `test-seat` 发现边界缺失：

- 发布 `objection`，status=`blocked`
- supervisor 自动调度 review
- supervisor 决定继续、修订合同、阻断对应 task

5. native-git audit 汇总

每个 write/edit/bash/apply_patch 后：

- `.git/omo/native-git/audit.jsonl` 记录文件变化
- `.git/omo/republic/commons.jsonl` 发布 status
- task state 更新 changed files

6. Review Phase

执行完成后自动调度：

- test reviewer
- architecture reviewer
- security reviewer 可选
- supervisor final review

输出：

```text
.git/omo/republic/team/final-report.md
```

## Supervisor 策略

Supervisor 不是普通 reviewer，而是项目治理者。触发条件包括：

- unresolved question 超时
- unresolved objection
- blocked/review-required status
- 修改触及高风险路径
- 修改跨多个 workgroup
- 实现偏离 contract
- task 长时间无进展
- 两个 seat 对同一 contract 给出冲突 revision
- Git dirty state 与 task state 不一致

Supervisor 可以发布：

- `supervisor-policy`
- `consensus`
- `revision`
- `objection`
- `handoff`
- `contract`

第一阶段 supervisor 是 advisory。后续 governed 模式可以阻断执行。

## Contract 约束力

Contract 需要从“文档”逐步变成“执行约束”。

### Advisory

- 偏离 contract 时提醒。
- 写入 Commons 和 ledger。
- 不阻断。

### Governed

- cross-workgroup 写入必须有相关 contract。
- blocked contract 不允许继续执行相关 task。
- test-seat objection 未解决时，不允许 final report。
- supervisor veto 可以暂停 task。

### Strict

后续可选：

- 每个 task 必须绑定 contract。
- 每个 contract revision 必须有 supervisor 或 quorum approval。
- 每个 task 完成必须有 native-git audit 和 reviewer note。

## 可视化面板

Dashboard 应从“记录查看器”升级为“团队态势图”。

节点：

- project
- phase
- seat
- workgroup
- task
- contract
- message
- file
- commit
- supervisor intervention

边：

- owns
- depends-on
- asked
- answered
- objected
- revised
- supervised
- changed
- blocked
- approved

第一版只读。后续支持拖拽：

- 创建 seat
- 分配 workgroup
- 连 task dependency
- 设置 supervisor
- 调整并发上限
- 生成 team manifest

## 命令草案

```text
/republic-team init
/republic-team status
/republic-team reset

/republic-plan <goal>
/republic-plan continue
/republic-plan lock

/republic-execute
/republic-execute continue
/republic-review

/republic-dashboard --serve
```

工具草案：

- `republic_publish`
- `republic_inbox`
- `republic_wait`
- `republic_contract`
- `republic_team_status`
- `republic_task_update`
- `republic_phase_transition`
- `republic_conference_report`

## 实施路线

### Phase 1: 常驻身份和状态

- 新增 `team/manifest.json`
- 新增 `team/seats/<seat>/state.json`
- 新增 `memory.md` 和 inbox cursor
- 调度时读写 seat state
- session id 可恢复时复用，不可恢复时从 memory 恢复

验收：

- 同一个 seat 多次被调度后，能看到之前 memory 和当前 task。
- Commons offset 不重复读取。
- 工作区保持 clean。

### Phase 2: Planning Parliament

- `/republic-plan`
- 并行 planner seats
- Round 0 proposal
- Round 1 cross-examination
- supervisor conflict scan
- conference report
- contract lock

验收：

- 一个复杂需求能产出多份独立 proposal。
- 至少一轮互相引用和 objection/revision。
- 最终生成 conference report 和 contracts。

### Phase 3: Execution Squad

- task graph
- workgroup assignment
- dependency-aware dispatch
- per-task state
- `republic_wait` 集成到执行 prompt
- contract advisory gate

验收：

- 三个模块任务可以并行执行。
- 有依赖的 task 等待上游。
- 发现 contract 问题时能主动问相关 seat 并等待回复。

### Phase 4: Supervisor Governance

- blocked/review-required 自动 supervisor dispatch
- contract drift 检测
- stalled task 检测
- governed mode 阻断高风险偏离

验收：

- objection 自动触发 supervisor。
- supervisor 能发布 consensus 或 contract revision。
- governed 模式能阻断未解决 blocker 的执行。

### Phase 5: 可视化团队图

- dashboard 加 team graph
- seat 状态实时刷新
- task dependency 展示
- contract/message/file/change 联动

验收：

- 能看到谁在工作、谁阻塞、谁问了谁、哪些文件被改。
- 能从图上追溯到 Commons message 和 native-git audit。

### Phase 6: 真正 daemon 化

- 常驻 `republic-scheduler`
- 监听 Commons 和 audit
- 自动唤醒 seat
- 失败重试
- 成本和并发预算

验收：

- 不依赖用户下一次输入，也能推动 question/answer/supervisor review。
- seat failure 被记录并重试或上报。

## 测试计划

### 单元测试

- team manifest parse/defaults
- seat state create/update
- inbox cursor
- session handle fallback
- phase transition
- task graph dependency resolution
- supervisor trigger rules
- contract gate

### 集成测试

- `republic_publish` targeted question dispatches seat
- `republic_wait` waits for answer
- objection dispatches supervisor
- supervisor consensus resolves objection
- contract lock changes phase
- execution task updates state and audit

### OpenCode App Smoke

使用本地插件路径：

```powershell
$env:OPENCODE_CONFIG_DIR = "D:\OMO\.opencode-test-config"
```

复杂任务建议：

1. 小型订单系统
   - API seat
   - DB seat
   - Test seat
   - Docs seat
   - Supervisor

2. 插件内部功能
   - Config seat
   - Hook seat
   - Tool seat
   - Test seat
   - Review seat

3. 前端 dashboard
   - Graph seat
   - Data seat
   - UI seat
   - UX review seat
   - Supervisor

每个 smoke 必须验证：

- Commons 有 proposal/question/answer/objection/consensus
- Ledger 有 dispatch/task/review records
- Contracts 被生成或修订
- Native-git audit 能追踪文件变化
- 工作区没有意外 dirty
- 所有 seat 的 memory/state 更新

## 风险和约束

1. **OpenCode runtime 限制**
   - App 和 CLI 暴露的 agent registry 可能不同。
   - 必须保留 runtime fallback。

2. **成本控制**
   - 常驻团队如果无限调度，会快速消耗模型调用。
   - 必须有 max parallel seats、max rounds、timeout、budget。

3. **上下文膨胀**
   - seat memory 必须压缩。
   - inbox 注入必须按相关性和 cursor 控制。

4. **循环争论**
   - objection 循环必须有 round limit。
   - 超过限制交给 supervisor 或用户。

5. **错误的强制阻断**
   - governed mode 初期只阻断明确可证明的高风险行为。
   - 默认 advisory，避免影响日常使用。

6. **Git common-dir 不是版本化提交**
   - runtime records 放在 `.git/omo` 可保持工作区 clean。
   - 如果用户要把会议纪要纳入仓库，应提供 export 命令，而不是默认污染源码仓库。

## 最小可行闭环

最小的“常驻团队”第一版不需要 daemon，也不需要复杂 UI。它只需要做到：

1. `/republic-team init` 创建 team manifest 和 seat states。
2. `republic_publish` / `republic_wait` 读写 seat state 和 memory。
3. 调度 seat 时优先复用 session handle，失败则用 memory 恢复。
4. `/republic-plan` 并行启动 planner seats，生成 proposals。
5. supervisor 合成 conference report。
6. `republic_contract` 锁定方案。
7. `/republic-execute` 按 task graph 调度 executor seats。

这一步完成后，Republic 才真正从“主动协作工具”进入“项目团队编排器”。

