/**
 * 引擎测试 —— 纯 Node 运行，无需第三方依赖。
 *   node test/engine.test.js
 *
 * 用极简断言框架，覆盖：反应判定、中和、道具效果、催化剂、胜负。
 */
const Engine = require('../js/engine.js');
const REACTIONS = require('../js/reactions.js');
const CARD_CONFIG = require('../config/cards.js');

let passed = 0, failed = 0;
const fails = [];
function ok(cond, name) {
  if (cond) { passed++; }
  else { failed++; fails.push(name); console.error('  ✗ ' + name); }
}
function eq(a, b, name) { ok(a === b, `${name} (期望 ${b}, 实际 ${a})`); }
function section(t) { console.log('\n=== ' + t + ' ==='); }

// ---- 工具：手工构造一局，直接操纵 zone/hand 便于定向测试 ----
function freshGame() {
  return Engine.createGame({ seed: 12345, playerNames: ['A', 'B'] });
}
// 在指定玩家手里塞一张牌，返回 uid
function giveCard(state, idx, type, id) {
  const c = Engine._internal.makeCard(type, id);
  state.players[idx].hand.push(c);
  return c.uid;
}
// 直接往反应区放离子
function seedZone(state, id) {
  const c = Engine._internal.makeCard('ion', id);
  state.zone.push(c);
  return c.uid;
}

// ---------------------------------------------------------------------------
section('反应判定表 checkPair');
{
  eq(REACTIONS.checkPair('Ba', 'SO4').type, 'precipitate', 'Ba+SO4 沉淀');
  eq(REACTIONS.checkPair('SO4', 'Ba').type, 'precipitate', 'SO4+Ba 无序');
  eq(REACTIONS.checkPair('H', 'OH').type, 'neutralize', 'H+OH 中和');
  eq(REACTIONS.checkPair('H', 'CO3').type, 'gas', 'H+CO3 气体');
  eq(REACTIONS.checkPair('NH4', 'OH').type, 'gas', 'NH4+OH 气体');
  eq(REACTIONS.checkPair('Na', 'Cl'), null, 'Na+Cl 无反应');
  eq(REACTIONS.checkPair('Na', 'NO3'), null, 'Na+NO3 无反应');
}

// ---------------------------------------------------------------------------
section('牌堆构成');
{
  const deck = Engine.buildDeck();
  let total = 0;
  for (const id in CARD_CONFIG.CATIONS) total += CARD_CONFIG.CATIONS[id].count;
  for (const id in CARD_CONFIG.ANIONS) total += CARD_CONFIG.ANIONS[id].count;
  for (const id in CARD_CONFIG.ITEMS) total += CARD_CONFIG.ITEMS[id].count;
  eq(deck.length, total, '牌堆总数与配置一致');
}

// ---------------------------------------------------------------------------
section('初始发牌');
{
  const s = freshGame();
  // 先手首回合不额外摸牌（抵消先手优势），双方初始均为 7 张
  eq(s.players[0].hand.length, CARD_CONFIG.SETTINGS.initialHandSize, 'A 先手首回合不摸牌，手牌数');
  eq(s.players[1].hand.length, CARD_CONFIG.SETTINGS.initialHandSize, 'B 初始手牌数');
  eq(s.activePlayer, 0, 'A 先手');
  eq(s.phase, 'play', '初始为出牌阶段');
}

// ---------------------------------------------------------------------------
section('中和自动处理');
{
  const s = freshGame();
  seedZone(s, 'H');
  const uid = giveCard(s, 0, 'ion', 'OH');
  const r = Engine.playIon(s, 0, uid);
  ok(r.ok, '打出 OH 成功');
  eq(s.zone.length, 0, 'H+OH 自动中和清空反应区');
  ok(s.discard.length >= 2, '两张牌进入弃牌区');
  eq(s.activePlayer, 1, '中和后正常结束回合轮到 B');
}

// ---------------------------------------------------------------------------
section('沉淀反应 → 道具阶段 → 过滤解除');
{
  const s = freshGame();
  seedZone(s, 'Ba');
  const uid = giveCard(s, 0, 'ion', 'SO4');
  const r = Engine.playIon(s, 0, uid);
  ok(r.ok && r.reaction, 'Ba+SO4 触发沉淀反应');
  eq(s.phase, 'item', '进入道具阶段');
  eq(s.pending.resolver, 0, 'A 处理反应');

  const filterUid = giveCard(s, 0, 'item', 'filter');
  const fr = Engine.playItem(s, 0, filterUid, {});
  ok(fr.ok, '过滤使用成功');
  eq(s.zone.length, 0, '过滤移走一对沉淀离子');
  eq(s.activePlayer, 1, '解除后轮到 B');
}

// ---------------------------------------------------------------------------
section('气体反应 → 加热解除');
{
  const s = freshGame();
  seedZone(s, 'CO3');
  const uid = giveCard(s, 0, 'ion', 'H');
  Engine.playIon(s, 0, uid);
  eq(s.phase, 'item', 'H+CO3 进入道具阶段');
  // 过滤不能解气体
  const filterUid = giveCard(s, 0, 'item', 'filter');
  const bad = Engine.playItem(s, 0, filterUid, {});
  ok(!bad.ok, '过滤无法处理气体反应');
  const heatUid = giveCard(s, 0, 'item', 'heat');
  const hr = Engine.playItem(s, 0, heatUid, {});
  ok(hr.ok, '加热使用成功');
  ok(s.zone.length < 2, '加热移走一个气体离子');
}

