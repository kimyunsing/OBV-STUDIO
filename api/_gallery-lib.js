// OBVIO 갤러리 공용 함수 — 파일명이 _로 시작하므로 Vercel이 API 경로로 노출하지 않습니다.
// 외부 패키지 없이 동작합니다 (Node 18+ 내장 fetch / crypto).
const crypto = require('crypto');

const PACKAGES = {
  BASIC:    { label: 'BASIC · 1컨셉',    limit: 4 },
  STANDARD: { label: 'STANDARD · 2컨셉', limit: 8 },
  PREMIUM:  { label: 'PREMIUM · 3컨셉',  limit: 12 },
  FREE:     { label: 'FREE · 무제한 선택', limit: 0 }, // 0 = 장수 제한 없음
};
const ORIGINAL_DAYS = 7;   // 원본 다운로드 기간
const RETOUCHED_DAYS = 30; // 보정본 다운로드 기간
const DAY = 24 * 60 * 60 * 1000;

function env(name, required = true) {
  const v = process.env[name];
  if (!v && required) throw fail(500, `서버 설정 누락: 환경변수 ${name}`);
  return v;
}

function fail(status, message) {
  const e = new Error(message);
  e.status = status;
  e.expose = true;
  return e;
}

// ---------- 토큰 (HMAC 서명) ----------
const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const mac = (body) => b64url(crypto.createHmac('sha256', env('GALLERY_SECRET')).update(body).digest());

function signToken(payload, ttlMs) {
  const body = b64url(JSON.stringify({ ...payload, exp: Date.now() + ttlMs }));
  return `${body}.${mac(body)}`;
}

function verifyToken(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  if (!safeEqual(mac(body), sig)) return null;
  try {
    const p = JSON.parse(Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    return p.exp > Date.now() ? p : null;
  } catch { return null; }
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function bearer(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : null;
}

function randomSlug(n = 10) {
  const abc = 'abcdefghjkmnpqrstuvwxyz23456789';
  return [...crypto.randomBytes(n)].map((b) => abc[b % abc.length]).join('');
}

function randomHex(n = 4) { return crypto.randomBytes(n).toString('hex'); }

// ---------- Supabase (PostgREST) ----------
async function db(path, { method = 'GET', body, prefer } = {}) {
  const key = env('SUPABASE_SERVICE_ROLE_KEY');
  const headers = { apikey: key, 'Content-Type': 'application/json' };
  if (key.startsWith('eyJ')) headers.Authorization = `Bearer ${key}`; // 구형 JWT 키일 때만
  if (prefer) headers.Prefer = prefer;
  const r = await fetch(`${env('SUPABASE_URL').replace(/\/$/, '')}/rest/v1/${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`DB ${r.status} ${path}: ${text}`);
  return text ? JSON.parse(text) : null;
}

// ---------- Cloudflare R2 서명 URL (AWS SigV4, path-style) ----------
const sha256hex = (s) => crypto.createHash('sha256').update(s).digest('hex');
const hmac = (k, s) => crypto.createHmac('sha256', k).update(s).digest();
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

/**
 * @param method  'GET' | 'PUT' | 'DELETE'
 * @param key     버킷 안 경로
 * @param opts.expires  유효 시간(초, 최대 604800)
 * @param opts.query    추가 쿼리 (예: response-content-disposition)
 * @param opts.now      서명 시각 (같은 시간대 안에서 URL을 고정해 브라우저 캐시를 살리기 위함)
 */
function presign(method, key, { expires = 3600, query = {}, now = new Date() } = {}) {
  const accountId = env('R2_ACCOUNT_ID');
  const host = `${accountId}.r2.cloudflarestorage.com`;
  const region = 'auto';
  const service = 's3';
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const date = amzDate.slice(0, 8);
  const scope = `${date}/${region}/${service}/aws4_request`;
  const path = `/${env('R2_BUCKET')}/` + key.split('/').map(enc).join('/');

  const q = {
    ...query,
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${env('R2_ACCESS_KEY_ID')}/${scope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(expires),
    'X-Amz-SignedHeaders': 'host',
  };
  const canonicalQuery = Object.keys(q).map((k) => [enc(k), enc(q[k])]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join('&');
  const canonicalRequest = [method, path, canonicalQuery, `host:${host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest)].join('\n');

  let k = hmac('AWS4' + env('R2_SECRET_ACCESS_KEY'), date);
  k = hmac(k, region);
  k = hmac(k, service);
  k = hmac(k, 'aws4_request');
  const signature = crypto.createHmac('sha256', k).update(stringToSign).digest('hex');
  return `https://${host}${path}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

// 6시간 단위로 서명 시각을 고정 → 같은 사진의 URL이 바뀌지 않아 재방문 시 캐시 사용
function viewUrl(key) {
  const bucket = Math.floor(Date.now() / (6 * 3600 * 1000)) * 6 * 3600 * 1000;
  return presign('GET', key, { expires: 12 * 3600, now: new Date(bucket) });
}

function downloadUrl(key, filename) {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
  return presign('GET', key, {
    expires: 6 * 3600,
    query: { 'response-content-disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${enc(filename)}` },
  });
}

