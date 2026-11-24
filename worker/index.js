// Kitaplığım için küçük aracı: uygulama bir ISBN gönderir, aracı Milli Kütüphane
// kataloğunda arar ve sonucu uygulamaya iletir. Tarayıcı katalog sitesine doğrudan
// soramadığı (CORS) için bu aracı gerekiyor.
const ALLOWED = ['https://yazgiminerva.github.io'];
const MK = isbn => `https://kasif.mkutup.gov.tr/OpacArama.aspx?Ara=${isbn}&DtSrc=0&fld=-1&NvBar=0`;

function cors(req) {
  const o = req.headers.get('Origin') || '';
  return {
    'Access-Control-Allow-Origin': ALLOWED.includes(o) ? o : ALLOWED[0],
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Vary': 'Origin',
  };
}
const json = (req, body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), {status, headers: {...cors(req), 'Content-Type': 'application/json; charset=utf-8', ...extra}});

function toText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d|td|th)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/[ \t\r]+/g, ' ').replace(/\n\s*/g, '\n').replace(/\n{2,}/g, '\n').trim();
}

export default {
  async fetch(req) {
    try { return await handle(req); }
    catch (e) { return json(req, {ok: false, error: 'Aracıda hata', detail: String(e && e.stack || e)}); }
  },
};

async function handle(req) {
    if (req.method === 'OPTIONS') return new Response(null, {headers: cors(req)});
    const url = new URL(req.url);
    const isbn = (url.searchParams.get('isbn') || '').replace(/[^0-9Xx]/g, '').toUpperCase();
    if (!/^(\d{9}[\dX]|97[89]\d{10})$/.test(isbn)) return json(req, {ok: false, error: 'Geçersiz ISBN'});
    const mode = url.searchParams.get('mode') || 'text';

    let r;
    try {
      r = await fetch(MK(isbn), {headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Kitapligim/1.0; kisisel kitaplik uygulamasi)',
        'Accept': 'text/html', 'Accept-Language': 'tr-TR,tr;q=0.9',
      }, signal: AbortSignal.timeout(20000)});
    } catch (e) {
      return json(req, {ok: false, error: 'Katalog sitesine ulaşılamadı', detail: String(e)});
    }
    const html = await r.text();
    // Geliştirme için: sayfanın ham hâli
    if (mode === 'raw') return new Response(html, {headers: {...cors(req), 'Content-Type': 'text/plain; charset=utf-8'}});
    const text = toText(html);
    const at = text.indexOf(isbn);
    const snippet = at >= 0 ? text.slice(Math.max(0, at - 1500), at + 1500) : text.slice(0, 3000);
    return json(req, {ok: r.ok, isbn, status: r.status, found: at >= 0, length: html.length, text: snippet, source: 'Milli Kütüphane'}, 200, r.ok ? {'Cache-Control': 'public, max-age=86400'} : {});
}