// ---------------------------------------------------------------------------
section('道具用尽判负');
{
  const s = freshGame();
  seedZone(s, 'Ag');
  const uid = giveCard(s, 0, 'ion', 'Cl');
  Engine.playIon(s, 0, uid);
  eq(s.phase, 'item', 'Ag+Cl 进入道具阶段');
  const r = Engine.concede(s, 0);
  ok(r.ok, 'A 认输该反应');
  eq(s.loser, 0, 'A 判负');
  eq(s.winner, 1, 'B 获胜');
  eq(s.phase, 'over', '游戏结束');
}

// ---------------------------------------------------------------------------
section('搅拌清空反应区');
{
  const s = freshGame();
  seedZone(s, 'Ba');
  seedZone(s, 'Na');
  const stirUid = giveCard(s, 0, 'item', 'stir');
  const r = Engine.playItem(s, 0, stirUid, {});
  ok(r.ok, '搅拌成功');
  eq(s.zone.length, 0, '反应区清空');
}

// ---------------------------------------------------------------------------
section('萃取取回离子');
{
  const s = freshGame();
  seedZone(s, 'Ba');
  const tUid = seedZone(s, 'SO4');
  const uid = giveCard(s, 0, 'ion', 'Cl'); // 占位先触发？改为直接道具阶段模拟
  // 手工进入道具阶段
  s.phase = 'item';
  s.activePlayer = 0;
  s.pending = { resolver: 0, triggerUid: tUid, reaction: {} };
  const handBefore = s.players[0].hand.length;
  const exUid = giveCard(s, 0, 'item', 'extract');
  const r = Engine.playItem(s, 0, exUid, { uid: tUid });
  ok(r.ok, '萃取成功');
  ok(s.players[0].hand.some(c => c.id === 'SO4'), 'SO4 回到手牌');
}

// ---------------------------------------------------------------------------
section('中和道具不能处理 NH4+OH');
{
  const s = freshGame();
  seedZone(s, 'NH4');
  const ohUid = seedZone(s, 'OH');
  s.phase = 'item';
  s.activePlayer = 0;
  s.pending = { resolver: 0, triggerUid: ohUid, reaction: {} };
  const nUid = giveCard(s, 0, 'item', 'neutralize');
  const r = Engine.playItem(s, 0, nUid, { uid: ohUid });
  ok(!r.ok, '中和拒绝处理 NH4+OH');
}

// ---------------------------------------------------------------------------
section('催化剂流程');
{
  const s = freshGame();
  // 清掉双方手牌，定向放置
  s.players[0].hand = [];
  s.players[1].hand = [];
  s.zone = [];
  const catUid = giveCard(s, 0, 'item', 'catalyst');
  const aIon = giveCard(s, 0, 'ion', 'Ba');
  const bIon = giveCard(s, 1, 'ion', 'SO4');
  const r = Engine.playItem(s, 0, catUid, {});
  ok(r.ok, '催化剂打出');
  eq(s.phase, 'catalyst', '进入催化剂阶段');
  eq(s.activePlayer, 0, '使用者先出');
  const r1 = Engine.playCatalystIon(s, 0, aIon);
  ok(r1.ok, 'A 出 Ba');
  eq(s.activePlayer, 1, '轮到 B 出');
  const r2 = Engine.playCatalystIon(s, 1, bIon);
  ok(r2.ok, 'B 出 SO4');
  eq(s.phase, 'item', '催化剂判定触发沉淀，进入道具阶段');
  eq(s.pending.resolver, 0, '由催化剂使用者处理反应');
}

// ---------------------------------------------------------------------------
section('催化剂：对手无离子牌则跳过');
{
  const s = freshGame();
  s.players[0].hand = [];
  s.players[1].hand = [];
  s.zone = [];
  const catUid = giveCard(s, 0, 'item', 'catalyst');
  const aIon = giveCard(s, 0, 'ion', 'Na'); // 不反应
  // B 无离子牌
  Engine.playItem(s, 0, catUid, {});
  Engine.playCatalystIon(s, 0, aIon);
  // B 无离子，自动跳过并结算；Na 不反应 → 结束回合
  eq(s.phase, 'play', '无反应，回合结束回到出牌阶段');
  eq(s.activePlayer, 1, '轮到 B');
}

// ---------------------------------------------------------------------------
section('viewFor 隐藏对手手牌');
{
  const s = freshGame();
  const v = Engine.viewFor(s, 0);
  ok(v.players[1].hand.every(c => c.hidden), '对手手牌被隐藏');
  ok(typeof v.players[1].handCount === 'number', '保留对手手牌数');
  ok(v.deck === undefined, '牌堆内容不可见');
  ok(typeof v.deckCount === 'number', '牌堆数量可见');
}

// ---------------------------------------------------------------------------
console.log(`\n${'='.repeat(40)}`);
console.log(`通过 ${passed} / ${passed + failed}`);
if (failed > 0) {
  console.log('失败用例:');
  fails.forEach(f => console.log('  - ' + f));
  process.exit(1);
} else {
  console.log('全部通过 ✓');
  process.exit(0);
}
