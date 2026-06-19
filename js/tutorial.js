/**
 * 新手教程模块 —— 覆盖层引导式。
 * 在真实游戏 UI 上叠加聚光灯 + 对话框，脚本化游戏状态，逐步引导新手操作。
 *
 * 导出 window.Tutorial（IIFE 模式，与其余 JS 模块一致）。
 */
(function () {
  'use strict';

  const $ = function (id) { return document.getElementById(id); };

  // ---- 私有状态 ----
  let _state = null;         // Engine state
  let _renderFn = null;      // ui.js render()
  let _rawDoAction = null;   // bypass tutorial gate, apply engine action directly
  let _currentStep = 0;
  let _active = false;
  let _timer = null;         // auto-play timer
  let _stepCtx = {};         // inter-step context (stores UIDs etc.)

  // ---- DOM 缓存 ----
  let _overlay, _spotlight, _dialog, _dialogText, _nextBtn, _skipBtn;

  // ---- 步骤定义 ----
  const _steps = [
    // ── 步骤 0：欢迎 ──
    {
      id: 'welcome',
      text: '欢迎来到 <b>No Reaction</b>！<br><br>这是一款化学离子卡牌对战游戏。你和对手轮流往<b>反应区</b>打出离子牌——但要小心，如果反应区中形成了<b>沉淀</b>或<b>气体</b>反应，你就会输掉这一局。<br><br>准备好学习基础操作了吗？点击「下一步」开始。',
      target: null,
      expected: null,
      dialogPos: 'center',
      setup: function (s) {
        _initCleanState(s);
      }
    },

    // ── 步骤 1：打出离子牌 ──
    {
      id: 'play-ion',
      text: '这是你的<b>手牌区</b>。现在请点击一张<b>离子牌</b>（有红色或蓝色顶边的牌）打出到反应区。',
      target: function () { return _findCardInHand('ion', 'Ba'); },
      expected: 'playIon',
      dialogPos: 'above',
      hint: '点击手牌中带颜色的离子牌即可打出',
      setup: function (s) {
        _initCleanState(s);
        s.phase = 'play';
        s.activePlayer = 0;
        s.playsThisTurn = 0;
        s.requiredPlays = 1;
        s.players[0].hand = [];
        s.players[1].hand = [];
        // 给学员几张牌
        _giveCard(s, 0, 'ion', 'Ba');
        _giveCard(s, 0, 'item', 'filter');
        _giveCard(s, 0, 'ion', 'Na');
        _stepCtx.targetUid = s.players[0].hand[0].uid; // Ba²⁺
      }
    },

    // ── 步骤 2：观察反应 ──
    {
      id: 'see-reaction',
      text: '⚠ 反应区中出现了<b>沉淀反应 BaSO₄↓</b>！<br><br>如果不处理而直接「确认结束」，你就会输掉。好消息是，你手牌中有一张<b>「过滤」</b>道具可以解除它。',
      target: function () { return document.querySelector('#zone .card'); },
      expected: null,
      dialogPos: 'above',
      hint: '请点击「下一步」继续',
      setup: function (s) {
        _initCleanState(s);
        s.phase = 'response';
        s.activePlayer = 0;
        s.zone = [];
        _seedZone(s, 'Ba');
        _seedZone(s, 'SO4');
        s.players[0].hand = [];
        _giveCard(s, 0, 'item', 'filter');
        _stepCtx.filterUid = s.players[0].hand[0].uid;
        s.players[1].hand = [];
        _giveCard(s, 1, 'ion', 'Na');
      }
    },

    // ── 步骤 3：使用过滤 ──
    {
      id: 'use-filter',
      text: '点击手牌中的<b>「过滤」</b>道具来移除反应区中的沉淀离子。',
      target: function () { return _findCardInHand('item', 'filter'); },
      expected: 'playItem',
      dialogPos: 'above',
      hint: '点击手牌中金色的「过滤」道具牌',
      setup: function (s) {
        // 保持上一步的状态
        // 不做额外 setup，由步骤 2 的 onEnter 效果衔接
      }
    },

    // ── 步骤 4：确认结束 ──
    {
      id: 'confirm-response',
      text: '反应区已安全（无沉淀或气体反应）。现在点击<b>「确认结束」</b>按钮结束你的道具阶段。',
      target: function () { return document.querySelector('#hand-actions .btn'); },
      expected: 'confirmResponse',
      dialogPos: 'above',
      hint: '点击下方的「确认结束道具阶段」按钮',
      setup: function (s) {
        // 过滤已消耗，zone 为空，phase 已是 response（由前一步结算）
      }
    },

    // ── 步骤 5：对手回合（自动播放）──
    {
      id: 'opponent-turn',
      text: '现在轮到对手「教程助手」操作。对手会打出一张离子牌到反应区。<br><br>观察对手的动作，注意反应区的变化。',
      target: null,
      expected: null,
      dialogPos: 'center',
      hint: '请点击「下一步」继续',
      setup: function (s) {
        // 确认结束后 turn 已切换到对手
        // 再额外准备对手手牌
        s.players[1].hand = [];
        _giveCard(s, 1, 'ion', 'Cl');
        _stepCtx.oppIonUid = s.players[1].hand[0].uid;
      },
      onEnter: function () {
        // 自动执行对手出牌（seat=1），完成后等待用户点击下一步
        _autoPlay([
          { type: 'playIon', uid: _stepCtx.oppIonUid, seat: 1, delay: 800 },
        ], function () {
          _autoPlay([
            { type: 'confirmResponse', seat: 1, delay: 500 },
          ]);
        });
      }
    },

    // ── 步骤 6：使用催化剂 ──
    {
      id: 'play-catalyst',
      text: '现在到你出牌。试试<b>攻击道具「催化剂」</b>——它替代离子牌打出，不往反应区放东西，但<b>对手下回合必须连续出 2 张离子牌</b>！',
      target: function () { return _findCardInHand('item', 'catalyst'); },
      expected: 'playCatalyst',
      dialogPos: 'above',
      hint: '点击手牌中红色的「催化剂」攻击道具',
      setup: function (s) {
        // 设置玩家回合
        s.phase = 'play';
        s.activePlayer = 0;
        s.playsThisTurn = 0;
        s.requiredPlays = 1;
        s.players[0].hand = [];
        _giveCard(s, 0, 'item', 'catalyst');
        _giveCard(s, 0, 'ion', 'Na');
        _giveCard(s, 0, 'ion', 'Cl');
        _stepCtx.catalystUid = s.players[0].hand[0].uid;
        s.zone = [];
        _seedZone(s, 'SO4');
      }
    },

    // ── 步骤 7：使用挥发 ──
    {
      id: 'play-volatilize',
      text: '再来试试<b>攻击道具「挥发」</b>——打出的回合会<b>让对手随机弃置 2 张手牌</b>。这是削弱对手防御的好办法！',
      target: function () { return _findCardInHand('item', 'volatilize'); },
      expected: 'playAttackItem',
      dialogPos: 'above',
      hint: '点击手牌中红色的「挥发」攻击道具',
      setup: function (s) {
        // 催化剂已打出，现在给新回合
        s.phase = 'play';
        s.activePlayer = 0;
        s.playsThisTurn = 0;
        s.requiredPlays = 1;
        s.players[0].forcedIons = 0;
        s.players[1].forcedIons = 0;
        s.players[0].hand = [];
        _giveCard(s, 0, 'item', 'volatilize');
        _giveCard(s, 0, 'ion', 'Fe');
        s.players[1].hand = [];
        _giveCard(s, 1, 'ion', 'Na');
        _giveCard(s, 1, 'item', 'stir');
        _giveCard(s, 1, 'ion', 'SO4');
        _stepCtx.volUid = s.players[0].hand[0].uid;
        s.zone = [];
        _seedZone(s, 'Cl');
      }
    },

    // ── 步骤 8：对手惩罚（自动播放）──
    {
      id: 'opponent-penalty',
      text: '现在轮到对手。但对手手牌中<b>既没有离子牌也没有攻击道具</b>，触发了<b>惩罚阶段</b>！<br><br>惩罚：额外摸 2 张牌，摸到的道具交给对手。',
      target: null,
      expected: null,
      dialogPos: 'center',
      hint: '请点击「下一步」继续',
      setup: function (s) {
        // 挥发打出后进入 response → confirm → 轮到对手
        // 手动设置对手的回合，让其触发惩罚
        s.phase = 'play';
        s.activePlayer = 1;
        s.playsThisTurn = 0;
        s.requiredPlays = 1;
        s.players[1].forcedIons = 0;
        s.players[1].hand = [];
        // 只给道具，不给离子 → 触发惩罚
        _giveCard(s, 1, 'item', 'heat');
        s.players[0].forcedIons = 0;
      },
      onEnter: function () {
        // 触发对手 startTurn → 惩罚 → 自动确认，完成后等待用户点击下一步
        _autoPlay([
          { type: '_startTurn', seat: 1, delay: 500 },
          { type: 'confirmResponse', seat: 1, delay: 900 },
        ]);
      }
    },

    // ── 步骤 9：胜利（自动播放）──
    {
      id: 'win',
      text: '现在对手打出离子牌触发了<b>无法解除的反应</b>——你赢了！🎉<br><br>这就是 No Reaction 的核心：<b>让对手触发反应，同时保护自己。</b>',
      target: null,
      expected: null,
      dialogPos: 'center',
      hint: '请点击「下一步」继续',
      setup: function (s) {
        s.phase = 'play';
        s.activePlayer = 1;
        s.playsThisTurn = 0;
        s.requiredPlays = 1;
        s.players[1].forcedIons = 0;
        s.players[1].hand = [];
        _giveCard(s, 1, 'ion', 'SO4');
        _stepCtx.oppIon2Uid = s.players[1].hand[0].uid;
        s.zone = [];
        _seedZone(s, 'Ba');
        s.players[0].hand = [];
      },
      onEnter: function () {
        // 自动执行对手出牌触发反应 → 判负，完成后等待用户点击下一步
        _autoPlay([
          { type: 'playIon', uid: _stepCtx.oppIon2Uid, seat: 1, delay: 800 },
        ], function () {
          _autoPlay([
            { type: 'confirmResponse', seat: 1, delay: 500 },
          ]);
        });
      }
    },

    // ── 步骤 10：完成 ──
    {
      id: 'completion',
      text: '🎉 <b>恭喜完成新手教程！</b><br><br>你已经掌握了：<br>• 打出离子牌与观察反应区<br>• 使用防守道具（过滤）解除沉淀<br>• 使用攻击道具（催化剂 / 挥发）压制对手<br>• 触发对手反应获胜<br><br>现在去创建或加入房间，开始真正的对局吧！',
      target: null,
      expected: null,
      dialogPos: 'center',
      setup: function () {},
      onEnter: function () {
        // 将「下一步」按钮变为「开始对战」
        _nextBtn.textContent = '开始对战';
        _nextBtn.onclick = function () {
          Tutorial.skip();
        };
        _skipBtn.style.display = 'none';
      }
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
    _positionDialog(rect, step.dialogPos || 'above');
  }

  // 对话框定位
  function _positionDialog(targetRect, pos) {
    if (!_dialog) return;
    var vw = window.innerWidth;
    var vh = window.innerHeight;
    var dw = 340; // max-width
    var left, top;

    if (!targetRect || pos === 'center') {
      left = Math.max(16, (vw - dw) / 2);
      top = vh * 0.3;
    } else if (pos === 'above') {
      left = Math.max(16, Math.min(vw - dw - 16, targetRect.left + targetRect.width / 2 - dw / 2));
      var dialogH = _dialog.offsetHeight || 180;
      top = Math.max(16, targetRect.top - dialogH - 12);
    } else if (pos === 'below') {
      left = Math.max(16, Math.min(vw - dw - 16, targetRect.left + targetRect.width / 2 - dw / 2));
      top = Math.min(vh - _dialog.offsetHeight - 16, targetRect.bottom + 12);
    }

    _dialog.style.left = left + 'px';
    _dialog.style.top = top + 'px';
  }

  // 自动播放对手动作（直接调 Engine，跳过教程门禁和 ctx.seat）
  function _autoPlay(actions, onDone) {
    function run(i) {
      if (i >= actions.length) { if (onDone) onDone(); return; }
      var act = actions[i];
      _timer = setTimeout(function () {
        var seat = act.seat != null ? act.seat : _state.activePlayer;
        if (act.type === '_startTurn') {
          _state.players[seat].forcedIons = _state.players[seat].forcedIons || 0;
          Engine.startTurn(_state, seat, false);
        } else if (act.type === 'confirmResponse') {
          Engine.confirmResponse(_state, seat);
        } else if (act.type === 'playIon') {
          Engine.playIon(_state, seat, act.uid);
        } else {
          _rawDoAction(act.type, { uid: act.uid });
        }
        _renderFn();
        run(i + 1);
      }, act.delay || 600);
    }
    run(0);
  }

  // 前进到下一步
  function _advance() {
    if (_currentStep >= _steps.length) {
      Tutorial.skip();
      return;
    }
    var step = _steps[_currentStep];
    if (step.setup) step.setup(_state);
    _renderFn();

    // 等 DOM 更新后：先显示对话框（获取真实高度），再定位
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        _showDialog(step);
        _positionSpotlight(step);
        if (step.onEnter) {
          _timer = setTimeout(function () { step.onEnter(); }, 500);
        }
      });
    });
  }

  function _showDialog(step) {
    if (!_dialogText || !_dialog) return;
    _dialogText.innerHTML = step.text;

    if (step.expected === null) {
      _nextBtn.style.display = '';
      _skipBtn.style.display = '';
    } else {
      // 用户需要操作，隐藏下一步按钮
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
        _nextBtn.addEventListener('click', function () {
          _hideDialog();
          _currentStep++;
          _advance();
        });
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
      // 对于 playItem，检查是否是预期的道具
      if (type === 'playItem' && step.id === 'use-filter') {
        var card = _findCardByUid(payload.uid);
        if (!card || card.id !== 'filter') {
          return { allowed: false, msg: '请使用「过滤」道具' };
        }
      }
      if (type === 'playAttackItem' && step.id === 'play-volatilize') {
        var c = _findCardByUid(payload.uid);
        if (!c || c.id !== 'volatilize') {
          return { allowed: false, msg: '请使用「挥发」道具' };
        }
      }
      return { allowed: true };
    },

    // ui.js doAction 在校验通过并执行后调用
    onActionTaken: function () {
      if (!_active) return;
      _hideDialog();
      _currentStep++;
      if (_timer) clearTimeout(_timer);
      _timer = setTimeout(function () { _advance(); }, 300);
    },

    _onPostRender: function () {
      if (!_active) return;
      var step = _steps[_currentStep];
      if (step) _positionSpotlight(step);
    },

    skip: function () {
      _active = false;
      if (_timer) clearTimeout(_timer);
      if (_overlay) _overlay.classList.remove('active');
      document.body.classList.remove('tutorial-active');
      if (_dialog) _dialog.classList.remove('show');
      if (_spotlight) _spotlight.style.display = 'none';
      sessionStorage.removeItem('nr_launch');
      location.href = 'index.html';
    },

    isActive: function () { return _active; }
  };

  window.Tutorial = Tutorial;
})();
