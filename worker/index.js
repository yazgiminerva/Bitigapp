// Kitaplığım ortak kitap listesi.
// Uygulama bir kitabı kaydettiğinde yalnızca künye bilgilerini (ISBN, başlık, yazar,
// çevirmen, yayınevi, yıl, sayfa, tür, kapak adresi) buraya gönderir. Okuma durumu,
// puan, notlar, ödünç bilgisi gibi kişisel alanlar asla gönderilmez.
// Barkod okutulduğunda uygulama önce burada arar.
//
// GET  /book?isbn=978...   -> {ok, found, book}
// POST /book  {isbn, title, ...} -> {ok, created}
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
  if (url.searchParams.get('ping')) return json(req, {ok: true, version: 10});
  if (url.pathname !== '/book') return json(req, {ok: false, error: 'Bilinmeyen adres'});

  if (req.method === 'GET') {
    const isbn = normIsbn(url.searchParams.get('isbn'));
    if (!isbn) return json(req, {ok: false, error: 'Geçersiz ISBN'});
    const row = await env.DB.prepare('SELECT isbn, title, author, translator, publisher, year, pages, genre, cover FROM books WHERE isbn = ?').bind(isbn).first();
    return json(req, {ok: true, found: !!row, book: row || null});
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
