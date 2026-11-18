/*
  fetch-epg.js  —  يسحب جدول قنوات ART من الموقع الرسمي (+ ART Movies من ontvtonight) ويحفظه في epg-data.js
  التشغيل:  node fetch-epg.js        (يحتاج Node.js 18 أو أحدث، بدون أي مكتبات)
  حطه في نفس مجلد art-tv.html (أو اكتب مسار مجلد الصفحة بعد اسمه)، وشغّله مرة كل 24 ساعة (أو من التطبيق: require('./fetch-epg').run()).
  لو الموقع فشل أو غيّر شكله، البيانات القديمة في الملف بتفضل زي ما هي.

  متغيرات اختيارية:
    ART_MOVIES_TZ   توقيت مواعيد ontvtonight. اسم منطقة (America/New_York) أو إزاحة ثابتة (UTC+7 أو +07:00). الافتراضي: UTC+7
    ART_MOVIES_URL  رابط صفحة القناة
    ART_BASE        عنوان موقع ART الرسمي
    ART_EPG_DIR     مجلد الحفظ
*/
const fs = require('fs');
const path = require('path');

const BASE = process.env.ART_BASE || 'https://www.artonline.tv';
/* الحفظ جنب السكربت، أو في مجلد تحدده:  node fetch-epg.js "C:\\مسار\\مجلد-الصفحة"  */
const OUT  = path.join(process.env.ART_EPG_DIR || (require.main === module && process.argv[2]) || __dirname, 'epg-data.js');
const UA   = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

/* رقم القناة في الصفحة  ←  عنوان الطلب في الموقع */
const CHANNELS = [
  { num: 1, ep: '/Home/TvlistHekayat'  },   // حكايات 1
  { num: 2, ep: '/Home/TvlistHekayat2' },   // حكايات 2
  { num: 3, ep: '/Home/Tvlist'         },   // أفلام 1
  { num: 4, ep: '/Home/TvlistAflam2'   },   // أفلام 2
  { num: 5, ep: '/Home/TvlistCinema'   }    // سينما
];

const pad = n => String(n).padStart(2, '0');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const PAUSE = 300;   // راحة (مللي ثانية) بين الطلبات عشان منضغطش على المواقع

async function withRetry(fn, tries = 3) {
  let err;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) { err = e; await sleep(800 * (i + 1)); }
  }
  throw err;
}

function readOld() {
  try {
    const t = fs.readFileSync(OUT, 'utf8');
    const m = t.match(/window\.ART_EPG\s*=\s*([\s\S]*?);\s*$/);
    const d = m && JSON.parse(m[1]);
    if (d && d.days) return d;
  } catch (e) {}
  return { generatedAt: '', days: {} };
}

function parseDay(txt) {
  let j = JSON.parse(txt);
  if (typeof j === 'string') j = JSON.parse(j);
  if (!Array.isArray(j)) throw new Error('الرد مش قايمة برامج');
  const items = [];
  for (const x of j) {
    const m = /(\d{1,2}):(\d{2})/.exec(String(x.start_Time || ''));
    const title = String(x.title || '').trim();
    if (m && title) items.push([+m[1] * 60 + +m[2], title]);   // [الدقيقة من منتصف الليل GMT, اسم البرنامج]
  }
  return items;
}

/* ============ مصدر تاني: ART Movies من ontvtonight.com ============ */
/* مواعيد الموقع مش بتوقيت مصر. الافتراضي UTC+7 (اتحسب من مقارنة الموقع بالبث الفعلي).
   لو البرنامج الشغال مش مطابق، غيّر ART_MOVIES_TZ بساعة زيادة أو أقل (UTC+6 / UTC+8) */
const MOVIES = {
  id: 6,
  url: process.env.ART_MOVIES_URL || 'https://www.ontvtonight.com/guide/listings/channel/69033482/art-movies.html',
  tz:  process.env.ART_MOVIES_TZ  || 'UTC+7'
};

function decodeHtml(t) {
  return t.replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCodePoint(parseInt(h, 16)))
          .replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(+n))
          .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/* إزاحة ثابتة مكتوبة زي UTC+7 أو +07:00 أو GMT-5:30  ←  مللي ثانية (أو null لو الاسم منطقة زمنية عادية) */
function parseFixedOffset(tz) {
  const m = /^(?:UTC|GMT)?\s*([+-])(\d{1,2})(?::?(\d{2}))?$/i.exec(String(tz).trim());
  if (!m) return null;
  return (m[1] === '-' ? -1 : 1) * ((+m[2]) * 60 + (+(m[3] || 0))) * 60000;
}

