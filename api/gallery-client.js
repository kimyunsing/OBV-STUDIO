// 고객용 API — /api/gallery-client (POST, body.action)
const L = require('./_gallery-lib');

const MAX_ATTEMPTS = 5;

function siteOrigin(req) {
  if (process.env.SITE_URL) return process.env.SITE_URL.replace(/\/$/, '');
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  return `${proto}://${host}`;
}
const LOCK_MINUTES = 15;

async function bySlug(slug) {
  if (!/^[a-z0-9]{6,20}$/.test(String(slug || ''))) throw L.fail(404, '갤러리를 찾을 수 없어요. 링크를 다시 확인해 주세요.');
  const rows = await L.db(`galleries?slug=eq.${slug}&select=*`);
  if (!rows.length) throw L.fail(404, '갤러리를 찾을 수 없어요. 링크를 다시 확인해 주세요.');
  return rows[0];
}

async function fromToken(token) {
  const p = L.verifyToken(token);
  if (!p || (p.role !== 'client' && p.role !== 'retoucher')) throw L.fail(401, p ? '다시 입장해 주세요.' : '링크가 만료됐거나 올바르지 않아요.');
  const g = await bySlug(p.slug);
  if (g.id !== p.gid) throw L.fail(401, '다시 입장해 주세요.');
  g._role = p.role;
  return g;
}

function publicGallery(g) {
  return {
    client_name: g.client_name,
    shoot_date: g.shoot_date,
    package: g.package,
    package_label: (L.PACKAGES[g.package] || {}).label || g.package,
    select_limit: g.select_limit,
    status: g.status,
    selected: g.selected || [],
    selected_at: g.selected_at,
    originals_expire_at: g.originals_expire_at,
    delivered_at: g.delivered_at,
    retouched_expire_at: g.retouched_expire_at,
  };
}

