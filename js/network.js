/**
 * 联机层 —— 基于自托管服务器的房间同步（替代已停服的 LeanCloud）。
 *
 * 不需要任何配置、不需要注册账号、不需要引入第三方 SDK。
 * 只要这个页面是通过 `node server.js` 起的服务打开的（http(s)，而不是
 * 直接双击 html 用 file:// 打开），联机就自动可用。
 *
 *   远程联机：本机起服后用「樱花 frp」把端口映射到公网即可，对方访问那个
 *             公网地址就能一起玩。
 *   局域网  ：同一 WiFi 下，对方访问  http://<本机内网IP>:5173 即可。
 *
 * 通信方式：
 *   · 创建/加入/出牌/写状态 —— 普通的 fetch POST 到 /api/*
 *   · 实时接收对方变化      —— SSE（EventSource）订阅 /api/events
 *
 * 同步策略（与原来一致）：房主（host）是权威端，持有完整 state 并运行引擎；
 * 访客（guest）只发送「意图动作」，房主校验后整份回写 state。规则只在一处
 * 执行，避免双端不一致。
 */
(function (root) {
  'use strict';

  const STORAGE_KEY = 'nr_client_id';

  // 接口基址：默认同源（页面从哪个地址打开，就连哪个服务器）。
  // 用 file:// 直接打开 html 时 location.origin 为 'null'，此时联机不可用。
  const API_BASE = (location.protocol === 'http:' || location.protocol === 'https:')
    ? location.origin
    : '';

  // 只要是 http(s) 打开的就认为联机可用（服务器和页面同源）。
  function isConfigured() {
    return !!API_BASE;
  }

  // 持久的客户端 id（区分房主/访客，同设备调试也能分辨）
  function clientId() {
    let id = localStorage.getItem(STORAGE_KEY);
    if (!id) {
      id = 'c_' + Math.random().toString(36).slice(2, 10);
      localStorage.setItem(STORAGE_KEY, id);
    }
    return id;
  }

  // 统一的 POST helper：发 JSON，回 JSON，非 2xx 抛出服务器给的错误信息。
  async function postJson(pathname, body) {
    const resp = await fetch(API_BASE + pathname, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    let data = {};
    try { data = await resp.json(); } catch (_) {}
    if (!resp.ok) throw new Error(data.error || ('请求失败（' + resp.status + '）'));
    return data;
  }

  // ---- 创建房间（房主）----
  async function createRoom(nick) {
    if (!isConfigured()) throw new Error('请通过 node server.js 起的服务打开页面');
    const data = await postJson('/api/create', { clientId: clientId(), nick });
    return data.code;
  }

  // ---- 加入房间（访客）----
  async function joinRoom(code, nick) {
    if (!isConfigured()) throw new Error('请通过 node server.js 起的服务打开页面');
    const data = await postJson('/api/join', { code, clientId: clientId(), nick });
    return data.code;
  }

  /**
   * 订阅房间变化。回调 onUpdate(snapshot) 在房间任何字段更新时触发。
   * 返回一个 { close() } 句柄用于退订。
   *
   * 主通道是 SSE（EventSource）；另开一个低频轮询兜底，万一 SSE 被中间
   * 代理掐断也不至于卡死。
   */
  async function subscribe(code, onUpdate) {
    if (!isConfigured()) throw new Error('联机不可用');

    const url = API_BASE + '/api/events?code=' + encodeURIComponent(code);
    let es = new EventSource(url);
    let closed = false;

    es.onmessage = (ev) => {
      if (!ev.data) return;
      try { onUpdate(JSON.parse(ev.data)); } catch (_) {}
    };
    // EventSource 默认会自动重连，这里不主动关闭，交给浏览器重试。
    es.onerror = () => { /* 浏览器会自动重连，轮询兜底也在跑 */ };

    // 轮询兜底（每 4 秒拉一次当前快照）
    const poll = setInterval(async () => {
      if (closed) return;
      try {
        const resp = await fetch(API_BASE + '/api/room?code=' + encodeURIComponent(code));
        if (resp.ok) onUpdate(await resp.json());
      } catch (_) {}
    }, 4000);

    return {
      close() {
        closed = true;
        clearInterval(poll);
        try { es.close(); } catch (_) {}
      },
    };
  }

  // ---- 房主写回完整状态 ----
  async function pushState(code, state) {
    await postJson('/api/state', { code, state });
  }

  // ---- 访客提交动作意图 ----
  async function pushAction(code, action) {
    await postJson('/api/action', { code, clientId: clientId(), action });
  }

  // ---- 我的座位号（0=房主, 1=访客）----
  function mySeat(players) {
    const me = (players || []).find(p => p.id === clientId());
    return me ? me.seat : -1;
  }

  root.Network = {
    isConfigured, clientId,
    createRoom, joinRoom, subscribe,
    pushState, pushAction, mySeat,
  };
})(typeof window !== 'undefined' ? window : globalThis);
