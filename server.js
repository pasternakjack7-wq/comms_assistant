/**
 * Ассистент проверки коммуникаций — сервер для внутреннего теста.
 *
 * Делает три вещи:
 *   1. отдаёт страницу из ./public
 *   2. проксирует запросы к модели, держа ключ только на сервере
 *   3. пишет журнал прогонов в ./runs — по спеке, раздел 7
 *
 * Зависимостей нет. Нужен Node 18+.
 */

const http = require('http');
const fs   = require('fs');
const path = require('path');

const PORT      = process.env.PORT || 8080;
const API_KEY   = process.env.ANTHROPIC_API_KEY;
const BASE_URL  = (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, '');
const MODEL     = process.env.MODEL || '';      // подмена имени модели, нужна для шлюзов
const PROVIDER  = process.env.PROVIDER || '';  // жёстко закрепить провайдера у шлюза

/* Режим релея. Нужен, когда до модели не дотянуться напрямую:
   российский сервер отдаёт страницу и пересылает запросы на зарубежный экземпляр,
   а тот уже ходит к модели. Пользователи при этом заходят только на российский адрес. */
const RELAY_TO = (process.env.RELAY_TO || '').replace(/\/+$/, '');
const RELAY_PASSWORD = process.env.RELAY_PASSWORD || '';   // пароль дальнего сервера, если он закрыт
const PASSWORD  = process.env.ACCESS_PASSWORD || '';   // пусто — вход свободный
const LOG_RUNS  = process.env.LOG_RUNS !== '0';
const MAX_BODY  = 12 * 1024 * 1024;                    // 12 МБ: скриншоты в base64

const PUBLIC = path.join(__dirname, 'public');
const RUNS   = path.join(__dirname, 'runs');

if (!API_KEY && !RELAY_TO) {
  console.error('Не задан ANTHROPIC_API_KEY (и не указан RELAY_TO). Запуск невозможен.');
  process.exit(1);
}
let canLog = LOG_RUNS;
if (canLog) {
  try { if (!fs.existsSync(RUNS)) fs.mkdirSync(RUNS, { recursive: true }); }
  catch (e) { canLog = false; console.warn('Журнал отключён: нет доступа к диску'); }
}

const MIME = {
  '.woff2': 'font/woff2',
  '.woff' : 'font/woff',
  '.html': 'text/html; charset=utf-8',
  '.js'  : 'text/javascript; charset=utf-8',
  '.css' : 'text/css; charset=utf-8',
  '.svg' : 'image/svg+xml',
  '.ico' : 'image/x-icon',
  '.json': 'application/json; charset=utf-8'
};

function authOk(req) {
  if (!PASSWORD) return true;
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) return false;
  const [, pass] = Buffer.from(h.slice(6), 'base64').toString('utf8').split(':');
  return pass === PASSWORD;
}

// Дальний сервер в схеме с релеем можно закрыть отдельным паролем,
// чтобы к нему ходил только наш российский экземпляр, а не кто угодно.
const RELAY_ACCEPT = process.env.RELAY_ACCEPT || '';
function relayOk(req) {
  if (!RELAY_ACCEPT) return true;
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) return false;
  const [, pass] = Buffer.from(h.slice(6), 'base64').toString('utf8').split(':');
  return pass === RELAY_ACCEPT;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('too_large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// в журнал не пишем содержимое картинок — только текст и метаданные
function logRun(payload, answer, ms, status) {
  if (!canLog) return;
  try {
    const msgs = (payload.messages || []).map(m => ({
      role: m.role,
      content: Array.isArray(m.content)
        ? m.content.map(b => b.type === 'text' ? { type: 'text', text: b.text }
                                               : { type: b.type, omitted: true })
        : m.content
    }));
    const rec = {
      at: new Date().toISOString(), ms, status,
      model: payload.model, temperature: payload.temperature,
      request: msgs, response: answer
    };
    const file = path.join(RUNS, new Date().toISOString().slice(0, 10) + '.jsonl');
    fs.appendFile(file, JSON.stringify(rec) + '\n', () => {});
  } catch (_) { /* журнал не должен ронять запрос */ }
}

async function proxy(req, res) {
  let raw;
  try {
    raw = await readBody(req);
  } catch (e) {
    res.writeHead(413, MIME['.json']);
    return res.end(JSON.stringify({ error: 'Материал слишком большой. Уберите часть файлов.' }));
  }

  let payload;
  try { payload = JSON.parse(raw); }
  catch { res.writeHead(400); return res.end('{"error":"bad_json"}'); }

  // детерминизм задаём на сервере: страница не может его отключить
  payload.temperature = 0;
  // у шлюзов имя модели своё: anthropic/claude-sonnet-4.6 вместо claude-sonnet-4-6
  if (MODEL) payload.model = MODEL;
  // без этого шлюз может увести запрос к другому провайдеру той же модели
  if (PROVIDER) payload.provider = { order: [PROVIDER], allow_fallbacks: false };

  const started = Date.now();
  try {
    // в режиме релея ключ остаётся на дальнем сервере, здесь он не нужен
    const url = RELAY_TO ? RELAY_TO + '/api/messages' : BASE_URL + '/v1/messages';
    const headers = RELAY_TO
      ? { 'content-type': 'application/json',
          ...(RELAY_PASSWORD ? {'authorization': 'Basic ' + Buffer.from('relay:' + RELAY_PASSWORD).toString('base64')} : {}) }
      : { 'content-type': 'application/json',
          // Anthropic ждёт x-api-key, шлюзы — Bearer. Шлём оба, лишний игнорируется
          'x-api-key': API_KEY,
          'authorization': 'Bearer ' + API_KEY,
          'anthropic-version': '2023-06-01' };

    const upstream = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload)
    });
    const text = await upstream.text();
    const ms = Date.now() - started;

    let answer = null;
    try { answer = JSON.parse(text); } catch (_) {}
    logRun(payload, upstream.ok ? answer : { error: text.slice(0, 500) }, ms, upstream.status);

    res.writeHead(upstream.status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(text);
  } catch (e) {
    logRun(payload, { error: String(e) }, Date.now() - started, 502);
    res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'Модель недоступна: ' + e.message }));
  }
}

