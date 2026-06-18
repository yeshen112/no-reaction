# No Reaction — Codebase Guide

双人联机化学卡牌游戏。打出离子牌，避免触发化学反应；迫使反应发生的玩家判负。

## 启动

```bash
node server.js   # 默认 http://localhost:5173
```

无需 `npm install`，仅依赖 Node 内置模块。

## 文件结构

| 文件 | 职责 |
|------|------|
| `config/cards.js` | 所有卡牌定义（离子 id/symbol/name/count、道具定义、SETTINGS）。改数量只改这里。 |
| `js/reactions.js` | 反应判定表（NEUTRALIZE / PRECIPITATES / GASES）+ `checkPair(x, y)` |
| `js/engine.js` | 纯逻辑引擎，无 DOM 依赖。状态为可 JSON 序列化的纯对象。同时导出 `window.Engine` 和 `module.exports`。 |
| `js/network.js` | 联机层。SSE 接收 + fetch POST。`window.Network` 导出。 |
| `js/ui.js` | 游戏页控制器。渲染 + 交互 + 本地/联机两种模式。 |
| `js/home.js` | 首页（创建/加入房间）逻辑。 |
| `server.js` | Node HTTP 服务器：静态文件 + 房间中继 API（`/api/create|join|state|action|events|room`）。 |
| `index.html` / `game.html` | 首页 / 游戏页，直接 `<script src>` 加载各模块，无构建步骤。 |
| `css/style.css` | 所有样式。 |
| `DESIGN.md` | 完整游戏设计文档（规则、卡牌、反应表）。 |

## 核心架构

### 离子 id（内部 key）

阳离子：`Ba Ca Cu Fe Ag NH4 H Na Al`
阴离子：`SO4 CO3 OH Cl NO3 PO4 S HCO3`

### 回合流程

```
startTurn
  ├─ 手里无离子且无催化剂 → applyPenalty（额外摸2张，道具转给对手）→ phase='response'
  └─ 正常 → 摸 drawPerTurn(2) 张 → phase='play'

play 阶段
  ├─ playIon(uid)         出离子牌；playsThisTurn++；达到 requiredPlays → phase='response'
  └─ playCatalyst(uid)    替代离子出牌，标记对手 forcedIons=2 → phase='response'

response 阶段
  ├─ playItem(uid, params) 用防守/中性道具（可多次）
  └─ confirmResponse()     扫描反应区：有反应 → 判负(over)；无反应 → endTurn → 换手
```

### 关键 state 字段

| 字段 | 说明 |
|------|------|
| `phase` | `'play'` \| `'response'` \| `'over'` |
| `activePlayer` | 当前可操作的座位号（0 或 1） |
| `playsThisTurn` | 本回合已出牌次数 |
| `requiredPlays` | 本回合需出牌次数（正常=1，被催化剂标记=2） |
| `players[i].forcedIons` | 该玩家下回合须强制出的离子张数（0 或 2） |

### 联机同步策略

- **房主（host）是权威端**：持有完整 state，运行引擎，结算后 `pushState` 下发。
- **访客（guest）只发意图**：调用 `Network.pushAction`，房主收到后调用 `applyAction` 结算，再推回 state。
- 规则只在一处执行，避免双端不一致。

### 主要 Engine API

```js
Engine.createGame({ playerNames, seed })    // 初始化
Engine.playIon(state, idx, uid)             // 出离子牌（play 阶段）
Engine.playCatalyst(state, idx, uid)        // 出催化剂（play 阶段，替代离子）
Engine.playItem(state, idx, uid, params)    // 用道具（response 阶段）
Engine.confirmResponse(state, idx)          // 确认结束道具阶段 → 反应判定
Engine.viewFor(state, idx)                  // 生成只读视图（隐藏对手手牌）
Engine.findReactions(zone)                  // 扫描反应区
```

### 道具 params 约定

| 道具 id | params 字段 | 说明 |
|---------|-------------|------|
| `filter` | `{ aUid, bUid }` 可选 | 指定要移走的那对沉淀，省略则取第一对 |
| `heat` | `{ uid }` 可选 | 指定要移走的气体离子 |
| `extract` | `{ uid }` 必填 | 要取回手牌的反应区离子 |
| `neutralize` | `{ uid }` 必填 | 要移走的 H⁺ 或 OH⁻ |
| `stir` | 无 | 清空反应区 |

> 催化剂不走 playItem，走 playCatalyst。

## 测试

```bash
node test/engine.test.js   # 63 个单元用例
node test/sim.test.js      # 300 局随机模拟
```

## 已知注意点

- `_uid` 是模块级计数器，`createGame` 会重置为 0；uid 仅在内存内比较，序列化后传输无冲突。
- 惩罚检查在**摸牌之前**：若此刻手里已无离子且无催化剂才触发，额外摸 2 张不改变这个判断。
- `H⁺ + OH⁻` 中和是自动的（`autoNeutralize`），不触发判定；`NH₄⁺ + OH⁻` 是气体反应，会触发判定。
- 搅拌（stir）是中性道具，只能在 response 阶段使用（出牌阶段已不可用）。
- `Engine.viewFor` 深拷贝 state，对手手牌替换为 `{ hidden: true }`，`deck` 字段完全删除。
