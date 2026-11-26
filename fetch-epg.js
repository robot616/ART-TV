/*
  fetch-epg.js  —  يسحب جدول قنوات ART من الموقع الرسمي (+ ART Movies من tvpassport.com) ويحفظه في epg-data.js
  التشغيل:  node fetch-epg.js        (يحتاج Node.js 18 أو أحدث، بدون أي مكتبات)
  حطه في نفس مجلد art-tv.html (أو اكتب مسار مجلد الصفحة بعد اسمه)، وشغّله مرة كل 24 ساعة (أو من التطبيق: require('./fetch-epg').run()).
  لو الموقع فشل أو غيّر شكله، البيانات القديمة في الملف بتفضل زي ما هي.

  متغيرات اختيارية:
    ART_MOVIES_URL  رابط صفحة القناة على tvpassport (من غير التاريخ)
    ART_MOVIES_MIN_DAYS  أقل عدد أيام مخزّنة قدام قبل ما نسحب ART Movies تاني (الافتراضي 3)
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

/* ============ مصدر تاني: ART Movies من tvpassport.com ============ */
/* المواعيد بتتقرا زي ما الصفحة عارضاها (القاهرة)، من غير أي إزاحات يدوية. */
const MOVIES = {
  id: 6,
  url: (process.env.ART_MOVIES_URL || 'https://www.tvpassport.com/tv-listings/stations/art-movie-america/33199').replace(/\/+$/, ''),
  tz:  'Africa/Cairo',
  /* السحب مش كل مرة: لو المخزّن عندنا بيغطي كفاية قدام، بنتخطى السحب. بنسحب تاني لما يفضل أقل من كده (بالأيام) */
  minDaysAhead: Number(process.env.ART_MOVIES_MIN_DAYS || 3)
};

function decodeHtml(t) {
  return t.replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCodePoint(parseInt(h, 16)))
          .replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(+n))
          .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}


/* ============ تحويل أسماء الأفلام من إنجليزي/فرانكو إلى عربي ============ */
/* الموقع بيكتب الأسماء العربية بحروف إنجليزية (Al Deazel = الديزل). القاموس ده بيرجّعها عربي صح.
   أي كلمة مش موجودة فيه بتتحوّل بقواعد الفرانكو (sa3d = سعد) وبتتكتب في اللوج عشان تضيفها هنا.
   الكلمات مكتوبة بدون "ال" (لأن Al بتتحول لـ "ال" وتلزق في الكلمة اللي بعدها). */
const AR_WORDS = {
  "a'am":"عم","a'ysh":"عيش","adel":"عادل","aela":"عائلة","ahlam":"أحلام","ahmad":"أحمد","ali":"علي","ana":"أنا","anfeh":"أنفه",
  "aqmar":"أقمار","arba'a":"أربعة","aref":"عارف","arousa":"عروسة","arousti":"عروستي","ayyam":"أيام","azraq":"أزرق","azwag":"أزواج",
  "baher":"بحر","balad":"بلد","banat":"بنات","batal":"بطل","bateniya":"باطنية","beh":"بيه","bint":"بنت","boulbol":"بلبل",
  "deazel":"ديزل","e'bada":"عبادة","e'esh":"عيش","eish":"عيش","ersan":"عرسان","fadiha":"فضيحة","farah":"فرح","fatina":"فاتنة",
  "fi":"في","ga'altani":"جعلتني","ghani":"غني","gharamiyya":"غرامية","goz":"جوز","had":"حد","haha":"هاها","haqan":"حقاً",
  "hareb":"هارب","hatta":"حتى","hawa":"هوا","hawak":"هواك","haya":"حياة","helou":"حلو","herman":"حرمان","hob":"حب","hobak":"حبك",
  "ikhtiyar":"اختيار","imam":"إمام","inaha":"إنها","karmouz":"كرموز","khadema":"خادمة","khaliya":"خلية","khiyana":"خيانة",
  "kountou":"كنت","lamine":"لمين","law":"لو","layali":"ليالي","lezza":"لذة","louqmat":"لقمة","ma":"ما","ma'ahom":"معاهم",
  "mahatet":"محطة","mandil":"منديل","maqam":"مقام","mazhar":"مظهر","min":"من","mougriman":"مجرماً","mouhtaline":"محتالين",
  "mouhtarama":"محترمة","mountaha":"منتهى","mourgan":"مرجان","moush":"مش","nar":"نار","nas":"ناس","nashal":"نشل","omar":"عمر",
  "ouns":"أنس","qartaba":"قرطبة","rabi'e":"ربيع","raghma":"رغم","rehla":"رحلة","resalat":"رسالة","saheb":"صاحب","salam":"سلام",
  "salma":"سلمى","saye'e":"صايع","shanab":"شنب","share'e":"شارع","sharq":"شرق","shayatine":"شياطين","shelat":"شلة",
  "tahdeed":"تهديد","tahta":"تحت","talaga":"ثلاجة","toufaha":"تفاحة","tqoulsh":"تقولش","waraq":"ورق","welad":"ولاد","west":"وسط",
  "ya":"يا","zalamouni":"ظلموني","zamalek":"زمالك","zawat":"ذوات","zay":"زي","zouhour":"زهور"
};
const AR_WHOLE = { "fill in": "فاصل" };   /* عناوين كاملة ليها ترجمة خاصة */

