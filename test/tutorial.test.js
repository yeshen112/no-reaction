/**
 * 新手教程冒烟测试 —— 纯 Node 运行，无需 DOM、无需第三方依赖。
 *   node test/tutorial.test.js
 *
 * 目的：把教程的每一步 setup 摆出的棋面，连同“用户应做的操作”与“对手自动行动”，
 * 全部丢给真实引擎执行，确认：
 *   1. 每一步 setup 产生的局面合法、且声明的 expected 动作能被引擎接受；
 *   2. 关键剧情节点（引发沉淀 / 过滤解除 / 胜利判定）确实如脚本描述发生；
 *   3. 新增 / 改动步骤时若与引擎规则脱节，测试立即报红。
 *
 * 这样后续往教程里加道具步骤，只要照样填 expected / expectedItemId，
 * 这个测试就能守住“教程动作必须是引擎合法动作”这条底线。
 */
const Engine = require('../js/engine.js');
const CARD_CONFIG = require('../config/cards.js');
// tutorial.js 在 Node 下导出 module.exports（含 _test 钩子）
const Tutorial = require('../js/tutorial.js');

let passed = 0, failed = 0;
const fails = [];
function ok(cond, name) {
  if (cond) { passed++; }
  else { failed++; fails.push(name); console.error('  ✗ ' + name); }
}
function section(t) { console.log('\n=== ' + t + ' ==='); }

const T = Tutorial._test;
const steps = T.steps;

// 取某 seat 手牌中第一张指定 type/id 的卡（模拟“用户点了那张牌”）
function findInHand(state, seat, type, id) {
  return (state.players[seat].hand || []).find(function (c) {
    return c.type === type && (id == null || c.id === id);
  });
}

// 模拟“用户在交互步骤里做出 expected 动作”
function performExpected(state, step) {
  switch (step.expected) {
    case 'playIon': {
      var ion = findInHand(state, 0, 'ion', null);
      return Engine.playIon(state, 0, ion && ion.uid);
    }
    case 'playItem': {
      var it = findInHand(state, 0, 'item', step.expectedItemId);
      return Engine.playItem(state, 0, it && it.uid, {});
    }
    case 'playCatalyst': {
      var cat = findInHand(state, 0, 'item', 'catalyst');
      return Engine.playCatalyst(state, 0, cat && cat.uid);
    }
    case 'playAttackItem': {
      var atk = findInHand(state, 0, 'item', step.expectedItemId);
      return Engine.playAttackItem(state, 0, atk && atk.uid);
    }
    case 'confirmResponse':
      return Engine.confirmResponse(state, 0);
    default:
      return { ok: false, msg: '未知 expected: ' + step.expected };
  }
}

// ---------------------------------------------------------------------------
section('教程步骤完整性');
{
  ok(Array.isArray(steps) && steps.length >= 10, '步骤数组存在且不为空');
  // 每个 expected 非空的步骤都应能在引擎里找到对应动作类型
  var validExpected = { playIon: 1, playItem: 1, playCatalyst: 1, playAttackItem: 1, confirmResponse: 1 };
  steps.forEach(function (s) {
    if (s.expected != null) ok(!!validExpected[s.expected], `步骤 ${s.id} 的 expected「${s.expected}」是合法引擎动作`);
    if (s.expectedItemId) ok(!!CARD_CONFIG.ITEMS[s.expectedItemId], `步骤 ${s.id} 的 expectedItemId「${s.expectedItemId}」存在于卡牌配置`);
  });
}

