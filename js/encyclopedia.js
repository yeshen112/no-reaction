/**
 * 卡牌百科 —— 数据驱动的卡牌 / 反应说明面板。
 *
 * 所有内容直接从 config/cards.js (CARD_CONFIG) 与 js/reactions.js (REACTIONS)
 * 读取，新增离子或道具只需改那两处，本面板自动更新，无需改动这里。
 *
 * 用法：页面引入本脚本后，调用 Encyclopedia.open() 即可弹出（覆盖层 DOM 自建）。
 * 导出 window.Encyclopedia（IIFE 模式，与其余模块一致）。
 */
(function () {
  'use strict';

  var CFG = (typeof window !== 'undefined' && window.CARD_CONFIG) || null;
  var RX = (typeof window !== 'undefined' && window.REACTIONS) || null;

  var _mask = null;   // 覆盖层根节点
  var _built = false;

  // 道具类型 → 中文标签 + 样式类
  var KIND_LABEL = { defense: '防守', neutral: '中性', attack: '攻击' };

  function ionDef(id) {
    return (CFG.CATIONS[id] || CFG.ANIONS[id]) || null;
  }

  function ionSymbol(id) {
    var d = ionDef(id);
    return d ? d.symbol : id;
  }

  // 汇总某个离子参与的所有反应，返回可读字符串数组。
  function reactionsForIon(id) {
    var out = [];
    if (!RX) return out;
    (RX.PRECIPITATES || []).forEach(function (p) {
      if (p.cation === id || p.anion === id) {
        var other = p.cation === id ? p.anion : p.cation;
        out.push('＋ ' + ionSymbol(other) + ' → ' + p.product + '（沉淀' +
          (p.note ? ' · ' + p.note : '') + '）');
      }
    });
    (RX.GASES || []).forEach(function (g) {
      if (g.cation === id || g.anion === id) {
        var other = g.cation === id ? g.anion : g.cation;
        out.push('＋ ' + ionSymbol(other) + ' → ' + g.product + '（气体）');
      }
    });
    (RX.NEUTRALIZE || []).forEach(function (n) {
      if (n.a === id || n.b === id) {
        var other = n.a === id ? n.b : n.a;
        out.push('＋ ' + ionSymbol(other) + ' → 自动中和（不判负）');
      }
    });
    return out;
  }

  // 生成一张卡牌缩略（复用游戏内 .card 样式）
  function cardTile(opts) {
    var el = document.createElement('div');
    el.className = 'card enc-tile ' + (opts.cls || '');
    el.innerHTML =
      '<span class="tag">' + opts.tag + '</span>' +
      '<span class="sym">' + opts.sym + '</span>' +
      '<span class="nm">' + opts.nm + '</span>';
    el.addEventListener('click', function () { opts.onClick(el); });
    return el;
  }

  // 渲染离子分组
  function renderIons(container, map, kindCls, tagText) {
    Object.keys(map).forEach(function (id) {
      var d = map[id];
      var tile = cardTile({
        cls: kindCls,
        tag: tagText,
        sym: d.symbol,
        nm: d.name,
        onClick: function () { showDetail(buildIonDetail(id, d, tagText)); }
      });
      container.appendChild(tile);
    });
  }

  // 渲染道具分组
  function renderItems(container) {
    Object.keys(CFG.ITEMS).forEach(function (id) {
      var d = CFG.ITEMS[id];
      var attack = d.kind === 'attack';
      var tile = cardTile({
        cls: 'item' + (attack ? ' attack' : ''),
        tag: '道具',
        sym: d.name,
        nm: KIND_LABEL[d.kind] || '',
        onClick: function () { showDetail(buildItemDetail(id, d)); }
      });
      container.appendChild(tile);
    });
  }

  function buildIonDetail(id, d, tagText) {
    var rs = reactionsForIon(id);
    var body = '<p class="enc-meta">' + tagText + '离子 · 电荷 ' +
      (d.charge > 0 ? '+' + d.charge : d.charge) + ' · 牌库 ' + d.count + ' 张</p>';
    if (rs.length) {
      body += '<div class="enc-section-title">可能的反应</div><ul class="enc-rx">';
      rs.forEach(function (r) { body += '<li>' + r + '</li>'; });
      body += '</ul>';
    } else {
      body += '<p class="enc-meta">该离子不参与任何反应，可安全打出。</p>';
    }
    return { title: d.symbol + ' ' + d.name, html: body };
  }

  function buildItemDetail(id, d) {
    var kindCls = d.kind === 'attack' ? 'tag-attack'
      : d.kind === 'neutral' ? 'tag-neutral' : 'tag-defense';
    var body = '<p class="enc-meta">道具 · <span class="' + kindCls + '">' +
      (KIND_LABEL[d.kind] || '') + '</span> · 牌库 ' + d.count + ' 张</p>';
    body += '<div class="enc-section-title">效果</div><p class="enc-desc">' + d.desc + '</p>';
    return { title: d.name, html: body };
  }

  function showDetail(detail) {
    var box = _mask.querySelector('.enc-detail');
    box.querySelector('.enc-detail-title').textContent = detail.title;
    box.querySelector('.enc-detail-body').innerHTML = detail.html;
    box.classList.add('show');
  }

  function hideDetail() {
    var box = _mask.querySelector('.enc-detail');
    if (box) box.classList.remove('show');
  }

  // 构建覆盖层（只建一次）
  function build() {
    if (_built) return;
    _mask = document.createElement('div');
    _mask.className = 'enc-mask';
    _mask.innerHTML =
      '<div class="enc-panel">' +
        '<div class="enc-head">' +
          '<span class="enc-title">📖 卡牌百科</span>' +
          '<button class="enc-close" aria-label="关闭">✕</button>' +
        '</div>' +
        '<div class="enc-scroll">' +
          '<div class="enc-group-title">阳离子</div>' +
          '<div class="enc-grid" data-grid="cation"></div>' +
          '<div class="enc-group-title">阴离子</div>' +
          '<div class="enc-grid" data-grid="anion"></div>' +
          '<div class="enc-group-title">道具牌</div>' +
          '<div class="enc-grid" data-grid="item"></div>' +
        '</div>' +
        '<div class="enc-detail">' +
          '<div class="enc-detail-head">' +
            '<span class="enc-detail-title"></span>' +
            '<button class="enc-detail-back">返回</button>' +
          '</div>' +
          '<div class="enc-detail-body"></div>' +
        '</div>' +
      '</div>';
    document.body.appendChild(_mask);

    renderIons(_mask.querySelector('[data-grid="cation"]'), CFG.CATIONS, 'cation', '阳');
    renderIons(_mask.querySelector('[data-grid="anion"]'), CFG.ANIONS, 'anion', '阴');
    renderItems(_mask.querySelector('[data-grid="item"]'));

    _mask.querySelector('.enc-close').addEventListener('click', close);
    _mask.querySelector('.enc-detail-back').addEventListener('click', hideDetail);
    _mask.addEventListener('click', function (e) {
      if (e.target === _mask) close();
    });
    _built = true;
  }

  function open() {
    if (!CFG) return;
    build();
    hideDetail();
    _mask.classList.add('show');
  }

  function close() {
    if (_mask) _mask.classList.remove('show');
  }

  window.Encyclopedia = { open: open, close: close };
})();
