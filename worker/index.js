// Bitigapp ortak kitap listesi.
// Uygulama bir kitabı kaydettiğinde yalnızca künye bilgilerini (ISBN, başlık, yazar,
// çevirmen, yayınevi, yıl, sayfa, tür, kapak adresi) buraya gönderir. Okuma durumu,
// puan, notlar, ödünç bilgisi gibi kişisel alanlar ve kimin gönderdiği asla tutulmaz.
// Barkod okutulduğunda ve adla arandığında uygulama önce burada arar.
//
// GET  /book?isbn=978...   -> {ok, found, book}
// POST /book  {isbn, title, ...} -> a book saved to someone's library (saves + 1)
// GET  /search?q=dorian gray -> {ok, books: [...]} most saved / picked first
// POST /pick  {isbn, title, ...} -> a search result someone opened or picked (picks + 1);
//                                   unknown books join the list so the next search finds them here
// POST /read {image: base64 jpeg, genres: [...]} -> {ok, info} the title/author/... read from a cover photo
//      by a vision model running on Cloudflare (Workers AI). The photo is not stored anywhere.
//      Limits: READ_DAY per day for everyone together, READ_IP per day per connection (IP kept only as a daily hash).
// GET  /cover?isbn=978...  -> the shared cover image (404 if none); &check=1 -> {ok, exists}
// POST /cover {isbn, mime, data(base64)} -> a cover a user chose to share; the first one stays
// Var olan bir kaydın dolu alanları değiştirilmez, yalnızca boş alanları doldurulur.

const ALLOWED = ['https://bitigapp.com', 'https://www.bitigapp.com', 'https://yazgiminerva.github.io'];

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
// arama anahtarı: küçük harf, Türkçe harfler sadeleşir (ı→i, ş→s ...), noktalama boşluk olur
const norm = s => String(s || '').toLocaleLowerCase('tr').replace(/ı/g, 'i').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const skOf = r => ' ' + norm([r.title, r.author, r.translator, r.publisher].join(' ')) + ' ';
const COLS = 'isbn, title, author, translator, publisher, year, pages, genre, cover, saves, picks';
const READ_MODEL = '@cf/google/gemma-4-26b-a4b-it', READ_DAY = 600, READ_IP = 30;

export default {
  async fetch(req, env) {
    try { return await handle(req, env); }
    catch (e) { return json(req, {ok: false, error: 'Aracıda hata', detail: String(e && e.message || e)}); }
  },
};

function readRec(b) {
  const isbn = normIsbn(b && b.isbn);
  const title = clean(b && b.title, 300);
  if (!isbn || !title) return null;
  const cover = clean(b.cover, 500);
  const rec = {
    isbn, title, author: clean(b.author, 200), translator: clean(b.translator, 200), publisher: clean(b.publisher, 200),
    genre: clean(b.genre, 60), cover: /^https:\/\//.test(cover) ? cover : '',
    year: int(b.year, 1450, 2100), pages: int(b.pages, 1, 20000),
  };
  rec.sk = skOf(rec);
  return rec;
}
async function readBody(req) {
  const raw = await req.text();
  if (raw.length > 4000) return {err: 'Çok büyük'};
  try { return {b: JSON.parse(raw)}; } catch (e) { return {err: 'Geçersiz veri'}; }
}
// Yeni kayıt ekle; varsa yalnızca boş alanları doldur ve sayacı artır
function upsert(env, rec, kind) {
  const now = new Date().toISOString();
  const s0 = kind === 'save' ? 1 : 0, p0 = kind === 'pick' ? 1 : 0;
  return env.DB.prepare(`INSERT INTO books (isbn, title, author, translator, publisher, year, pages, genre, cover, saves, picks, sk, created_at, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?11, ?12, ?13, ?10, ?10)
      ON CONFLICT(isbn) DO UPDATE SET
        author = CASE WHEN IFNULL(author, '') = '' THEN excluded.author ELSE author END,
        translator = CASE WHEN IFNULL(translator, '') = '' THEN excluded.translator ELSE translator END,
        publisher = CASE WHEN IFNULL(publisher, '') = '' THEN excluded.publisher ELSE publisher END,
        genre = CASE WHEN IFNULL(genre, '') = '' THEN excluded.genre ELSE genre END,
        cover = CASE WHEN IFNULL(cover, '') = '' THEN excluded.cover ELSE cover END,
        year = IFNULL(year, excluded.year),
        pages = IFNULL(pages, excluded.pages),
        saves = saves + ?11,
        picks = picks + ?12,
        sk = '',
        updated_at = ?10`)
    .bind(rec.isbn, rec.title, rec.author, rec.translator, rec.publisher, rec.year, rec.pages, rec.genre, rec.cover, now, s0, p0, rec.sk).run();
}
// eski ya da güncellenmiş kayıtların arama anahtarını doldur
async function fillKeys(env) {
  const {results} = await env.DB.prepare("SELECT isbn, title, author, translator, publisher FROM books WHERE sk = '' LIMIT 400").all();
  if (!results || !results.length) return;
  await env.DB.batch(results.map(r => env.DB.prepare('UPDATE books SET sk = ? WHERE isbn = ?').bind(skOf(r), r.isbn)));
}

