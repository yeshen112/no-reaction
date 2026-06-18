/**
 * 引擎测试 —— 纯 Node 运行，无需第三方依赖。
 *   node test/engine.test.js
 *
 * 覆盖：反应判定、中和、道具效果、催化剂新流程、惩罚阶段、强制出牌、胜负。
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

// ---- 工具：手工构造一局 ----
function freshGame() {
  return Engine.createGame({ seed: 12345, playerNames: ['A', 'B'] });
}
function giveCard(state, idx, type, id) {
  const c = Engine._internal.makeCard(type, id);
  state.players[idx].hand.push(c);
  return c.uid;
}
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
section('牌堆构成与配置');
{
  const deck = Engine.buildDeck();
  let total = 0;
  for (const id in CARD_CONFIG.CATIONS) total += CARD_CONFIG.CATIONS[id].count;
  for (const id in CARD_CONFIG.ANIONS) total += CARD_CONFIG.ANIONS[id].count;
  for (const id in CARD_CONFIG.ITEMS) total += CARD_CONFIG.ITEMS[id].count;
  eq(deck.length, total, '牌堆总数与配置一致');
  ok(CARD_CONFIG.SETTINGS.drawPerTurn === 2, 'drawPerTurn=2');
}

// ---------------------------------------------------------------------------
section('初始发牌');
{
  const s = freshGame();
  eq(s.players[0].hand.length, CARD_CONFIG.SETTINGS.initialHandSize, 'A 初始手牌数');
  eq(s.players[1].hand.length, CARD_CONFIG.SETTINGS.initialHandSize, 'B 初始手牌数');
  eq(s.activePlayer, 0, 'A 先手');
  eq(s.phase, 'play', '初始为出牌阶段');
  eq(s.requiredPlays, 1, '初始 requiredPlays=1');
  eq(s.playsThisTurn, 0, '初始 playsThisTurn=0');
}

// ---------------------------------------------------------------------------
section('中和自动处理');
{
  const s = freshGame();
  s.players[0].hand = [];
  s.zone = [];
  seedZone(s, 'H');
  const uid = giveCard(s, 0, 'ion', 'OH');
  s.phase = 'play';
  s.activePlayer = 0;
  s.playsThisTurn = 0;
  s.requiredPlays = 1;
  const r = Engine.playIon(s, 0, uid);
  ok(r.ok, '打出 OH 成功');
  eq(s.zone.length, 0, 'H+OH 自动中和清空反应区');
  ok(s.discard.length >= 2, '两张牌进入弃牌区');
  eq(s.phase, 'response', '出牌后进入 response 阶段');
  // 确认结束，无反应 → 换手
  const r2 = Engine.confirmResponse(s, 0);
  ok(r2.ok, 'confirmResponse 成功');
  eq(s.activePlayer, 1, '中和后轮到 B');
}

// ---------------------------------------------------------------------------
section('出牌 → response → 过滤解除沉淀');
{
  const s = freshGame();
  s.players[0].hand = [];
  s.zone = [];
  seedZone(s, 'Ba');
  const uid = giveCard(s, 0, 'ion', 'SO4');
  s.phase = 'play';
  s.activePlayer = 0;
  s.playsThisTurn = 0;
  s.requiredPlays = 1;

  const r = Engine.playIon(s, 0, uid);
  ok(r.ok, 'Ba+SO4 打出成功');
  eq(s.phase, 'response', '进入 response 阶段');

  // 使用过滤
  const filterUid = giveCard(s, 0, 'item', 'filter');
  const fr = Engine.playItem(s, 0, filterUid, {});
  ok(fr.ok, '过滤使用成功');
  eq(s.zone.length, 0, '过滤移走沉淀对');

  // 确认结束，无反应 → 换手
  const cr = Engine.confirmResponse(s, 0);
  ok(cr.ok && !cr.lost, '确认结束：无反应');
  eq(s.activePlayer, 1, '轮到 B');
}

// ---------------------------------------------------------------------------
section('confirmResponse 有反应 → 判负');
{
  const s = freshGame();
  s.players[0].hand = [];
  s.zone = [];
  seedZone(s, 'Ba');
  const uid = giveCard(s, 0, 'ion', 'SO4');
  s.phase = 'play';
  s.activePlayer = 0;
  s.playsThisTurn = 0;
  s.requiredPlays = 1;
  Engine.playIon(s, 0, uid);
  eq(s.phase, 'response', '进入 response 阶段');

  // 不用任何道具，直接确认 → A 判负
  const cr = Engine.confirmResponse(s, 0);
  ok(cr.ok && cr.lost, '确认结束：有反应，判负');
  eq(s.loser, 0, 'A 判负');
  eq(s.winner, 1, 'B 获胜');
  eq(s.phase, 'over', '游戏结束');
}

// ---------------------------------------------------------------------------
section('气体反应 → 加热解除');
{
  const s = freshGame();
  s.players[0].hand = [];
  s.zone = [];
  seedZone(s, 'CO3');
  const uid = giveCard(s, 0, 'ion', 'H');
  s.phase = 'play';
  s.activePlayer = 0;
  s.playsThisTurn = 0;
  s.requiredPlays = 1;
  Engine.playIon(s, 0, uid);
  eq(s.phase, 'response', 'H+CO3 进入 response');

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
section('搅拌清空反应区');
{
  const s = freshGame();
  s.players[0].hand = [];
  s.zone = [];
  seedZone(s, 'Ba');
  seedZone(s, 'SO4');
  // 手工置于 response 阶段
  s.phase = 'response';
  s.activePlayer = 0;
  const stirUid = giveCard(s, 0, 'item', 'stir');
  const r = Engine.playItem(s, 0, stirUid, {});
  ok(r.ok, '搅拌成功');
  eq(s.zone.length, 0, '反应区清空');
}

// ---------------------------------------------------------------------------
section('萃取取回离子');
{
  const s = freshGame();
  s.players[0].hand = [];
  s.zone = [];
  seedZone(s, 'Ba');
  const tUid = seedZone(s, 'SO4');
  s.phase = 'response';
  s.activePlayer = 0;
  const exUid = giveCard(s, 0, 'item', 'extract');
  const r = Engine.playItem(s, 0, exUid, { uid: tUid });
  ok(r.ok, '萃取成功');
  ok(s.players[0].hand.some(c => c.id === 'SO4'), 'SO4 回到手牌');
}

// ---------------------------------------------------------------------------
section('中和道具不能处理 NH4+OH');
{
  const s = freshGame();
  s.players[0].hand = [];
  s.zone = [];
  seedZone(s, 'NH4');
  const ohUid = seedZone(s, 'OH');
  s.phase = 'response';
  s.activePlayer = 0;
  const nUid = giveCard(s, 0, 'item', 'neutralize');
  const r = Engine.playItem(s, 0, nUid, { uid: ohUid });
  ok(!r.ok, '中和拒绝处理 NH4+OH');
}

// ---------------------------------------------------------------------------
section('催化剂新流程：替代离子，标记对手 forcedIons=2');
{
  const s = freshGame();
  s.players[0].hand = [];
  s.players[1].hand = [];
  s.zone = [];
  s.phase = 'play';
  s.activePlayer = 0;
  s.playsThisTurn = 0;
  s.requiredPlays = 1;
  s.players[0].forcedIons = 0;
  s.players[1].forcedIons = 0;

  const catUid = giveCard(s, 0, 'item', 'catalyst');
  const r = Engine.playCatalyst(s, 0, catUid);
  ok(r.ok, '催化剂打出成功');
  eq(s.phase, 'response', '打出催化剂后进 response');
  eq(s.players[1].forcedIons, 2, '对手 forcedIons=2');
  eq(s.zone.length, 0, '催化剂不往反应区放牌');
}

// ---------------------------------------------------------------------------
section('催化剂：对手下回合强制出两张离子');
{
  const s = freshGame();
  s.players[0].hand = [];
  s.players[1].hand = [];
  s.zone = [];
  s.phase = 'play';
  s.activePlayer = 0;
  s.playsThisTurn = 0;
  s.requiredPlays = 1;
  s.players[1].forcedIons = 0;

  // 给 B 两张离子（确保不会触发惩罚）
  giveCard(s, 1, 'ion', 'Na');
  giveCard(s, 1, 'ion', 'Na');

  // A 打出催化剂
  const catUid = giveCard(s, 0, 'item', 'catalyst');
  Engine.playCatalyst(s, 0, catUid);
  Engine.confirmResponse(s, 0); // 无反应，轮到 B

  // 现在是 B 的回合，requiredPlays 应为 2
  eq(s.activePlayer, 1, '轮到 B');
  eq(s.requiredPlays, 2, 'B 的 requiredPlays=2');
  eq(s.players[1].forcedIons, 0, 'forcedIons 已消耗');

  // B 出第一张离子
  const ion1 = s.players[1].hand.find(c => c.type === 'ion').uid;
  const r1 = Engine.playIon(s, 1, ion1);
  ok(r1.ok, 'B 出第一张离子');
  eq(s.phase, 'play', '还需第二张，仍在 play 阶段');
  eq(s.playsThisTurn, 1, 'playsThisTurn=1');

  // B 出第二张离子
  const ion2 = s.players[1].hand.find(c => c.type === 'ion').uid;
  const r2 = Engine.playIon(s, 1, ion2);
  ok(r2.ok, 'B 出第二张离子');
  eq(s.phase, 'response', '两张出完，进入 response');
}

// ---------------------------------------------------------------------------
section('惩罚阶段：无离子无催化剂 → 额外摸牌并转移道具');
{
  const s = freshGame();
  // 清空 A 手牌，只给道具
  s.players[0].hand = [];
  s.players[1].hand = [];
  const itemUid = giveCard(s, 0, 'item', 'stir');
  giveCard(s, 0, 'item', 'filter');
  const oppHandBefore = s.players[1].hand.length;
  const deckBefore = s.deck.length;

  // 触发惩罚（通过 startTurn 自动）
  Engine.startTurn(s, 0, false);
  eq(s.phase, 'response', '惩罚后直接进入 response');
  // A 手里的道具都转给 B
  ok(!s.players[0].hand.some(c => c.type === 'item'), 'A 手里无道具');
  ok(s.players[1].hand.some(c => c.id === 'stir'), 'stir 转给 B');
}

// ---------------------------------------------------------------------------
section('催化剂不可在被强制出牌时使用');
{
  const s = freshGame();
  s.players[0].hand = [];
  s.players[1].hand = [];
  s.phase = 'play';
  s.activePlayer = 1;
  s.playsThisTurn = 0;
  s.requiredPlays = 2; // 被催化剂标记
  s.players[1].forcedIons = 0;

  const catUid = giveCard(s, 1, 'item', 'catalyst');
  const r = Engine.playCatalyst(s, 1, catUid);
  ok(!r.ok, '被强制时不可用催化剂');
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
  ok(typeof v.playsThisTurn === 'number', 'playsThisTurn 可见');
  ok(typeof v.requiredPlays === 'number', 'requiredPlays 可见');
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
