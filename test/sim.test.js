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
    const required = s.requiredPlays || 1;
    const ions = hand.filter(c => c.type === 'ion');
    const choices = [];
    ions.forEach(c => choices.push({ type: 'playIon', uid: c.uid }));
    // 催化剂只能在正常出牌轮（requiredPlays=1）使用
    if (required === 1) {
      hand.filter(c => c.id === 'catalyst').forEach(c => choices.push({ type: 'playCatalyst', uid: c.uid }));
    }
    if (choices.length === 0) {
      // 理论上不应到达这里（惩罚已在 startTurn 自动处理）
      return { ok: false, stuck: true };
    }
    const ch = choices[rand(rng, choices.length)];
    if (ch.type === 'playIon') return Engine.playIon(s, seat, ch.uid);
    return Engine.playCatalyst(s, seat, ch.uid);
  }

  if (s.phase === 'response') {
    const reacts = Engine.findReactions(s.zone);
    const isGas = reacts.some(r => r.type === 'gas');
    const isPpt = reacts.some(r => r.type === 'precipitate');

    // 50% 概率尝试用道具（若有），否则直接确认结束
    if (rng() < 0.5) {
      const tries = [];
      hand.forEach(c => {
        if (c.type !== 'item') return;
        if (c.id === 'catalyst') return; // 催化剂不能在 response 用
        if (c.id === 'filter' && isPpt) tries.push({ uid: c.uid, params: {} });
        if (c.id === 'heat' && isGas) tries.push({ uid: c.uid, params: {} });
        if (c.id === 'stir') tries.push({ uid: c.uid, params: {} });
        if (c.id === 'extract' && reacts.length > 0) {
          tries.push({ uid: c.uid, params: { uid: reacts[0].aUid } });
        }
        if (c.id === 'neutralize') {
          const tgt = s.zone.find(z => z.id === 'H' || z.id === 'OH');
          if (tgt) tries.push({ uid: c.uid, params: { uid: tgt.uid } });
        }
      });
      if (tries.length > 0) {
        const t = tries[rand(rng, tries.length)];
        const r = Engine.playItem(s, seat, t.uid, t.params);
        if (r.ok) return r;
      }
    }
    // 确认结束（可能触发判负）
    return Engine.confirmResponse(s, seat);
  }

  return { ok: false, over: s.winner != null };
}

let passed = 0, failed = 0;
const fails = [];
function ok(cond, name) { if (cond) passed++; else { failed++; fails.push(name); console.error('  ✗ ' + name); } }

console.log('=== 随机对局模拟 ===');
const GAMES = 300;
let finished = 0, maxTurns = 0;

for (let g = 0; g < GAMES; g++) {
  const rng = mulberry32(1000 + g);
  const s = Engine.createGame({ seed: 2000 + g, playerNames: ['A', 'B'] });
  let safety = 0;
  let conserved = true;

  while (s.winner == null && safety < 3000) {
    safety++;
    if (countCards(s) !== TOTAL) { conserved = false; break; }
    const r = step(s, rng);
    if (r && r.stuck) {
      // 理论上引擎已处理惩罚，stuck 不该出现
      failed++;
      fails.push(`第 ${g} 局 step 卡死（seat=${s.activePlayer}, phase=${s.phase}）`);
      break;
    }
  }

  ok(conserved, `第 ${g} 局牌数守恒`);
  if (s.winner != null) finished++;
  maxTurns = Math.max(maxTurns, safety);
  if (safety >= 3000) { failed++; fails.push(`第 ${g} 局未能在 3000 步内结束`); }
}

console.log(`完成对局 ${finished} / ${GAMES}`);
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
