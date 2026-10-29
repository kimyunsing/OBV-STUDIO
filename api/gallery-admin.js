// 관리자용 API — /api/gallery-admin (POST, body.action)
const L = require('./_gallery-lib');

const GALLERY_FIELDS = 'id,slug,client_name,shoot_date,package,select_limit,pin,memo,status,selected,selected_at,originals_expire_at,delivered_at,retouched_expire_at,original_count,retouched_count,created_at';

function requireAdmin(req) {
  const p = L.verifyToken(L.bearer(req));
  if (!p || p.role !== 'admin') throw L.fail(401, '다시 로그인해 주세요.');
}

async function getGallery(id) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id))) throw L.fail(400, '잘못된 갤러리예요.');
  const rows = await L.db(`galleries?id=eq.${id}&select=${GALLERY_FIELDS}`);
  if (!rows.length) throw L.fail(404, '갤러리를 찾을 수 없어요.');
  return rows[0];
}

function cleanPin(pin) {
  const p = String(pin ?? '').trim();
  if (!/^\d{4,8}$/.test(p)) throw L.fail(400, '비밀번호는 숫자 4~8자리로 정해 주세요.');
  return p;
}

function cleanPackage(pkg, limit) {
  const p = L.PACKAGES[pkg] ? pkg : 'BASIC';
  const n = Number(limit) > 0 ? Math.min(200, Math.floor(Number(limit))) : L.PACKAGES[p].limit;
  return { package: p, select_limit: n };
}

const safeName = (name) => String(name).normalize('NFC').replace(/[^A-Za-z0-9._-]+/g, '_').slice(-80) || 'file';

