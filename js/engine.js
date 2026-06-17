/**
 * 核心游戏引擎 —— 纯逻辑，不依赖 DOM。
 * 状态为纯数据（可 JSON 序列化），所有操作就地更新 state 并返回 { ok, msg }，
 * 便于通过网络整份同步状态。
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

  function symbolToCard(c) { return cardLabel(c); }

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

  function log(state, msg) { state.log.push(msg); if (state.log.length > 200) state.log.shift(); }

  // ---- 反应扫描 ----
  // 扫描反应区内所有无序离子对，返回需要处理的（沉淀/气体）反应列表。
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
  // 返回某离子当前参与的所有反应（沉淀/气体）。
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
    const players = names.map(n => ({ name: n, hand: [] }));
    const state = {
      seed, players, deck, discard: [], zone: [],
      turn: 0, activePlayer: 0, phase: 'play',
      pending: null, winner: null, loser: null,
      catalyst: null, log: [], started: true,
    };
    // 发初始手牌
    for (let i = 0; i < SETTINGS.initialHandSize; i++) {
      for (let p = 0; p < players.length; p++) drawCard(state, p);
    }
    log(state, `游戏开始（种子 ${seed}）。${players[0].name} 先手。`);
    startTurn(state, 0, true);
    return state;
  }

  // 从牌堆顶摸一张给指定玩家；牌堆空则洗入弃牌。
  function drawCard(state, idx) {
    if (state.deck.length === 0) {
      if (state.discard.length === 0) return null;
      const rng = mulberry32((state.seed + state.discard.length) | 0);
      state.deck = shuffle(state.discard.slice(), rng);
      state.discard = [];
      log(state, '牌堆耗尽，弃牌堆重新洗入牌堆。');
    }
    const c = state.deck.shift();
    if (c) state.players[idx].hand.push(c);
    return c;
  }

  // 开始某玩家的回合：摸 1 张，进入出牌阶段。
  function startTurn(state, idx, skipDraw) {
    state.turn = idx;
    state.activePlayer = idx;
    state.phase = 'play';
    state.pending = null;
    if (!skipDraw) {
      const c = drawCard(state, idx);
      if (c) log(state, `${state.players[idx].name} 摸了一张 ${cardLabel(c)}。`);
    } else {
      log(state, `${state.players[idx].name} 摸了起始手牌。`);
    }
    return { ok: true };
  }

  // ---- 出牌：离子 ----
  // 玩家在出牌阶段打出一张离子牌到反应区。
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
    state.lastPlayer = idx;
    log(state, `${state.players[idx].name} 打出 ${ionSymbol(card.id)} 到反应区。`);
    autoNeutralize(state);
    return resolveAfterPlay(state, idx, card);
  }

  // 出牌后判定：若有沉淀/气体反应则进入道具阶段，否则结束回合。
  function resolveAfterPlay(state, idx, card) {
    const reacts = card ? reactionsInvolving(state, card.uid) : findReactions(state.zone);
    if (reacts.length > 0) {
      const r = reacts[0];
      state.phase = 'item';
      state.pending = {
        resolver: idx,
        triggerUid: card ? card.uid : r.aUid,
        reaction: r,
      };
      const sym = card ? `${ionSymbol(card.id)} 与 ${ionSymbol(r.otherId)}` : '反应区离子';
      log(state, `触发${r.type === 'gas' ? '气体' : '沉淀'}反应：${sym} → ${r.product}。${state.players[idx].name} 进入道具阶段。`);
      return { ok: true, reaction: r };
    }
    return endTurn(state, idx);
  }

  // ---- 出牌：道具 ----
  function playItem(state, idx, uid, params) {
    if (state.winner != null) return { ok: false, msg: '游戏已结束。' };
    params = params || {};
    const hand = state.players[idx].hand;
    const ci = hand.findIndex(c => c.uid === uid);
    if (ci < 0) return { ok: false, msg: '手牌中没有这张牌。' };
    if (hand[ci].type !== 'item') return { ok: false, msg: '这不是道具牌。' };
    const itemId = hand[ci].id;

    // 催化剂：仅在出牌阶段、出完离子且无反应时打出
    if (itemId === 'catalyst') {
      if (state.phase !== 'play' || state.activePlayer !== idx) {
        return { ok: false, msg: '催化剂只能在你的出牌阶段、且反应区无反应时打出。' };
      }
      if (findReactions(state.zone).length > 0) {
        return { ok: false, msg: '反应区当前存在反应，不能打出催化剂。' };
      }
      const card = hand.splice(ci, 1)[0];
      state.discard.push(card);
      return startCatalyst(state, idx);
    }

    // 其余道具：搅拌为中性（出牌阶段也可用），防守道具需在道具阶段
    const def = ITEMS[itemId];
    if (def.kind === 'defense' && state.phase !== 'item') {
      return { ok: false, msg: '防守道具只能在道具阶段使用。' };
    }
    if (state.phase === 'item' && state.pending && state.pending.resolver !== idx) {
      return { ok: false, msg: '当前由对手处理反应。' };
    }

    const res = applyItem(state, idx, itemId, params);
    if (!res.ok) return res;
    // 成功使用后移除该道具
    const ci2 = hand.findIndex(c => c.uid === uid);
    if (ci2 >= 0) { const card = hand.splice(ci2, 1)[0]; state.discard.push(card); }
    log(state, `${state.players[idx].name} 使用了「${def.name}」。`);

    // 道具使用后重新判定反应区
    autoNeutralize(state);
    if (state.phase === 'item') {
      const remaining = findReactions(state.zone);
      if (remaining.length === 0) {
        log(state, '反应已全部解除。');
        return endTurn(state, state.pending ? state.pending.resolver : idx);
      } else {
        state.pending.reaction = Object.assign({ otherId: zoneFind(state, remaining[0].bUid) ? zoneFind(state, remaining[0].bUid).id : null }, remaining[0]);
      }
    }
    return { ok: true };
  }

  // 应用单个道具的效果。params 视道具而定。
  function applyItem(state, idx, itemId, params) {
    switch (itemId) {
      case 'filter': {
        // 移走一对沉淀离子
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
        // 移走一个参与气体反应的离子
        const gas = findReactions(state.zone).filter(r => r.type === 'gas');
        if (gas.length === 0) return { ok: false, msg: '反应区没有气体反应，加热无效。' };
        let uid = params.uid;
        if (!uid || !gas.some(r => r.aUid === uid || r.bUid === uid)) uid = gas[0].aUid;
        moveZoneToDiscard(state, uid);
        return { ok: true };
      }
      case 'extract': {
        // 把指定离子取回手牌
        const uid = params.uid;
        const c = zoneFind(state, uid);
        if (!c) return { ok: false, msg: '反应区没有该离子。' };
        state.zone = state.zone.filter(x => x.uid !== uid);
        state.players[idx].hand.push(c);
        return { ok: true };
      }
      case 'neutralize': {
        // 移走一个 H⁺ 或 OH⁻（须参与反应）
        const uid = params.uid;
        const c = zoneFind(state, uid);
        if (!c) return { ok: false, msg: '反应区没有该离子。' };
        if (c.id !== 'H' && c.id !== 'OH') return { ok: false, msg: '中和只能移走 H⁺ 或 OH⁻。' };
        const involved = reactionsInvolving(state, uid);
        if (involved.length === 0) return { ok: false, msg: '该离子未参与反应。' };
        // 不能处理 NH₄⁺ + OH⁻
        if (involved.every(r => r.otherId === 'NH4')) {
          return { ok: false, msg: '中和不能处理 NH₄⁺ + OH⁻ 反应。' };
        }
        moveZoneToDiscard(state, uid);
        return { ok: true };
      }
      case 'stir': {
        // 清空反应区
        if (state.zone.length === 0) return { ok: false, msg: '反应区已空。' };
        state.discard.push(...state.zone);
        state.zone = [];
        return { ok: true };
      }
      default:
        return { ok: false, msg: '未知道具。' };
    }
  }

  // ---- 放弃道具阶段，认输该反应 ----
  function concede(state, idx) {
    if (state.phase !== 'item') return { ok: false, msg: '当前不是道具阶段。' };
    if (!state.pending || state.pending.resolver !== idx) return { ok: false, msg: '不是你在处理反应。' };
    declareLoser(state, idx);
    return { ok: true };
  }

  function declareLoser(state, idx) {
    state.loser = idx;
    state.winner = opponentOf(state, idx);
    state.phase = 'over';
    log(state, `${state.players[idx].name} 无法解除反应，判负！${state.players[state.winner].name} 获胜！`);
  }

  // ---- 催化剂流程 ----
  function startCatalyst(state, userIdx) {
    log(state, `${state.players[userIdx].name} 打出催化剂！双方各出一张离子牌后统一判定。`);
    state.catalyst = { user: userIdx, step: 'user' };
    state.phase = 'catalyst';
    state.activePlayer = userIdx;
    // 使用者必须先出一张离子（有牌必须出）
    if (!handHasIon(state, userIdx)) {
      // 使用者无离子牌，跳到对手
      log(state, `${state.players[userIdx].name} 没有离子牌可出，跳过。`);
      return catalystToOpponent(state);
    }
    return { ok: true, needIon: true };
  }

  // 催化剂阶段出离子
  function playCatalystIon(state, idx, uid) {
    if (state.phase !== 'catalyst') return { ok: false, msg: '当前不是催化剂阶段。' };
    if (state.activePlayer !== idx) return { ok: false, msg: '还没轮到你出牌。' };
    const hand = state.players[idx].hand;
    const ci = hand.findIndex(c => c.uid === uid);
    if (ci < 0 || hand[ci].type !== 'ion') return { ok: false, msg: '请选择一张离子牌。' };
    const card = hand.splice(ci, 1)[0];
    state.zone.push(card);
    log(state, `${state.players[idx].name} 在催化剂下打出 ${ionSymbol(card.id)}。`);
    if (state.catalyst.step === 'user') {
      return catalystToOpponent(state);
    } else {
      return finishCatalyst(state);
    }
  }

  function catalystToOpponent(state) {
    const opp = opponentOf(state, state.catalyst.user);
    state.catalyst.step = 'opp';
    state.activePlayer = opp;
    if (!handHasIon(state, opp)) {
      log(state, `${state.players[opp].name} 没有离子牌可出，跳过。`);
      return finishCatalyst(state);
    }
    return { ok: true, needIon: true };
  }

  // 催化剂双方出完后统一判定。
  function finishCatalyst(state) {
    const user = state.catalyst.user;
    state.catalyst = null;
    autoNeutralize(state);
    const reacts = findReactions(state.zone);
    if (reacts.length > 0) {
      // 由引发者（催化剂使用者）进入道具阶段处理
      const r = reacts[0];
      state.phase = 'item';
      state.activePlayer = user;
      state.pending = {
        resolver: user,
        triggerUid: r.aUid,
        reaction: Object.assign({ otherId: zoneFind(state, r.bUid) ? zoneFind(state, r.bUid).id : null }, r),
      };
      log(state, `催化剂判定触发反应 → ${r.product}。${state.players[user].name} 进入道具阶段。`);
      return { ok: true, reaction: r };
    }
    log(state, '催化剂结算：反应区无反应。');
    return endTurn(state, user);
  }

  // ---- 结束回合，轮到对手 ----
  function endTurn(state, idx) {
    if (state.winner != null) return { ok: true };
    state.pending = null;
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
      return { name: p.name, handCount: p.hand.length, hand: p.hand.map(() => ({ hidden: true })) };
    });
    v.deckCount = state.deck.length;
    v.discardCount = state.discard.length;
    delete v.deck;
    return v;
  }

  return {
    createGame, drawCard, startTurn, endTurn,
    playIon, playItem, playCatalystIon, concede,
    findReactions, reactionsInvolving, autoNeutralize,
    viewFor,
    // 辅助导出（UI/测试用）
    ionKind, ionSymbol, cardLabel, isIon, handHasIon, opponentOf, buildDeck,
    _internal: { mulberry32, shuffle, makeCard },
  };
});
