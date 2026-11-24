// Kitaplığım ortak kitap listesi.
// Uygulama bir kitabı kaydettiğinde yalnızca künye bilgilerini (ISBN, başlık, yazar,
// çevirmen, yayınevi, yıl, sayfa, tür, kapak adresi) buraya gönderir. Okuma durumu,
// puan, notlar, ödünç bilgisi gibi kişisel alanlar asla gönderilmez.
// Barkod okutulduğunda uygulama önce burada arar.
//
// GET  /book?isbn=978...   -> {ok, found, book}
// POST /book  {isbn, title, ...} -> {ok, created}
// GET  /cover?isbn=978...  -> the shared cover image (404 if none); &check=1 -> {ok, exists}
// POST /cover {isbn, mime, data(base64)} -> a cover a user chose to share; the first one stays
// Var olan bir kaydın dolu alanları değiştirilmez, yalnızca boş alanları doldurulur.

const ALLOWED = ['https://yazgiminerva.github.io'];
const FIELDS = ['title', 'author', 'translator', 'publisher', 'genre', 'cover'];

function cors(req) {
  const o = req.headers.get('Origin') || '';
  return {
    'Access-Control-Allow-Origin': ALLOWED.includes(o) ? o : ALLOWED[0],
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}
const json = (req, body, extra = {}) =>
  new Response(JSON.stringify(body), {headers: {...cors(req), 'Content-Type': 'application/json; charset=utf-8', ...extra}});

// ISBN-13 (978/979) ya da ISBN-10, sağlama basamağıyla birlikte doğrulanır
function normIsbn(v) {
  const s = String(v || '').replace(/[^0-9Xx]/g, '').toUpperCase();
  if (/^97[89]\d{10}$/.test(s)) {
    let sum = 0;
    for (let i = 0; i < 12; i++) sum += +s[i] * (i % 2 ? 3 : 1);
    return (10 - (sum % 10)) % 10 === +s[12] ? s : null;
  }
  if (/^\d{9}[\dX]$/.test(s)) {
    let sum = 0;
    for (let i = 0; i < 10; i++) sum += (s[i] === 'X' ? 10 : +s[i]) * (10 - i);
    if (sum % 11) return null;
    // ISBN-10'u 978'li ISBN-13'e çevir, tek bir anahtar kullanalım
    const b = '978' + s.slice(0, 9);
    let t = 0;
    for (let i = 0; i < 12; i++) t += +b[i] * (i % 2 ? 3 : 1);
    return b + ((10 - (t % 10)) % 10);
  }
  return null;
}
const clean = (v, max) => typeof v === 'string' ? v.replace(/[\u0000-\u001f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '';
const int = (v, lo, hi) => { const n = parseInt(v, 10); return Number.isFinite(n) && n >= lo && n <= hi ? n : null; };

export default {
  async fetch(req, env) {
    try { return await handle(req, env); }
    catch (e) { return json(req, {ok: false, error: 'Aracıda hata', detail: String(e && e.message || e)}); }
  },
};

async function handle(req, env) {
  if (req.method === 'OPTIONS') return new Response(null, {headers: cors(req)});
  const url = new URL(req.url);
  if (url.searchParams.get('ping')) return json(req, {ok: true, version: 11});
  // writes only from the app's own page
  if (req.method === 'POST' && !ALLOWED.includes(req.headers.get('Origin') || '')) return json(req, {ok: false, error: 'İzin yok'});
  if (url.pathname === '/cover') return cover(req, env, url);
  if (url.pathname !== '/book') return json(req, {ok: false, error: 'Bilinmeyen adres'});

  if (req.method === 'GET') {
    const isbn = normIsbn(url.searchParams.get('isbn'));
    if (!isbn) return json(req, {ok: false, error: 'Geçersiz ISBN'});
    const row = await env.DB.prepare('SELECT isbn, title, author, translator, publisher, year, pages, genre, cover FROM books WHERE isbn = ?').bind(isbn).first();
    const pc = await env.DB.prepare('SELECT 1 AS x FROM covers WHERE isbn = ?').bind(isbn).first();
    const poolUrl = pc ? `${url.origin}/cover?isbn=${isbn}` : '';
    if (row && poolUrl && !row.cover) row.cover = poolUrl;
    return json(req, {ok: true, found: !!row, book: row || null, poolCover: poolUrl});
  }

  if (req.method === 'POST') {
    const raw = await req.text();
    if (raw.length > 4000) return json(req, {ok: false, error: 'Çok büyük'});
    let b; try { b = JSON.parse(raw); } catch (e) { return json(req, {ok: false, error: 'Geçersiz veri'}); }
    const isbn = normIsbn(b && b.isbn);
    const title = clean(b && b.title, 300);
    if (!isbn || !title) return json(req, {ok: false, error: 'ISBN ve başlık gerekli'});
    const cover = clean(b.cover, 500);
    const rec = {
      title, author: clean(b.author, 200), translator: clean(b.translator, 200), publisher: clean(b.publisher, 200),
      genre: clean(b.genre, 60), cover: /^https:\/\//.test(cover) ? cover : '',
      year: int(b.year, 1450, 2100), pages: int(b.pages, 1, 20000),
    };
    const now = new Date().toISOString();
    // Yeni kayıt ekle; varsa yalnızca boş alanları doldur ve kaydetme sayısını artır
    const r = await env.DB.prepare(`INSERT INTO books (isbn, title, author, translator, publisher, year, pages, genre, cover, saves, created_at, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 1, ?10, ?10)
      ON CONFLICT(isbn) DO UPDATE SET
        author = CASE WHEN IFNULL(author, '') = '' THEN excluded.author ELSE author END,
        translator = CASE WHEN IFNULL(translator, '') = '' THEN excluded.translator ELSE translator END,
        publisher = CASE WHEN IFNULL(publisher, '') = '' THEN excluded.publisher ELSE publisher END,
        genre = CASE WHEN IFNULL(genre, '') = '' THEN excluded.genre ELSE genre END,
        cover = CASE WHEN IFNULL(cover, '') = '' THEN excluded.cover ELSE cover END,
        year = IFNULL(year, excluded.year),
        pages = IFNULL(pages, excluded.pages),
        saves = saves + 1,
        updated_at = ?10`)
      .bind(isbn, rec.title, rec.author, rec.translator, rec.publisher, rec.year, rec.pages, rec.genre, rec.cover, now).run();
    return json(req, {ok: true, isbn, changes: r.meta && r.meta.changes});
  }
  return json(req, {ok: false, error: 'Desteklenmeyen istek'});
}

async function cover(req, env, url) {
  if (req.method === 'GET') {
    const isbn = normIsbn(url.searchParams.get('isbn'));
    if (!isbn) return json(req, {ok: false, error: 'Geçersiz ISBN'});
    if (url.searchParams.get('check')) {
      const r = await env.DB.prepare('SELECT 1 AS x FROM covers WHERE isbn = ?').bind(isbn).first();
      return json(req, {ok: true, exists: !!r, url: r ? `${url.origin}/cover?isbn=${isbn}` : ''});
    }
    const row = await env.DB.prepare('SELECT mime, data FROM covers WHERE isbn = ?').bind(isbn).first();
    if (!row) return new Response('Kapak yok', {status: 404, headers: cors(req)});
    const bin = atob(row.data), bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Response(bytes, {headers: {...cors(req), 'Content-Type': row.mime, 'Cache-Control': 'public, max-age=604800'}});
  }
  if (req.method === 'POST') {
    const raw = await req.text();
    if (raw.length > 420000) return json(req, {ok: false, error: 'Fotoğraf çok büyük'});
    let b; try { b = JSON.parse(raw); } catch (e) { return json(req, {ok: false, error: 'Geçersiz veri'}); }
    const isbn = normIsbn(b && b.isbn);
    const mime = b && b.mime === 'image/png' ? 'image/png' : 'image/jpeg';
    const data = typeof (b && b.data) === 'string' ? b.data : '';
    if (!isbn) return json(req, {ok: false, error: 'Geçersiz ISBN'});
    if (data.length < 2000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return json(req, {ok: false, error: 'Geçersiz fotoğraf'});
    // check the file really is a JPEG or PNG
    const head = atob(data.slice(0, 16));
    const isJpg = head.charCodeAt(0) === 0xFF && head.charCodeAt(1) === 0xD8 && head.charCodeAt(2) === 0xFF;
    const isPng = head.slice(1, 4) === 'PNG';
    if (!isJpg && !isPng) return json(req, {ok: false, error: 'Geçersiz fotoğraf'});
    const r = await env.DB.prepare('INSERT OR IGNORE INTO covers (isbn, mime, data, size, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(isbn, isPng ? 'image/png' : 'image/jpeg', data, Math.round(data.length * 3 / 4), new Date().toISOString()).run();
    const created = !!(r.meta && r.meta.changes);
    return json(req, {ok: true, created, url: `${url.origin}/cover?isbn=${isbn}`});
  }
  return json(req, {ok: false, error: 'Desteklenmeyen istek'});
}
