/**
 * 新手教程模块 —— 覆盖层引导式。
 * 在真实游戏 UI 上叠加聚光灯 + 对话框，脚本化游戏状态，逐步引导新手操作。
 *
 * 浏览器中导出 window.Tutorial；Node 中导出 module.exports（供冒烟测试驱动真实步骤）。
 * 两端共用同一份步骤定义与 _applyAuto 执行器，避免测试与运行时漂移。
 */
(function () {
  'use strict';

  // Engine 解析：浏览器取全局，Node 取 require（让步骤逻辑可离线测试）。
  var Engine = (typeof window !== 'undefined' && window.Engine) ||
    (typeof require !== 'undefined' ? require('./engine.js') : null);

  const $ = function (id) {
    return (typeof document !== 'undefined') ? document.getElementById(id) : null;
  };

  // ---- 私有状态 ----
  let _state = null;         // Engine state
  let _renderFn = null;      // ui.js render()
  let _rawDoAction = null;   // bypass tutorial gate, apply engine action directly
  let _currentStep = 0;
  let _active = false;
  let _timer = null;         // auto-play timer
  let _stepCtx = {};         // inter-step context (stores UIDs etc.)
  // 步骤代际令牌：每次步骤切换 +1。所有异步回调（定时器 / onNext 播放完成）
  // 在恢复时校验自己启动时的代际是否仍是当前代际，过期则直接放弃，
  // 杜绝“上一步遗留的回调把当前步骤又推进一格”导致的连跳多个对话框。
  let _gen = 0;

  // ---- DOM 缓存 ----
  let _overlay, _spotlight, _dialog, _dialogText, _nextBtn, _skipBtn;

  // ---- 步骤定义 ----
  // 教程是一段连贯的对局：你先在自己的回合体验「出牌→引发反应→防守解除→结束」，
  // 再观察对手回合，然后学习两张攻击道具，最后逼对手触发反应取胜。
  // 每个 setup 尽量承接上一步的真实棋面，避免“瞬移”到陌生局面。
  const _steps = [
    // ── 步骤 0：欢迎（铺设第一回合棋面）──
    {
      id: 'welcome',
      text: '欢迎来到 <b>No Reaction</b>！<br><br>这是一款化学离子卡牌对战游戏。双方轮流往<b>反应区</b>打出离子牌——谁打出的牌触发了<b>沉淀</b>或<b>气体</b>反应、又无法解除，谁就输掉这一局。<br><br>先从你的回合开始。注意看，反应区里已经有对手留下的一张 <b>SO₄²⁻</b>（硫酸根）。',
      target: null,
      expected: null,
      dialogPos: 'center',
      setup: function (s) {
        _initCleanState(s);
        s.phase = 'play';
        s.activePlayer = 0;
        s.players[0].hand = [];
        // 只给两张牌，避免新手在第一步纠结：一张会引发反应的离子 + 一张解药
        _giveCard(s, 0, 'ion', 'Ba');
        _giveCard(s, 0, 'item', 'filter');
        _stepCtx.baUid = s.players[0].hand[0].uid;
        s.players[1].hand = [];
        _giveCard(s, 1, 'ion', 'Na');
        // 反应区预置 SO₄²⁻，等待学员的 Ba²⁺ 来“引爆”
        s.zone = [];
        _seedZone(s, 'SO4');
      }
    },

    // ── 步骤 1：打出离子牌（亲手引发反应）──
    {
      id: 'play-ion',
      text: '点击你手里的 <b>Ba²⁺</b>（钡离子）把它打到反应区。<br><br>留意它和已有的 SO₄²⁻ 会发生什么。',
      target: function () { return _findCardInHand('ion', 'Ba'); },
      expected: 'playIon',
      dialogPos: 'auto',
      hint: '点击高亮的 Ba²⁺ 离子牌打出',
      setup: function () { /* 承接步骤 0 的棋面，无需重置 */ }
    },

    // ── 步骤 2：观察反应（由上一步自然产生）──
    {
      id: 'see-reaction',
      text: '⚠ 你打出的 <b>Ba²⁺</b> 和 <b>SO₄²⁻</b> 结合成了 <b>BaSO₄↓ 沉淀</b>！<br><br>现在如果直接「确认结束」，你就判负了。好在你手里还有一张 <b>「过滤」</b>道具，可以移走这对沉淀离子。',
      target: function () { return $('zone'); },
      expected: null,
      dialogPos: 'auto',
      hint: '请点击「下一步」继续',
      setup: function () { /* 连贯承接，不重置棋面 */ }
    },

    // ── 步骤 3：使用过滤（解除自己造成的反应）──
    {
      id: 'use-filter',
      text: '点击手里的 <b>「过滤」</b>道具，移走反应区里那对沉淀离子。',
      target: function () { return _findCardInHand('item', 'filter'); },
      expected: 'playItem',
      expectedItemId: 'filter',
      dialogPos: 'auto',
      hint: '点击高亮的「过滤」道具牌',
      setup: function () { /* 连贯承接 */ }
    },

    // ── 步骤 4：确认结束 ──
    {
      id: 'confirm-response',
      text: '反应区已经安全（没有沉淀或气体反应）。<br><br>点击 <b>「确认结束」</b> 按钮，结束你这一回合。',
      target: function () { return document.querySelector('#hand-actions .btn'); },
      expected: 'confirmResponse',
      dialogPos: 'auto',
      hint: '点击下方的「确认结束道具阶段」按钮',
      setup: function () { /* 过滤已消耗、zone 已空，连贯承接 */ }
    },


    // ── 步骤 5：对手回合（点「下一步」后播放）──
    {
      id: 'opponent-turn',
      text: '你的回合结束了，轮到对手「教程助手」。<br><br>点「下一步」，看它往反应区打出一张离子牌——留意反应区有没有变化。',
      target: function () { return $('zone'); },
      expected: null,
      dialogPos: 'auto',
      hint: '请点击「下一步」继续',
      setup: function (s) {
        // 步骤 4 确认结束后，回合已自动切到对手（seat 1）。
        // 给对手一张安全离子（Na⁺ 不与空反应区反应），让新手看清“出牌但不触发”的常态。
        s.activePlayer = 1;
        s.phase = 'play';
        s.playsThisTurn = 0;
        s.requiredPlays = 1;
        s.zone = [];
        s.players[1].hand = [];
        _giveCard(s, 1, 'ion', 'Na');
        _stepCtx.oppIonUid = s.players[1].hand[0].uid;
        // 关键：先给“你”补一张离子。对手回合结束后会自动 startTurn 切回你，
        // 若此刻你手里没有离子，会触发惩罚（额外摸牌 + 道具飞给对手），
        // 一连串卡牌动画会让新手误以为“对手连出了两张道具”。补一张离子即可避免。
        s.players[0].forcedIons = 0;
        s.players[0].hand = [];
        _giveCard(s, 0, 'ion', 'Cl');
      },
      // 点「下一步」时才播放：对手出牌（停顿看清）→ 确认结束，播完再进入下一步。
      onNext: function (done) {
        _autoPlay([
          { type: 'playIon', pick: 'ion', seat: 1, delay: 450 },
          { type: 'confirmResponse', seat: 1, delay: 650 },
        ], done);
      }
    },

    // ── 步骤 6：使用催化剂 ──
    {
      id: 'play-catalyst',
      text: '又轮到你了。除了普通离子，你还能打<b>攻击道具</b>。<br><br>先试 <b>「催化剂」</b>——它替代离子牌打出，自己不往反应区放东西，但<b>对手下回合必须连出 2 张离子牌</b>，更容易踩雷。',
      target: function () { return _findCardInHand('item', 'catalyst'); },
      expected: 'playCatalyst',
      expectedItemId: 'catalyst',
      dialogPos: 'auto',
      hint: '点击高亮的「催化剂」攻击道具',
      setup: function (s) {
        // 对手回合结束后回到你（seat 0）。给一手含催化剂的牌。
        s.phase = 'play';
        s.activePlayer = 0;
        s.playsThisTurn = 0;
        s.requiredPlays = 1;
        s.players[0].forcedIons = 0;
        s.players[0].hand = [];
        _giveCard(s, 0, 'item', 'catalyst');
        _giveCard(s, 0, 'ion', 'Cl');
        _stepCtx.catalystUid = s.players[0].hand[0].uid;
      }
    },

    // ── 步骤 7：使用挥发 ──
    {
      id: 'play-volatilize',
      text: '催化剂打出了，对手下回合会被迫连出 2 张离子牌。<br><br>再认识一张攻击道具 <b>「挥发」</b>——打出后<b>让对手随机弃掉 2 张手牌</b>，直接削弱它的防守能力。',
      target: function () { return _findCardInHand('item', 'volatilize'); },
      expected: 'playAttackItem',
      expectedItemId: 'volatilize',
      dialogPos: 'auto',
      hint: '点击高亮的「挥发」攻击道具',
      setup: function (s) {
        // 催化剂回合结束后的新回合（仍是你，用于连续教学两张道具）。
        s.phase = 'play';
        s.activePlayer = 0;
        s.playsThisTurn = 0;
        s.requiredPlays = 1;
        s.players[0].forcedIons = 0;
        s.players[1].forcedIons = 0;
        s.players[0].hand = [];
        _giveCard(s, 0, 'item', 'volatilize');
        _giveCard(s, 0, 'ion', 'Cl');
        s.players[1].hand = [];
        _giveCard(s, 1, 'ion', 'Na');
        _giveCard(s, 1, 'item', 'stir');
        _stepCtx.volUid = s.players[0].hand[0].uid;
      }
    },

    // ── 步骤 8：对手惩罚（自动播放）──
    {
      id: 'opponent-penalty',
      text: '你的攻势让对手陷入困境：轮到它时，它手里<b>既没有离子牌、也没有攻击道具</b>，触发了<b>惩罚</b>！<br><br>惩罚规则：额外摸 2 张牌，其中摸到的道具直接送给对手（也就是你）。',
      target: function () { return $('zone'); },
      expected: null,
      dialogPos: 'auto',
      hint: '请点击「下一步」继续',
      setup: function (s) {
        // 切到对手回合，且对手手里只有道具、没有离子 → startTurn 触发惩罚。
        s.phase = 'play';
        s.activePlayer = 1;
        s.playsThisTurn = 0;
        s.requiredPlays = 1;
        s.players[1].forcedIons = 0;
        s.players[0].forcedIons = 0;
        s.players[1].hand = [];
        _giveCard(s, 1, 'item', 'heat');
      },
      onNext: function (done) {
        // 点「下一步」后才播放：startTurn 触发惩罚（停顿看清）→ 确认结束。
        _autoPlay([
          { type: '_startTurn', seat: 1, delay: 450 },
          { type: 'confirmResponse', seat: 1, delay: 650 },
        ], done);
      }
    },

    // ── 步骤 9：胜利（点「下一步」后播放）──
    {
      id: 'win',
      text: '最后一击：反应区里有你留下的 <b>Ba²⁺</b>。点「下一步」，看对手被迫打出 <b>SO₄²⁻</b>——凑成 <b>BaSO₄↓ 沉淀</b>，而它手里没有任何道具能解除。',
      target: function () { return $('zone'); },
      expected: null,
      dialogPos: 'auto',
      hint: '请点击「下一步」继续',
      setup: function (s) {
        s.phase = 'play';
        s.activePlayer = 1;
        s.playsThisTurn = 0;
        s.requiredPlays = 1;
        s.players[1].forcedIons = 0;
        s.players[0].forcedIons = 0;
        s.players[1].hand = [];
        _giveCard(s, 1, 'ion', 'SO4');
        _stepCtx.oppIon2Uid = s.players[1].hand[0].uid;
        s.zone = [];
        _seedZone(s, 'Ba');
        s.players[0].hand = [];
      },
      onNext: function (done) {
        _autoPlay([
          { type: 'playIon', pick: 'ion', seat: 1, delay: 450 },
          { type: 'confirmResponse', seat: 1, delay: 650 },
        ], done);
      }
    },

    // ── 步骤 10：完成 ──
    {
      id: 'completion',
      text: '🎉 <b>恭喜完成新手教程！</b><br><br>你已经掌握了：<br>• 打出离子牌、观察反应区<br>• 用防守道具（过滤）解除沉淀<br>• 用攻击道具（催化剂 / 挥发）压制对手<br>• 逼对手触发反应取胜<br><br>想随时查阅每张牌的作用，点顶栏的 <b>📖 百科</b>。现在去开一局真正的对战吧！',
      target: null,
      expected: null,
      dialogPos: 'center',
      setup: function () {}
    }
  ];

  // ---- 内部辅助 ----
  function _initCleanState(s) {
    s.players[0].hand = [];
    s.players[1].hand = [];
    s.zone = [];
    s.phase = 'play';
    s.activePlayer = 0;
    s.playsThisTurn = 0;
    s.requiredPlays = 1;
    s.players[0].forcedIons = 0;
    s.players[1].forcedIons = 0;
    s.winner = null;
    s.loser = null;
    s.log = [];
    s.pendingDisplace = null;
  }

  function _giveCard(s, idx, type, id) {
    var c = Engine._internal.makeCard(type, id);
    s.players[idx].hand.push(c);
    return c.uid;
  }

  function _seedZone(s, id) {
    var c = Engine._internal.makeCard('ion', id);
    s.zone.push(c);
    return c.uid;
  }

  function _findCardInHand(type, id) {
    var hand = document.querySelectorAll('#hand .card');
    for (var i = 0; i < hand.length; i++) {
      var uid = parseInt(hand[i].dataset.uid, 10);
      if (isNaN(uid)) continue;
      // 用 state 反查卡牌信息
      var card = _findCardByUid(uid);
      if (card && card.type === type && card.id === id) return hand[i];
    }
    return null;
  }

  function _findCardByUid(uid) {
    for (var p = 0; p < _state.players.length; p++) {
      for (var j = 0; j < _state.players[p].hand.length; j++) {
        if (_state.players[p].hand[j].uid === uid) return _state.players[p].hand[j];
      }
    }
    for (var k = 0; k < _state.zone.length; k++) {
      if (_state.zone[k].uid === uid) return _state.zone[k];
    }
    return null;
  }

  // 聚光灯定位
  function _positionSpotlight(step) {
    if (!_spotlight) return;
    var target = null;
    if (typeof step.target === 'function') {
      target = step.target();
    }
    if (!target) {
      _spotlight.style.display = 'none';
      _positionDialog(null, step.dialogPos || 'center');
      return;
    }
    var rect = target.getBoundingClientRect();
    var pad = 8;
    _spotlight.style.display = 'block';
    _spotlight.style.left = (rect.left - pad) + 'px';
    _spotlight.style.top = (rect.top - pad) + 'px';
    _spotlight.style.width = (rect.width + pad * 2) + 'px';
    _spotlight.style.height = (rect.height + pad * 2) + 'px';
    _positionDialog(rect, step.dialogPos || 'auto');
  }

  // 对话框定位：视口感知，自动在目标上/下方择优摆放，并用箭头指向目标。
  function _positionDialog(targetRect, pos) {
    if (!_dialog) return;
    var vw = window.innerWidth;
    var vh = window.innerHeight;
    var margin = 14;          // 距视口边缘
    var gap = 14;             // 对话框与目标的间距
    var dw = Math.min(340, vw - margin * 2);
    var dh = _dialog.offsetHeight || 180;
    var left, top, arrow = 'none';

    // 无目标 / 居中：放在视口下三分之一，避免遮住上方的反应区
    if (!targetRect || pos === 'center') {
      left = (vw - dw) / 2;
      top = Math.min(vh - dh - margin, vh * 0.58);
      _applyDialog(left, top, 'none');
      return;
    }

    // 水平居中对齐目标，并夹在视口内
    var cx = targetRect.left + targetRect.width / 2;
    left = Math.max(margin, Math.min(vw - dw - margin, cx - dw / 2));

    // 计算上方 / 下方可用空间
    var spaceAbove = targetRect.top - gap - margin;
    var spaceBelow = vh - targetRect.bottom - gap - margin;

    var place = pos;
    if (pos === 'auto' || (pos !== 'above' && pos !== 'below')) {
      // 优先放在空间更充足的一侧
      place = spaceBelow >= dh ? 'below'
            : spaceAbove >= dh ? 'above'
            : (spaceBelow >= spaceAbove ? 'below' : 'above');
    } else if (pos === 'above' && spaceAbove < dh && spaceBelow >= dh) {
      place = 'below'; // 上方放不下则翻到下方
    } else if (pos === 'below' && spaceBelow < dh && spaceAbove >= dh) {
      place = 'above';
    }

    if (place === 'above') {
      top = Math.max(margin, targetRect.top - dh - gap);
      arrow = 'down';
    } else {
      top = Math.min(vh - dh - margin, targetRect.bottom + gap);
      arrow = 'up';
    }

    // 箭头水平位置：对准目标中心（相对对话框左缘）
    var arrowX = Math.max(16, Math.min(dw - 16, cx - left));
    _dialog.style.setProperty('--arrow-x', arrowX + 'px');
    _applyDialog(left, top, arrow);
  }

  function _applyDialog(left, top, arrow) {
    _dialog.style.left = left + 'px';
    _dialog.style.top = top + 'px';
    _dialog.setAttribute('data-arrow', arrow);
  }

  // 应用一个自动动作到 state（纯逻辑，无 DOM / 无定时器）。
  // 供运行时定时驱动与离线冒烟测试共用，是“对手自动行动”的唯一真相来源。
  // act: { type, seat?, uid?, pick? }
  //   pick: 'ion' → 取该 seat 手牌中第一张离子牌的 uid（省去跨步骤记 uid）。
  function _applyAuto(state, act) {
    var seat = act.seat != null ? act.seat : state.activePlayer;
    if (act.type === '_startTurn') {
      state.players[seat].forcedIons = state.players[seat].forcedIons || 0;
      return Engine.startTurn(state, seat, false);
    }
    if (act.type === 'confirmResponse') {
      return Engine.confirmResponse(state, seat);
    }
    if (act.type === 'playIon') {
      var uid = act.uid;
      if (uid == null && act.pick === 'ion') {
        var ion = (state.players[seat].hand || []).find(function (c) { return c.type === 'ion'; });
        uid = ion && ion.uid;
      }
      return Engine.playIon(state, seat, uid);
    }
    if (act.type === 'playItem') {
      return Engine.playItem(state, seat, act.uid, act.params || {});
    }
    return { ok: false, msg: '未知自动动作: ' + act.type };
  }

  // 自动播放对手动作（定时执行 _applyAuto，并在每步后重渲染）
  // 绑定启动时的代际：若中途步骤被切换（_gen 变化），立即中止，不再执行后续动作，
  // 也不调用 onDone，避免把已经不属于当前步骤的流程继续推进。
  function _autoPlay(actions, onDone) {
    var myGen = _gen;
    function run(i) {
      if (!_active || myGen !== _gen) return;        // 步骤已切换，放弃
      if (i >= actions.length) { if (onDone) onDone(); return; }
      var act = actions[i];
      _timer = setTimeout(function () {
        if (!_active || myGen !== _gen) return;       // 触发时再次校验
        _applyAuto(_state, act);
        _renderFn();
        run(i + 1);
      }, act.delay || 600);
    }
    run(0);
  }

  // 重定位一次聚光灯/弹窗，兜底布局回流（如字体加载、滚动条出现导致的尺寸变化）。
  // 教程已禁用摸牌飞入动画（见 ui.js），卡牌渲染即落位，无需多档反复校正。
  var _settleTimers = [];
  function _clearSettle() {
    for (var i = 0; i < _settleTimers.length; i++) clearTimeout(_settleTimers[i]);
    _settleTimers = [];
  }
  function _scheduleSettle(step) {
    _clearSettle();
    // 仅对有高亮目标的步骤需要校正（居中弹窗与目标无关）
    if (typeof step.target !== 'function') return;
    _settleTimers.push(setTimeout(function () {
      if (_active && _steps[_currentStep] === step) _positionSpotlight(step);
    }, 260));
  }

  // 前进到下一步。done(): 对话框真正显示到屏幕后回调（用于释放推进锁）。
  function _advance(done) {
    if (_currentStep >= _steps.length) {
      Tutorial.skip();
      return;
    }
    var step = _steps[_currentStep];
    var myGen = _gen;
    if (step.setup) step.setup(_state);
    _renderFn();

    // 等 DOM 更新后：先显示对话框（获取真实高度），再定位
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        // 渲染后若步骤已被切换（理论上不会，双保险），放弃本次显示
        if (!_active || myGen !== _gen) { if (done) done(); return; }
        _showDialog(step);
        _positionSpotlight(step);
        // 新发的手牌会从牌堆飞入（animateDraw，约 350ms+ 带错位），
        // 飞行途中 getBoundingClientRect 取到的是牌堆附近的瞬时位置（右上角）。
        // 待动画落定后再重定位一次，让弹窗对准卡牌的最终位置。
        _scheduleSettle(step);
        if (done) done();
      });
    });
  }

  // 点「下一步」：唯一的“讲解类步骤”推进入口。
  // - _busy 防抖：从点击直到新对话框真正出现在屏幕上，全程上锁；
  //   期间任何重复点击 / 重入（含 render 触发）都被忽略，避免一次推进多个对话框；
  // - 清掉上一步遗留的自动播放/校正定时器，杜绝串台；
  // - 若当前步骤声明了 onNext（对手自动行动），先播完再进入下一步。
  var _busy = false;
  function _goNext() {
    if (!_active || _busy) return;
    var step = _steps[_currentStep];
    if (!step) { Tutorial.skip(); return; }

    // 最后一步：按钮即“开始对战”
    if (_currentStep >= _steps.length - 1) {
      Tutorial.skip();
      return;
    }

    _busy = true;
    if (_timer) { clearTimeout(_timer); _timer = null; }
    _clearSettle();
    _gen++;                       // 进入新一轮推进，作废所有在途回调
    var myGen = _gen;

    function proceed() {
      _hideDialog();
      _currentStep++;
      // 锁持续到新对话框真正显示之后再释放，覆盖 rAF 间隙，杜绝重入连跳。
      _advance(function () { _busy = false; });
    }

    if (typeof step.onNext === 'function') {
      // 播放期间禁用按钮并提示，给出“进行中”反馈
      _nextBtn.disabled = true;
      var _label = _nextBtn.textContent;
      _nextBtn.textContent = '对手行动中…';
      step.onNext(function () {
        // onNext 播放完成回调：若期间已被 skip 或步骤被切换，则不推进。
        if (!_active || myGen !== _gen) { _busy = false; return; }
        _nextBtn.disabled = false;
        _nextBtn.textContent = _label;
        proceed();
      });
    } else {
      proceed();
    }
  }

  function _showDialog(step) {
    if (!_dialogText || !_dialog) return;
    _dialogText.innerHTML = step.text;

    var isLast = (_currentStep >= _steps.length - 1);
    _nextBtn.disabled = false;
    _nextBtn.textContent = isLast ? '开始对战' : '下一步';

    if (step.expected === null) {
      // 讲解类步骤：显示「下一步 / 开始对战」；最后一步隐藏「跳过」。
      _nextBtn.style.display = '';
      _skipBtn.style.display = isLast ? 'none' : '';
    } else {
      // 用户需要亲自操作：隐藏下一步按钮，保留跳过
      _nextBtn.style.display = 'none';
      _skipBtn.style.display = '';
    }
    _dialog.classList.add('show');
  }

  function _hideDialog() {
    if (_dialog) _dialog.classList.remove('show');
  }

  // ---- 公开 API ----
  var Tutorial = {
    init: function (state, renderFn, rawDoAction) {
      _state = state;
      _renderFn = renderFn;
      _rawDoAction = rawDoAction;
      _overlay = $('tutorial-overlay');
      _spotlight = document.querySelector('.tutorial-spotlight');
      _dialog = document.querySelector('.tutorial-dialog');
      _dialogText = $('tutorial-dialog-text');
      _nextBtn = $('tutorial-next');
      _skipBtn = $('tutorial-skip');

      if (_nextBtn) {
        _nextBtn.addEventListener('click', function () { _goNext(); });
      }
      if (_skipBtn) {
        _skipBtn.addEventListener('click', function () {
          Tutorial.skip();
        });
      }
    },

    start: function () {
      _currentStep = 0;
      _active = true;
      _busy = false;
      _gen++;
      _stepCtx = {};
      _overlay.classList.add('active');
      document.body.classList.add('tutorial-active');
      _advance();
    },

    // ui.js doAction 调用此方法校验动作
    checkAction: function (type, payload) {
      if (!_active) return { allowed: true };
      var step = _steps[_currentStep];
      if (!step) return { allowed: false, msg: '教程已完成' };
      if (step.expected === null) {
        return { allowed: false, msg: '请先点击「下一步」继续教程' };
      }
      if (type !== step.expected) {
        return { allowed: false, msg: step.hint || '请按教程指引操作' };
      }
      // 道具类动作：若步骤声明了 expectedItemId，则校验打出的正是那张道具。
      // 用数据字段而非按 step.id 硬编码，新增道具教学步骤时无需改动这里。
      if (step.expectedItemId &&
          (type === 'playItem' || type === 'playAttackItem' || type === 'playCatalyst')) {
        var card = _findCardByUid(payload.uid);
        if (!card || card.id !== step.expectedItemId) {
          var def = (window.CARD_CONFIG && CARD_CONFIG.ITEMS[step.expectedItemId]) || null;
          return { allowed: false, msg: '请使用「' + (def ? def.name : step.expectedItemId) + '」道具' };
        }
      }
      return { allowed: true };
    },

    // ui.js doAction 在校验通过并执行后调用
    onActionTaken: function () {
      if (!_active || _busy) return;
      _busy = true;
      _hideDialog();
      _clearSettle();
      _currentStep++;
      _gen++;                                  // 作废在途回调
      var myGen = _gen;
      if (_timer) clearTimeout(_timer);
      _timer = setTimeout(function () {
        if (!_active || myGen !== _gen) { _busy = false; return; }
        _advance(function () { _busy = false; });
      }, 300);
    },

    _onPostRender: function () {
      if (!_active) return;
      var step = _steps[_currentStep];
      if (step) _positionSpotlight(step);
    },

    skip: function () {
      _active = false;
      _busy = false;
      _gen++;
      if (_timer) clearTimeout(_timer);
      _clearSettle();
      if (_overlay) _overlay.classList.remove('active');
      document.body.classList.remove('tutorial-active');
      if (_dialog) _dialog.classList.remove('show');
      if (_spotlight) _spotlight.style.display = 'none';
      sessionStorage.removeItem('nr_launch');
      location.href = 'index.html';
    },

    isActive: function () { return _active; },

    // 仅供测试 / 调试：暴露步骤定义与执行器，便于离线驱动整条教程流程。
    _test: {
      steps: _steps,
      applyAuto: _applyAuto,
      giveCard: _giveCard,
      seedZone: _seedZone,
      initCleanState: _initCleanState,
      // 用脚手架 state 跑某一步的 setup（不依赖 DOM）
      runSetup: function (state, i) {
        _state = state;
        if (_steps[i] && _steps[i].setup) _steps[i].setup(state);
      }
    }
  };

  if (typeof window !== 'undefined') window.Tutorial = Tutorial;
  if (typeof module !== 'undefined' && module.exports) module.exports = Tutorial;
})();