const actions = {
  async login({ password }) {
    if (!password || !L.safeEqual(password, L.env('ADMIN_PASSWORD'))) {
      await new Promise((r) => setTimeout(r, 800));
      throw L.fail(401, '비밀번호가 맞지 않아요.');
    }
    return { token: L.signToken({ role: 'admin' }, 12 * 3600 * 1000) };
  },

  async list(_, req) {
    requireAdmin(req);
    const rows = await L.db(`galleries?select=${GALLERY_FIELDS}&order=shoot_date.desc,created_at.desc&limit=300`);
    return { galleries: rows, packages: L.PACKAGES };
  },

  async create(body, req) {
    requireAdmin(req);
    const client_name = String(body.client_name || '').trim().slice(0, 60);
    if (!client_name) throw L.fail(400, '고객 이름을 입력해 주세요.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(body.shoot_date || '')) throw L.fail(400, '촬영 날짜를 입력해 주세요.');
    const row = {
      slug: L.randomSlug(),
      client_name,
      shoot_date: body.shoot_date,
      pin: cleanPin(body.pin),
      memo: String(body.memo || '').slice(0, 500) || null,
      ...cleanPackage(body.package, body.select_limit),
    };
    const [g] = await L.db('galleries?select=' + GALLERY_FIELDS, { method: 'POST', body: row, prefer: 'return=representation' });
    return { gallery: g };
  },

  async update(body, req) {
    requireAdmin(req);
    const g = await getGallery(body.id);
    const f = body.fields || {};
    const patch = {};
    if (f.client_name !== undefined) patch.client_name = String(f.client_name).trim().slice(0, 60) || g.client_name;
    if (f.shoot_date && /^\d{4}-\d{2}-\d{2}$/.test(f.shoot_date)) patch.shoot_date = f.shoot_date;
    if (f.memo !== undefined) patch.memo = String(f.memo).slice(0, 500) || null;
    if (f.pin !== undefined) { patch.pin = cleanPin(f.pin); patch.failed_attempts = 0; patch.locked_until = null; }
    if (f.package !== undefined || f.select_limit !== undefined) Object.assign(patch, cleanPackage(f.package ?? g.package, f.select_limit));
    const [row] = await L.db(`galleries?id=eq.${g.id}&select=${GALLERY_FIELDS}`, { method: 'PATCH', body: patch, prefer: 'return=representation' });
    return { gallery: row };
  },

  async detail({ id }, req) {
    requireAdmin(req);
    const g = await getGallery(id);
    const photos = await L.db(`gallery_photos?gallery_id=eq.${g.id}&select=id,kind,filename,object_key,thumb_key,preview_key,size_bytes,width,height&order=filename.asc`);
    return {
      gallery: g,
      photos: photos.map((p) => ({
        id: p.id, kind: p.kind, filename: p.filename, size: p.size_bytes, width: p.width, height: p.height,
        thumb: p.thumb_key ? L.viewUrl(p.thumb_key) : null,
        preview: p.preview_key ? L.viewUrl(p.preview_key) : null,
        download: L.downloadUrl(p.object_key, p.filename),
      })),
    };
  },

  // 브라우저가 R2로 직접 올릴 수 있도록 서명된 PUT 주소를 발급
  async presign({ id, kind, files }, req) {
    requireAdmin(req);
    const g = await getGallery(id);
    if (!['original', 'retouched'].includes(kind)) throw L.fail(400, '잘못된 종류예요.');
    if (!Array.isArray(files) || !files.length || files.length > 50) throw L.fail(400, '파일 목록이 비어 있거나 너무 많아요.');
    return {
      uploads: files.map((f) => {
        const base = `${g.id}/${L.randomHex(3)}-${safeName(f.name)}`;
        const keys = { object_key: `${kind}/${base}`, preview_key: `preview/${base}.jpg`, thumb_key: `thumb/${base}.jpg` };
        return {
          name: f.name,
          ...keys,
          put: {
            object: L.presign('PUT', keys.object_key, { expires: 3 * 3600 }),
            preview: L.presign('PUT', keys.preview_key, { expires: 3 * 3600 }),
            thumb: L.presign('PUT', keys.thumb_key, { expires: 3 * 3600 }),
          },
        };
      }),
    };
  },

  // 업로드가 끝난 파일을 DB에 기록 (같은 파일명은 건너뜀 → 이어 올리기 가능)
  async register({ id, kind, items }, req) {
    requireAdmin(req);
    const g = await getGallery(id);
    if (!['original', 'retouched'].includes(kind)) throw L.fail(400, '잘못된 종류예요.');
    const prefix = (p) => typeof p === 'string' && p.includes(`/${g.id}/`);
    const rows = (items || []).filter((it) => it.filename && prefix(it.object_key)).map((it) => ({
      gallery_id: g.id,
      kind,
      filename: String(it.filename).normalize('NFC').slice(0, 200),
      object_key: it.object_key,
      preview_key: prefix(it.preview_key) ? it.preview_key : null,
      thumb_key: prefix(it.thumb_key) ? it.thumb_key : null,
      size_bytes: Number(it.size) || null,
      width: Number(it.width) || null,
      height: Number(it.height) || null,
    }));
    if (!rows.length) return { inserted: 0 };
    const out = await L.db('gallery_photos?on_conflict=gallery_id,kind,filename&select=id', {
      method: 'POST', body: rows, prefer: 'return=representation,resolution=ignore-duplicates',
    });
    return { inserted: out.length };
  },

  async 'finish-originals'({ id }, req) {
    requireAdmin(req);
    const g = await getGallery(id);
    const patch = { originals_expire_at: new Date(Date.now() + L.ORIGINAL_DAYS * L.DAY).toISOString() };
    if (g.status === 'uploading') patch.status = 'selecting';
    const [row] = await L.db(`galleries?id=eq.${g.id}&select=${GALLERY_FIELDS}`, { method: 'PATCH', body: patch, prefer: 'return=representation' });
    return { gallery: row };
  },

  async 'finish-retouched'({ id }, req) {
    requireAdmin(req);
    const g = await getGallery(id);
    const now = Date.now();
    const [row] = await L.db(`galleries?id=eq.${g.id}&select=${GALLERY_FIELDS}`, {
      method: 'PATCH',
      body: { status: 'delivered', delivered_at: new Date(now).toISOString(), retouched_expire_at: new Date(now + L.RETOUCHED_DAYS * L.DAY).toISOString() },
      prefer: 'return=representation',
    });
    return { gallery: row };
  },

  async 'reset-selection'({ id }, req) {
    requireAdmin(req);
    const g = await getGallery(id);
    const [row] = await L.db(`galleries?id=eq.${g.id}&select=${GALLERY_FIELDS}`, {
      method: 'PATCH', body: { selected: null, selected_at: null, status: 'selecting' }, prefer: 'return=representation',
    });
    return { gallery: row };
  },

  async 'delete-photos'({ id, photoIds }, req) {
    requireAdmin(req);
    const g = await getGallery(id);
    const ids = (photoIds || []).filter((x) => /^[0-9a-f-]{36}$/i.test(x));
    if (!ids.length) return { deleted: 0 };
    const rows = await L.db(`gallery_photos?gallery_id=eq.${g.id}&id=in.(${ids.join(',')})&select=id,object_key,preview_key,thumb_key`);
    await L.deleteObjects(rows.flatMap((r) => [r.object_key, r.preview_key, r.thumb_key]));
    await L.db(`gallery_photos?gallery_id=eq.${g.id}&id=in.(${rows.map((r) => r.id).join(',') || '00000000-0000-0000-0000-000000000000'})`, { method: 'DELETE' });
    return { deleted: rows.length };
  },

  async delete({ id }, req) {
    requireAdmin(req);
    const g = await getGallery(id);
    const rows = await L.db(`gallery_photos?gallery_id=eq.${g.id}&select=object_key,preview_key,thumb_key`);
    await L.deleteObjects(rows.flatMap((r) => [r.object_key, r.preview_key, r.thumb_key]));
    await L.db(`galleries?id=eq.${g.id}`, { method: 'DELETE' });
    return { ok: true };
  },
};

module.exports = L.route(actions, { exposeErrors: true });