/* قواعد الفرانكو للكلمات الغريبة. الأرقام جوه الكلمة: 3=ع 7=ح 5=خ 2=ء 9=ص 6=ط 8=غ */
const FR_DIGRAPHS = [['kh','خ'],['sh','ش'],['gh','غ'],['th','ث'],['dh','ذ'],['ch','ش'],['ou','و'],['oo','و'],['ee','ي'],['ei','ي'],['ai','ي'],['aa','ا'],['ie','ي']];
const FR_CHARS = { b:'ب',t:'ت',g:'ج',j:'ج',h:'ه',d:'د',r:'ر',z:'ز',s:'س',f:'ف',q:'ق',k:'ك',c:'ك',l:'ل',m:'م',n:'ن',w:'و',y:'ي',p:'ب',v:'ف',x:'كس',
                    "'":'ع','3':'ع','7':'ح','5':'خ','2':'ء','9':'ص','6':'ط','8':'غ','4':'ش' };
function franco(w) {
  const x = w.toLowerCase(); let out = '';
  for (let i = 0; i < x.length; i++) {
    const dg = FR_DIGRAPHS.find(([k]) => x.startsWith(k, i));
    if (dg) { out += dg[1]; i += dg[0].length - 1; continue; }
    const c = x[i];
    if ('aeiou'.includes(c)) { if (i === 0) out += 'ا'; else if (i === x.length - 1 && (c === 'a' || c === 'o')) out += (c === 'a' && x.endsWith('iya') ? '' : 'ا'); continue; }   /* الحركات القصيرة بتتحذف */
    out += FR_CHARS[c] !== undefined ? FR_CHARS[c] : c;
  }
  return out.replace(/ياا$/, 'ية');
}
const unknownWords = new Set();
function arabize(title) {
  title = String(title || '').trim();
  if (!/[A-Za-z]/.test(title)) return title;                       /* عربي أصلًا */
  const whole = AR_WHOLE[title.toLowerCase().replace(/\s+/g, ' ')];
  if (whole) return whole;
  const toks = title.split(/\s+/), out = []; let glue = '';        /* glue = بادئة بتلزق في الكلمة اللي بعدها (ال / و / ل) */
  for (const raw of toks) {
    const k = raw.toLowerCase();
    if (/^\d+$/.test(raw)) { out.push(glue + raw); glue = ''; continue; }
    if (k === 'al' || k === 'el') { glue += 'ال'; continue; }
    if (k === 'w' || k === 'wa') { glue += 'و'; continue; }
    if (k === 'li') { glue += 'ل'; continue; }
    let ar = AR_WORDS[k];
    if (ar === undefined) { unknownWords.add(raw); ar = franco(raw); }
    let word = glue + ar; glue = '';
    out.push(word);
  }
  if (glue) out.push(glue);
  return out.join(' ').replace(/لال/g, 'لل');
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

/* data-xxx="..." من عنصر البرنامج (الصفحة بتكتب كل بيانات البرنامج كـ attributes) */
function dataAttrs(tag) {
  const o = {}; const re = /data-([A-Za-z_]+)="([^"]*)"/g; let m;
  while ((m = re.exec(tag))) o[m[1]] = decodeHtml(m[2]);
  return o;
}

/* بيرجّع المواعيد + المنطقة الزمنية المعروضة بيها الصفحة (لو مش لاقيها نفترض القاهرة) */
function parseMoviesPage(html) {
  const sel = /<select id="timezone_selector"[\s\S]*?<\/select>/.exec(html);
  const tzm = sel && /<option value="([^"]+)"[^>]*\bselected\b/.exec(sel[0]);
  const rows = [];
  for (const tag of (html.match(/<div id="itemheader\d+"[^>]*>/g) || [])) {
    const a = dataAttrs(tag);
    const st = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})/.exec(a.st || '');
    const title = (a.episodeTitle || a.showName || '').replace(/\s+/g, ' ').trim();
    if (st && title) rows.push({ y: +st[1], mo: +st[2], d: +st[3], h: +st[4], m: +st[5], dur: +a.duration || 30, title });
  }
  return { tz: tzm ? tzm[1] : MOVIES.tz, rows };
}

async function getText(url, headers) {
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
  const body = await r.text();
  if (!r.ok) {
    const snip = body.replace(/\s+/g, ' ').slice(0, 120);
    throw new Error('HTTP ' + r.status + (snip ? ' — ' + snip : ''));
  }
  return body;
}

const MOVIES_HEADERS = {
  'User-Agent': UA,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cache-Control': 'no-cache',
  'Upgrade-Insecure-Requests': '1',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1'
};

/* وقت بتوقيت القاهرة للعرض في اللوج بس (للمقارنة بالبث الفعلي) */
const cairoFmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Cairo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