function serveStatic(req, res) {
  const url = req.url.split('?')[0];
  const rel = url === '/' ? 'index.html' : decodeURIComponent(url).replace(/^\/+/, '');
  const file = path.join(PUBLIC, rel);

  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end('forbidden'); }

  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-store'
    });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  try {
    return Promise.resolve(handle(req, res)).catch(e => {
      console.error('Ошибка обработчика:', e);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Внутренняя ошибка');
    });
  } catch (e) {
    console.error('Ошибка обработчика:', e);
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Внутренняя ошибка');
  }
});

async function handle(req, res) {
  if (req.url === '/health') { res.writeHead(200); return res.end('ok'); }

  // страница показывает в шапке ту модель, которая реально используется
  if (req.url === '/api/config') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    // в режиме релея модель знает дальний сервер — спрашиваем у него, чтобы шапка не врала
    if (RELAY_TO && !MODEL) {
      try {
        const r = await fetch(RELAY_TO + '/api/config', {
          headers: RELAY_PASSWORD
            ? {'authorization': 'Basic ' + Buffer.from('relay:' + RELAY_PASSWORD).toString('base64')}
            : {}
        });
        if (r.ok) {
          const cfg = await r.json();
          return res.end(JSON.stringify({ ...cfg, relay: true }));
        }
      } catch (_) { /* дальний недоступен — отдадим своё значение */ }
    }
    return res.end(JSON.stringify({ model: MODEL || 'claude-sonnet-4-6', provider: PROVIDER || null,
                                    relay: RELAY_TO ? true : false }));
  }

  if (RELAY_ACCEPT && relayOk(req)) {
    if (req.method === 'POST' && req.url === '/api/messages') return proxy(req, res);
    if (req.url === '/api/config') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ model: MODEL || 'claude-sonnet-4-6', provider: PROVIDER || null }));
    }
  }

  if (!authOk(req)) {
    // realm только латиницей: кириллица в заголовке роняет Node
    res.writeHead(401, {
      'WWW-Authenticate': 'Basic realm="Comms Assistant"',
      'content-type': 'text/plain; charset=utf-8'
    });
    return res.end('Нужен пароль. Логин любой, пароль спросите у владельца инструмента.');
  }

  if (req.method === 'POST' && req.url === '/api/messages') {
    // запрос от релея приходит с отдельным паролем, обычный вход этого не требует
    if (RELAY_ACCEPT && !relayOk(req) && !authOk(req)) {
      res.writeHead(401, {'content-type':'text/plain; charset=utf-8'});
      return res.end('Нет доступа');
    }
    return proxy(req, res);
  }
  if (req.method === 'GET') return serveStatic(req, res);

  res.writeHead(405); res.end('method not allowed');
}

process.on('uncaughtException', e => console.error('Непойманная ошибка:', e));
process.on('unhandledRejection', e => console.error('Необработанный отказ:', e));

server.listen(PORT, () => {
  console.log(`Ассистент запущен: http://localhost:${PORT}`);
  console.log(RELAY_TO
    ? `Режим релея: запросы идут на ${RELAY_TO}`
    : `Модель через: ${BASE_URL}${MODEL ? ' · ' + MODEL : ''}${PROVIDER ? ' · провайдер ' + PROVIDER : ''}`);
  console.log(`Пароль: ${PASSWORD ? 'включён' : 'не задан — вход свободный'}`);
  console.log(`Журнал прогонов: ${canLog ? RUNS : 'отключён'}`);
});