/* فرق التوقيت (بالمللي ثانية) لمنطقة زمنية عند لحظة معينة */
function tzOffsetMs(utcMs, tz) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const p = Object.fromEntries(f.formatToParts(new Date(utcMs)).map(x => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - utcMs;
}
/* وقت محلي في منطقة زمنية  ←  لحظة UTC (بيراعي التوقيت الصيفي) */
function zonedToUtc(y, mo, d, h, mi, tz) {
  const fixed = parseFixedOffset(tz);
  if (fixed !== null) return Date.UTC(y, mo - 1, d, h, mi) - fixed;
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const off = tzOffsetMs(guess, tz);
  let t = guess - off;
  const off2 = tzOffsetMs(t, tz);
  if (off2 !== off) t = guess - off2;
  return t;
}

function parseMoviesPage(html, pageDate) {
  const out = [];
  for (const row of (html.match(/<tr[\s\S]*?<\/tr>/g) || [])) {
    const t  = /<h5 class="thin ott-channel-time">\s*([^<]+?)\s*<\/h5>/.exec(row);
    const ti = /<h5 class="thin ott-channel-show__title">\s*<a [^>]*>([\s\S]*?)<\/a>/.exec(row);
    if (!t || !ti) continue;
    const tm = /(\d{1,2}):(\d{2})\s*([ap]m)/i.exec(t[1]);
    if (!tm) continue;
    const h = (+tm[1] % 12) + (/pm/i.test(tm[3]) ? 12 : 0);
    const dn = /<i class="ott-channel-date-note">\s*(\d{4}-\d{2}-\d{2})/.exec(row);   // برنامج من اليوم اللي قبله
    const title = decodeHtml(ti[1].replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim().replace(/\s*\(\d{4}\)$/, '');
    if (title) out.push({ date: dn ? dn[1] : pageDate, h, m: +tm[2], title });
  }
  return out;
}

async function getText(url, headers) {
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.text();
}

/* وقت بتوقيت القاهرة للعرض في اللوج بس (للمقارنة بالبث الفعلي) */
const cairoFmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Cairo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

async function fetchMovies(data) {
  const headers = { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.8' };
  const first = await withRetry(() => getText(MOVIES.url, headers));
  const dates = []; const re = /<option value="(\d{4}-\d{2}-\d{2})"/g; let m;
  while ((m = re.exec(first))) dates.push(m[1]);
  if (!dates.length) throw new Error('مش لاقي قايمة التواريخ في صفحة ART Movies');

  const rows = []; let pagesOk = 0;
  for (const d of dates) {
    try { rows.push(...parseMoviesPage(await withRetry(() => getText(MOVIES.url + '?dt=' + d, headers)), d)); pagesOk++; }
    catch (e) { console.warn(`تعذّر ART Movies ${d} → ${e.message}`); }
    await sleep(700);
  }
  if (!rows.length) throw new Error('ART Movies: مفيش برامج اتسحبت');

  const seen = new Set(), list = [];
  for (const r of rows) {
    const [y, mo, d] = r.date.split('-').map(Number);
    const t = zonedToUtc(y, mo, d, r.h, r.m, MOVIES.tz);
    if (!seen.has(t)) { seen.add(t); list.push({ t, title: r.title }); }   // برنامج واحد لكل لحظة بداية
  }
  list.sort((a, b) => a.t - b.t);

  /* للمقارنة: البرنامج الشغال دلوقتي حسب الموقع، بتوقيت القاهرة */
  const nowMs = Date.now();
  let ni = list.findIndex(p => p.t > nowMs);
  if (ni < 0) ni = list.length;
  console.log('ART Movies (توقيت القاهرة) حوالين الوقت الحالي:');
  for (const p of list.slice(Math.max(0, ni - 1), ni + 2)) console.log('   ' + cairoFmt.format(new Date(p.t)) + '  ' + p.title);

  /* التغطية: من أول يوم لآخر يوم في قايمة الموقع (بتوقيته) */
  const [fy, fm, fd] = dates[0].split('-').map(Number), [ly, lm, ld] = dates[dates.length - 1].split('-').map(Number);
  const covStart = zonedToUtc(fy, fm, fd, 0, 0, MOVIES.tz), covEnd = zonedToUtc(ly, lm, ld + 1, 0, 0, MOVIES.tz);
  const byDay = {};
  for (const p of list) {
    const dt = new Date(p.t), key = dt.toISOString().slice(0, 10);
    (byDay[key] = byDay[key] || []).push([dt.getUTCHours() * 60 + dt.getUTCMinutes(), p.title]);
  }

  /* اليوم (GMT) اللي الصفحات مغطياه جزئيًا بيتدمج مع القديم بدل ما يتمسح: الساعات المغطاة بتتحدّث والباقي بيفضل */
  let written = 0;
  for (const [key, arr] of Object.entries(byDay)) {
    const [y, mo, d] = key.split('-').map(Number), ds = Date.UTC(y, mo - 1, d);
    if (ds + 86400000 <= covStart || ds >= covEnd) continue;           // خارج التغطية تمامًا
    const prev = ((data.days[key] || {})[MOVIES.id]) || [];
    const a = (covStart - ds) / 60000, b = (covEnd - ds) / 60000;       // الدقايق المغطاة من اليوم ده
    const merged = new Map(prev.filter(x => x[0] < a || x[0] >= b).map(x => [x[0], x]));
    for (const x of arr) merged.set(x[0], x);
    (data.days[key] = data.days[key] || {})[MOVIES.id] = [...merged.values()].sort((p, q) => p[0] - q[0]);
    written++;
  }
  console.log(`ART Movies: ${rows.length} صف من ${pagesOk} صفحة، ${written} يوم اتحفظ (التوقيت ${MOVIES.tz})`);
  return written;
}

async function run() {
  const old = readOld();
  const data = { generatedAt: old.generatedAt, days: JSON.parse(JSON.stringify(old.days)) };

  // 1) صفحة الجدول: نجيب منها الكوكيز وتواريخ الأيام الستة
  const headers = { 'User-Agent': UA, 'Accept-Language': 'ar,en;q=0.8' };
  const page = await withRetry(() => fetch(BASE + '/guide/1', { headers, signal: AbortSignal.timeout(20000) }));
  if (!page.ok) throw new Error('صفحة الجدول رجعت HTTP ' + page.status);
  const html = await page.text();
  const cookie = (page.headers.getSetCookie ? page.headers.getSetCookie() : []).map(c => c.split(';')[0]).join('; ');

  let days = [];
  const re = /<option value=['"](\d+)['"][^>]*>\s*(\d{2})\/(\d{2})\/(\d{4})/g;
  let m;
  while ((m = re.exec(html))) days.push({ idx: +m[1], mm: m[2], dd: m[3], yyyy: m[4] });
  if (!days.length) {                                   // لو شكل الصفحة اتغير: نحسب التواريخ بنفسنا
    const n = new Date();
    days = [0, 1, 2, 3, 4, 5].map(k => {
      const d = new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate() + k));
      return { idx: k, mm: pad(d.getUTCMonth() + 1), dd: pad(d.getUTCDate()), yyyy: String(d.getUTCFullYear()) };
    });
  }

  // 2) لكل يوم ولكل قناة
  let ok = 0, fail = 0, withPrograms = 0;
  for (const day of days) {
    const key = `${day.yyyy}-${day.mm}-${day.dd}`;
    const text = `${day.mm}/${day.dd}/${day.yyyy}`;
    for (const ch of CHANNELS) {
      const ask = t => fetch(BASE + ch.ep, {
        method: 'POST',
        headers: Object.assign({}, headers, {
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-Requested-With': 'XMLHttpRequest',
          'Referer': BASE + '/guide/1',
          'Origin': BASE,
          'Cookie': cookie
        }),
        body: new URLSearchParams({ objId: String(day.idx), objtext: t }).toString(),
        signal: AbortSignal.timeout(20000)
      }).then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); });
      try {
        let items = await withRetry(async () => parseDay(await ask(text)));
        if (!items.length) items = await withRetry(async () => parseDay(await ask(' ' + text)));   // نفس طريقة الصفحة (مسافة قبل التاريخ)
        (data.days[key] = data.days[key] || {})[ch.num] = items;
        ok++; if (items.length) withPrograms++;
      } catch (e) {
        fail++;
        console.warn(`تعذّر: ${ch.ep} يوم ${text} → ${e.message} (بنسيب البيانات القديمة)`);
      }
      await sleep(PAUSE);
    }
  }

  // 2.5) ART Movies من مصدر تاني (لو فشل، باقي القنوات مش بتتأثر)
  try { const n = await fetchMovies(data); if (n) { ok += n; withPrograms += n; } else fail++; }
  catch (e) { fail++; console.warn('تعذّر ART Movies:', e.message, '(بنسيب بياناتها القديمة)'); }

  if (!ok || !withPrograms) throw new Error('مفيش ولا جدول اتسحب (نجح ' + ok + '، فشل ' + fail + '). الملف القديم اتسابت زي ما هو.');

  // 3) نمسح الأيام القديمة (نسيب أمس) ونحفظ
  const yesterday = new Date(Date.now() - 24 * 3600e3);
  const minKey = `${yesterday.getUTCFullYear()}-${pad(yesterday.getUTCMonth() + 1)}-${pad(yesterday.getUTCDate())}`;
  Object.keys(data.days).forEach(k => { if (k < minKey) delete data.days[k]; });
  data.generatedAt = new Date().toISOString();

  const tmp = OUT + '.tmp';
  fs.writeFileSync(tmp, 'window.ART_EPG = ' + JSON.stringify(data) + ';\n', 'utf8');
  fs.renameSync(tmp, OUT);
  console.log(`تم: ${ok} طلب نجح، ${fail} فشل، ${withPrograms} فيهم برامج. اتحفظ في ${OUT}`);
  return { ok, fail };
}

module.exports = { run };
if (require.main === module) run().catch(e => { console.error('فشل التحديث:', e.message); process.exit(1); });