async function search(req, env, url) {
  const q = norm(url.searchParams.get('q')).slice(0, 100);
  const words = [...new Set(q.split(' ').filter(w => w.length >= 2))].slice(0, 6);
  const isbn = normIsbn(q.replace(/ /g, ''));
  if (!words.length && !isbn) return json(req, {ok: true, books: []});
  await fillKeys(env);
  let rows;
  if (isbn) rows = (await env.DB.prepare(`SELECT ${COLS} FROM books WHERE isbn = ?`).bind(isbn).all()).results || [];
  else {
    const where = words.map((_, i) => `sk LIKE ?${i + 1}`).join(' AND ');
    rows = (await env.DB.prepare(`SELECT ${COLS} FROM books WHERE ${where} ORDER BY (saves * 3 + picks) DESC LIMIT 60`)
      .bind(...words.map(w => '%' + w + '%')).all()).results || [];
  }
  // başlığında geçenler önce, sonra en çok kaydedilen ve açılanlar
  const score = r => { const t = ' ' + norm(r.title) + ' '; return words.filter(w => t.includes(w)).length * 1000 + (r.saves || 0) * 3 + (r.picks || 0); };
  rows.sort((a, b) => score(b) - score(a));
  return json(req, {ok: true, books: rows.slice(0, 30)}, {'Cache-Control': 'no-store'});
}

