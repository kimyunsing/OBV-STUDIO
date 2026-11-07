// OBVIO 갤러리 — 여러 사진을 zip 하나로 묶어 받기 (맥·윈도우·모든 브라우저)
// 사진은 이미 압축된 파일이라 다시 압축하지 않고 그대로 묶습니다(STORE). 외부 라이브러리 없음.
(function () {
  const TABLE = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    TABLE[n] = c >>> 0;
  }
  function crc32(u8, c) {
    for (let i = 0; i < u8.length; i++) c = TABLE[(c ^ u8[i]) & 255] ^ (c >>> 8);
    return c;
  }
  const utf8 = new TextEncoder();

  function dos(d) {
    return {
      time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
      date: ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
    };
  }

  function Zip() { this.parts = []; this.central = []; this.offset = 0; this.count = 0; this.names = new Set(); }
  Zip.prototype.uniqueName = function (name) {
    let n = String(name).replace(/[\\/:*?"<>|]/g, '_') || 'photo';
    if (this.names.has(n.toLowerCase())) {
      const dot = n.lastIndexOf('.'), base = dot > 0 ? n.slice(0, dot) : n, ext = dot > 0 ? n.slice(dot) : '';
      let i = 2; while (this.names.has(`${base} (${i})${ext}`.toLowerCase())) i++;
      n = `${base} (${i})${ext}`;
    }
    this.names.add(n.toLowerCase());
    return n;
  };
  Zip.prototype.add = async function (name, blob) {
    const buf = new Uint8Array(await blob.arrayBuffer());
    const crc = (crc32(buf, 0xffffffff) ^ 0xffffffff) >>> 0;
    const size = buf.length;
    const nm = utf8.encode(this.uniqueName(name));
    const { time, date } = dos(new Date());

    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); // UTF-8 파일명
    h.setUint16(8, 0, true); h.setUint16(10, time, true); h.setUint16(12, date, true);
    h.setUint32(14, crc, true); h.setUint32(18, size, true); h.setUint32(22, size, true);
    h.setUint16(26, nm.length, true); h.setUint16(28, 0, true);
    this.parts.push(h.buffer, nm, blob); // 원본 Blob을 그대로 넣어 메모리 복사를 줄임

    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true);
    c.setUint16(10, 0, true); c.setUint16(12, time, true); c.setUint16(14, date, true);
    c.setUint32(16, crc, true); c.setUint32(20, size, true); c.setUint32(24, size, true);
    c.setUint16(28, nm.length, true); c.setUint32(42, this.offset, true);
    this.central.push(c.buffer, nm);

    this.offset += 30 + nm.length + size;
    this.count++;
  };
  Zip.prototype.blob = function () {
    const cdSize = this.central.reduce((a, p) => a + p.byteLength, 0);
    const e = new DataView(new ArrayBuffer(22));
    e.setUint32(0, 0x06054b50, true); e.setUint16(8, this.count, true); e.setUint16(10, this.count, true);
    e.setUint32(12, cdSize, true); e.setUint32(16, this.offset, true);
    return new Blob([...this.parts, ...this.central, e.buffer], { type: 'application/zip' });
  };

  // 용량 기준으로 zip 묶음을 나눔 (브라우저 메모리 보호, zip 4GB 한도 회피)
  function plan(files, limit) {
    const groups = []; let cur = [], sum = 0;
    files.forEach((f) => {
      const s = f.size || 25e6;
      if (cur.length && sum + s > limit) { groups.push(cur); cur = []; sum = 0; }
      cur.push(f); sum += s;
    });
    if (cur.length) groups.push(cur);
    return groups;
  }

  async function fetchBlob(url, onBytes, isCancelled) {
    let lastErr;
    for (let t = 0; t < 3; t++) {
      try {
        const r = await fetch(url);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        if (!r.body || !r.body.getReader) { const b = await r.blob(); onBytes(b.size); return b; }
        const reader = r.body.getReader(); const chunks = [];
        for (;;) {
          if (isCancelled()) { try { reader.cancel(); } catch (e) {} throw Object.assign(new Error('cancelled'), { name: 'AbortError' }); }
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value); onBytes(value.length);
        }
        return new Blob(chunks);
      } catch (err) {
        if (err.name === 'AbortError') throw err;
        lastErr = err;
        if (t === 0 && err instanceof TypeError) err.network = true;
        await new Promise((res) => setTimeout(res, 1200 * (t + 1)));
      }
    }
    throw lastErr;
  }

  function saveBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.rel = 'noopener';
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 120000);
  }

  // 한 장씩 다운로드 (zip을 만들 수 없을 때의 대안)
  async function oneByOne(files, onProgress) {
    for (let i = 0; i < files.length; i++) {
      const a = document.createElement('a'); a.href = files[i].download; a.rel = 'noopener';
      document.body.append(a); a.click(); a.remove();
      onProgress({ done: i + 1, total: files.length, fallback: true });
      await new Promise((res) => setTimeout(res, 1100));
    }
  }

  /**
   * files: [{ filename, download(서명 URL), size }]
   * opts.name: zip 파일 이름(확장자 제외)
   * opts.onProgress({ done, total, bytes, totalBytes, part, parts })
   * opts.isCancelled(): true면 중단
   */
  async function saveZip(files, opts) {
    const o = Object.assign({ name: 'OBVIO', limit: 1e9, onProgress() {}, isCancelled: () => false }, opts);
    const list = files.filter((f) => f.download);
    const groups = plan(list, o.limit);
    const totalBytes = list.reduce((a, f) => a + (f.size || 0), 0);
    let done = 0, bytes = 0;
    for (let gi = 0; gi < groups.length; gi++) {
      const zip = new Zip();
      for (const f of groups[gi]) {
        if (o.isCancelled()) return { cancelled: true };
        let blob;
        try {
          blob = await fetchBlob(f.download, (n) => { bytes += n; o.onProgress({ done, total: list.length, bytes, totalBytes, part: gi + 1, parts: groups.length }); }, o.isCancelled);
        } catch (err) {
          if (err.name === 'AbortError') return { cancelled: true };
          // 첫 사진부터 받지 못하면(보안 설정 등) 한 장씩 받기로 전환
          if (done === 0) { await oneByOne(list, o.onProgress); return { fallback: true, parts: 0 }; }
          throw err;
        }
        await zip.add(f.filename, blob);
        done++;
        o.onProgress({ done, total: list.length, bytes, totalBytes, part: gi + 1, parts: groups.length });
      }
      saveBlob(zip.blob(), groups.length > 1 ? `${o.name}_${gi + 1}.zip` : `${o.name}.zip`);
      if (gi < groups.length - 1) await new Promise((res) => setTimeout(res, 800));
    }
    return { parts: groups.length, count: list.length };
  }

  window.ObvioZip = { saveZip, plan, Zip };
})();
