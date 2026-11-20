// TempMail Private v1.0：私有域名随机邮箱 —— Cloudflare Worker + KV + Email Routing
// 单文件部署：前端页面直接嵌在 INDEX_HTML 里（由 build.js 从 src/index.html 生成），
// 部署时只需上传这一个 _worker.js，再绑定一个 KV（MAILBOXES），不用 wrangler 也能部署。
// 域名在 MAIL_DOMAIN 修改（同时改页面里的 DOMAIN 常量）。
const WORKER_VERSION = '1.0.0';
const MAIL_DOMAIN = 'mbds.kdns.fr';

// 寿命选项：秒数，0 = 永久
const TTL_OPTIONS = { '10m': 600, '1h': 3600, '1d': 86400, '7d': 604800, 'forever': 0 };
const MAX_MSGS_PER_BOX = 50;      // 每个邮箱最多存 50 封
const MAX_TEXT_CHARS = 200000;    // 正文纯文本截断
const MAX_HTML_CHARS = 500000;    // 正文 HTML 截断
const CREATE_LIMIT_PER_HOUR = 20; // 每 IP 每小时最多建 20 个邮箱

const ADDRESS_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MSG_ID_RE = /^[0-9a-f]{16}$/;

const INDEX_HTML = "<!DOCTYPE html>\n<html lang=\"zh-CN\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n<title>随机邮箱 · mbds.kdns.fr</title>\n<style>\n  * { box-sizing: border-box; }\n  body { margin: 0; font-family: system-ui, -apple-system, \"PingFang SC\", \"Microsoft YaHei\", sans-serif; background: #f1f5f9; color: #0f172a; }\n  .wrap { max-width: 720px; margin: 0 auto; padding: 20px 16px 40px; }\n  header { text-align: center; margin: 8px 0 20px; }\n  header h1 { font-size: 1.6rem; margin: 0 0 6px; }\n  header p { color: #64748b; margin: 0; font-size: 0.95rem; }\n  .card { background: #fff; border-radius: 16px; padding: 20px; margin-bottom: 16px; box-shadow: 0 1px 3px rgba(15,23,42,.08); }\n  .label { font-size: 0.8rem; color: #64748b; margin-bottom: 8px; }\n  .ttl-row { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 14px; }\n  .ttl-btn { flex: 1; min-width: 64px; border: 1px solid #cbd5e1; background: #fff; color: #334155; border-radius: 10px; padding: 9px 6px; font-size: 0.9rem; cursor: pointer; }\n  .ttl-btn.active { background: #2563eb; border-color: #2563eb; color: #fff; font-weight: 600; }\n  .address { font-family: ui-monospace, \"SF Mono\", Menlo, Consolas, monospace; font-size: 1.05rem; font-weight: 700; word-break: break-all; padding: 14px; background: #f8fafc; border: 1px dashed #cbd5e1; border-radius: 12px; text-align: center; min-height: 52px; display: flex; align-items: center; justify-content: center; }\n  .address.empty { color: #94a3b8; font-weight: 400; font-size: 0.95rem; font-family: inherit; }\n  .expiry { text-align: center; font-size: 0.85rem; color: #64748b; margin-top: 8px; min-height: 1.2em; }\n  .expiry.soon { color: #dc2626; font-weight: 600; }\n  .btn-row { display: flex; gap: 10px; margin-top: 12px; }\n  button { border: none; border-radius: 12px; padding: 13px 10px; font-size: 1rem; font-weight: 600; cursor: pointer; }\n  button:disabled { opacity: .5; cursor: default; }\n  .btn-primary { background: #2563eb; color: #fff; flex: 1; }\n  .btn-primary:active { background: #1d4ed8; }\n  .btn-secondary { background: #e2e8f0; color: #0f172a; flex: 1; }\n  .btn-secondary:active { background: #cbd5e1; }\n  .btn-danger { background: #fee2e2; color: #b91c1c; flex: 1; }\n  .status { margin-top: 12px; font-size: 0.88rem; color: #64748b; text-align: center; min-height: 1.3em; }\n  .status.error { color: #dc2626; }\n  .status.ok { color: #16a34a; }\n  .box-item { border: 1px solid #e2e8f0; border-radius: 12px; padding: 10px 12px; margin-bottom: 8px; cursor: pointer; display: flex; justify-content: space-between; align-items: center; gap: 8px; }\n  .box-item.active { border-color: #2563eb; background: #eff6ff; }\n  .box-item.expired { opacity: .55; }\n  .box-item .addr { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 0.88rem; word-break: break-all; }\n  .box-item .left { color: #64748b; font-size: 0.78rem; white-space: nowrap; }\n  .box-item .left.soon { color: #dc2626; font-weight: 600; }\n  .box-del { flex: none; background: none; border: none; color: #94a3b8; font-size: 1.1rem; padding: 2px 6px; cursor: pointer; }\n  .inbox-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }\n  .inbox-head h2 { font-size: 1.05rem; margin: 0; }\n  .inbox-head h2 span { color: #2563eb; }\n  .btn-small { flex: none; padding: 8px 14px; font-size: 0.88rem; border-radius: 10px; }\n  .msg { border: 1px solid #e2e8f0; border-radius: 12px; padding: 12px 14px; margin-bottom: 10px; cursor: pointer; }\n  .msg:active { background: #f8fafc; }\n  .msg.unread { border-color: #93c5fd; background: #eff6ff; }\n  .msg .from { font-weight: 600; font-size: 0.92rem; word-break: break-all; }\n  .msg .subject { color: #334155; font-size: 0.92rem; margin-top: 2px; word-break: break-all; }\n  .msg .time { color: #94a3b8; font-size: 0.78rem; margin-top: 4px; }\n  .empty-inbox { text-align: center; color: #94a3b8; padding: 28px 10px; line-height: 1.7; font-size: 0.92rem; }\n  .detail { border-top: 1px solid #e2e8f0; margin-top: 6px; padding-top: 16px; }\n  .detail h3 { font-size: 1rem; margin: 0 0 6px; word-break: break-all; }\n  .detail .meta { color: #64748b; font-size: 0.82rem; margin-bottom: 12px; word-break: break-all; }\n  .codes { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 14px; }\n  .code-chip { background: #fef3c7; border: 1px solid #fcd34d; border-radius: 10px; padding: 10px 14px; font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 1.3rem; font-weight: 700; letter-spacing: 2px; cursor: pointer; }\n  .code-chip small { display: block; font-family: inherit; font-size: 0.7rem; font-weight: 400; letter-spacing: 0; color: #92400e; text-align: center; }\n  .body-text { white-space: pre-wrap; word-break: break-word; font-size: 0.92rem; line-height: 1.7; color: #334155; background: #f8fafc; border-radius: 12px; padding: 14px; max-height: 400px; overflow: auto; }\n  .body-frame { width: 100%; height: 400px; border: 1px solid #e2e8f0; border-radius: 12px; }\n  .detail-actions { display: flex; gap: 10px; margin-top: 12px; }\n  footer { text-align: center; color: #94a3b8; font-size: 0.82rem; line-height: 1.7; }\n</style>\n</head>\n<body>\n<div class=\"wrap\">\n  <header>\n    <h1>📧 随机邮箱</h1>\n    <p>你的私有域名邮箱 · 点一下生成一个，验证码自动收在这里</p>\n  </header>\n\n  <div class=\"card\">\n    <div class=\"label\">新邮箱的寿命</div>\n    <div class=\"ttl-row\" id=\"ttlRow\">\n      <button class=\"ttl-btn\" data-ttl=\"10m\">10 分钟</button>\n      <button class=\"ttl-btn active\" data-ttl=\"1h\">1 小时</button>\n      <button class=\"ttl-btn\" data-ttl=\"1d\">1 天</button>\n      <button class=\"ttl-btn\" data-ttl=\"7d\">7 天</button>\n      <button class=\"ttl-btn\" data-ttl=\"forever\">永久</button>\n    </div>\n    <div class=\"label\">当前邮箱</div>\n    <div class=\"address empty\" id=\"addressBox\">正在生成…</div>\n    <div class=\"expiry\" id=\"expiryBox\"></div>\n    <div class=\"btn-row\">\n      <button class=\"btn-secondary\" id=\"copyBtn\" disabled>复制邮箱</button>\n      <button class=\"btn-primary\" id=\"genBtn\">生成新邮箱</button>\n    </div>\n    <div class=\"btn-row\">\n      <button class=\"btn-danger\" id=\"delBoxBtn\" disabled>删除这个邮箱</button>\n    </div>\n    <div class=\"status\" id=\"status\"></div>\n  </div>\n\n  <div class=\"card\" id=\"myBoxesCard\">\n    <div class=\"label\">我的邮箱</div>\n    <div id=\"boxList\"></div>\n  </div>\n\n  <div class=\"card\">\n    <div class=\"inbox-head\">\n      <h2>收件箱 <span id=\"msgCount\"></span></h2>\n      <button class=\"btn-secondary btn-small\" id=\"refreshBtn\">刷新</button>\n    </div>\n    <div id=\"msgList\"><div class=\"empty-inbox\">暂无邮件<br>把上面的邮箱拿去注册，验证码会显示在这里</div></div>\n    <div id=\"detail\"></div>\n  </div>\n\n  <footer>临时邮箱到期后自动删除，连同里面的邮件一起删掉。<br>邮箱地址与访问口令只保存在你的浏览器里。</footer>\n</div>\n\n<script>\nconst $ = id => document.getElementById(id);\nconst LS_KEY = 'tempmail.private.v1';\nconst POLL_MS = 10000;\nconst TTL_LABELS = { '10m': '10 分钟', '1h': '1 小时', '1d': '1 天', '7d': '7 天', 'forever': '永久' };\nlet boxes = [];        // [{address, token, createdAt, expiresAt, expired}]\nlet current = null;    // 当前选中邮箱的 address\nlet selectedTtl = '1h';\nlet pollTimer = null;\nlet countdownTimer = null;\nlet loadingMsgs = false;\nlet seenIds = new Set();\n\nfunction setStatus(text, cls) {\n  const el = $('status');\n  el.textContent = text;\n  el.className = 'status' + (cls ? ' ' + cls : '');\n}\n\nasync function api(path, opts) {\n  const res = await fetch(path, opts);\n  if (res.status === 204) return null;\n  const text = await res.text();\n  let data = null;\n  try { data = JSON.parse(text); } catch (_) {}\n  if (!res.ok) {\n    const err = new Error((data && data.error) || ('请求失败 ' + res.status));\n    err.status = res.status;\n    throw err;\n  }\n  return data;\n}\n\nfunction saveBoxes() {\n  try { localStorage.setItem(LS_KEY, JSON.stringify(boxes)); } catch (_) {}\n}\nfunction loadBoxes() {\n  try {\n    const raw = localStorage.getItem(LS_KEY);\n    if (!raw) return [];\n    const arr = JSON.parse(raw);\n    return Array.isArray(arr) ? arr.filter(b => b && b.address && b.token) : [];\n  } catch (_) { return []; }\n}\n\nfunction currentBox() {\n  return boxes.find(b => b.address === current) || null;\n}\n\nfunction fmtLeft(expiresAt) {\n  if (!expiresAt) return '永久';\n  const ms = expiresAt - Date.now();\n  if (ms <= 0) return '已过期';\n  const s = Math.floor(ms / 1000);\n  if (s < 60) return s + ' 秒后过期';\n  const m = Math.floor(s / 60);\n  if (m < 60) return m + ' 分钟后过期';\n  const h = Math.floor(m / 60);\n  if (h < 24) return h + ' 小时后过期';\n  const d = Math.floor(h / 24);\n  return d + ' 天后过期';\n}\nfunction isSoon(expiresAt) {\n  return expiresAt && (expiresAt - Date.now() < 10 * 60 * 1000) && (expiresAt - Date.now() > 0);\n}\n\nfunction renderCurrent() {\n  const box = $('addressBox');\n  const b = currentBox();\n  if (b) {\n    box.textContent = b.address;\n    box.classList.remove('empty');\n    $('copyBtn').disabled = false;\n    $('delBoxBtn').disabled = false;\n  } else {\n    box.textContent = boxes.length ? '点下面的邮箱切换，或生成一个新邮箱' : '还没有邮箱，点下面按钮生成一个';\n    box.classList.add('empty');\n    $('copyBtn').disabled = true;\n    $('delBoxBtn').disabled = true;\n  }\n  renderExpiry();\n}\n\nfunction renderExpiry() {\n  const b = currentBox();\n  const el = $('expiryBox');\n  if (!b) { el.textContent = ''; el.className = 'expiry'; return; }\n  if (b.expired) { el.textContent = '这个邮箱已过期，邮件已删除'; el.className = 'expiry soon'; return; }\n  el.textContent = b.expiresAt ? ('剩余时间：' + fmtLeft(b.expiresAt)) : '永久邮箱，不会过期';\n  el.className = 'expiry' + (isSoon(b.expiresAt) ? ' soon' : '');\n}\n\nfunction renderBoxList() {\n  const wrap = $('boxList');\n  if (!boxes.length) {\n    wrap.innerHTML = '<div class=\"empty-inbox\" style=\"padding:12px\">还没有邮箱</div>';\n    return;\n  }\n  wrap.innerHTML = '';\n  boxes.forEach(b => {\n    const div = document.createElement('div');\n    div.className = 'box-item' + (b.address === current ? ' active' : '') + (b.expired ? ' expired' : '');\n    const left = document.createElement('div');\n    left.innerHTML = '<div class=\"addr\"></div>';\n    left.querySelector('.addr').textContent = b.address;\n    const right = document.createElement('div');\n    right.style.display = 'flex';\n    right.style.alignItems = 'center';\n    right.style.gap = '4px';\n    const span = document.createElement('span');\n    span.className = 'left' + (isSoon(b.expiresAt) ? ' soon' : '');\n    span.textContent = b.expired ? '已过期' : fmtLeft(b.expiresAt);\n    const del = document.createElement('button');\n    del.className = 'box-del';\n    del.textContent = '✕';\n    del.title = '从列表移除';\n    del.onclick = ev => { ev.stopPropagation(); removeBox(b.address, false); };\n    right.appendChild(span);\n    right.appendChild(del);\n    div.appendChild(left);\n    div.appendChild(right);\n    div.onclick = () => selectBox(b.address);\n    wrap.appendChild(div);\n  });\n}\n\nfunction renderAll() {\n  renderCurrent();\n  renderBoxList();\n}\n\nfunction selectBox(address) {\n  current = address;\n  seenIds = new Set();\n  $('detail').innerHTML = '';\n  renderAll();\n  loadMessages();\n}\n\nfunction removeBox(address, serverDelete) {\n  boxes = boxes.filter(b => b.address !== address);\n  saveBoxes();\n  if (current === address) {\n    current = boxes.length ? boxes[0].address : null;\n    seenIds = new Set();\n    $('detail').innerHTML = '';\n  }\n  renderAll();\n  if (current) loadMessages();\n  else { $('msgList').innerHTML = '<div class=\"empty-inbox\">暂无邮件<br>把上面的邮箱拿去注册，验证码会显示在这里</div>'; $('msgCount').textContent = ''; }\n}\n\nasync function generateMailbox() {\n  $('genBtn').disabled = true;\n  setStatus('正在生成新邮箱…');\n  try {\n    const mb = await api('/api/mailboxes', {\n      method: 'POST',\n      headers: { 'Content-Type': 'application/json' },\n      body: JSON.stringify({ ttl: selectedTtl }),\n    });\n    boxes.unshift({ address: mb.address, token: mb.token, createdAt: mb.createdAt, expiresAt: mb.expiresAt });\n    saveBoxes();\n    selectBox(mb.address);\n    setStatus('新邮箱已生成（' + TTL_LABELS[selectedTtl] + '）', 'ok');\n  } catch (e) {\n    console.error(e);\n    setStatus(e.status === 429 ? '创建太频繁，请稍后再试' : ('生成失败：' + e.message), 'error');\n  } finally {\n    $('genBtn').disabled = false;\n  }\n}\n\nasync function loadMessages() {\n  const b = currentBox();\n  if (!b || b.expired || loadingMsgs) return;\n  loadingMsgs = true;\n  try {\n    const data = await api('/api/mailboxes/' + encodeURIComponent(b.address) + '/messages?token=' + encodeURIComponent(b.token));\n    renderMessages(data.messages || []);\n    // 服务端可能纠正过期时间，同步一下\n    if (data.expiresAt !== undefined && data.expiresAt !== b.expiresAt) {\n      b.expiresAt = data.expiresAt;\n      saveBoxes();\n      renderExpiry();\n      renderBoxList();\n    }\n  } catch (e) {\n    console.error(e);\n    if (e.status === 410) {\n      b.expired = true;\n      saveBoxes();\n      renderAll();\n      $('msgList').innerHTML = '<div class=\"empty-inbox\">这个邮箱已过期，邮件已删除<br>可以生成一个新邮箱</div>';\n      $('msgCount').textContent = '';\n    } else if (e.status === 404) {\n      b.expired = true;\n      saveBoxes();\n      renderAll();\n      $('msgList').innerHTML = '<div class=\"empty-inbox\">这个邮箱不存在了（可能已在别处删除）</div>';\n    } else {\n      setStatus('收件箱刷新失败：' + e.message, 'error');\n    }\n  } finally {\n    loadingMsgs = false;\n  }\n}\n\nfunction fmtTime(iso) {\n  try {\n    const d = new Date(iso);\n    return d.toLocaleString('zh-CN', { hour12: false });\n  } catch (_) { return iso || ''; }\n}\n\nfunction renderMessages(list) {\n  $('msgCount').textContent = list.length ? '(' + list.length + ')' : '';\n  const wrap = $('msgList');\n  if (!list.length) {\n    wrap.innerHTML = '<div class=\"empty-inbox\">暂无邮件<br>把上面的邮箱拿去注册，验证码会显示在这里</div>';\n    return;\n  }\n  wrap.innerHTML = '';\n  list.forEach(m => {\n    const isNew = !seenIds.has(m.id);\n    const div = document.createElement('div');\n    div.className = 'msg' + (isNew ? ' unread' : '');\n    div.innerHTML = '<div class=\"from\"></div><div class=\"subject\"></div><div class=\"time\"></div>';\n    div.querySelector('.from').textContent = m.from || '未知发件人';\n    div.querySelector('.subject').textContent = m.subject || '(无主题)';\n    div.querySelector('.time').textContent = fmtTime(m.createdAt) + (m.snippet ? ' · ' + m.snippet : '');\n    div.onclick = () => { seenIds.add(m.id); div.classList.remove('unread'); openMessage(m.id); };\n    wrap.appendChild(div);\n  });\n}\n\nfunction extractCodes(text) {\n  if (!text) return [];\n  const found = text.match(/\\b\\d{4,8}\\b/g) || [];\n  return [...new Set(found)];\n}\n\nasync function openMessage(id) {\n  const b = currentBox();\n  if (!b) return;\n  const detail = $('detail');\n  detail.innerHTML = '<div class=\"detail\"><div class=\"status\">正在读取邮件…</div></div>';\n  try {\n    const m = await api('/api/mailboxes/' + encodeURIComponent(b.address) + '/messages/' + id + '?token=' + encodeURIComponent(b.token));\n    const codes = extractCodes((m.text || '') + '\\n' + (m.subject || ''));\n    let html = '<div class=\"detail\"><h3></h3><div class=\"meta\"></div>';\n    if (codes.length) {\n      html += '<div class=\"label\">验证码（点一下复制）</div><div class=\"codes\">' +\n        codes.map(c => '<div class=\"code-chip\" data-code=\"' + c + '\">' + c + '<small>点一下复制</small></div>').join('') +\n        '</div>';\n    }\n    if (m.text) {\n      html += '<div class=\"body-text\"></div>';\n    } else if (m.html) {\n      html += '<iframe class=\"body-frame\" sandbox></iframe>';\n    } else {\n      html += '<div class=\"body-text\">（这封邮件没有正文）</div>';\n    }\n    html += '<div class=\"detail-actions\"><button class=\"btn-secondary\" id=\"delMsgBtn\">删除这封邮件</button></div></div>';\n    detail.innerHTML = html;\n    detail.querySelector('h3').textContent = m.subject || '(无主题)';\n    detail.querySelector('.meta').textContent = (m.from || '') + ' · ' + fmtTime(m.createdAt);\n    if (m.text) detail.querySelector('.body-text').textContent = m.text;\n    if (!m.text && m.html) detail.querySelector('.body-frame').srcdoc = m.html;\n    detail.querySelectorAll('.code-chip').forEach(el => {\n      el.onclick = () => copyText(el.dataset.code, '验证码已复制');\n    });\n    detail.querySelector('#delMsgBtn').onclick = async () => {\n      try {\n        await api('/api/mailboxes/' + encodeURIComponent(b.address) + '/messages/' + id + '?token=' + encodeURIComponent(b.token), { method: 'DELETE' });\n        detail.innerHTML = '';\n        loadMessages();\n      } catch (e) { setStatus('删除失败：' + e.message, 'error'); }\n    };\n    detail.scrollIntoView({ behavior: 'smooth', block: 'nearest' });\n  } catch (e) {\n    detail.innerHTML = '<div class=\"detail\"><div class=\"status error\">读取失败：' + e.message + '</div></div>';\n  }\n}\n\nasync function copyText(text, okMsg) {\n  try {\n    await navigator.clipboard.writeText(text);\n    setStatus(okMsg || '已复制', 'ok');\n  } catch (_) {\n    const ta = document.createElement('textarea');\n    ta.value = text;\n    document.body.appendChild(ta);\n    ta.select();\n    try { document.execCommand('copy'); setStatus(okMsg || '已复制', 'ok'); }\n    catch (e) { setStatus('复制失败，请长按手动复制', 'error'); }\n    document.body.removeChild(ta);\n  }\n}\n\nfunction startPolling() {\n  if (pollTimer) clearInterval(pollTimer);\n  pollTimer = setInterval(() => { if (!document.hidden) loadMessages(); }, POLL_MS);\n  if (countdownTimer) clearInterval(countdownTimer);\n  countdownTimer = setInterval(() => { renderExpiry(); renderBoxList(); }, 30000);\n}\n\n$('ttlRow').addEventListener('click', ev => {\n  const btn = ev.target.closest('.ttl-btn');\n  if (!btn) return;\n  selectedTtl = btn.dataset.ttl;\n  document.querySelectorAll('.ttl-btn').forEach(x => x.classList.toggle('active', x === btn));\n});\n$('genBtn').onclick = generateMailbox;\n$('refreshBtn').onclick = () => { setStatus('正在刷新…'); loadMessages().then(() => setStatus('')); };\n$('copyBtn').onclick = () => { const b = currentBox(); if (b) copyText(b.address, '邮箱已复制'); };\n$('delBoxBtn').onclick = async () => {\n  const b = currentBox();\n  if (!b) return;\n  if (!confirm('确定删除 ' + b.address + ' 吗？里面的邮件会一起删掉。')) return;\n  try {\n    await api('/api/mailboxes/' + encodeURIComponent(b.address) + '?token=' + encodeURIComponent(b.token), { method: 'DELETE' });\n  } catch (e) { /* 服务端删失败也继续从列表移除 */ }\n  removeBox(b.address, false);\n  setStatus('邮箱已删除', 'ok');\n};\ndocument.addEventListener('visibilitychange', () => { if (!document.hidden) loadMessages(); });\n\n// 启动：恢复保存的邮箱，没有就自动生成一个\n(async () => {\n  boxes = loadBoxes();\n  if (boxes.length) {\n    current = boxes[0].address;\n    renderAll();\n    startPolling();\n    loadMessages();\n  } else {\n    renderAll();\n    startPolling();\n    generateMailbox();\n  }\n})();\n</script>\n</body>\n</html>\n";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function randomStr(len, chars) {
  const arr = new Uint8Array(len);
  crypto.getRandomValues(arr);
  let out = '';
  for (let i = 0; i < len; i++) out += chars[arr[i] % chars.length];
  return out;
}
const randomUsername = () => randomStr(10, 'abcdefghijklmnopqrstuvwxyz0123456789');
const randomToken = () => randomStr(32, 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789');
const randomMsgId = () => randomStr(16, '0123456789abcdef');

const isExpired = mb => !!(mb && mb.expiresAt && Date.now() > mb.expiresAt);
// 剩余寿命（秒），用于 KV 自动过期；永久返回 null
function remainingTtl(mb) {
  if (!mb || !mb.expiresAt) return null;
  return Math.max(60, Math.floor((mb.expiresAt - Date.now()) / 1000));
}

function kv(env) {
  if (!env || !env.MAILBOXES) throw new Error('KV 未绑定：请在 Worker 设置里绑定名为 MAILBOXES 的 KV');
  return env.MAILBOXES;
}

async function getMailbox(env, address) {
  return kv(env).get('mb:' + address, 'json');
}

async function deleteMailbox(env, address) {
  const store = kv(env);
  await store.delete('mb:' + address);
  await store.delete('idx:' + address);
  let cursor;
  do {
    const page = await store.list({ prefix: 'msg:' + address + ':', cursor });
    for (const k of page.keys) await store.delete(k.name);
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
}

// 校验邮箱存在 + token 正确 + 未过期；失败返回 {error, status}
async function authMailbox(env, address, token) {
  const mb = await getMailbox(env, address);
  if (!mb) return { error: '邮箱不存在', status: 404 };
  if (isExpired(mb)) {
    // 懒清理：过期邮箱读到就删掉
    await deleteMailbox(env, address).catch(() => {});
    return { error: '邮箱已过期', status: 410 };
  }
  if (!token || token !== mb.token) return { error: 'token 不正确', status: 403 };
  return { mb };
}

async function handleFetch(request, env) {
  const url = new URL(request.url);
  const p = url.pathname;

  if (p === '/health') {
    return json({ ok: true, version: WORKER_VERSION, domain: MAIL_DOMAIN, time: new Date().toISOString() });
  }

  // ---- 创建邮箱 ----
  if (p === '/api/mailboxes' && request.method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const ttlKey = typeof body.ttl === 'string' && body.ttl in TTL_OPTIONS ? body.ttl : '1h';
    const ttlSec = TTL_OPTIONS[ttlKey];
    // 每 IP 限流
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const hour = Math.floor(Date.now() / 3600000);
    const rlKey = 'rl:' + ip + ':' + hour;
    const store = kv(env);
    const used = parseInt(await store.get(rlKey)) || 0;
    if (used >= CREATE_LIMIT_PER_HOUR) {
      return json({ error: '创建太频繁，请稍后再试' }, 429);
    }
    const now = Date.now();
    const address = randomUsername() + '@' + MAIL_DOMAIN;
    const mb = {
      address,
      token: randomToken(),
      createdAt: now,
      expiresAt: ttlSec > 0 ? now + ttlSec * 1000 : null,
    };
    const opts = ttlSec > 0 ? { expirationTtl: ttlSec } : undefined;
    await store.put('mb:' + address, JSON.stringify(mb), opts);
    await store.put(rlKey, String(used + 1), { expirationTtl: 3600 });
    return json(mb, 201);
  }

  // ---- /api/mailboxes/:address[/messages[/:id]] ----
  const m = p.match(/^\/api\/mailboxes\/([^/]+)(?:\/messages(?:\/([^/]+))?)?$/);
  if (m) {
    const address = decodeURIComponent(m[1]).toLowerCase();
    const msgId = m[2] ? decodeURIComponent(m[2]) : null;
    const user = address.split('@')[0];
    if (!ADDRESS_RE.test(user) || !address.endsWith('@' + MAIL_DOMAIN)) {
      return json({ error: '邮箱地址不正确' }, 400);
    }
    if (msgId && !MSG_ID_RE.test(msgId)) {
      return json({ error: '邮件 ID 不正确' }, 400);
    }
    const token = url.searchParams.get('token') || '';
    const isMsgRoute = p.includes('/messages');

    if (!isMsgRoute && request.method === 'GET') {
      const auth = await authMailbox(env, address, token);
      if (auth.error) return json({ error: auth.error }, auth.status);
      const idx = (await kv(env).get('idx:' + address, 'json')) || [];
      return json({ address, createdAt: auth.mb.createdAt, expiresAt: auth.mb.expiresAt, messageCount: idx.length });
    }
    if (!isMsgRoute && request.method === 'DELETE') {
      const auth = await authMailbox(env, address, token);
      if (auth.error) return json({ error: auth.error }, auth.status);
      await deleteMailbox(env, address);
      return new Response(null, { status: 204 });
    }
    if (isMsgRoute && !msgId && request.method === 'GET') {
      const auth = await authMailbox(env, address, token);
      if (auth.error) return json({ error: auth.error }, auth.status);
      const idx = (await kv(env).get('idx:' + address, 'json')) || [];
      return json({ messages: idx, expiresAt: auth.mb.expiresAt });
    }
    if (isMsgRoute && msgId && request.method === 'GET') {
      const auth = await authMailbox(env, address, token);
      if (auth.error) return json({ error: auth.error }, auth.status);
      const msg = await kv(env).get('msg:' + address + ':' + msgId, 'json');
      if (!msg) return json({ error: '邮件不存在' }, 404);
      return json(msg);
    }
    if (isMsgRoute && msgId && request.method === 'DELETE') {
      const auth = await authMailbox(env, address, token);
      if (auth.error) return json({ error: auth.error }, auth.status);
      await kv(env).delete('msg:' + address + ':' + msgId);
      const idx = ((await kv(env).get('idx:' + address, 'json')) || []).filter(x => x.id !== msgId);
      const ttl = remainingTtl(auth.mb);
      await kv(env).put('idx:' + address, JSON.stringify(idx), ttl ? { expirationTtl: ttl } : undefined);
      return new Response(null, { status: 204 });
    }
    return json({ error: '未知接口' }, 404);
  }

  if (p.startsWith('/api/')) {
    return json({ error: '未知接口' }, 404);
  }

  // ---- 前端页面（单文件内嵌，其他路径也回退到首页）----
  return new Response(INDEX_HTML, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

// ---- 收件：Email Routing catch-all 转发到这里 ----
// 只收“已生成且未过期”的邮箱的邮件，其他一律拒收（防止域名变成公开垃圾箱）。
async function handleEmail(message, env) {
  const to = (message.to || '').toLowerCase().trim();
  if (!to.endsWith('@' + MAIL_DOMAIN)) {
    message.setReject('Unknown domain');
    return;
  }
  const store = kv(env);
  const mb = await store.get('mb:' + to, 'json');
  if (!mb) {
    message.setReject('No such mailbox');
    return;
  }
  if (isExpired(mb)) {
    await deleteMailbox(env, to).catch(() => {});
    message.setReject('Mailbox expired');
    return;
  }
  const idx = (await store.get('idx:' + to, 'json')) || [];
  if (idx.length >= MAX_MSGS_PER_BOX) {
    message.setReject('Mailbox full');
    return;
  }
  let text = '';
  let html = '';
  try { text = (await message.text()) || ''; } catch (_) {}
  try { html = (await message.html()) || ''; } catch (_) {}
  text = text.slice(0, MAX_TEXT_CHARS);
  html = html.slice(0, MAX_HTML_CHARS);
  const from = message.from || '';
  let subject = '';
  try { subject = message.headers.get('subject') || ''; } catch (_) {}
  const id = randomMsgId();
  const createdAt = Date.now();
  const snippet = text.replace(/\s+/g, ' ').trim().slice(0, 120);
  const ttl = remainingTtl(mb);
  const opts = ttl ? { expirationTtl: ttl } : undefined;
  await store.put('msg:' + to + ':' + id, JSON.stringify({ id, from, subject, createdAt, text, html }), opts);
  idx.unshift({ id, from, subject, createdAt, snippet });
  await store.put('idx:' + to, JSON.stringify(idx), opts);
}

// ---- 定时清理：每小时删掉过期的邮箱（KV TTL 是主力清理，这里是兜底）----
async function handleScheduled(event, env) {
  const store = kv(env);
  let cursor;
  let deleted = 0;
  do {
    const page = await store.list({ prefix: 'mb:', cursor });
    for (const k of page.keys) {
      const mb = await store.get(k.name, 'json');
      if (mb && isExpired(mb)) {
        await deleteMailbox(env, mb.address).catch(() => {});
        deleted++;
      }
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  console.log('cleanup: deleted ' + deleted + ' expired mailboxes');
}

export default {
  async fetch(request, env, ctx) {
    try {
      return await handleFetch(request, env, ctx);
    } catch (e) {
      console.error('fetch error:', e);
      return json({ error: e.message || '服务器内部错误' }, 500);
    }
  },
  async email(message, env, ctx) {
    try {
      await handleEmail(message, env);
    } catch (e) {
      console.error('email error:', e);
      try { message.setReject('Temporary error'); } catch (_) {}
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleScheduled(event, env).catch(e => console.error('scheduled error:', e)));
  },
};
