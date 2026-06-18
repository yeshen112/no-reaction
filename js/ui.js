/**
 * 游戏页控制器 —— 把引擎状态渲染到 DOM，处理本地热座与联机两种模式。
 *
 * 本地模式：单端持有 state，直接运行引擎，渲染当前 activePlayer 的视角。
 * 联机模式：房主权威运行引擎并 pushState；访客提交 action 意图由房主结算。
 */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const { CATIONS, ANIONS, ITEMS } = window.CARD_CONFIG;

  // ---- 运行时上下文 ----
  const ctx = {
    mode: 'local',     // 'local' | 'online'
    role: null,        // 'host' | 'guest'
    roomCode: null,
    seat: 0,           // 联机：我的座位；本地：忽略
    sub: null,         // 联机订阅句柄
    state: null,       // 完整 state（本地/房主）；访客侧为收到的快照
    selection: null,   // 当前选中的手牌 { uid, itemId }
    pendingItem: null, // 需要点选目标的道具 { itemId, uid, need }
  };

  // ---- 启动参数 ----
  let launch;
  try { launch = JSON.parse(sessionStorage.getItem('nr_launch') || '{}'); }
  catch (_) { launch = {}; }
  if (!launch.mode) { location.href = 'index.html'; }

  // ---- 提示横幅 ----
  let bannerTimer = null;
  function banner(msg, isErr) {
    const el = $('banner');
    el.textContent = msg;
    el.classList.toggle('err', !!isErr);
    el.classList.add('show');
    clearTimeout(bannerTimer);
    bannerTimer = setTimeout(() => el.classList.remove('show'), 2600);
  }

  // ---- 视角：当前应由谁操作 ----
  // 本地模式：始终渲染 activePlayer 的视角（热座）。
  // 联机模式：渲染「我」的视角（ctx.seat）。
  function myView() {
    if (!ctx.state) return null;
    const viewer = (ctx.mode === 'online') ? ctx.seat : activeSeat(ctx.state);
    return Engine.viewFor(ctx.state, viewer);
  }
  // 当前轮到操作的座位（出牌/道具/催化剂阶段的 activePlayer）
  function activeSeat(s) { return s.activePlayer; }

  // 我是否可以现在操作（联机模式下必须是我的回合）
  function canActNow(s) {
    if (ctx.mode === 'local') return true;
    return s.activePlayer === ctx.seat;
  }

  // ---- 启动 ----
  function boot() {
    ctx.mode = launch.mode;
    if (ctx.mode === 'local') {
      ctx.state = Engine.createGame({ playerNames: launch.playerNames || ['玩家1', '玩家2'] });
      $('room-tag').hidden = true;
      render();
    } else {
      ctx.role = launch.role;
      ctx.roomCode = launch.roomCode;
      $('room-tag').hidden = false;
      $('room-code-show').textContent = ctx.roomCode;
      $('waiting-code').textContent = ctx.roomCode;
      bootOnline();
    }
  }

  // ---- 联机启动 ----
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
    if (sub) $('waiting-sub').textContent = sub;
  }

  // 房间快照更新（联机）
  let _lastSeq = 0;
  async function onRoomUpdate(room) {
    ctx.seat = Network.mySeat(room.players);
    if (ctx.seat < 0) ctx.seat = (ctx.role === 'host') ? 0 : 1;

    const bothJoined = (room.players || []).length >= 2;

    if (ctx.role === 'host') {
      // 房主权威：双方就绪后若尚无 state 则开局
      if (bothJoined && !room.state) {
        const names = orderedNames(room.players);
        ctx.state = Engine.createGame({ playerNames: names });
        await Network.pushState(ctx.roomCode, ctx.state);
        return; // pushState 会再次触发 onRoomUpdate
      }
      // 处理访客提交的动作
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
      // 访客：直接采用房主下发的 state
      if (room.state) ctx.state = room.state;
    }

    if (!bothJoined) { showWaiting(true); return; }
    if (!ctx.state) { showWaiting(true, '等待房主开局…', '对手已加入，正在初始化。'); return; }
    showWaiting(false);
    render();
  }

  function orderedNames(players) {
    const byseat = [...players].sort((a, b) => a.seat - b.seat);
    return byseat.map(p => p.nick || ('玩家' + (p.seat + 1)));
  }

  // ---- 动作分发：把意图作用到 state（本地直接调用，房主代访客调用）----
  function applyAction(state, seat, action) {
    const p = action.payload || {};
    let res;
    switch (action.type) {
      case 'playIon':         res = Engine.playIon(state, seat, p.uid); break;
      case 'playCatalyst':    res = Engine.playCatalyst(state, seat, p.uid); break;
      case 'playItem':        res = Engine.playItem(state, seat, p.uid, p.params || {}); break;
      case 'confirmResponse': res = Engine.confirmResponse(state, seat); break;
      default: res = { ok: false, msg: '未知动作' };
    }
    return res;
  }

  // ---- 本地/房主执行动作，访客提交意图 ----
  async function doAction(type, payload) {
    if (ctx.mode === 'online' && ctx.role === 'guest') {
      try { await Network.pushAction(ctx.roomCode, { type, payload }); }
      catch (e) { banner('提交失败：' + (e && e.message || e), true); }
      return { ok: true };
    }
    const seat = (ctx.mode === 'online') ? ctx.seat : activeSeat(ctx.state);
    const res = applyAction(ctx.state, seat, { type, payload });
    if (!res.ok) { banner(res.msg || '操作无效', true); }
    if (ctx.mode === 'online' && ctx.role === 'host') {
      await Network.pushState(ctx.roomCode, ctx.state);
    }
    render(res);
    return res;
  }

  // ---- 摸牌动画 ----
  // 上次渲染时的手牌 uid 集合，用于识别新牌
  let _prevHandUids = new Set();

  function animateDraw(newUids) {
    // 找到牌堆 DOM 位置作为动画起点
    const deckEl = $('deck-stack');
    const handEl = $('hand');
    if (!deckEl || !handEl || newUids.length === 0) return;

    const deckRect = deckEl.getBoundingClientRect();
    const handRect = handEl.getBoundingClientRect();

    newUids.forEach((uid, i) => {
      // 找到对应手牌元素（刚被 renderHand 插入）
      const cardEl = handEl.querySelector(`[data-uid="${uid}"]`);
      if (!cardEl) return;

      const cardRect = cardEl.getBoundingClientRect();
      const dx = deckRect.left + deckRect.width / 2 - (cardRect.left + cardRect.width / 2);
      const dy = deckRect.top + deckRect.height / 2 - (cardRect.top + cardRect.height / 2);

      // 从牌堆位置飞入
      cardEl.style.transition = 'none';
      cardEl.style.transform = `translate(${dx}px, ${dy}px) scale(.7)`;
      cardEl.style.opacity = '0';

      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          cardEl.style.transition = `transform .35s cubic-bezier(.22,.7,.3,1.1) ${i * 70}ms,
                                     opacity .25s ease ${i * 70}ms`;
          cardEl.style.transform = '';
          cardEl.style.opacity = '';
          // 落位后短暂高亮
          setTimeout(() => {
            cardEl.classList.add('just-drawn');
            setTimeout(() => cardEl.classList.remove('just-drawn'), 600);
          }, 360 + i * 70);
        });
      });
    });
  }

  // ---- 渲染 ----
  function render(lastRes) {
    const v = myView();
    if (!v) return;

    // 顶栏：当前回合
    $('turn-name').textContent = v.players[v.activePlayer] ? v.players[v.activePlayer].name : '——';

    renderOpponent(v);
    renderZone(v, lastRes);

    // 找出本次渲染中新出现的手牌 uid（用于摸牌动画）
    const me = v.players[v.you];
    const currentUids = (me.hand || []).filter(c => !c.hidden).map(c => c.uid);
    const newUids = currentUids.filter(uid => !_prevHandUids.has(uid));
    _prevHandUids = new Set(currentUids);

    renderHand(v);
    if (newUids.length > 0) animateDraw(newUids);

    renderDeck(v);
    renderActions(v);
    renderLog(v);

    // 结束
    if (v.winner != null) showOver(v);
  }

  function renderDeck(v) {
    const countEl = $('deck-count');
    const stackEl = $('deck-stack');
    if (!countEl || !stackEl) return;
    countEl.textContent = (v.deckCount || 0) + ' 张';
    // 牌堆空时降低不透明度
    stackEl.style.opacity = (v.deckCount || 0) > 0 ? '1' : '0.3';
  }

  // 对手区（相对当前视角）
  function renderOpponent(v) {
    const oppSeat = (v.you + 1) % v.players.length;
    const opp = v.players[oppSeat];
    $('opp-name').textContent = opp.name;
    $('opp-count').textContent = opp.handCount != null ? opp.handCount : (opp.hand ? opp.hand.length : 0);
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
  function renderZone(v, lastRes) {
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
        const el = cardEl(c, inReaction.has(c.uid));
        // 若正在等待选择道具目标，反应区的牌可点选
        if (ctx.pendingItem && canActNow(ctx.state)) {
          el.classList.add('zone-target');
          el.addEventListener('click', () => onZoneTargetClick(c));
        }
        zone.appendChild(el);
      });
    }

    // 反应信息
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

  // 单张卡片元素
  function cardEl(card, highlight) {
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
      el.innerHTML = `<span class="tag">道具</span>` +
                     `<span class="sym">${def.name}</span>` +
                     `<span class="nm">${def.kind === 'attack' ? '攻击' : def.kind === 'neutral' ? '中性' : '防守'}</span>`;
    }
    if (highlight) el.classList.add('in-reaction');
    return el;
  }

  // 手牌
  function renderHand(v) {
    const me = v.players[v.you];
    $('me-name').textContent = me.name + (ctx.mode === 'local' ? '（请操作）' : '（你）');
    const phaseLabel = (() => {
      if (v.phase === 'play') {
        const required = v.requiredPlays || 1;
        if (required > 1) {
          return `催化剂效果：出第 ${(v.playsThisTurn || 0) + 1} / ${required} 张离子牌`;
        }
        return '出牌阶段：打出一张离子牌（或催化剂）';
      }
      if (v.phase === 'response') return '道具阶段：可使用道具，完成后点「确认结束」';
      if (v.phase === 'over') return '游戏结束';
      return '';
    })();
    $('phase-label').textContent = canActNow(ctx.state) ? phaseLabel : '等待对手操作…';

    const hand = $('hand');
    hand.innerHTML = '';
    const mine = me.hand || [];
    const actionable = canActNow(ctx.state) && v.winner == null;

    mine.forEach(c => {
      const el = cardEl(c, false);
      el.dataset.uid = c.uid;
      if (actionable && isPlayable(v, c)) {
        el.classList.add('selectable');
        if (ctx.selection && ctx.selection.uid === c.uid) el.classList.add('selected');
        el.addEventListener('click', () => onHandClick(v, c));
      }
      hand.appendChild(el);
    });
  }

  // 某张手牌当前是否可打出
  function isPlayable(v, c) {
    if (v.phase === 'play') {
      if (c.type === 'ion') return true;
      // 催化剂可在正常出牌轮（requiredPlays=1）当作离子打出
      if (c.id === 'catalyst') return (v.requiredPlays || 1) === 1;
      return false;
    }
    if (v.phase === 'response') {
      // 防守/中性道具可用，催化剂和离子不可用
      if (c.type !== 'item') return false;
      const def = ITEMS[c.id];
      return def && (def.kind === 'defense' || def.kind === 'neutral');
    }
    return false;
  }

  // 操作按钮区（确认结束道具阶段、取消选择等）
  function renderActions(v) {
    const bar = $('hand-actions');
    bar.innerHTML = '';
    if (!canActNow(ctx.state) || v.winner != null) return;

    if (v.phase === 'response') {
      bar.appendChild(mkBtn('确认结束道具阶段', 'btn', () => {
        doAction('confirmResponse', {});
      }));
    }
    if (ctx.pendingItem) {
      bar.appendChild(mkBtn('取消选择', 'btn-mini', () => {
        ctx.pendingItem = null; ctx.selection = null; render();
      }));
      const hintMap = {
        extract: '点击反应区中要取回手牌的离子',
        heat: '点击反应区中要移走的气体离子',
        neutralize: '点击反应区中要移走的 H⁺ 或 OH⁻',
      };
      banner(hintMap[ctx.pendingItem.itemId] || '请在反应区选择目标');
    }
  }

  function mkBtn(label, cls, fn) {
    const b = document.createElement('button');
    b.className = cls;
    b.textContent = label;
    b.addEventListener('click', fn);
    return b;
  }

  // 日志
  function renderLog(v) {
    const box = $('log');
    box.innerHTML = '';
    (v.log || []).slice(-60).forEach(line => {
      const e = document.createElement('div');
      e.className = 'entry';
      e.textContent = line;
      box.appendChild(e);
    });
    box.scrollTop = box.scrollHeight;
  }

  // ---- 交互：点击手牌 ----
  function onHandClick(v, card) {
    if (card.type === 'ion') {
      if (v.phase === 'play') return doAction('playIon', { uid: card.uid });
      return;
    }
    // 道具
    if (card.id === 'catalyst') {
      if (v.phase === 'play') return doAction('playCatalyst', { uid: card.uid });
      return;
    }
    // 需要点选目标的道具（response 阶段）
    if (['extract', 'heat', 'neutralize'].includes(card.id)) {
      ctx.pendingItem = { itemId: card.id, uid: card.uid };
      ctx.selection = { uid: card.uid };
      render();
      return;
    }
    // 过滤：默认处理第一对沉淀
    if (card.id === 'filter') {
      return doAction('playItem', { uid: card.uid, params: {} });
    }
    // 搅拌：直接生效
    if (card.id === 'stir') {
      return doAction('playItem', { uid: card.uid, params: {} });
    }
  }

  // ---- 交互：点击反应区目标（用于 extract/heat/neutralize）----
  function onZoneTargetClick(card) {
    if (!ctx.pendingItem) return;
    const { itemId, uid } = ctx.pendingItem;
    ctx.pendingItem = null;
    ctx.selection = null;
    doAction('playItem', { uid, params: { uid: card.uid } });
  }

  // ---- 结束模态 ----
  function showOver(v) {
    const mask = $('over-mask');
    const iWon = (ctx.mode === 'local')
      ? false // 本地热座无「我」，统一展示胜负双方
      : (v.winner === ctx.seat);
    const title = $('over-title');
    const sub = $('over-sub');
    if (ctx.mode === 'local') {
      title.textContent = '🏆 ' + v.players[v.winner].name + ' 获胜！';
      title.className = 'win';
      sub.textContent = v.players[v.loser].name + ' 触发了无法解除的反应。';
    } else {
      title.textContent = iWon ? '🏆 你赢了！' : '💧 你输了';
      title.className = iWon ? 'win' : 'lose';
      sub.textContent = iWon ? '对手触发了无法解除的反应。' : '你触发了无法解除的反应。';
    }
    mask.classList.add('show');
  }

  // ---- 模态与顶栏按钮 ----
  $('btn-again').addEventListener('click', () => {
    $('over-mask').classList.remove('show');
    if (ctx.mode === 'local') {
      ctx.state = Engine.createGame({ playerNames: launch.playerNames || ['玩家1', '玩家2'] });
      ctx.selection = null; ctx.pendingItem = null;
      render();
    } else if (ctx.role === 'host') {
      const names = ctx.state ? ctx.state.players.map(p => p.name) : ['玩家1', '玩家2'];
      ctx.state = Engine.createGame({ playerNames: names });
      Network.pushState(ctx.roomCode, ctx.state).then(render);
    } else {
      banner('等待房主开始新一局…');
    }
  });
  $('btn-home').addEventListener('click', () => { cleanup(); location.href = 'index.html'; });
  $('btn-quit').addEventListener('click', () => {
    if (confirm('确定退出当前对局？')) { cleanup(); location.href = 'index.html'; }
  });

  function cleanup() {
    if (ctx.sub) { try { ctx.sub.close(); } catch (_) {} }
    sessionStorage.removeItem('nr_launch');
  }
  window.addEventListener('beforeunload', cleanup);

  boot();
})();