async function sha(t) { const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t)); return [...new Uint8Array(d)].slice(0, 12).map(b => b.toString(16).padStart(2, '0')).join(''); }
// count one read; false if today's shared or per-connection limit is used up
async function takeRead(req, env) {
  const day = new Date().toISOString().slice(0, 10), ip = req.headers.get('CF-Connecting-IP') || 'x';
  const k = 'ip:' + await sha(day + '|' + ip + '|bitigapp');
  const rows = (await env.DB.prepare('SELECT k, n FROM ailimit WHERE day = ? AND k IN (?, ?)').bind(day, 'all', k).all()).results || [];
  const n = key => (rows.find(r => r.k === key) || {n: 0}).n;
  if (n('all') >= READ_DAY) return {ok: false, why: 'day'};
  if (n(k) >= READ_IP) return {ok: false, why: 'ip'};
  const up = 'INSERT INTO ailimit (day, k, n) VALUES (?, ?, 1) ON CONFLICT(day, k) DO UPDATE SET n = n + 1';
  await env.DB.batch([env.DB.prepare(up).bind(day, 'all'), env.DB.prepare(up).bind(day, k), env.DB.prepare('DELETE FROM ailimit WHERE day < ?').bind(day)]);
  return {ok: true, left: READ_DAY - n('all') - 1};
}
function readPrompt(genres) {
  const g = (Array.isArray(genres) ? genres : []).filter(x => typeof x === 'string').map(x => clean(x, 30)).filter(Boolean).slice(0, 40);
  return `Bu fotoğraf bir kitaba ait (çoğunlukla ön kapak; arka kapak ya da kitap sırtı da olabilir). Kitabın bilgilerini fotoğrafta YAZANLARA göre çıkar.
Kurallar:
- Başlık ve yazar adını Türkçe yazım kurallarına uygun, normal büyük-küçük harfle yaz; kapakta hepsi büyük harfle yazsa bile ("KÜRK MANTOLU MADONNA" -> "Kürk Mantolu Madonna").
- Fotoğrafta görmediğin alanları null bırak, asla uydurma. Çeviri kitapsa ve çevirmen görünüyorsa "translator" alanına yaz.
${g.length ? `- "genre": kitabı tanıyorsan ya da kapaktan anlaşılıyorsa şu listeden TAM OLARAK birini yaz: ${g.join(', ')}. Emin değilsen null.\n` : ''}- "box_2d": fotoğraftaki kitabın (kapağın) sınırları, [ymin, xmin, ymax, xmax] biçiminde, 0-1000 aralığına ölçeklenmiş tam sayılar. Kitap seçilemiyorsa null.
- "isbn" yalnızca fotoğrafta yazıyorsa, sadece rakamlarla.
Yalnızca tek bir JSON nesnesi döndür, başka hiçbir şey yazma:
{"title":"...","author":"...","translator":null,"publisher":"...","isbn":null,"genre":null,"year":null,"box_2d":[60,180,940,820]}`;
}
async function readCoverAI(req, env) {
  const raw = await req.text();
  if (raw.length > 1600000) return json(req, {ok: false, error: 'Fotoğraf çok büyük'});
  let b; try { b = JSON.parse(raw); } catch (e) { return json(req, {ok: false, error: 'Geçersiz veri'}); }
  const data = typeof (b && b.image) === 'string' ? b.image : '';
  if (data.length < 2000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return json(req, {ok: false, error: 'Geçersiz fotoğraf'});
  const head = atob(data.slice(0, 16));
  if (!(head.charCodeAt(0) === 0xFF && head.charCodeAt(1) === 0xD8)) return json(req, {ok: false, error: 'Fotoğraf JPEG olmalı'});
  if (!env.AI) return json(req, {ok: false, error: 'Kapak okuma şu an kapalı'});
  const t = await takeRead(req, env);
  if (!t.ok) return json(req, {ok: false, limit: t.why, error: t.why === 'day' ? 'Bugünlük kapak okuma hakkı doldu' : 'Bugün bu bağlantıdan çok fazla kapak okundu'});
  const out = await env.AI.run(READ_MODEL, {
    messages: [{role: 'user', content: [{type: 'text', text: readPrompt(b.genres)}, {type: 'image_url', image_url: {url: 'data:image/jpeg;base64,' + data}}]}],
    max_tokens: 300, temperature: 0,
  });
  const txt = String((out && (out.response ?? (out.choices && out.choices[0] && out.choices[0].message && out.choices[0].message.content))) || '');
  let info = null;
  try { info = JSON.parse(txt); } catch (e) { const m = txt.match(/\{[\s\S]*\}/); if (m) try { info = JSON.parse(m[0]); } catch (x) {} }
  if (!info || typeof info !== 'object') return json(req, {ok: false, error: 'Kapaktaki yazılar okunamadı', usage: out && out.usage || null, dbg: JSON.stringify(out).slice(0, 1500)});
  const pick = {};
  for (const k of ['title', 'author', 'translator', 'publisher', 'genre']) pick[k] = typeof info[k] === 'string' ? clean(info[k], 300) || null : null;
  pick.isbn = info.isbn ? String(info.isbn).replace(/[^0-9Xx]/g, '').slice(0, 13) || null : null;
  pick.year = int(info.year, 1450, 2100);
  pick.box_2d = Array.isArray(info.box_2d) && info.box_2d.length === 4 && info.box_2d.every(v => Number.isFinite(+v)) ? info.box_2d.map(v => Math.max(0, Math.min(1000, Math.round(+v)))) : null;
  return json(req, {ok: true, info: pick, left: t.left, usage: out && out.usage || null});
}

async function handle(req, env) {
  if (req.method === 'OPTIONS') return new Response(null, {headers: cors(req)});
  const url = new URL(req.url);
  if (url.searchParams.get('ping')) return json(req, {ok: true, version: 14});
  // writes only from the app's own page
  if (req.method === 'POST' && !ALLOWED.includes(req.headers.get('Origin') || '')) return json(req, {ok: false, error: 'İzin yok'});
  if (url.pathname === '/cover') return cover(req, env, url);
  if (url.pathname === '/search' && req.method === 'GET') return search(req, env, url);
  if (url.pathname === '/read' && req.method === 'POST') return readCoverAI(req, env);
  if (url.pathname === '/pick' && req.method === 'POST') {
    const {b, err} = await readBody(req); if (err) return json(req, {ok: false, error: err});
    const rec = readRec(b); if (!rec) return json(req, {ok: false, error: 'ISBN ve başlık gerekli'});
    await upsert(env, rec, 'pick');
    return json(req, {ok: true, isbn: rec.isbn});
  }
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
    const {b, err} = await readBody(req); if (err) return json(req, {ok: false, error: err});
    const rec = readRec(b); if (!rec) return json(req, {ok: false, error: 'ISBN ve başlık gerekli'});
    const r = await upsert(env, rec, 'save');
    return json(req, {ok: true, isbn: rec.isbn, changes: r.meta && r.meta.changes});
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
