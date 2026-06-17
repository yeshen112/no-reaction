/**
 * No Reaction 本地服务器 —— 静态文件服务 + 联机房间中继。
 *   node server.js          （默认端口 5173，可用环境变量 PORT 覆盖）
 *
 * 两块职责：
 *   1) 静态文件：把 index.html / game.html / js / css 等发给浏览器。
 *   2) 房间中继（/api/*）：替代已停服的 LeanCloud。服务器只当“哑中继”，
 *      在内存里存房间数据，并通过 SSE（Server-Sent Events）把变化实时
 *      推给房间里的两个玩家。游戏规则一概不在这里跑——仍由房主权威结算。
 *
 * 部署方式（任选其一，都免费）：
 *   · 局域网：本机起服，同 WiFi 的人浏览器开  http://<本机内网IP>:5173
 *   · 远程  ：本机起服，再用樱花 frp 把 5173 端口映射到公网地址即可。
 *
 * 仅依赖 Node 内置模块，无需 npm install。
 *
 * ⚠ 房间无鉴权：任何拿到 6 位房间码的人都能加入/操作。对casual对战足够，
 *   不要拿来传敏感数据。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 5173;
const ROOT = __dirname;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// ============================================================
//  房间中继：内存存储
// ============================================================
// rooms: code -> { code, state, action, players[], subs:Set<res>, lastActive }
const rooms = new Map();

function randomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去掉易混淆字符
  let s = '';
  for (let i = 0; i < 6; i++) s += chars[(Math.random() * chars.length) | 0];
  return s;
}

function snapshot(room) {
  return {
    id: room.code, // 兼容旧接口字段（原 LeanCloud 对象 id）
    code: room.code,
    state: room.state,
    action: room.action,
    players: room.players || [],
  };
}

// 把最新快照推给房间内所有 SSE 订阅者
function broadcast(room) {
  room.lastActive = Date.now();
  const payload = 'data: ' + JSON.stringify(snapshot(room)) + '\n\n';
  for (const res of room.subs) {
    try { res.write(payload); } catch (_) { /* 断开的连接，靠 close 事件清理 */ }
  }
}

// 清理长时间无人的房间（1 小时无活动）
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (room.subs.size === 0 && now - room.lastActive > 60 * 60 * 1000) {
      rooms.delete(code);
    }
  }
}, 10 * 60 * 1000).unref();

// ---- 工具：读取并解析 JSON 请求体 ----
function readJson(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (c) => {
      buf += c;
      if (buf.length > 1e6) { reject(new Error('请求体过大')); req.destroy(); }
    });
    req.on('end', () => {
      if (!buf) return resolve({});
      try { resolve(JSON.parse(buf)); } catch (e) { reject(new Error('JSON 解析失败')); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  });
  res.end(JSON.stringify(obj));
}

// ============================================================
//  API 路由
// ============================================================
async function handleApi(req, res, url) {
  // CORS 预检
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    });
    res.end();
    return;
  }

  const route = url.pathname;

  // ---- 创建房间（房主）----
  if (route === '/api/create' && req.method === 'POST') {
    const { clientId, nick } = await readJson(req);
    if (!clientId) return sendJson(res, 400, { error: '缺少 clientId' });
    let code;
    do { code = randomCode(); } while (rooms.has(code));
    rooms.set(code, {
      code,
      state: null,
      action: null,
      players: [{ id: clientId, nick: nick || '房主', seat: 0 }],
      subs: new Set(),
      lastActive: Date.now(),
    });
    return sendJson(res, 200, { code });
  }

  // ---- 加入房间（访客）----
  if (route === '/api/join' && req.method === 'POST') {
    const { code, clientId, nick } = await readJson(req);
    const room = rooms.get((code || '').toUpperCase());
    if (!room) return sendJson(res, 404, { error: '房间不存在' });
    const players = room.players;
    const already = players.some(p => p.id === clientId);
    if (players.length >= 2 && !already) {
      return sendJson(res, 409, { error: '房间已满' });
    }
    if (!already) {
      players.push({ id: clientId, nick: nick || '访客', seat: 1 });
      broadcast(room); // 通知房主：有人加入了
    }
    return sendJson(res, 200, { code: room.code });
  }

  // ---- 房主写回完整状态（顺带清空已处理动作）----
  if (route === '/api/state' && req.method === 'POST') {
    const { code, state } = await readJson(req);
    const room = rooms.get((code || '').toUpperCase());
    if (!room) return sendJson(res, 404, { error: '房间不存在' });
    room.state = state;
    room.action = null;
    broadcast(room);
    return sendJson(res, 200, { ok: true });
  }

  // ---- 访客提交动作意图（服务器盖上 seq/by 戳）----
  if (route === '/api/action' && req.method === 'POST') {
    const { code, clientId, action } = await readJson(req);
    const room = rooms.get((code || '').toUpperCase());
    if (!room) return sendJson(res, 404, { error: '房间不存在' });
    room.action = Object.assign({}, action, { seq: Date.now(), by: clientId });
    broadcast(room);
    return sendJson(res, 200, { ok: true });
  }

  // ---- 取当前快照（SSE 的兜底轮询用）----
  if (route === '/api/room' && req.method === 'GET') {
    const room = rooms.get((url.searchParams.get('code') || '').toUpperCase());
    if (!room) return sendJson(res, 404, { error: '房间不存在' });
    return sendJson(res, 200, snapshot(room));
  }

  // ---- 订阅房间变化（SSE 长连接）----
  if (route === '/api/events' && req.method === 'GET') {
    const room = rooms.get((url.searchParams.get('code') || '').toUpperCase());
    if (!room) return sendJson(res, 404, { error: '房间不存在' });

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'X-Accel-Buffering': 'no', // 关掉某些代理的缓冲，保证实时
    });
    room.subs.add(res);
    room.lastActive = Date.now();

    // 立即下发一次当前快照
    res.write('data: ' + JSON.stringify(snapshot(room)) + '\n\n');

    // 心跳，穿越 frp / 代理时保活
    const beat = setInterval(() => {
      try { res.write(': ping\n\n'); } catch (_) {}
    }, 25000);

    req.on('close', () => {
      clearInterval(beat);
      room.subs.delete(res);
      room.lastActive = Date.now();
    });
    return;
  }

  sendJson(res, 404, { error: '未知接口' });
}

// ============================================================
//  HTTP 服务器：先看是不是 API，否则当静态文件
// ============================================================
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (url.pathname.startsWith('/api/')) {
    handleApi(req, res, url).catch((e) => {
      sendJson(res, 400, { error: (e && e.message) || '请求处理失败' });
    });
    return;
  }

  // ---- 静态文件 ----
  let urlPath = decodeURIComponent(url.pathname);
  if (urlPath === '/') urlPath = '/index.html';
  const safePath = path.normalize(path.join(ROOT, urlPath));
  if (!safePath.startsWith(ROOT)) {
    res.writeHead(403); res.end('403 Forbidden'); return;
  }
  fs.readFile(safePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }
    const ext = path.extname(safePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`No Reaction 已启动： http://localhost:${PORT}`);
  console.log(`局域网联机：同 WiFi 的人访问  http://<本机内网IP>:${PORT}`);
  console.log(`远程联机  ：用樱花 frp 把 ${PORT} 端口映射到公网即可。`);
});