async function fetchMovies(data) {
  /* آخر برنامج متخزّن للقناة (GMT)، ولو لسه بيغطي كفاية قدام منسحبش تاني */
  let lastStored = 0;
  for (const [key, chs] of Object.entries(data.days)) {
    const arr = (chs || {})[MOVIES.id]; if (!arr || !arr.length) continue;
    const [y, mo, d] = key.split('-').map(Number);
    lastStored = Math.max(lastStored, Date.UTC(y, mo - 1, d) + Math.max(...arr.map(x => x[0])) * 60000);
  }
  const daysLeft = (lastStored - Date.now()) / 86400e3;
  if (daysLeft >= MOVIES.minDaysAhead) {
    console.log(`ART Movies: المخزّن بيغطي ${daysLeft.toFixed(1)} يوم قدام (الحد ${MOVIES.minDaysAhead}) — مفيش سحب جديد.`);
    return null;
  }
  console.log(`ART Movies: المخزّن بيغطي ${Math.max(0, daysLeft).toFixed(1)} يوم بس — هنسحب من tvpassport.`);
  const headers = MOVIES_HEADERS;
  /* التواريخ: اليوم (بتوقيت القاهرة) + 13 يوم قدام، من غير الاعتماد على شكل الصفحة */
  const c = new Date(Date.now() + 2 * 3600e3);
  const dates = [];
  for (let k = 0; k < 14; k++) {
    const d = new Date(Date.UTC(c.getUTCFullYear(), c.getUTCMonth(), c.getUTCDate() + k));
    dates.push(d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()));
  }

  const list = []; const seen = new Set(); let pagesOk = 0, lastErr = '';
  for (const d of dates) {
    try {
      const html = await withRetry(() => getText(MOVIES.url + '/' + d, headers));
      const { tz, rows } = parseMoviesPage(html);
      for (const r of rows) {
        const t = zonedToUtc(r.y, r.mo, r.d, r.h, r.m, tz);
        if (!seen.has(t)) { seen.add(t); list.push({ t, end: t + r.dur * 60000, title: arabize(r.title) }); }   // برنامج واحد لكل لحظة بداية
      }
      console.log(`ART Movies ${d}: ${rows.length} برنامج (توقيت الصفحة ${tz})` + (rows.length ? '' : ' — الصفحة اتحملت بس مفيهاش برامج: ' + html.replace(/\s+/g, ' ').slice(0, 120)));
      if (rows.length) pagesOk++;
    } catch (e) { lastErr = e.message; console.warn(`تعذّر ART Movies ${d} → ${e.message}`); }
    await sleep(700);
  }
  if (!list.length) throw new Error('ART Movies: مفيش برامج اتسحبت' + (lastErr ? ' (آخر خطأ: ' + lastErr + ')' : ''));
  list.sort((a, b) => a.t - b.t);

  const nowMs = Date.now();
  let ni = list.findIndex(p => p.t > nowMs);
  if (ni < 0) ni = list.length;
  console.log('ART Movies (توقيت القاهرة) حوالين الوقت الحالي:');
  for (const p of list.slice(Math.max(0, ni - 1), ni + 2)) console.log('   ' + cairoFmt.format(new Date(p.t)) + '  ' + p.title);

  const byDay = {};
  for (const p of list) {
    const dt = new Date(p.t), key = dt.toISOString().slice(0, 10);
    (byDay[key] = byDay[key] || []).push([dt.getUTCHours() * 60 + dt.getUTCMinutes(), p.title]);
  }

  /* بنحدّث الفترة اللي اتسحبت بس (من أول برنامج لآخر برنامج)، وباقي المخزّن بيفضل زي ما هو */
  const covStart = list[0].t, covEnd = list[list.length - 1].end;
  let written = 0;
  for (const [key, arr] of Object.entries(byDay)) {
    const [y, mo, d] = key.split('-').map(Number), ds = Date.UTC(y, mo - 1, d);
    const prev = ((data.days[key] || {})[MOVIES.id]) || [];
    const a = (covStart - ds) / 60000, b = (covEnd - ds) / 60000;
    const merged = new Map(prev.filter(x => x[0] < a || x[0] >= b).map(x => [x[0], x]));
    for (const x of arr) merged.set(x[0], x);
    (data.days[key] = data.days[key] || {})[MOVIES.id] = [...merged.values()].sort((p, q) => p[0] - q[0]);
    written++;
  }
  if (unknownWords.size) console.warn('كلمات مش في القاموس:', [...unknownWords].join(', '));
  console.log(`ART Movies: ${list.length} برنامج من ${pagesOk} صفحة، ${written} يوم اتحفظ`);
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
  try { const n = await fetchMovies(data); if (n === null) { /* متخطّي: المخزّن كفاية */ } else if (n) { ok += n; withPrograms += n; } else fail++; }
  catch (e) {
    fail++; console.warn('تعذّر ART Movies:', e.message, '(بنسيب بياناتها القديمة)');
    if (process.env.GITHUB_ACTIONS) console.log('::warning title=ART Movies EPG failed::' + e.message);   // يظهر باللون الأصفر في صفحة الـ Action
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

module.exports = { run, arabize };
if (require.main === module) run().catch(e => { console.error('فشل التحديث:', e.message); process.exit(1); });
