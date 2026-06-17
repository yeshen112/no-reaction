/**
 * 首页控制器 —— 处理本地对战 / 创建 / 加入房间，并跳转到 game.html。
 * 通过 sessionStorage 把开局参数传给游戏页。
 */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const statusEl = $('net-status');

  function setStatus(msg, isErr) {
    statusEl.textContent = msg || '';
    statusEl.classList.toggle('err', !!isErr);
  }

  function nick() {
    const v = ($('nick').value || '').trim();
    return v || '玩家';
  }

  // 把开局参数写入 sessionStorage 后跳转游戏页
  function go(params) {
    sessionStorage.setItem('nr_launch', JSON.stringify(params));
    location.href = 'game.html';
  }

  // ---- 本地双人热座 ----
  $('btn-local').addEventListener('click', () => {
    go({ mode: 'local', playerNames: ['玩家1', '玩家2'] });
  });

  // ---- 联机：创建房间 ----
  $('btn-create').addEventListener('click', async () => {
    if (!window.Network || !Network.isConfigured()) {
      setStatus('联机需通过服务器打开：先运行 node server.js，再访问 http://localhost:5173（不要直接双击 html）。', true);
      return;
    }
    setStatus('正在创建房间…');
    try {
      const code = await Network.createRoom(nick());
      go({ mode: 'online', role: 'host', roomCode: code, nick: nick() });
    } catch (e) {
      setStatus('创建房间失败：' + (e && e.message || e), true);
    }
  });

  // ---- 联机：加入房间 ----
  $('btn-join').addEventListener('click', async () => {
    const code = ($('room-code').value || '').trim().toUpperCase();
    if (code.length !== 6) { setStatus('请输入 6 位房间码。', true); return; }
    if (!window.Network || !Network.isConfigured()) {
      setStatus('联机需通过服务器打开：先运行 node server.js，再访问 http://localhost:5173（不要直接双击 html）。', true);
      return;
    }
    setStatus('正在加入房间…');
    try {
      await Network.joinRoom(code, nick());
      go({ mode: 'online', role: 'guest', roomCode: code, nick: nick() });
    } catch (e) {
      setStatus('加入房间失败：' + (e && e.message || e), true);
    }
  });

  // 房间码输入框自动大写
  $('room-code').addEventListener('input', (e) => {
    e.target.value = e.target.value.toUpperCase();
  });

  // 启动时探测联机可用性
  if (window.Network && Network.isConfigured()) {
    setStatus('联机已就绪。');
  } else {
    setStatus('');
  }
})();
