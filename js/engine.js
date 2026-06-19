/**
 * 核心游戏引擎 —— 纯逻辑，不依赖 DOM。
 * 状态为纯数据（可 JSON 序列化），所有操作就地更新 state 并返回 { ok, msg }，
 * 便于通过网络整份同步状态。
 *
 * 回合流程：
 *   摸牌（drawPerTurn 张）
 *   → 出牌阶段（play）：出 1 张离子 or 催化剂；被催化剂标记时须出 2 张离子；
 *                        无离子无催化剂 → 惩罚阶段（自动）
 *   → 道具阶段（response）：任意张防守/中性道具，点「确认结束」
 *   → 反应判定（自动）：有反应 → 判负；无反应 → 换手
 *
 * 同时支持浏览器 (window.Engine) 与 Node (module.exports)。
 */
(function (root, factory) {
  const REACTIONS = (typeof require !== 'undefined') ? require('./reactions.js') : root.REACTIONS;
  const CARD_CONFIG = (typeof require !== 'undefined') ? require('../config/cards.js') : root.CARD_CONFIG;
  const Engine = factory(REACTIONS, CARD_CONFIG);
  if (typeof module !== 'undefined' && module.exports) module.exports = Engine;
  if (typeof root !== 'undefined') root.Engine = Engine;
})(typeof window !== 'undefined' ? window : globalThis, function (REACTIONS, CARD_CONFIG) {
  'use strict';

  const { CATIONS, ANIONS, ITEMS, SETTINGS } = CARD_CONFIG;

  // ---- 随机数（可注入种子，便于测试复现）----
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function shuffle(arr, rng) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  // ---- 卡牌与离子辅助 ----
  let _uid = 0;
  function makeCard(type, id) { return { uid: ++_uid, type, id }; }
  function ionKind(id) { return CATIONS[id] ? 'cation' : (ANIONS[id] ? 'anion' : null); }
  function ionSymbol(id) { return (CATIONS[id] || ANIONS[id] || {}).symbol || id; }
  function cardLabel(c) {
    if (!c) return '?';
    return c.type === 'ion' ? ionSymbol(c.id) : (ITEMS[c.id] ? ITEMS[c.id].name : c.id);
  }

  // ---- 建立牌堆 ----
  function buildDeck() {
    const cards = [];
    for (const id in CATIONS) for (let i = 0; i < CATIONS[id].count; i++) cards.push(makeCard('ion', id));
    for (const id in ANIONS)  for (let i = 0; i < ANIONS[id].count;  i++) cards.push(makeCard('ion', id));
    for (const id in ITEMS)   for (let i = 0; i < ITEMS[id].count;   i++) cards.push(makeCard('item', id));
    return cards;
  }

  function opponentOf(state, idx) { return (idx + 1) % state.players.length; }
  function isIon(card) { return card && card.type === 'ion'; }
  function handHasIon(state, idx) { return state.players[idx].hand.some(isIon); }
  function handHasCatalyst(state, idx) {
    return state.players[idx].hand.some(c => c.type === 'item' && c.id === 'catalyst');
  }
  function handHasAttackItem(state, idx) {
    return state.players[idx].hand.some(c => c.type === 'item' && ITEMS[c.id] && ITEMS[c.id].kind === 'attack');
  }

  function log(state, msg) { state.log.push(msg); if (state.log.length > 200) state.log.shift(); }

  // ---- 反应扫描 ----
  function findReactions(zone) {
    const out = [];
    for (let i = 0; i < zone.length; i++) {
      for (let j = i + 1; j < zone.length; j++) {
        const r = REACTIONS.checkPair(zone[i].id, zone[j].id);
        if (r && (r.type === 'precipitate' || r.type === 'gas')) {
          out.push(Object.assign({ aUid: zone[i].uid, bUid: zone[j].uid }, r));
        }
      }
    }
    return out;
  }

  // 自动处理 H⁺ + OH⁻ 中和：成对移入弃牌区。
  function autoNeutralize(state) {
    let removed = 0, again = true;
    while (again) {
      again = false;
      const zone = state.zone;
      outer:
      for (let i = 0; i < zone.length; i++) {
        for (let j = i + 1; j < zone.length; j++) {
          const r = REACTIONS.checkPair(zone[i].id, zone[j].id);
          if (r && r.type === 'neutralize') {
            const a = zone[i], b = zone[j];
            state.discard.push(a, b);
            state.zone = zone.filter(c => c.uid !== a.uid && c.uid !== b.uid);
            log(state, `中和反应：${ionSymbol(a.id)} + ${ionSymbol(b.id)} 自动移入弃牌区`);
            removed++; again = true;
            break outer;
          }
        }
      }
    }
    return removed;
  }

  // ---- 反应区辅助 ----
  function zoneFind(state, uid) { return state.zone.find(c => c.uid === uid); }
  function moveZoneToDiscard(state, uid) {
    const c = zoneFind(state, uid);
    if (!c) return null;
    state.zone = state.zone.filter(x => x.uid !== uid);
    state.discard.push(c);
    return c;
  }
  function reactionsInvolving(state, uid) {
    const me = zoneFind(state, uid);
    if (!me) return [];
    const out = [];
    for (const other of state.zone) {
      if (other.uid === uid) continue;
      const r = REACTIONS.checkPair(me.id, other.id);
      if (r && (r.type === 'precipitate' || r.type === 'gas')) {
        out.push(Object.assign({ otherUid: other.uid, otherId: other.id }, r));
      }
    }
    return out;
  }

  // ---- 游戏初始化 ----
  function createGame(opts) {
    opts = opts || {};
    const names = opts.playerNames || ['玩家1', '玩家2'];
    const seed = (opts.seed != null) ? opts.seed : (Math.random() * 1e9) | 0;
    _uid = 0;
    const rng = mulberry32(seed);
    const deck = shuffle(buildDeck(), rng);
    const players = names.map(n => ({ name: n, hand: [], forcedIons: 0 }));
    const state = {
      seed, players, deck, discard: [], zone: [],
      turn: 0, activePlayer: 0, phase: 'play',
      playsThisTurn: 0, requiredPlays: 1,
      winner: null, loser: null,
      log: [], started: true,
      pendingDisplace: null,
    };
    // 发初始手牌
    for (let i = 0; i < SETTINGS.initialHandSize; i++) {
      for (let p = 0; p < players.length; p++) drawCard(state, p);
    }
    log(state, `游戏开始（种子 ${seed}）。${players[0].name} 先手。`);
    startTurn(state, 0, true);
    return state;
  }

  // 从牌堆顶摸一张，不指定归属（底层）。
  function drawOne(state) {
    if (state.deck.length === 0) {
      if (state.discard.length === 0) return null;
      const rng = mulberry32((state.seed + state.discard.length) | 0);
      state.deck = shuffle(state.discard.slice(), rng);
      state.discard = [];
      log(state, '牌堆耗尽，弃牌堆重新洗入牌堆。');
    }
    return state.deck.shift() || null;
  }

  // 从牌堆顶摸一张给指定玩家。
  function drawCard(state, idx) {
    const c = drawOne(state);
    if (c) state.players[idx].hand.push(c);
    return c;
  }

  // 开始某玩家的回合。
  function startTurn(state, idx, skipDraw) {
    state.turn = idx;
    state.activePlayer = idx;
    state.playsThisTurn = 0;

    // 读取并消费 forcedIons 标记
    const forced = state.players[idx].forcedIons || 0;
    state.players[idx].forcedIons = 0;
    state.requiredPlays = forced > 0 ? forced : 1;

    if (skipDraw) {
      log(state, `${state.players[idx].name} 获得起始手牌。`);
      state.phase = 'play';
      return { ok: true };
    }

    // 惩罚检查在摸牌前：无离子时，只有非强制出牌且有攻击道具才能免罚
    if (!handHasIon(state, idx)) {
      if (state.requiredPlays > 1 || !handHasAttackItem(state, idx)) {
        applyPenalty(state, idx);
        return { ok: true };
      }
    }

    // 正常摸牌
    const drawCount = SETTINGS.drawPerTurn || 1;
    let drawn = 0;
    for (let i = 0; i < drawCount; i++) {
      if (drawCard(state, idx)) drawn++;
    }
    log(state, `${state.players[idx].name} 摸了 ${drawn} 张牌。`);

    state.phase = 'play';
    if (forced > 0) {
      log(state, `${state.players[idx].name} 受催化剂影响，本回合须出 ${state.requiredPlays} 张离子牌。`);
    }
    return { ok: true };
  }

  // 惩罚阶段：额外摸2张，离子归自己，道具直接给对手。
  function applyPenalty(state, idx) {
    const opp = opponentOf(state, idx);
    let drawn = 0, itemsGiven = 0;
    for (let i = 0; i < 2; i++) {
      const c = drawOne(state);
      if (!c) continue;
      drawn++;
      if (c.type === 'item') {
        state.players[opp].hand.push(c);
        itemsGiven++;
      } else {
        state.players[idx].hand.push(c);
      }
    }
    log(state, `${state.players[idx].name} 没有离子牌，触发惩罚：额外摸 ${drawn} 张，${itemsGiven} 张道具转给 ${state.players[opp].name}。`);
    state.phase = 'response';
  }

  // ---- 出牌：离子 ----
  function playIon(state, idx, uid) {
    if (state.winner != null) return { ok: false, msg: '游戏已结束。' };
    if (state.phase !== 'play') return { ok: false, msg: '当前不是出牌阶段。' };
    if (state.activePlayer !== idx) return { ok: false, msg: '还没轮到你。' };
    const hand = state.players[idx].hand;
    const ci = hand.findIndex(c => c.uid === uid);
    if (ci < 0) return { ok: false, msg: '手牌中没有这张牌。' };
    if (hand[ci].type !== 'ion') return { ok: false, msg: '这不是离子牌。' };

    const card = hand.splice(ci, 1)[0];
    state.zone.push(card);
    log(state, `${state.players[idx].name} 打出 ${ionSymbol(card.id)} 到反应区。`);
    autoNeutralize(state);

    state.playsThisTurn++;

    // 判断是否完成本轮出牌要求
    if (state.playsThisTurn >= state.requiredPlays) {
      state.phase = 'response';
      return { ok: true };
    }

    // 还需继续出牌，但若已无离子则自动进入 response
    if (!handHasIon(state, idx)) {
      log(state, `${state.players[idx].name} 没有更多离子牌，出牌结束。`);
      state.phase = 'response';
    }
    return { ok: true };
  }

  // ---- 出牌：催化剂（替代离子）----
  function playCatalyst(state, idx, uid) {
    if (state.winner != null) return { ok: false, msg: '游戏已结束。' };
    if (state.phase !== 'play') return { ok: false, msg: '当前不是出牌阶段。' };
    if (state.activePlayer !== idx) return { ok: false, msg: '还没轮到你。' };
    // 催化剂只能在正常出牌时用（requiredPlays=1），被强制出牌时不可用
    if (state.requiredPlays > 1) return { ok: false, msg: '受催化剂效果影响时，只能出离子牌。' };
    const hand = state.players[idx].hand;
    const ci = hand.findIndex(c => c.uid === uid);
    if (ci < 0) return { ok: false, msg: '手牌中没有这张牌。' };
    if (hand[ci].id !== 'catalyst') return { ok: false, msg: '这不是催化剂。' };

    const card = hand.splice(ci, 1)[0];
    state.discard.push(card);
    const opp = opponentOf(state, idx);
    state.players[opp].forcedIons = 2;
    log(state, `${state.players[idx].name} 打出催化剂！${state.players[opp].name} 下回合须出 2 张离子牌。`);
    state.phase = 'response';
    return { ok: true };
  }

  // ---- 出牌：攻击道具（play 阶段，替代离子）----
  function playAttackItem(state, idx, uid) {
    if (state.winner != null) return { ok: false, msg: '游戏已结束。' };
    if (state.phase !== 'play') return { ok: false, msg: '当前不是出牌阶段。' };
    if (state.activePlayer !== idx) return { ok: false, msg: '还没轮到你。' };
    if (state.requiredPlays > 1) return { ok: false, msg: '受催化剂效果影响时，只能出离子牌。' };
    const hand = state.players[idx].hand;
    const ci = hand.findIndex(c => c.uid === uid);
    if (ci < 0) return { ok: false, msg: '手牌中没有这张牌。' };
    if (hand[ci].type !== 'item') return { ok: false, msg: '这不是道具牌。' };
    const itemId = hand[ci].id;
    const def = ITEMS[itemId];
    if (!def || def.kind !== 'attack' || itemId === 'catalyst')
      return { ok: false, msg: '这不是攻击道具牌。' };

    const card = hand.splice(ci, 1)[0];
    state.discard.push(card);

    if (itemId === 'volatilize') return applyVolatilize(state, idx);
    if (itemId === 'displace')   return applyDisplace(state, idx);
    return { ok: false, msg: '未知道具。' };
  }

  function applyVolatilize(state, idx) {
    const opp = opponentOf(state, idx);
    const hand = state.players[opp].hand;
    const discardCount = Math.min(2, hand.length);
    if (discardCount === 0) {
      log(state, `${state.players[idx].name} 打出「挥发」，但 ${state.players[opp].name} 没有手牌可弃。`);
      state.phase = 'response';
      return { ok: true };
    }
    // 随机选取 discardCount 张弃置
    const indices = hand.map((_, i) => i);
    for (let i = indices.length - 1; i >= indices.length - discardCount; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [indices[i], indices[j]] = [indices[j], indices[i]];
    }
    const toDiscard = indices.slice(-discardCount).sort((a, b) => b - a);
    const discarded = [];
    for (const i of toDiscard) discarded.push(...hand.splice(i, 1));
    state.discard.push(...discarded);
    log(state, `${state.players[idx].name} 打出「挥发」！${state.players[opp].name} 随机弃置 ${discarded.length} 张手牌。`);
    state.phase = 'response';
    return { ok: true };
  }

  function applyDisplace(state, idx) {
    const opp = opponentOf(state, idx);
    // 惩罚阶段已处理掉对手道具的可能，此处对手可能有也可能没有
    const oppItems = state.players[opp].hand.filter(c => c.type === 'item');
    if (oppItems.length === 0) {
      log(state, `${state.players[idx].name} 打出「置换」，但 ${state.players[opp].name} 没有道具牌，无效果。`);
      state.phase = 'response';
      return { ok: true };
    }
    state.pendingDisplace = opp;
    log(state, `${state.players[idx].name} 打出「置换」！${state.players[opp].name} 须选择一张道具牌交给 ${state.players[idx].name}。`);
    return { ok: true };
  }

  function resolveDisplace(state, idx, itemUid) {
    if (state.winner != null) return { ok: false, msg: '游戏已结束。' };
    if (state.pendingDisplace !== idx) return { ok: false, msg: '当前没有待处理的置换。' };
    const hand = state.players[idx].hand;
    const ci = hand.findIndex(c => c.uid === itemUid);
    if (ci < 0) return { ok: false, msg: '手牌中没有这张牌。' };
    if (hand[ci].type !== 'item') return { ok: false, msg: '只能选择道具牌。' };

    const attacker = opponentOf(state, idx);
    const card = hand.splice(ci, 1)[0];
    state.players[attacker].hand.push(card);
    log(state, `${state.players[idx].name} 将「${ITEMS[card.id].name}」交给了 ${state.players[attacker].name}。`);
    state.pendingDisplace = null;
    state.phase = 'response';
    return { ok: true };
  }

  // ---- 出牌：道具（response 阶段）----
  function playItem(state, idx, uid, params) {
    if (state.winner != null) return { ok: false, msg: '游戏已结束。' };
    params = params || {};
    if (state.phase !== 'response') return { ok: false, msg: '道具只能在道具阶段使用。' };
    if (state.activePlayer !== idx) return { ok: false, msg: '还没轮到你。' };

    const hand = state.players[idx].hand;
    const ci = hand.findIndex(c => c.uid === uid);
    if (ci < 0) return { ok: false, msg: '手牌中没有这张牌。' };
    if (hand[ci].type !== 'item') return { ok: false, msg: '这不是道具牌。' };
    const itemId = hand[ci].id;
    if (itemId === 'catalyst') return { ok: false, msg: '催化剂只能在出牌阶段当作离子牌打出。' };

    const def = ITEMS[itemId];
    const res = applyItem(state, idx, itemId, params);
    if (!res.ok) return res;

    // 成功使用后移除该道具
    const ci2 = hand.findIndex(c => c.uid === uid);
    if (ci2 >= 0) { const card = hand.splice(ci2, 1)[0]; state.discard.push(card); }
    log(state, `${state.players[idx].name} 使用了「${def.name}」。`);
    autoNeutralize(state);
    return { ok: true };
  }

  // 应用单个道具的效果。
  function applyItem(state, idx, itemId, params) {
    switch (itemId) {
      case 'filter': {
        const reacts = findReactions(state.zone).filter(r => r.type === 'precipitate');
        if (reacts.length === 0) return { ok: false, msg: '反应区没有沉淀反应可过滤。' };
        let target = reacts[0];
        if (params.aUid && params.bUid) {
          const found = reacts.find(r =>
            (r.aUid === params.aUid && r.bUid === params.bUid) ||
            (r.aUid === params.bUid && r.bUid === params.aUid));
          if (found) target = found;
        }
        moveZoneToDiscard(state, target.aUid);
        moveZoneToDiscard(state, target.bUid);
        return { ok: true };
      }
      case 'heat': {
        const gas = findReactions(state.zone).filter(r => r.type === 'gas');
        if (gas.length === 0) return { ok: false, msg: '反应区没有气体反应，加热无效。' };
        let uid = params.uid;
        if (!uid || !gas.some(r => r.aUid === uid || r.bUid === uid)) uid = gas[0].aUid;
        moveZoneToDiscard(state, uid);
        return { ok: true };
      }
      case 'extract': {
        const uid = params.uid;
        const c = zoneFind(state, uid);
        if (!c) return { ok: false, msg: '反应区没有该离子。' };
        state.zone = state.zone.filter(x => x.uid !== uid);
        state.players[idx].hand.push(c);
        return { ok: true };
      }
      case 'neutralize': {
        const uid = params.uid;
        const c = zoneFind(state, uid);
        if (!c) return { ok: false, msg: '反应区没有该离子。' };
        if (c.id !== 'H' && c.id !== 'OH') return { ok: false, msg: '中和只能移走 H⁺ 或 OH⁻。' };
        const involved = reactionsInvolving(state, uid);
        if (involved.length === 0) return { ok: false, msg: '该离子未参与反应。' };
        if (involved.every(r => r.otherId === 'NH4')) {
          return { ok: false, msg: '中和不能处理 NH₄⁺ + OH⁻ 反应。' };
        }
        moveZoneToDiscard(state, uid);
        return { ok: true };
      }
      case 'stir': {
        if (state.zone.length === 0) return { ok: false, msg: '反应区已空。' };
        state.discard.push(...state.zone);
        state.zone = [];
        return { ok: true };
      }
      default:
        return { ok: false, msg: '未知道具。' };
    }
  }

  // ---- 确认结束道具阶段，触发反应判定 ----
  function confirmResponse(state, idx) {
    if (state.winner != null) return { ok: false, msg: '游戏已结束。' };
    if (state.phase !== 'response') return { ok: false, msg: '当前不是道具阶段。' };
    if (state.activePlayer !== idx) return { ok: false, msg: '还没轮到你。' };

    const reacts = findReactions(state.zone);
    if (reacts.length > 0) {
      const r = reacts[0];
      log(state, `反应区存在${r.type === 'gas' ? '气体' : '沉淀'}反应：${r.product}，${state.players[idx].name} 判负！`);
      declareLoser(state, idx);
      return { ok: true, lost: true, reaction: r };
    }
    return endTurn(state, idx);
  }

  function declareLoser(state, idx) {
    state.loser = idx;
    state.winner = opponentOf(state, idx);
    state.phase = 'over';
    log(state, `${state.players[state.winner].name} 获胜！`);
  }

  // ---- 结束回合，轮到对手 ----
  function endTurn(state, idx) {
    if (state.winner != null) return { ok: true };
    const next = opponentOf(state, idx);
    startTurn(state, next, false);
    return { ok: true, endedTurn: true };
  }

  // ---- 只读视图：给某玩家的可见状态（隐藏对手手牌）----
  function viewFor(state, idx) {
    const v = JSON.parse(JSON.stringify(state));
    v.you = idx;
    v.players = v.players.map((p, i) => {
      if (i === idx) return p;
      return { name: p.name, handCount: p.hand.length, hand: p.hand.map(() => ({ hidden: true })), forcedIons: p.forcedIons };
    });
    v.deckCount = state.deck.length;
    v.discardCount = state.discard.length;
    delete v.deck;
    return v;
  }

  return {
    createGame, drawCard, startTurn, endTurn,
    playIon, playItem, playCatalyst, playAttackItem, confirmResponse,
    resolveDisplace, findReactions, reactionsInvolving, autoNeutralize,
    viewFor,
    // 辅助导出（UI/测试用）
    ionKind, ionSymbol, cardLabel, isIon, handHasIon, handHasCatalyst, handHasAttackItem, opponentOf, buildDeck,
    _internal: { mulberry32, shuffle, makeCard },
  };
});
