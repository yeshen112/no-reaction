/**
 * 游戏页控制器 —— 联机模式（房主权威 + 访客提交意图）。
 */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const { CATIONS, ANIONS, ITEMS } = window.CARD_CONFIG;

  // ---- 运行时上下文 ----
  const ctx = {
    role: null,        // 'host' | 'guest'
    roomCode: null,
    seat: 0,           // 我的座位（0=房主, 1=访客）
    mode: null,        // 'online' | 'tutorial'
    _isTutorial: false,
    sub: null,         // SSE 订阅句柄
    state: null,       // 完整 state（房主）或收到的快照（访客）
    selection: null,   // 当前选中手牌 { uid }
    pendingItem: null, // 待点选目标的道具 { itemId, uid }
    _gameStartNotified: false, // 先后手提示只显示一次
    oppLeft: false,    // 对手是否已主动退出
  };

  // ---- 启动参数 ----
  let launch;
  try { launch = JSON.parse(sessionStorage.getItem('nr_launch') || '{}'); }
  catch (_) { launch = {}; }
  if (!launch.mode) { location.href = 'index.html'; }

  // ---- 提示横幅 ----
  let bannerTimer = null;
  function banner(msg, isErr, duration) {
    const el = $('banner');
    el.textContent = msg;
    el.classList.toggle('err', !!isErr);
    el.classList.add('show');
    clearTimeout(bannerTimer);
    if (duration === 0) return; // persistent: 不自动消失
    bannerTimer = setTimeout(() => el.classList.remove('show'), duration || 2600);
  }
  function clearBanner() {
    clearTimeout(bannerTimer);
    $('banner').classList.remove('show');
  }

  // ---- 表情弹窗 ----
  function showEmote(type, fromOpponent) {
    const pop = document.createElement('div');
    pop.className = 'face-pop' + (fromOpponent ? ' from-opp' : ' from-self');
    const inner = document.createElement('div');
    inner.className = 'face-inner face-' + type;
    pop.appendChild(inner);
    document.body.appendChild(pop);
    setTimeout(function () { pop.remove(); }, 2300);
  }

  // ---- 先后手提示（开局闪现）----
  function showStartNotice(isFirst) {
    const mask = $('turn-notice');
    const main = $('tn-main');
    const sub  = $('tn-sub');
    if (!mask || !main || !sub) return;
    main.textContent = isFirst ? '先手' : '后手';
    sub.textContent  = isFirst ? '你方先出牌' : '对手先出牌';
    mask.classList.add('show');
    setTimeout(() => mask.classList.remove('show'), 2200);
  }

  // ---- 视角 ----
  function myView() {
    if (!ctx.state) return null;
    // 教程模式：不隐藏对手手牌，学员需要看到全局
    if (ctx._isTutorial) {
      var v = JSON.parse(JSON.stringify(ctx.state));
      v.you = ctx.seat;
      v.deckCount = ctx.state.deck.length;
      v.discardCount = ctx.state.discard.length;
      delete v.deck;
      return v;
    }
    return Engine.viewFor(ctx.state, ctx.seat);
  }

  function canActNow(s) {
    if (s.pendingDisplace === ctx.seat) return true;
    return s.activePlayer === ctx.seat;
  }

  // ---- 教程模式启动 ----
  function bootTutorial() {
    ctx.role = 'host';
    ctx.seat = 0;
    ctx.roomCode = 'TUTORIAL';

    // 隐藏联机相关 UI
    $('room-tag').hidden = true;
    $('btn-quit').textContent = '退出教程';
    showWaiting(false);

    // 创建脚本化游戏
    ctx.state = Engine.createGame({
      seed: 0x54F01A1,
      playerNames: ['你', '教程助手']
    });
    ctx.state.started = true;

    // 初始化教程模块
    Tutorial.init(ctx.state, render, function (type, payload) {
      var res = applyAction(ctx.state, ctx.seat, { type: type, payload: payload || {} });
      render(res);
      return res;
    });

    Tutorial.start();
    render();
  }

  // ---- 启动 ----
  function boot() {
    ctx.mode = launch.mode || 'online';
    ctx._isTutorial = (ctx.mode === 'tutorial');

    if (ctx._isTutorial) {
      bootTutorial();
      return;
    }

    ctx.role = launch.role;
    ctx.roomCode = launch.roomCode;
    ctx.seat = launch.role === 'host' ? 0 : 1;
    $('room-tag').hidden = false;
    $('room-code-show').textContent = ctx.roomCode;
    $('waiting-code').textContent = ctx.roomCode;

    // 绑定表情菜单
    var emoteTrigger = $('emote-trigger');
    var emoteMenu = $('emote-menu');
    if (emoteTrigger && emoteMenu) {
      // 点击触发按钮 → 切换菜单开闭
      emoteTrigger.addEventListener('click', function (e) {
        e.stopPropagation();
        emoteMenu.classList.toggle('show');
      });
      // 点击菜单内表情
      emoteMenu.querySelectorAll('.emote-btn').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
          e.stopPropagation();
          var type = btn.dataset.emote;
          emoteMenu.classList.remove('show');
          showEmote(type, false);
          Network.pushEmote(ctx.roomCode, type).catch(function () {});
        });
      });
    }
    // 点击页面其他地方关闭菜单
    document.addEventListener('click', function () {
      if (emoteMenu) emoteMenu.classList.remove('show');
    });

    bootOnline();
  }

  async function bootOnline() {
    showWaiting(true);
    try {
      ctx.sub = await Network.subscribe(ctx.roomCode, onRoomUpdate);
    } catch (e) {
      banner('联机失败：' + (e && e.message || e), true);
    }
  }

  function showWaiting(on, title, sub) {
    const mask = $('waiting-mask');
    mask.classList.toggle('show', !!on);
    if (title) $('waiting-title').textContent = title;
    if (sub)   $('waiting-sub').textContent = sub;
  }

  // ---- 房间快照更新 ----
  let _lastSeq = 0;
  async function onRoomUpdate(room) {
    ctx.seat = Network.mySeat(room.players);
    if (ctx.seat < 0) ctx.seat = (ctx.role === 'host') ? 0 : 1;

    // 处理收到的表情（来自对手）
    if (room.emote && room.emote.by && room.emote.by !== Network.clientId()) {
      showEmote(room.emote.type, true);
    }

    const bothJoined = (room.players || []).length >= 2;

    if (ctx.role === 'host') {
      if (bothJoined && !room.state) {
        const names = orderedNames(room.players);
        ctx.state = Engine.createGame({ playerNames: names });
        await Network.pushState(ctx.roomCode, ctx.state);
        return;
      }
      if (room.action && room.action.by && room.action.seq !== _lastSeq) {
        const actorSeat = (room.players.find(p => p.id === room.action.by) || {}).seat;
        if (actorSeat === 1 && ctx.state) {
          _lastSeq = room.action.seq;
          applyAction(ctx.state, actorSeat, room.action);
          await Network.pushState(ctx.roomCode, ctx.state);
          return;
        }
      }
      if (room.state) ctx.state = room.state;
    } else {
      if (room.state) ctx.state = room.state;
    }

    if (!bothJoined) { showWaiting(true); return; }
    if (!ctx.state)  { showWaiting(true, '等待房主开局…', '对手已加入，正在初始化。'); return; }

    showWaiting(false);

    // 检测对手连接状态
    const myId = Network.clientId();
    const oppPlayer = (room.players || []).find(p => p.id !== myId);
    ctx.oppLeft = false;
    if (oppPlayer && ctx.state) {
      if (oppPlayer.left) {
        ctx.oppLeft = true;
        banner('对手已退出房间，可返回首页', false, 0);
      } else if (!oppPlayer.connected) {
        banner('对手已断线，等待重连…', false, 0);
      } else {
        clearBanner();
      }
    }

    // 游戏刚开始时显示先后手提示
    if (!ctx._gameStartNotified && ctx.state && ctx.state.started) {
      ctx._gameStartNotified = true;
      showStartNotice(ctx.seat === 0);
    }

    render();
  }

  function orderedNames(players) {
    const byseat = [...players].sort((a, b) => a.seat - b.seat);
    return byseat.map(p => p.nick || ('玩家' + (p.seat + 1)));
  }

  // ---- 动作分发 ----
  function applyAction(state, seat, action) {
    const p = action.payload || {};
    switch (action.type) {
      case 'playIon':         return Engine.playIon(state, seat, p.uid);
      case 'playCatalyst':    return Engine.playCatalyst(state, seat, p.uid);
      case 'playAttackItem':  return Engine.playAttackItem(state, seat, p.uid);
      case 'playItem':        return Engine.playItem(state, seat, p.uid, p.params || {});
      case 'confirmResponse': return Engine.confirmResponse(state, seat);
      case 'resolveDisplace': return Engine.resolveDisplace(state, seat, p.uid);
      default: return { ok: false, msg: '未知动作' };
    }
  }

  async function doAction(type, payload) {
    // 教程模式：校验动作
    if (ctx._isTutorial && Tutorial.isActive()) {
      var check = Tutorial.checkAction(type, payload || {});
      if (!check.allowed) {
        banner(check.msg || '请按教程指引操作', true);
        // 抖动目标元素
        var targetEl = document.querySelector('#hand .card.selected');
        if (!targetEl) targetEl = document.querySelector('#hand .card.selectable');
        if (targetEl) {
          targetEl.classList.add('tutorial-shake');
          setTimeout(function () { targetEl.classList.remove('tutorial-shake'); }, 500);
        }
        return { ok: false, msg: check.msg };
      }
      // 动作允许，直接结算
      var tres = applyAction(ctx.state, ctx.seat, { type: type, payload: payload || {} });
      render(tres);
      Tutorial.onActionTaken();
      return tres;
    }

    if (ctx.role === 'guest') {
      try { await Network.pushAction(ctx.roomCode, { type, payload }); }
      catch (e) { banner('提交失败：' + (e && e.message || e), true); }
      return { ok: true };
    }
    // 房主：直接结算，然后推送
    const res = applyAction(ctx.state, ctx.seat, { type, payload });
    if (!res.ok) { banner(res.msg || '操作无效', true); }
    await Network.pushState(ctx.roomCode, ctx.state);
    render(res);
    return res;
  }

  // ---- 每回合提示动画 ----
  let _prevActivePlayer = -1;
  let _myTurnCount = 0;
  function showTurnNotice(v) {
    if (ctx._isTutorial) return; // 教程用自己的对话框引导
    if (!v || v.winner != null) return;
    if (v.activePlayer !== ctx.seat) { _prevActivePlayer = v.activePlayer; return; }
    if (v.playsThisTurn !== 0) { _prevActivePlayer = v.activePlayer; return; }
    if (_prevActivePlayer === ctx.seat) return;
    _prevActivePlayer = ctx.seat;
    _myTurnCount++;

    const mask = $('turn-notice');
    const main = $('tn-main');
    const sub  = $('tn-sub');
    if (!mask || !main || !sub) return;

    main.textContent = '你的回合';
    sub.textContent  = `第 ${_myTurnCount} 回合`;
    mask.classList.add('show');
    setTimeout(() => mask.classList.remove('show'), 1600);
  }

  // ---- 摸牌动画 ----
  let _prevHandUids = new Set();

  function animateDraw(newUids) {
    const deckEl = $('deck-stack');
    const handEl = $('hand');
    if (!deckEl || !handEl || newUids.length === 0) return;
    const deckRect = deckEl.getBoundingClientRect();
    newUids.forEach((uid, i) => {
      const cardEl = handEl.querySelector(`[data-uid="${uid}"]`);
      if (!cardEl) return;
      const cardRect = cardEl.getBoundingClientRect();
      const dx = deckRect.left + deckRect.width / 2 - (cardRect.left + cardRect.width / 2);
      const dy = deckRect.top  + deckRect.height / 2 - (cardRect.top  + cardRect.height / 2);
      cardEl.style.transition = 'none';
      cardEl.style.transform = `translate(${dx}px, ${dy}px) scale(.7)`;
      cardEl.style.opacity = '0';
      requestAnimationFrame(() => requestAnimationFrame(() => {
        cardEl.style.transition = `transform .35s cubic-bezier(.22,.7,.3,1.1) ${i * 70}ms,
                                   opacity .25s ease ${i * 70}ms`;
        cardEl.style.transform = '';
        cardEl.style.opacity = '';
        setTimeout(() => {
          cardEl.classList.add('just-drawn');
          setTimeout(() => cardEl.classList.remove('just-drawn'), 600);
        }, 360 + i * 70);
      }));
    });
  }

  // ---- 渲染 ----
  function render(lastRes) {
    const v = myView();
    if (!v) return;

    // 表情栏：游戏中且未结束时显示
    var showEmoteBar = (v.winner == null && !ctx.oppLeft);
    $('emote-bar').style.display = showEmoteBar ? '' : 'none';
    if (!showEmoteBar) { var m = $('emote-menu'); if (m) m.classList.remove('show'); }

    $('turn-name').textContent = v.players[v.activePlayer]
      ? v.players[v.activePlayer].name : '——';

    renderOpponent(v);
    renderZone(v);

    const me = v.players[v.you];
    const currentUids = (me.hand || []).filter(c => !c.hidden).map(c => c.uid);
    const newUids = currentUids.filter(uid => !_prevHandUids.has(uid));
    _prevHandUids = new Set(currentUids);

    renderHand(v);
    // 教程模式不播放“摸牌飞入”动画：教程的手牌是脚本化下发的，
    // 飞入动画会让卡牌在落位前处于牌堆附近（右上角），导致引导弹窗对错位置。
    if (newUids.length > 0 && !ctx._isTutorial) animateDraw(newUids);
    renderDeck(v);
    renderActions(v);
    renderLog(v);
    showTurnNotice(v);

    if (v.winner != null) showOver(v);

    // 教程模式：重新定位聚光灯
    if (ctx._isTutorial && Tutorial.isActive()) {
      Tutorial._onPostRender();
    }
  }

  function renderDeck(v) {
    const countEl = $('deck-count');
    const stackEl = $('deck-stack');
    if (!countEl || !stackEl) return;
    countEl.textContent = (v.deckCount || 0) + ' 张';
    stackEl.style.opacity = (v.deckCount || 0) > 0 ? '1' : '0.3';
  }

  // 对手区
  function renderOpponent(v) {
    const oppSeat = (v.you + 1) % v.players.length;
    const opp = v.players[oppSeat];
    $('opp-name').textContent = opp.name;
    $('opp-count').textContent = opp.handCount != null
      ? opp.handCount : (opp.hand ? opp.hand.length : 0);
    $('opp-pill').classList.toggle('active', v.activePlayer === oppSeat);
    const wrap = $('opp-hand');
    wrap.innerHTML = '';
    const n = opp.handCount != null ? opp.handCount : (opp.hand ? opp.hand.length : 0);
    for (let i = 0; i < n; i++) {
      const b = document.createElement('div');
      b.className = 'card-back';
      wrap.appendChild(b);
    }
  }

  // 反应区
  function renderZone(v) {
    const zone = $('zone');
    zone.innerHTML = '';
    const reacts = Engine.findReactions(v.zone);
    const inReaction = new Set();
    reacts.forEach(r => { inReaction.add(r.aUid); inReaction.add(r.bUid); });
    zone.classList.toggle('reacting', reacts.length > 0);

    if (v.zone.length === 0) {
      const hint = document.createElement('span');
      hint.className = 'empty-hint';
      hint.textContent = '反应区为空';
      zone.appendChild(hint);
    } else {
      v.zone.forEach(c => {
        const el = makeCardEl(c, inReaction.has(c.uid));
        if (ctx.pendingItem && canActNow(ctx.state)) {
          el.classList.add('zone-target');
          el.addEventListener('click', () => onZoneTargetClick(c));
        }
        zone.appendChild(el);
      });
    }

    const info = $('zone-info');
    if (reacts.length > 0) {
      const r = reacts[0];
      info.textContent = `⚠ ${r.product}（${r.type === 'gas' ? '气体' : '沉淀'}）`;
      info.style.color = 'var(--danger)';
    } else {
      info.textContent = v.zone.length > 0 ? '无反应' : '';
      info.style.color = 'var(--text-dim)';
    }
  }

  // 卡牌 DOM 元素
  function makeCardEl(card, highlight) {
    const el = document.createElement('div');
    el.className = 'card';
    if (card.type === 'ion') {
      const k = CATIONS[card.id] ? 'cation' : 'anion';
      el.classList.add(k);
      const def = CATIONS[card.id] || ANIONS[card.id];
      el.innerHTML = `<span class="tag">${k === 'cation' ? '阳' : '阴'}</span>` +
                     `<span class="sym">${def.symbol}</span>` +
                     `<span class="nm">${def.name}</span>`;
    } else {
      el.classList.add('item');
      const def = ITEMS[card.id];
      if (def && def.kind === 'attack') el.classList.add('attack');
      el.innerHTML = `<span class="tag">道具</span>` +
                     `<span class="sym">${def.name}</span>` +
                     `<span class="nm">${def && def.kind === 'attack' ? '攻击' : def && def.kind === 'neutral' ? '中性' : '防守'}</span>`;
    }
    if (highlight) el.classList.add('in-reaction');
    return el;
  }

  // 手牌
  function renderHand(v) {
    const me = v.players[v.you];
    $('me-name').textContent = me.name + '（你）';
    const phaseLabel = (() => {
      if (v.pendingDisplace === ctx.seat) {
        const attacker = v.players[(ctx.seat + 1) % v.players.length];
        return `${(attacker && attacker.name) || '对手'} 对你使用了「置换」，请选择一张道具牌交出`;
      }
      if (v.pendingDisplace != null && v.pendingDisplace !== ctx.seat) {
        const target = v.players[v.pendingDisplace];
        return `等待 ${(target && target.name) || '对手'} 选择道具交出…`;
      }
      if (v.phase === 'play') {
        const required = v.requiredPlays || 1;
        if (required > 1) return `催化剂效果：出第 ${(v.playsThisTurn || 0) + 1} / ${required} 张离子牌`;
        return '出牌阶段：打出一张离子牌（或催化剂 / 攻击道具）';
      }
      if (v.phase === 'response') return '道具阶段：可使用道具，完成后点「确认结束」';
      if (v.phase === 'over') return '游戏结束';
      return '';
    })();
    if (ctx.oppLeft) {
      $('phase-label').textContent = '对手已退出';
    } else {
      $('phase-label').textContent = canActNow(ctx.state) ? phaseLabel : '等待对手操作…';
    }

    const hand = $('hand');
    hand.innerHTML = '';
    const mine = me.hand || [];
    const actionable = canActNow(ctx.state) && v.winner == null && !ctx.oppLeft;

    mine.forEach(c => {
      const el = makeCardEl(c, false);
      el.dataset.uid = c.uid;
      if (actionable && isPlayable(v, c)) {
        el.classList.add('selectable');
        if (ctx.selection && ctx.selection.uid === c.uid) el.classList.add('selected');
        el.addEventListener('click', () => onHandClick(v, c));
      }
      hand.appendChild(el);
    });
  }

  function isPlayable(v, c) {
    // 置换待处理时：对手可选道具交出
    if (v.pendingDisplace === ctx.seat) {
      return c.type === 'item';
    }
    if (v.phase === 'play') {
      if (c.type === 'ion') return true;
      if (c.type === 'item') {
        const def = ITEMS[c.id];
        if (!def) return false;
        if (c.id === 'catalyst') return (v.requiredPlays || 1) === 1;
        if (def.kind === 'attack') return (v.requiredPlays || 1) === 1;
        return false;
      }
      return false;
    }
    if (v.phase === 'response') {
      if (c.type !== 'item') return false;
      const def = ITEMS[c.id];
      return def && (def.kind === 'defense' || def.kind === 'neutral');
    }
    return false;
  }

  // 操作按钮
  function renderActions(v) {
    const bar = $('hand-actions');
    bar.innerHTML = '';
    if (ctx.oppLeft) {
      bar.appendChild(mkBtn('返回首页', 'btn', async () => { await cleanup(true); location.href = 'index.html'; }));
      return;
    }
    if (!canActNow(ctx.state) || v.winner != null) return;

    if (v.phase === 'response') {
      bar.appendChild(mkBtn('确认结束道具阶段', 'btn', () => doAction('confirmResponse', {})));
    }
    if (ctx.pendingItem) {
      bar.appendChild(mkBtn('取消选择', 'btn-mini', () => {
        ctx.pendingItem = null; ctx.selection = null; render();
      }));
      const hintMap = {
        extract:   '点击反应区中要取回手牌的离子',
        heat:      '点击反应区中要移走的气体离子',
        neutralize:'点击反应区中要移走的 H⁺ 或 OH⁻',
      };
      banner(hintMap[ctx.pendingItem.itemId] || '请在反应区选择目标');
    }
  }

  function mkBtn(label, cls, fn) {
    const b = document.createElement('button');
    b.className = cls; b.textContent = label;
    b.addEventListener('click', fn);
    return b;
  }

  // 日志
  function renderLog(v) {
    const box = $('log');
    box.innerHTML = '';
    (v.log || []).slice(-60).forEach(line => {
      const e = document.createElement('div');
      e.className = 'entry'; e.textContent = line;
      box.appendChild(e);
    });
    box.scrollTop = box.scrollHeight;
  }

  // ---- 交互 ----
  function onHandClick(v, card) {
    // 置换待处理时：点击道具即交出
    if (v.pendingDisplace === ctx.seat) {
      if (card.type === 'item') return doAction('resolveDisplace', { uid: card.uid });
      return;
    }
    if (card.type === 'ion') {
      if (v.phase === 'play') return doAction('playIon', { uid: card.uid });
      return;
    }
    if (card.id === 'catalyst') {
      if (v.phase === 'play') return doAction('playCatalyst', { uid: card.uid });
      return;
    }
    // 其他攻击道具
    if (card.type === 'item' && ITEMS[card.id] && ITEMS[card.id].kind === 'attack') {
      if (v.phase === 'play') return doAction('playAttackItem', { uid: card.uid });
      return;
    }
    if (['extract', 'heat', 'neutralize'].includes(card.id)) {
      ctx.pendingItem = { itemId: card.id, uid: card.uid };
      ctx.selection = { uid: card.uid };
      render(); return;
    }
    if (card.id === 'filter') return doAction('playItem', { uid: card.uid, params: {} });
    if (card.id === 'stir')   return doAction('playItem', { uid: card.uid, params: {} });
  }

  function onZoneTargetClick(card) {
    if (!ctx.pendingItem) return;
    const { uid } = ctx.pendingItem;
    ctx.pendingItem = null; ctx.selection = null;
    doAction('playItem', { uid, params: { uid: card.uid } });
  }

  // ---- 结束模态 ----
  function showOver(v) {
    if (ctx._isTutorial) return; // 教程用自己的完成界面
    const iWon = v.winner === ctx.seat;
    $('over-title').textContent = iWon ? '🏆 你赢了！' : '💧 你输了';
    $('over-title').className = iWon ? 'win' : 'lose';
    $('over-sub').textContent = iWon
      ? '对手触发了无法解除的反应。'
      : '你触发了无法解除的反应。';
    $('over-mask').classList.add('show');
  }

  // ---- 按钮事件 ----
  $('btn-again').addEventListener('click', () => {
    $('over-mask').classList.remove('show');
    ctx._gameStartNotified = false;
    _shownTurn = -1;
    _prevHandUids = new Set();
    if (ctx.role === 'host') {
      const names = ctx.state ? ctx.state.players.map(p => p.name) : ['玩家1', '玩家2'];
      ctx.state = Engine.createGame({ playerNames: names });
      Network.pushState(ctx.roomCode, ctx.state).then(() => render());
    } else {
      banner('等待房主开始新一局…');
    }
  });
  $('btn-home').addEventListener('click', async () => { await cleanup(true); location.href = 'index.html'; });
  $('btn-quit').addEventListener('click', async () => {
    if (confirm('确定退出当前对局？')) { await cleanup(true); location.href = 'index.html'; }
  });
  var _encBtn = $('btn-encyclopedia');
  if (_encBtn) _encBtn.addEventListener('click', function () {
    if (window.Encyclopedia) Encyclopedia.open();
  });

  async function cleanup(intentional) {
    if (intentional && ctx.roomCode) {
      try { await Network.leaveRoom(ctx.roomCode); } catch (_) {}
    }
    if (ctx.sub) { try { ctx.sub.close(); } catch (_) {} }
    sessionStorage.removeItem('nr_launch');
  }
  // beforeunload 时不调 leaveRoom（异步可能来不及），靠 SSE close 让服务器感知断线
  window.addEventListener('beforeunload', () => cleanup(false));

  boot();
})();