// ---------------------------------------------------------------------------
section('逐步驱动整条教程流程');
{
  // 用一局真实 createGame 作为脚手架；每步先跑该步 setup，再施加动作。
  var state = Engine.createGame({ seed: 999, playerNames: ['你', '教程助手'] });

  function step(id) { return steps.find(function (s) { return s.id === id; }); }
  function run(i) { T.runSetup(state, i); return steps[i]; }

  // 步骤 0：欢迎 —— 反应区应预置 SO4，玩家手里有 Ba
  var idxWelcome = steps.findIndex(function (s) { return s.id === 'welcome'; });
  run(idxWelcome);
  ok(state.zone.some(function (c) { return c.id === 'SO4'; }), 'welcome：反应区预置了 SO₄²⁻');
  ok(findInHand(state, 0, 'ion', 'Ba'), 'welcome：手里有 Ba²⁺');

  // 步骤 1：玩家打出 Ba²⁺ → 应与 SO4 形成沉淀
  var idxPlay = steps.findIndex(function (s) { return s.id === 'play-ion'; });
  run(idxPlay);
  var r1 = performExpected(state, step('play-ion'));
  ok(r1.ok, 'play-ion：打出 Ba²⁺ 被引擎接受');
  var reacts = Engine.findReactions(state.zone);
  ok(reacts.length > 0 && reacts[0].type === 'precipitate', 'play-ion：Ba²⁺ + SO₄²⁻ 形成沉淀反应');
  ok(state.phase === 'response', 'play-ion：进入道具阶段');

  // 步骤 3：用过滤解除沉淀（步骤 2 仅叙事，setup 连贯承接）
  var idxFilter = steps.findIndex(function (s) { return s.id === 'use-filter'; });
  run(idxFilter);
  var r3 = performExpected(state, step('use-filter'));
  ok(r3.ok, 'use-filter：过滤被引擎接受');
  ok(Engine.findReactions(state.zone).length === 0, 'use-filter：沉淀已被解除，反应区安全');

  // 步骤 4：确认结束 → 回合切给对手
  var idxConfirm = steps.findIndex(function (s) { return s.id === 'confirm-response'; });
  run(idxConfirm);
  var r4 = performExpected(state, step('confirm-response'));
  ok(r4.ok && state.winner == null, 'confirm-response：安全确认，未判负');

  // 步骤 5：对手回合自动行动（playIon + confirmResponse）
  var idxOpp = steps.findIndex(function (s) { return s.id === 'opponent-turn'; });
  run(idxOpp);
  ok(state.activePlayer === 1, 'opponent-turn：轮到对手');
  T.applyAuto(state, { type: 'playIon', pick: 'ion', seat: 1 });
  var r5 = T.applyAuto(state, { type: 'confirmResponse', seat: 1 });
  ok(state.winner == null, 'opponent-turn：对手安全出牌，无人判负');

  // 步骤 6：催化剂 → 对手 forcedIons = 2
  var idxCat = steps.findIndex(function (s) { return s.id === 'play-catalyst'; });
  run(idxCat);
  var r6 = performExpected(state, step('play-catalyst'));
  ok(r6.ok, 'play-catalyst：催化剂被引擎接受');
  ok(state.players[1].forcedIons === 2, 'play-catalyst：对手被标记下回合须出 2 张离子');

  // 步骤 7：挥发 → 对手随机弃 2 张
  var idxVol = steps.findIndex(function (s) { return s.id === 'play-volatilize'; });
  run(idxVol);
  var oppBefore = state.players[1].hand.length;
  var r7 = performExpected(state, step('play-volatilize'));
  ok(r7.ok, 'play-volatilize：挥发被引擎接受');
  ok(state.players[1].hand.length <= oppBefore, 'play-volatilize：对手手牌未增加（被弃置）');

  // 步骤 8：对手惩罚（只有道具、无离子 → startTurn 触发惩罚）
  var idxPen = steps.findIndex(function (s) { return s.id === 'opponent-penalty'; });
  run(idxPen);
  ok(!state.players[1].hand.some(function (c) { return c.type === 'ion'; }), 'opponent-penalty：对手手里无离子（惩罚前提成立）');
  T.applyAuto(state, { type: '_startTurn', seat: 1 });
  ok(state.phase === 'response', 'opponent-penalty：startTurn 触发惩罚进入 response');
  T.applyAuto(state, { type: 'confirmResponse', seat: 1 });

  // 步骤 9：胜利 —— 反应区有 Ba，对手被迫出 SO4 → 判负，winner = 玩家(0)
  var idxWin = steps.findIndex(function (s) { return s.id === 'win'; });
  run(idxWin);
  ok(state.zone.some(function (c) { return c.id === 'Ba'; }), 'win：反应区已有 Ba²⁺');
  T.applyAuto(state, { type: 'playIon', pick: 'ion', seat: 1 });
  ok(Engine.findReactions(state.zone).length > 0, 'win：对手出 SO₄²⁻ 形成无法解除的沉淀');
  T.applyAuto(state, { type: 'confirmResponse', seat: 1 });
  ok(state.winner === 0, 'win：判负结算正确，玩家获胜');
  ok(state.phase === 'over', 'win：游戏进入结束态');
}

// ---------------------------------------------------------------------------
console.log(`\n通过 ${passed} / ${passed + failed}`);
if (failed > 0) {
  console.error('\n失败用例：\n  - ' + fails.join('\n  - '));
  process.exit(1);
} else {
  console.log('教程冒烟测试全部通过 ✓');
}
