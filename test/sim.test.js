/**
 * 全局随机对局模拟 —— 跑大量随机合法动作，确保引擎在长对局中不抛异常、
 * 状态始终自洽（牌总数守恒、必有胜负或正常推进）。
 *   node test/sim.test.js
 */
const Engine = require('../js/engine.js');
const CARD_CONFIG = require('../config/cards.js');

// 牌堆总数（用于守恒校验）
let TOTAL = 0;
for (const id in CARD_CONFIG.CATIONS) TOTAL += CARD_CONFIG.CATIONS[id].count;
for (const id in CARD_CONFIG.ANIONS) TOTAL += CARD_CONFIG.ANIONS[id].count;
for (const id in CARD_CONFIG.ITEMS) TOTAL += CARD_CONFIG.ITEMS[id].count;

function countCards(s) {
  let n = s.deck.length + s.discard.length + s.zone.length;
  for (const p of s.players) n += p.hand.length;
  return n;
}

function rand(rng, n) { return Math.floor(rng() * n); }
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 给定 state，挑一个当前阶段下的合法随机动作并执行
function step(s, rng) {
  const seat = s.activePlayer;
  const hand = s.players[seat].hand;

  if (s.phase === 'play') {
    // 优先随机：出离子 / 用搅拌 / 用催化剂（若无反应）
    const ions = hand.filter(c => c.type === 'ion');
    const choices = [];
    ions.forEach(c => choices.push({ type: 'playIon', uid: c.uid }));
    hand.filter(c => c.id === 'stir').forEach(c => choices.push({ type: 'playItem', uid: c.uid }));
    if (Engine.findReactions(s.zone).length === 0) {
      hand.filter(c => c.id === 'catalyst').forEach(c => choices.push({ type: 'playItem', uid: c.uid }));
    }
    if (choices.length === 0) {
      // 无离子可出且无可用道具：模拟跳过（直接结束回合给对手）
      // 引擎没有显式 pass，这里用搅拌/催化剂都没有时，强行结束：打出任意手牌不可行
      // 兜底：把回合让出（通过出一张不存在的牌不行）——用 concede 不适用 play 阶段
      // 真实游戏中规则要求必须出离子；若手里全是防守道具属于死局，直接判该玩家负以推进模拟
      return { dead: true, seat };
    }
    const ch = choices[rand(rng, choices.length)];
    if (ch.type === 'playIon') return Engine.playIon(s, seat, ch.uid);
    return Engine.playItem(s, seat, ch.uid, {});
  }

  if (s.phase === 'catalyst') {
    const ions = hand.filter(c => c.type === 'ion');
    if (ions.length === 0) return { ok: false }; // 引擎应已自动跳过
    const c = ions[rand(rng, ions.length)];
    return Engine.playCatalystIon(s, seat, c.uid);
  }

  if (s.phase === 'item') {
    const resolver = s.pending ? s.pending.resolver : seat;
    const rhand = s.players[resolver].hand;
    const reacts = Engine.findReactions(s.zone);
    const isGas = reacts.some(r => r.type === 'gas');
    const isPpt = reacts.some(r => r.type === 'precipitate');

    // 收集可能解除反应的道具动作
    const tries = [];
    rhand.forEach(c => {
      if (c.type !== 'item') return;
      if (c.id === 'filter' && isPpt) tries.push({ uid: c.uid, params: {} });
      if (c.id === 'heat' && isGas) tries.push({ uid: c.uid, params: {} });
      if (c.id === 'stir') tries.push({ uid: c.uid, params: {} });
      if (c.id === 'extract') {
        const t = reacts[0];
        tries.push({ uid: c.uid, params: { uid: t.aUid } });
      }
      if (c.id === 'neutralize') {
        // 找一个 H/OH 目标
        const tgt = s.zone.find(z => (z.id === 'H' || z.id === 'OH'));
        if (tgt) tries.push({ uid: c.uid, params: { uid: tgt.uid } });
      }
    });
    if (tries.length > 0) {
      const t = tries[rand(rng, tries.length)];
      const r = Engine.playItem(s, resolver, t.uid, t.params);
      if (r.ok) return r;
    }
    // 无法解除 → 认输
    return Engine.concede(s, resolver);
  }

  return { ok: false, over: s.winner != null };
}

let passed = 0, failed = 0;
const fails = [];
function ok(cond, name) { if (cond) passed++; else { failed++; fails.push(name); console.error('  ✗ ' + name); } }

console.log('=== 随机对局模拟 ===');
const GAMES = 300;
let finished = 0, maxTurns = 0, deadlocks = 0;

for (let g = 0; g < GAMES; g++) {
  const rng = mulberry32(1000 + g);
  const s = Engine.createGame({ seed: 2000 + g, playerNames: ['A', 'B'] });
  let safety = 0;
  let conserved = true;

  while (s.winner == null && safety < 2000) {
    safety++;
    if (countCards(s) !== TOTAL) { conserved = false; break; }
    const r = step(s, rng);
    if (r && r.dead) {
      // 死局（手里全防守道具，无离子可出）：判该玩家负以推进
      // 这是模拟器的处理，不是引擎行为
      deadlocks++;
      s.winner = (r.seat + 1) % 2;
      s.loser = r.seat;
      break;
    }
  }

  ok(conserved, `第 ${g} 局牌数守恒`);
  if (s.winner != null) finished++;
  maxTurns = Math.max(maxTurns, safety);
  if (safety >= 2000) { failed++; fails.push(`第 ${g} 局未能在 2000 步内结束`); }
}

console.log(`完成对局 ${finished} / ${GAMES}`);
console.log(`其中死局(手牌全防守道具) ${deadlocks} 局，由模拟器强制判负`);
console.log(`单局最大步数 ${maxTurns}`);

console.log(`\n${'='.repeat(40)}`);
console.log(`通过 ${passed} / ${passed + failed}`);
if (failed > 0) {
  console.log('失败用例:');
  fails.slice(0, 10).forEach(f => console.log('  - ' + f));
  process.exit(1);
} else {
  console.log('全部通过 ✓');
  process.exit(0);
}
