/*
  fetch-epg.js  —  يسحب جدول قنوات ART من الموقع الرسمي ويحفظه في epg-data.js
  التشغيل:  node fetch-epg.js        (يحتاج Node.js 18 أو أحدث، بدون أي مكتبات)
  حطه في نفس مجلد art-tv.html (أو اكتب مسار مجلد الصفحة بعد اسمه)، وشغّله مرة كل 24 ساعة (أو من التطبيق: require('./fetch-epg').run()).
  لو الموقع فشل أو غيّر شكله، البيانات القديمة في الملف بتفضل زي ما هي.
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
    }
  }

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