async function deleteObjects(keys) {
  const list = keys.filter(Boolean);
  for (let i = 0; i < list.length; i += 16) {
    await Promise.all(list.slice(i, i + 16).map(async (key) => {
      const r = await fetch(presign('DELETE', key, { expires: 300 }), { method: 'DELETE' });
      if (!r.ok && r.status !== 404) throw new Error(`R2 삭제 실패 ${r.status} ${key}`);
    }));
  }
}

// ---------- 메일 알림 (선택 사항) ----------
// 1) GOOGLE_SCRIPT_URL 이 있으면: 구글 Apps Script로 ys Gmail에서 발송 (가입 불필요)
// 2) 아니면 RESEND_API_KEY + NOTIFY_EMAIL 이 있으면 Resend로 발송
// 둘 다 없으면 조용히 건너뜀 (관리자 화면에서 확인)
function notifyKey() {
  // 구글 스크립트와 맞추는 키: GALLERY_SECRET에서 파생 (코드에 비밀값을 직접 쓰지 않기 위함)
  return crypto.createHmac('sha256', env('GALLERY_SECRET')).update('obvio-notify').digest('hex').slice(0, 32);
}

async function notify(subject, html) {
  const to = (process.env.NOTIFY_EMAIL || '').split(',').map((s) => s.trim()).filter(Boolean);

  const gs = process.env.GOOGLE_SCRIPT_URL;
  if (gs) {
    const r = await fetch(gs, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: notifyKey(), to: to.join(','), subject, html }),
      redirect: 'follow',
    });
    const text = await r.text();
    let ok = r.ok;
    try { ok = ok && JSON.parse(text).ok === true; } catch { ok = false; }
    if (!ok) console.error('구글 메일 전송 실패', r.status, text.slice(0, 300));
    return ok;
  }

  const key = process.env.RESEND_API_KEY;
  if (!key || !to.length) return false;
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: process.env.NOTIFY_FROM || 'OBVIO Gallery <onboarding@resend.dev>', to, subject, html }),
  });
  if (!r.ok) console.error('메일 전송 실패', r.status, await r.text());
  return r.ok;
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- 라우터 ----------
function route(actions, { exposeErrors = false } = {}) {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'POST') return res.status(405).json({ error: 'POST만 허용됩니다.' });
    try {
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
      const fn = actions[body.action];
      if (!fn) throw fail(400, '알 수 없는 요청이에요.');
      res.status(200).json((await fn(body, req)) ?? { ok: true });
    } catch (e) {
      const status = e.status || 500;
      if (status >= 500) console.error(e);
      res.status(status).json({ error: e.expose || exposeErrors ? e.message : '잠시 후 다시 시도해 주세요.' });
    }
  };
}

module.exports = {
  PACKAGES, ORIGINAL_DAYS, RETOUCHED_DAYS, DAY,
  env, fail, signToken, verifyToken, safeEqual, bearer, randomSlug, randomHex,
  db, presign, viewUrl, downloadUrl, deleteObjects, notify, notifyKey, esc, route,
};