const actions = {
  async login({ slug, pin }) {
    const g = await bySlug(slug);
    if (g.locked_until && new Date(g.locked_until) > new Date()) {
      throw L.fail(429, `비밀번호를 여러 번 틀려서 잠시 잠겼어요. ${LOCK_MINUTES}분 뒤에 다시 시도해 주세요.`);
    }
    if (!L.safeEqual(String(pin || '').trim(), g.pin)) {
      const n = (g.failed_attempts || 0) + 1;
      const patch = n >= MAX_ATTEMPTS
        ? { failed_attempts: 0, locked_until: new Date(Date.now() + LOCK_MINUTES * 60000).toISOString() }
        : { failed_attempts: n };
      await L.db(`galleries?id=eq.${g.id}`, { method: 'PATCH', body: patch });
      throw L.fail(401, '비밀번호가 맞지 않아요.');
    }
    if (g.failed_attempts) await L.db(`galleries?id=eq.${g.id}`, { method: 'PATCH', body: { failed_attempts: 0, locked_until: null } });
    return { token: L.signToken({ role: 'client', gid: g.id, slug: g.slug }, 24 * 3600 * 1000) };
  },

  async get({ token }) {
    const g = await fromToken(token);
    if (g.status === 'uploading') return { gallery: publicGallery(g), originals: [], retouched: [] };

    const photos = await L.db(`gallery_photos?gallery_id=eq.${g.id}&select=id,kind,filename,object_key,preview_key,thumb_key,size_bytes,width,height`);
    const now = Date.now();
    const origOpen = !g.originals_expire_at || new Date(g.originals_expire_at).getTime() > now;
    const retOpen = g.status === 'delivered' && (!g.retouched_expire_at || new Date(g.retouched_expire_at).getTime() > now);

    const view = (p, canDownload) => ({
      id: p.id,
      filename: p.filename,
      size: p.size_bytes,
      width: p.width,
      height: p.height,
      thumb: p.thumb_key ? L.viewUrl(p.thumb_key) : null,
      preview: p.preview_key ? L.viewUrl(p.preview_key) : null,
      download: canDownload ? L.downloadUrl(p.object_key, p.filename) : null,
    });
    const byName = (a, b) => a.filename.localeCompare(b.filename, 'en', { numeric: true });

    // 보정 작가용 링크: 고객이 고른 원본만, 다운로드 가능하게
    if (g._role === 'retoucher') {
      const sel = new Set(g.selected || []);
      return {
        role: 'retoucher',
        gallery: publicGallery(g),
        originals: photos.filter((p) => p.kind === 'original' && sel.has(p.id)).map((p) => view(p, origOpen)).sort(byName),
        retouched: [],
      };
    }

    return {
      role: 'client',
      gallery: publicGallery(g),
      originals: photos.filter((p) => p.kind === 'original').map((p) => view(p, origOpen)).sort(byName),
      retouched: retOpen ? photos.filter((p) => p.kind === 'retouched').map((p) => view(p, true)).sort(byName) : [],
    };
  },

  async select({ token, photoIds }, req) {
    const g = await fromToken(token);
    if (g._role !== 'client') throw L.fail(403, '이 링크로는 선택할 수 없어요.');
    if (g.status !== 'selecting') throw L.fail(409, '이미 선택이 완료됐어요. 변경이 필요하면 카카오톡 채널로 말씀해 주세요.');
    const ids = [...new Set((photoIds || []).filter((x) => /^[0-9a-f-]{36}$/i.test(x)))];
    if (!ids.length) throw L.fail(400, '사진을 선택해 주세요.');
    if (g.select_limit > 0 && ids.length > g.select_limit) throw L.fail(400, `최대 ${g.select_limit}장까지 고를 수 있어요.`);

    const rows = await L.db(`gallery_photos?gallery_id=eq.${g.id}&kind=eq.original&id=in.(${ids.join(',')})&select=id,filename`);
    if (rows.length !== ids.length) throw L.fail(400, '선택한 사진 중 확인되지 않는 사진이 있어요. 새로고침 후 다시 시도해 주세요.');

    // 다른 요청이 먼저 끝냈다면 덮어쓰지 않도록 status 조건을 함께 건다
    const updated = await L.db(`galleries?id=eq.${g.id}&status=eq.selecting&select=id`, {
      method: 'PATCH',
      body: { selected: ids, selected_at: new Date().toISOString(), status: 'selected' },
      prefer: 'return=representation',
    });
    if (!updated.length) throw L.fail(409, '이미 선택이 완료됐어요.');

    const names = rows.map((r) => r.filename).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
    const site = siteOrigin(req);
    const adminUrl = `${site}/gallery-admin#/g/${g.id}`;
    const retUrl = `${site}/g/${g.slug}#r=${L.signToken({ role: 'retoucher', gid: g.id, slug: g.slug }, 14 * L.DAY)}`;
    const count = g.select_limit > 0 ? `${names.length}/${g.select_limit}장` : `${names.length}장 (무제한)`;
    const btn = (href, label, dark) => `<a href="${L.esc(href)}" style="display:inline-block;padding:11px 16px;margin:0 6px 8px 0;text-decoration:none;font-size:14px;${dark ? 'background:#121212;color:#fff' : 'border:1px solid #121212;color:#121212'}">${label}</a>`;
    await L.notify(
      `[OBVIO 셀렉 완료] ${g.client_name} · ${count}`,
      `<div style="font-family:-apple-system,'Apple SD Gothic Neo',sans-serif;font-size:14px;line-height:1.65;color:#121212;max-width:520px">
        <p style="font-size:17px;margin:0 0 4px"><b>${L.esc(g.client_name)}</b>님이 사진을 골랐어요.</p>
        <p style="color:#666;margin:0 0 18px">촬영일 ${L.esc(g.shoot_date)} · ${L.esc((L.PACKAGES[g.package] || {}).label || g.package)} · ${count}</p>
        <div style="margin:0 0 14px">${btn(retUrl, '형님용 원본 링크 열기', true)}${btn(adminUrl, '관리자 화면')}</div>
        <p style="font-size:12.5px;color:#666;margin:0 0 6px">형님께 그대로 전달할 링크 (14일 유효):</p>
        <p style="font-size:12px;background:#f4f4f2;padding:10px;word-break:break-all;margin:0 0 18px">${L.esc(retUrl)}</p>
        <p style="font-size:12.5px;color:#666;margin:0 0 6px">고른 파일</p>
        <pre style="background:#f4f4f2;padding:12px;font-size:13px;margin:0">${names.map(L.esc).join('\n')}</pre>
      </div>`,
    ).catch((e) => console.error(e));
    return { ok: true, selected: ids };
  },
};

module.exports = L.route(actions);
