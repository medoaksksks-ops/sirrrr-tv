/**
 * Sir TV Live Server v5.2
 * ------------------------------------------------------------
 * v5.2:
 *  - الهيدرز ثابتة جوه السيرفر (Origin/Referer/UA/Accept/Cookie بتوع المصدر) — من اللوحة بتحط رابط البث بس
 *    وممكن تتغيّر من Railway: STREAM_REFERER / STREAM_ORIGIN / STREAM_UA / STREAM_COOKIE / STREAM_ACCEPT
 * v5.1:
 *  - الطلب للمصدر بيتبعت بنفس هيدرز المتصفح بالظبط: Origin / Referer / User-Agent / Accept / Accept-Encoding: identity / Cookie / Connection: keep-alive
 * v5.0:
 *  - نظام بث يدوي: لوحة تحكم (admin) بتحط رابط m3u8 لكل ماتش، بيتحفظ في Firebase
 *    والسيرفر بيشغّله عبر بروكسي بنفس Referer/Origin/User-Agent. متغيرات: ADMIN_PASSWORD, FIREBASE_DB_URL, FIREBASE_SECRET
 *    مسارات: /api/admin/{login,matches,stream,test} — و /api/stream بيدّي الأولوية للرابط اليدوي
 * v4.3:
 *  - GET /api/article?url= : قارئ مقالات جوه الموقع (بيفك روابط أخبار جوجل ويطلّع النص والصورة)
 * v4.2:
 *  - استخراج رابط البث أقوى: بيدوّر على playerv5.php?match=&key= (sirtv.top) حتى لو جوه JS/متشفّر (escaped / base64)
 *  - GET /api/debug/stream?link= : بيوريك السيرفر شاف إيه في كل خطوة (للتشخيص)
 *  - GET /embed?url= : بروكسي لصفحة المشغّل بـ Referer سير تي في (احتياطي للـ iframe)
 * v4.1:
 *  - البث: لو السيرفر مقدرش يطلع رابط HLS، /api/stream بيرجّع رابط الـ iframe (مشغّل المصدر)
 *    عشان الصفحة تشغّله بدل ما المباراة متشتغلش خالص (type:'iframe' + embedUrl)
 * v4.0:
 *  - أخبار كورة: GET /api/news (عام / topics=فريق|دوري) + /api/news/status لفحص المصادر
 *    (متغير NEWS_FEEDS = JSON لإضافة مصادر RSS)
 *  - ملخصات: GET /api/highlights?q= + ملخص الماتش الرسمي من FotMob
 *    (متغير HL_CHANNELS = channel_id[:اسم],... لقنوات يوتيوب مفضلة)
 *  - GET /api/match/extras : ملخص نصي تلقائي + فيديوهات + أخبار المباراة
 *  - GET /api/player/:id : بيانات اللاعب (مركز/سن/قيمة/إحصائيات/آخر المباريات)
 *  - الهدافين: assists + ترتيب فريق اللاعب
 *  - إشعارات: متابعة دوري كامل (leagues في الاشتراك)
 * v3.9:
 *  - توقيت المباريات: تصحيح فرق الساعتين + عرض بتوقيت القاهرة
 *      (SRC_SHIFT_MIN / START_ADJUST_MIN / DISPLAY_TZ من متغيرات Railway)
 *  - ترتيب الفريق في دوريه: /api/ranks + homeRank/awayRank داخل /api/matches
 *  - متابعة الفرق: /api/teams/search , /api/team/:id (المباراة الجاية + آخر النتائج)
 *  - تفاصيل أغنى: تبديلات / كروت / أهداف لكل لاعب + دكة البدلاء + أحداث كاملة
 *  - إشعارات: مفاتيح VAPID ثابتة، تذكير قبل المباراة، بداية، جول، نهاية
 *  - /api/debug/time لفحص الوقت الخام من المصدر
 */
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
const webpush = require('web-push');

const app = express();

// Build absolute URLs that browsers can use from HTTPS sites behind Railway.
// Express may see the internal HTTP connection and req.protocol can therefore
// produce insecure http:// playlist/segment URLs unless the proxy headers are trusted.
function publicBaseUrl(req) {
  const host = String(req.get('host') || '').trim();
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  const isRailwayHost = /(^|\.)up\.railway\.app$/i.test(host);
  const proto = isRailwayHost || forwardedProto === 'https' || req.secure ? 'https' : 'http';
  return `${proto}://${host}`;
}

const server = http.createServer(app);
const PORT = process.env.PORT || 3000;
const SOURCE = 'https://sir-tv.vip/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

const httpClient = axios.create({
  timeout: 16000,
  maxRedirects: 5,
  validateStatus: s => s < 500,
  headers: {
    'User-Agent': UA,
    'Accept-Language': 'ar,en;q=0.9',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
  }
});

async function get(url, opts = {}, retries = 2) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await httpClient.get(url, opts);
      if (res.status >= 400) throw new Error(`HTTP ${res.status}`);
      return res;
    } catch (e) {
      lastErr = e;
      if (i < retries) await new Promise(r => setTimeout(r, 350 * (i + 1)));
    }
  }
  throw lastErr;
}

app.use(cors({ origin: true }));
app.options('*', cors({ origin: true }));
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});
app.use(express.json());

const io = new Server(server, { cors: { origin: true }, pingInterval: 20000, pingTimeout: 25000 });

let cache = {
  matches: [], live: [], finished: [], upcoming: [],
  counts: { total: 0, live: 0, finished: 0, upcoming: 0 },
  lastUpdate: null, error: null, version: '5.2'
};

const detailsCache = new Map();
const streamCache = new Map();
const DETAILS_TTL = 90 * 1000;

const STREAM_TTL = 45 * 1000;

function to12Hour(timeStr) {
  if (!timeStr) return '';
  if (/[صم]|am|pm/i.test(timeStr)) return timeStr;
  const m = String(timeStr).trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return timeStr;
  let h = parseInt(m[1], 10);
  const min = m[2];
  const period = h >= 12 ? 'م' : 'ص';
  if (h === 0) h = 12;
  else if (h > 12) h -= 12;
  return `${h}:${min} ${period}`;
}

// ========== TIME (Africa/Cairo) ==========
const VERSION = '5.2';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (_) {}
const envNum = (k, d) => { const v = process.env[k]; if (v === undefined || v === '') return d; const n = Number(v); return Number.isFinite(n) ? n : d; };
const TZ = process.env.DISPLAY_TZ || 'Africa/Cairo';
// الموقع المصدر بيعرض الساعة متأخرة عن توقيت القاهرة بالدقائق دي (الافتراضي ساعتين). غيّره من Railway لو لزم.
const SRC_SHIFT_MIN = envNum('SRC_SHIFT_MIN', 120);
// تعديل نهائي يتطبق على كل المواعيد (احتياطي، الافتراضي 0)
const START_ADJUST_MIN = envNum('START_ADJUST_MIN', 0);

const _dtf = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit'
});
function tzParts(ms) {
  const o = {};
  for (const p of _dtf.formatToParts(new Date(ms))) o[p.type] = p.value;
  return { y: +o.year, mo: +o.month, d: +o.day, h: (+o.hour) % 24, mi: +o.minute, s: +o.second };
}
function tzOffsetMin(ms) {
  const p = tzParts(ms);
  return (Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000) / 60000;
}
// ساعة حائط في منطقة TZ → UTC ms
function wallToUtc(y, mo, d, h, mi) {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  let t = guess - tzOffsetMin(guess) * 60000;
  t = guess - tzOffsetMin(t) * 60000;
  return t;
}
function fmtClock12(ms) {
  const p = tzParts(ms);
  const per = p.h >= 12 ? 'م' : 'ص';
  let h = p.h % 12; if (h === 0) h = 12;
  return `${h}:${String(p.mi).padStart(2, '0')} ${per}`;
}
function toLatinDigits(s) {
  return String(s == null ? '' : s)
    .replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d))
    .replace(/[۰-۹]/g, d => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d));
}
function parseClock(text) {
  const t = toLatinDigits(text);
  const m = t.match(/(\d{1,2})\s*[:.]\s*(\d{2})\s*(ص|م|am|pm)?/i);
  if (!m) return null;
  let h = parseInt(m[1], 10); const mi = parseInt(m[2], 10);
  const suf = (m[3] || '').toLowerCase();
  if (suf === 'م' || suf === 'pm') { if (h < 12) h += 12; }
  else if (suf === 'ص' || suf === 'am') { if (h === 12) h = 0; }
  if (h > 23 || mi > 59) return null;
  return { h, mi };
}
/**
 * يحوّل ميعاد المصدر لـ UTC صحيح.
 *  - لو data-start فيه منطقة زمنية صريحة (Z / +02:00 / epoch) نثق فيه.
 *  - لو من غير منطقة، أو لو هو نص "7:00 م" بس: نضيف SRC_SHIFT_MIN ونعتبره توقيت القاهرة.
 */
function parseStart(attr, timeRaw, statusType) {
  const now = Date.now();
  const a = toLatinDigits(attr).trim();
  if (a) {
    if (/^\d{13}$/.test(a)) return { ms: +a, how: 'attr-epoch-ms' };
    if (/^\d{10}$/.test(a)) return { ms: +a * 1000, how: 'attr-epoch-s' };
    if (/(Z|[+-]\d{2}:?\d{2})$/i.test(a) && !isNaN(Date.parse(a))) return { ms: Date.parse(a), how: 'attr-iso-tz' };
    const m = a.match(/^(\d{4})-(\d{2})-(\d{2})[T\s](\d{1,2}):(\d{2})/);
    if (m) {
      const q = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) + SRC_SHIFT_MIN * 60000);
      return { ms: wallToUtc(q.getUTCFullYear(), q.getUTCMonth() + 1, q.getUTCDate(), q.getUTCHours(), q.getUTCMinutes()), how: 'attr-naive+shift' };
    }
  }
  const c = parseClock(timeRaw);
  if (!c) return null;
  const total = c.h * 60 + c.mi + SRC_SHIFT_MIN;
  const base = tzParts(now);
  const cands = [-1, 0, 1].map(off => {
    const dd = new Date(Date.UTC(base.y, base.mo - 1, base.d + off, 0, total));
    return wallToUtc(dd.getUTCFullYear(), dd.getUTCMonth() + 1, dd.getUTCDate(), dd.getUTCHours(), dd.getUTCMinutes());
  });
  let pick;
  if (statusType === 'finished') {
    pick = cands.filter(x => x <= now + 30 * 60000).pop() ?? cands[0];
  } else if (statusType === 'live') {
    pick = cands.slice().sort((x, y) => Math.abs(x - now) - Math.abs(y - now))[0];
  } else {
    pick = cands.find(x => x >= now - 3 * 3600000) ?? cands[2];
  }
  return { ms: pick, how: 'text+shift' };
}
// ========== MATCHES SCRAPER ==========
let lastRaw = [];
async function fetchMatches() {
  try {
    const { data } = await get(SOURCE, { headers: { Referer: SOURCE, 'Cache-Control': 'no-cache' } });
    const $ = cheerio.load(data);
    const matches = [];
    const raw = [];

    $('.AY_Match').each((_, el) => {
      const $el = $(el);
      const id = ($el.attr('id') || '').replace(/^m-/, '') || null;
      let link = $el.find('a').attr('href') || null;
      if (link && !link.startsWith('http')) link = new URL(link, SOURCE).href;

      // TM1 = first team in score (left number), TM2 = second (right number)
      const home = $el.find('.TM1 .TM_Name').text().trim();
      const away = $el.find('.TM2 .TM_Name').text().trim();
      const homeLogo = $el.find('.TM1 img').attr('src') || null;
      const awayLogo = $el.find('.TM2 img').attr('src') || null;

      const goalSpans = $el.find('.MT_Result .RS-goals, .MT_Result .goals, .MT_Result span')
        .map((_, s) => $(s).text().trim())
        .get()
        .filter(t => /^\d+$/.test(t));
      let homeScore = null, awayScore = null, score = 'vs';
      if (goalSpans.length >= 2) {
        homeScore = parseInt(goalSpans[0], 10);
        awayScore = parseInt(goalSpans[1], 10);
        score = `${homeScore}-${awayScore}`;
      } else {
        const rawS = $el.find('.MT_Result').text().replace(/\s+/g, ' ').trim();
        const mscore = rawS.match(/(\d+)\s*[-–:]\s*(\d+)/);
        if (mscore) {
          homeScore = parseInt(mscore[1], 10);
          awayScore = parseInt(mscore[2], 10);
          score = `${homeScore}-${awayScore}`;
        } else if (rawS) {
          score = rawS;
        }
      }

      const statusText = $el.find('.MT_Stat').text().trim();
      const timeRaw = $el.find('.MT_Time span, .MT_Time').first().text().trim();
      const isLiveClass = $el.hasClass('live') || $el.hasClass('now');
      const startAttr = $el.attr('data-start') || null;

      let externalId = null;
      if (link) {
        const mm = link.match(/[?&]m=(\d+)/);
        if (mm) externalId = mm[1];
      }

      let statusType = 'upcoming';
      const s = (statusText || '').toLowerCase();
      if (isLiveClass || /مباشر|live|شوط|دقيقة|توقف/.test(s)) statusType = 'live';
      else if (/انتهت|انتهى|ft|نهاية/.test(s)) statusType = 'finished';

      const hasStream = !!(link && (link.includes('korat') || link.includes('hes-goals') || /[?&]m=\d+/.test(link) || link.includes('watch-')));

      // الوقت: نصحّحه ونحوله لتوقيت القاهرة
      const st = parseStart(startAttr, timeRaw, statusType);
      const startMs = st ? st.ms + START_ADJUST_MIN * 60000 : null;

      if (home && away) {
        const key = String(externalId || id || link || `${home}-${away}`);
        matches.push({
          key, id, externalId, home, away, homeLogo, awayLogo, score,
          homeScore, awayScore,
          status: statusText || (statusType === 'live' ? 'مباشر' : statusType === 'finished' ? 'انتهت' : 'لم تبدأ'),
          statusType,
          time: startMs ? fmtClock12(startMs) : to12Hour(timeRaw),
          timeRaw: timeRaw || null,
          isLive: statusType === 'live',
          start: startMs ? new Date(startMs).toISOString() : null,
          startMs: startMs || null,
          startHow: st ? st.how : null,
          link, hasStream
        });
        if (raw.length < 15) raw.push({ home, away, timeRaw, startAttr, how: st ? st.how : null, startIso: startMs ? new Date(startMs).toISOString() : null, cairo: startMs ? fmtClock12(startMs) : null });
      }
    });
    lastRaw = raw;

    const order = { live: 0, upcoming: 1, finished: 2 };
    matches.sort((a, b) => (order[a.statusType] ?? 3) - (order[b.statusType] ?? 3));
    attachInfo(matches);
    const live = matches.filter(m => m.statusType === 'live');
    const finished = matches.filter(m => m.statusType === 'finished');
    const upcoming = matches.filter(m => m.statusType === 'upcoming');

    cache = {
      matches, live, finished, upcoming,
      counts: { total: matches.length, live: live.length, finished: finished.length, upcoming: upcoming.length },
      lastUpdate: new Date().toISOString(), error: null, version: VERSION, tz: TZ
    };
    console.log(`[Scraper] total=${matches.length} live=${live.length}`);
    resolveInBackground(matches);
    return cache;
  } catch (err) {
    console.error('[Scraper]', err.message);
    cache.error = err.message;
    cache.lastUpdate = new Date().toISOString();
    return cache;
  }
}


function emptyDetails() {
  return {
    events: [],
    homeLineup: [],
    awayLineup: [],
    homeSubs: [],
    awaySubs: [],
    stats: [],
    info: {},
    formations: {},
    source: null,
    updatedAt: null
  };
}

// ========== NAMES: عربي ⇄ إنجليزي ==========
const stripMarks = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
function normAr(s) {
  return stripMarks(s).toLowerCase()
    .replace(/[ً-ٰٟـ]/g, '')
    .replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').replace(/ؤ/g, 'و').replace(/ئ/g, 'ي')
    .replace(/[^a-z0-9؀-ۿ]+/g, ' ').replace(/\s+/g, ' ').trim()
    .replace(/^نادي /, '');
}
const stripAl = s => String(s || '').replace(/(^|\s)ال(?=\S)/g, '$1');
function normEn(s) {
  return stripMarks(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(fc|cf|afc|sc|fk|ac)\b/g, ' ').replace(/\s+/g, ' ').trim();
}
// كل سطر: عربي|إنجليزي|إنجليزي بديل...
const DICT = `
مانشستر سيتي|Manchester City
مانشستر يونايتد|Manchester United
ليفربول|Liverpool
آرسنال|Arsenal
أرسنال|Arsenal
تشيلسي|Chelsea
توتنهام|Tottenham Hotspur|Tottenham
نيوكاسل|Newcastle United|Newcastle
أستون فيلا|Aston Villa
برايتون|Brighton|Brighton & Hove Albion
وست هام|West Ham United|West Ham
إيفرتون|Everton
فولهام|Fulham
كريستال بالاس|Crystal Palace
وولفرهامبتون|Wolverhampton Wanderers|Wolves
برينتفورد|Brentford
بورنموث|Bournemouth
نوتنغهام فورست|Nottingham Forest
ليدز يونايتد|Leeds United|Leeds
ساوثهامبتون|Southampton
ليستر سيتي|Leicester City
سندرلاند|Sunderland
بيرنلي|Burnley
برشلونة|Barcelona
بارسا|Barcelona
ريال مدريد|Real Madrid
أتلتيكو مدريد|Atletico Madrid|Atlético Madrid
إشبيلية|Sevilla
فالنسيا|Valencia
فياريال|Villarreal
ريال سوسيداد|Real Sociedad
أتلتيك بلباو|Athletic Club|Athletic Bilbao
ريال بيتيس|Real Betis|Betis
أوساسونا|Osasuna
جيرونا|Girona
سيلتا فيغو|Celta Vigo|Celta
خيتافي|Getafe
رايو فايكانو|Rayo Vallecano
مايوركا|Mallorca
ألافيس|Alaves|Alavés
لاس بالماس|Las Palmas
إسبانيول|Espanyol
ليغانيس|Leganes
ليفانتي|Levante
إلتشي|Elche
أوفييدو|Real Oviedo|Oviedo
يوفنتوس|Juventus
ميلان|AC Milan|Milan
إنتر|Inter|Inter Milan|Internazionale
إنتر ميلان|Inter|Inter Milan|Internazionale
نابولي|Napoli
روما|Roma|AS Roma
لاتسيو|Lazio
أتالانتا|Atalanta
فيورنتينا|Fiorentina
بولونيا|Bologna
تورينو|Torino
أودينيزي|Udinese
ساسولو|Sassuolo
جنوى|Genoa
كالياري|Cagliari
ليتشي|Lecce
هيلاس فيرونا|Hellas Verona|Verona
بارما|Parma
كومو|Como
بيزا|Pisa
كريمونيزي|Cremonese
بايرن ميونخ|Bayern Munich|Bayern München
بوروسيا دورتموند|Borussia Dortmund|Dortmund
دورتموند|Borussia Dortmund|Dortmund
باير ليفركوزن|Bayer Leverkusen|Leverkusen
ليفركوزن|Bayer Leverkusen|Leverkusen
لايبزيج|RB Leipzig|Leipzig
آينتراخت فرانكفورت|Eintracht Frankfurt|Frankfurt
شتوتجارت|VfB Stuttgart|Stuttgart
فولفسبورج|VfL Wolfsburg|Wolfsburg
بوروسيا مونشنجلادباخ|Borussia Monchengladbach|Mönchengladbach|Gladbach
فرايبورج|SC Freiburg|Freiburg
هوفنهايم|Hoffenheim|TSG Hoffenheim
ماينز|Mainz|Mainz 05
فيردر بريمن|Werder Bremen
أونيون برلين|Union Berlin
أوجسبورج|Augsburg
هامبورج|Hamburger SV|Hamburg
سانت باولي|St. Pauli|St Pauli
هايدنهايم|Heidenheim
كولن|FC Köln|Köln|Cologne
باريس سان جيرمان|Paris Saint-Germain|Paris Saint Germain|PSG
مارسيليا|Marseille|Olympique Marseille
ليون|Lyon|Olympique Lyonnais
موناكو|Monaco|AS Monaco
ليل|Lille|LOSC Lille
نيس|Nice|OGC Nice
لانس|Lens|RC Lens
رين|Rennes|Stade Rennais
ستراسبورج|Strasbourg
نانت|Nantes
تولوز|Toulouse
بريست|Brest
لوريان|Lorient
أنجيه|Angers
أوكسير|Auxerre
ميتز|Metz
لو هافر|Le Havre
بنفيكا|Benfica|SL Benfica
بورتو|Porto|FC Porto
سبورتينج لشبونة|Sporting CP|Sporting Lisbon|Sporting
براجا|Braga|SC Braga
أياكس|Ajax
آيندهوفن|PSV Eindhoven|PSV
فينورد|Feyenoord
غلطة سراي|Galatasaray
جالطة سراي|Galatasaray
فنربخشة|Fenerbahce|Fenerbahçe
بشكتاش|Besiktas|Beşiktaş
طرابزون سبور|Trabzonspor
سلتيك|Celtic
رينجرز|Rangers
كلوب بروج|Club Brugge
أندرلخت|Anderlecht
شاختار دونيتسك|Shakhtar Donetsk
دينامو كييف|Dynamo Kyiv|Dynamo Kiev
ريد بول سالزبورج|Red Bull Salzburg|Salzburg
كوبنهاجن|Copenhagen|FC Copenhagen
أولمبياكوس|Olympiacos
بانثينايكوس|Panathinaikos
سلافيا براج|Slavia Praha|Slavia Prague
بودو جليمت|Bodo/Glimt|Bodø/Glimt
الهلال|Al Hilal|Al-Hilal
النصر|Al Nassr|Al-Nassr
الاتحاد|Al Ittihad|Al-Ittihad
الأهلي السعودي|Al Ahli|Al-Ahli|Al Ahli Jeddah|Al-Ahli Saudi
الشباب|Al Shabab|Al-Shabab
الاتفاق|Al Ettifaq|Al-Ettifaq
الفتح|Al Fateh|Al-Fateh
التعاون|Al Taawoun|Al-Taawoun
الفيحاء|Al Fayha|Al-Fayha
الرائد|Al Raed|Al-Raed
الخليج|Al Khaleej|Al-Khaleej
الأخدود|Al Okhdood|Al-Okhdood
ضمك|Damac
الرياض|Al Riyadh|Al-Riyadh
العروبة|Al Orobah|Al-Orobah
الحزم|Al Hazem|Al-Hazem
القادسية|Al Qadsiah|Al-Qadsiah|Al-Qadisiyah
نيوم|NEOM
الخلود|Al Kholood|Al-Kholood
الأهلي|Al Ahly|Al Ahly SC|Al Ahly Cairo
الزمالك|Zamalek|Zamalek SC
بيراميدز|Pyramids|Pyramids FC
سيراميكا كليوباترا|Ceramica Cleopatra
المصري|Al Masry|Al Masry SC
الاتحاد السكندري|Al Ittihad Alexandria|Al Ittihad Alexandria Club
الإسماعيلي|Ismaily|Ismaily SC
سموحة|Smouha|Smouha SC
إنبي|ENPPI|Enppi
بتروجت|Petrojet
فاركو|Pharco|Pharco FC
الجونة|El Gouna|El Gouna FC
حرس الحدود|Haras El Hodoud
طلائع الجيش|Tala'ea El Gaish|El Gaish
المقاولون العرب|Arab Contractors|Al Mokawloon Al Arab
زد|ZED FC|Zed
البنك الأهلي|National Bank of Egypt|Bank Ahly
غزل المحلة|Ghazl El Mahalla
مودرن سبورت|Modern Sport|Modern Future|Future FC
وادي دجلة|Wadi Degla
الداخلية|Al Dakhleya|Dakhleya
الغرافة|Al Gharafa
الوصل|Al Wasl
العين|Al Ain
السد|Al Sadd
الدحيل|Al Duhail
شباب الأهلي|Shabab Al Ahli
الوحدة|Al Wahda
الجزيرة|Al Jazira
الوداد|Wydad Casablanca|Wydad AC|Wydad
الرجاء|Raja Casablanca|Raja CA
الجيش الملكي|AS FAR|FAR Rabat
نهضة بركان|RS Berkane
الترجي|Esperance Tunis|Esperance de Tunis|ES Tunis
الإفريقي|Club Africain
صن داونز|Mamelodi Sundowns
أورلاندو بايرتس|Orlando Pirates
كايزر تشيفز|Kaizer Chiefs
إنتر ميامي|Inter Miami
لوس أنجلوس جالاكسي|LA Galaxy
لوس أنجلوس إف سي|Los Angeles FC|LAFC
بوكا جونيورز|Boca Juniors
ريفر بليت|River Plate
فلامنجو|Flamengo
بالميراس|Palmeiras
مصر|Egypt
السعودية|Saudi Arabia
المغرب|Morocco
تونس|Tunisia
الجزائر|Algeria
السنغال|Senegal
نيجيريا|Nigeria
الكاميرون|Cameroon
غانا|Ghana
كوت ديفوار|Ivory Coast|Cote d'Ivoire
مالي|Mali
جنوب أفريقيا|South Africa
الأردن|Jordan
العراق|Iraq
الإمارات|United Arab Emirates|UAE
قطر|Qatar
عمان|Oman
الكويت|Kuwait
البحرين|Bahrain
سوريا|Syria
لبنان|Lebanon
فلسطين|Palestine
ليبيا|Libya
السودان|Sudan
الأرجنتين|Argentina
البرازيل|Brazil
أوروجواي|Uruguay
كولومبيا|Colombia
تشيلي|Chile
باراجواي|Paraguay
الإكوادور|Ecuador
بيرو|Peru
فرنسا|France
ألمانيا|Germany
إسبانيا|Spain
إنجلترا|England
إيطاليا|Italy
البرتغال|Portugal
هولندا|Netherlands
بلجيكا|Belgium
كرواتيا|Croatia
سويسرا|Switzerland
الدنمارك|Denmark
النمسا|Austria
تركيا|Turkey|Türkiye
اسكتلندا|Scotland
ويلز|Wales
بولندا|Poland
صربيا|Serbia
اليابان|Japan
كوريا الجنوبية|South Korea|Korea Republic
إيران|Iran
أستراليا|Australia
أمريكا|USA|United States
المكسيك|Mexico
كندا|Canada`.trim().split('\n');

const AR2EN = new Map();   // normAr(عربي) → [English...]
const EN2AR = new Map();   // normEn(English) → عربي (للعرض)
const ARS_BY_EN = new Map(); // normEn(English) → Set(كل الأسماء العربية)
for (const line of DICT) {
  const [ar, ...ens] = line.split('|').map(x => x.trim()).filter(Boolean);
  if (!ar || !ens.length) continue;
  for (const k of new Set([normAr(ar), stripAl(normAr(ar))])) {
    const cur = AR2EN.get(k) || [];
    for (const e of ens) if (!cur.includes(e)) cur.push(e);
    AR2EN.set(k, cur);
  }
  for (const e of ens) { const k = normEn(e); if (!k) continue; if (!EN2AR.has(k)) EN2AR.set(k, ar); if (!ARS_BY_EN.has(k)) ARS_BY_EN.set(k, new Set()); ARS_BY_EN.get(k).add(ar); }
}
const trAr = en => EN2AR.get(normEn(en)) || en;
function enCandidates(name) {
  const k = normAr(name);
  const out = [...(AR2EN.get(k) || AR2EN.get(stripAl(k)) || [])];
  if (/[a-z]/i.test(name)) out.push(name);
  return [...new Set(out.map(normEn).filter(Boolean))];
}
function teamEn(name) {
  if (!name) return '';
  const n = String(name).trim();
  const c = AR2EN.get(normAr(n)) || AR2EN.get(stripAl(normAr(n)));
  return c ? c[0] : n;
}
function normName(s) { return normAr(s); }
function tokensOf(s) { return String(s || '').split(' ').filter(w => w.length > 2); }
// تشابه اسم الفريق في الموقع (عربي) مع اسم FotMob (إنجليزي غالباً) — من 0 لـ 1
function simTeam(siteName, ...fmNames) {
  const ens = enCandidates(siteName);
  const ar = normAr(siteName), ar2 = stripAl(ar);
  let best = 0;
  for (const raw of fmNames) {
    if (!raw) continue;
    const t = normEn(raw), ta = normAr(raw);
    if (!t && !ta) continue;
    for (const e of ens) {
      if (t === e) best = Math.max(best, 1);
      else if (e.length >= 4 && t.length >= 4 && (t.includes(e) || e.includes(t))) best = Math.max(best, .8);
      else if (tokensOf(t).some(w => tokensOf(e).includes(w))) best = Math.max(best, .45);
    }
    if (ta === ar || stripAl(ta) === ar2) best = Math.max(best, 1);
    else if (ar.length >= 4 && ta.length >= 4 && (ta.includes(ar) || ar.includes(ta))) best = Math.max(best, .8);
  }
  return best;
}
function namesMatch(a, b) {
  const x = normName(a), y = normName(b);
  if (!x || !y) return false;
  if (x === y) return true;
  if (x.includes(y) || y.includes(x)) return true;
  const xs = x.split(' ').filter(w => w.length > 2);
  const ys = y.split(' ').filter(w => w.length > 2);
  return xs.some(w => ys.some(z => w.includes(z) || z.includes(w)));
}

function fotmobPhoto(playerId) {
  if (!playerId) return null;
  return `https://images.fotmob.com/image_resources/playerimages/${playerId}.png`;
}
function posFromId(p) {
  const id = Number(p.positionId);
  if (Number.isFinite(id)) {
    if (id === 11) return 'G';
    if (id >= 32 && id <= 59) return 'D';
    if (id >= 60 && id <= 99) return 'M';
    if (id >= 100) return 'F';
    if (id === 0) return 'G';
    if (id >= 1 && id <= 4) return 'D';
    if (id >= 5 && id <= 8) return 'M';
    if (id >= 9 && id <= 10) return 'F';
  }
  const u = p.usualPlayingPositionId;
  if (u === 0) return 'G'; if (u === 1) return 'D'; if (u === 2) return 'M'; if (u === 3) return 'F';
  return null;
}
function perfOf(p) {
  const perf = p.performance || {};
  const o = { subIn: null, subOut: null, goals: 0, ownGoals: 0, assists: 0, yellow: 0, red: 0 };
  for (const e of (perf.substitutionEvents || [])) {
    const t = String(e.type || '').toLowerCase(), tm = e.time ?? e.minute ?? null;
    if (t.includes('out')) o.subOut = tm; else if (t.includes('in')) o.subIn = tm;
  }
  for (const e of (perf.events || [])) {
    const t = String(e.type || '').toLowerCase();
    if (t.includes('assist')) o.assists++;
    else if (t.includes('own')) o.ownGoals++;
    else if (t.includes('goal')) o.goals++;
    else if (t.includes('yellow')) o.yellow++;
    else if (t.includes('red')) o.red++;
  }
  return o;
}
function fmtRating(r) {
  const n = parseFloat(r);
  return Number.isFinite(n) && n > 0 ? n.toFixed(1) : null;
}
function mapFotmobPlayers(list) {
  if (!Array.isArray(list)) return [];
  return list.map(p => {
    const f = perfOf(p);
    return {
      id: p.id,
      name: p.name || `${p.firstName || ''} ${p.lastName || ''}`.trim(),
      number: p.shirtNumber != null ? String(p.shirtNumber) : null,
      position: posFromId(p) || p.positionLabel || null,
      rating: fmtRating((p.performance && p.performance.rating) ?? p.rating),
      captain: !!(p.isCaptain || p.captain),
      photo: fotmobPhoto(p.id),
      subIn: f.subIn, subOut: f.subOut,
      goals: f.goals, ownGoals: f.ownGoals, assists: f.assists, yellow: f.yellow, red: f.red
    };
  }).filter(p => p.name);
}

function mapFotmobStats(periods) {
  const all = (periods && (periods.All || periods.all)) || {};
  const groups = all.stats || [];
  const out = [];
  for (const g of groups) {
    for (const s of (g.stats || [])) {
      const arr = s.stats || [];
      if (arr.length >= 2) {
        out.push({
          label: s.title || s.key || '',
          home: arr[0],
          away: arr[1]
        });
      }
    }
  }
  return out.filter(x => x.label);
}

function mapFotmobEvents(matchFacts, idName) {
  const list = (matchFacts && matchFacts.events && matchFacts.events.events) || [];
  const out = [];
  for (const e of list) {
    const type = String(e.type || '');
    const team = e.isHome === true ? 'home' : e.isHome === false ? 'away' : '';
    let minute = e.time != null ? String(e.time) : (e.timeStr != null ? String(e.timeStr) : null);
    if (minute && e.overloadTime) minute += '+' + e.overloadTime;
    const pname = (e.player && e.player.name) || e.nameStr || '';
    if (type === 'Goal') {
      const og = !!e.ownGoal || /own/i.test(e.goalDescription || '');
      const assist = e.assistPlayerId && idName.get(e.assistPlayerId) || (e.assistStr ? String(e.assistStr).replace(/^assist by\s*/i, '') : '');
      out.push({
        minute, type: og ? 'Own goal' : 'Goal', team, player: pname, playerId: (e.player && e.player.id) || e.playerId || null,
        detail: assist ? 'صناعة: ' + assist : '', text: pname, score: Array.isArray(e.newScore) ? e.newScore.join('-') : null
      });
    } else if (type === 'Card') {
      const c = String(e.card || e.cardType || '');
      const red = /red/i.test(c);
      out.push({ minute, type: red ? 'Red card' : 'Yellow card', team, player: pname, playerId: (e.player && e.player.id) || null, text: pname, detail: /yellowred|second/i.test(c) ? 'إنذار ثاني' : '' });
    } else if (type === 'Substitution') {
      const sw = Array.isArray(e.swap) ? e.swap : [];
      out.push({ minute, type: 'Substitution', team, _swap: sw.map(x => ({ id: x.id, name: x.name })), player: pname, playerId: (e.player && e.player.id) || null, text: '' });
    } else if (type === 'VAR') {
      out.push({ minute, type: 'VAR', team, player: pname, text: pname, detail: e.varText || e.decision || '' });
    }
  }
  return out;
}
// نحدد مين دخل ومين خرج: اللي في التشكيلة الأساسية هو الخارج
function resolveSubs(events, startersIds, subsIds) {
  for (const e of events) {
    if (e.type !== 'Substitution') continue;
    const sw = e._swap || []; delete e._swap;
    let out = null, inn = null;
    if (sw.length >= 2) {
      if (startersIds.has(sw[0].id) && !startersIds.has(sw[1].id)) { out = sw[0]; inn = sw[1]; }
      else if (startersIds.has(sw[1].id) && !startersIds.has(sw[0].id)) { out = sw[1]; inn = sw[0]; }
      else if (subsIds.has(sw[0].id)) { inn = sw[0]; out = sw[1]; }
      else if (subsIds.has(sw[1].id)) { inn = sw[1]; out = sw[0]; }
      else { inn = sw[0]; out = sw[1]; }
    }
    e.playerIn = inn ? inn.name : ''; e.playerInId = inn ? inn.id : null;
    e.playerOut = out ? out.name : ''; e.playerOutId = out ? out.id : null;
    e.player = e.playerIn; e.text = [e.playerIn, e.playerOut].filter(Boolean).join(' ← ');
    e.detail = e.playerOut ? 'خرج: ' + e.playerOut : '';
  }
}

async function fotmobGet(url) {
  const { data } = await get(url, {
    headers: {
      'User-Agent': UA,
      Accept: 'application/json',
      Referer: 'https://www.fotmob.com/'
    },
    timeout: 14000
  }, 1);
  return data;
}

// ========== FOTMOB: قايمة اليوم + مطابقة المباراة ==========
const dayCache = new Map();
const ymd = ms => { const d = new Date(ms); return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`; };
async function fotmobDay(date) {
  const hit = dayCache.get(date);
  if (hit && Date.now() - hit.ts < 90 * 1000) return hit.list;
  const data = await fotmobGet(`https://www.fotmob.com/api/data/matches?date=${date}`);
  const list = [];
  for (const lg of (data && data.leagues) || []) {
    for (const m of lg.matches || []) {
      list.push({
        id: m.id, lgId: lg.primaryId || lg.id, lgName: lg.name,
        home: m.home || {}, away: m.away || {},
        utc: Date.parse((m.status && m.status.utcTime) || '') || null
      });
    }
  }
  dayCache.set(date, { ts: Date.now(), list });
  return list;
}

const resolveCache = new Map(); // key → { ts, r }
const aliasLearn = new Map();   // normAr(name) → teamId
const ALIAS_FILE = path.join(DATA_DIR, 'aliases.json');
try {
  if (fs.existsSync(ALIAS_FILE)) for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(ALIAS_FILE, 'utf8')))) aliasLearn.set(k, v);
} catch (_) {}
let aliasDirty = false;
function learnAlias(name, id) {
  const k = normAr(name);
  if (!k || !id || aliasLearn.get(k) === id) return;
  aliasLearn.set(k, id); aliasDirty = true;
}
setInterval(() => {
  if (!aliasDirty) return; aliasDirty = false;
  try { fs.writeFileSync(ALIAS_FILE, JSON.stringify(Object.fromEntries(aliasLearn))); } catch (_) {}
}, 60 * 1000);

async function resolveFotmobMatch({ home, away, startMs }) {
  const dates = new Set();
  const base = startMs || Date.now();
  [-1, 0, 1].forEach(o => dates.add(ymd(base + o * 86400000)));
  let best = null;
  for (const date of dates) {
    let list;
    try { list = await fotmobDay(date); } catch (e) { console.error('[FotMob day]', date, e.message); continue; }
    for (const f of list) {
      const s1 = simTeam(home, f.home.name, f.home.longName), s2 = simTeam(away, f.away.name, f.away.longName);
      const w1 = simTeam(home, f.away.name, f.away.longName), w2 = simTeam(away, f.home.name, f.home.longName);
      const straight = s1 + s2, swapped = w1 + w2, sw = swapped > straight, sum = sw ? swapped : straight;
      let tb = 0;
      if (startMs && f.utc) { const dm = Math.abs(f.utc - startMs) / 60000; tb = dm <= 5 ? .4 : dm <= 120 ? .1 : 0; }
      const total = sum + tb;
      if (!best || total > best.total) best = { total, sum, tb, f, sw };
    }
  }
  if (!best) return null;
  if (!(best.sum >= 1.4 || (best.sum >= .8 && best.tb >= .4))) return null;
  const f = best.f;
  const r = {
    fmId: f.id, leagueId: f.lgId, leagueName: f.lgName, swapped: best.sw,
    homeId: best.sw ? f.away.id : f.home.id, awayId: best.sw ? f.home.id : f.away.id, strong: best.sum >= 1.4
  };
  if (r.strong) { learnAlias(home, r.homeId); learnAlias(away, r.awayId); }
  return r;
}
async function findFotmobMatchId(home, away, startIso) {
  const r = await resolveFotmobMatch({ home, away, startMs: startIso ? Date.parse(startIso) : null });
  return r ? r.fmId : null;
}

let resolving = false;
async function resolveInBackground(matches) {
  if (resolving) return;
  resolving = true;
  try {
    let changed = false;
    for (const m of matches) {
      if (m.statusType === 'finished' && m.startMs && Date.now() - m.startMs > 36 * 3600000) continue;
      const c = resolveCache.get(m.key);
      if (c && (c.r ? Date.now() - c.ts < 6 * 3600000 : Date.now() - c.ts < 3 * 60000)) continue;
      let r = null;
      try { r = await resolveFotmobMatch({ home: m.home, away: m.away, startMs: m.startMs }); } catch (_) {}
      resolveCache.set(m.key, { ts: Date.now(), r });
      if (r) changed = true;
    }
    if (changed) {
      attachInfo(cache.matches);
      try { io.emit('matches', cache); } catch (_) {}
    }
  } finally { resolving = false; }
}

// ========== TEAM INDEX (ids / ترتيب / مباريات) ==========
const INDEX_TTL = 10 * 60 * 1000;
const teamIndex = { byId: new Map(), byEn: new Map(), byAr: new Map(), builtAt: 0, building: null };
const teamLogo = id => `https://images.fotmob.com/image_resources/logo/teamlogo/${id}_small.png`;
async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const it = items[i++]; await fn(it); }
  }));
}
function putUnique(map, k, id) {
  if (!k) return;
  const cur = map.get(k);
  if (cur === undefined) map.set(k, id); else if (cur !== id) map.set(k, -1);
}
function leagueMeta(id, fallbackName) {
  const l = LEAGUES.find(x => x.id === Number(id));
  return l
    ? { id: l.id, name: l.name, nameAr: l.nameAr, logo: `https://images.fotmob.com/image_resources/logo/leaguelogo/${l.id}.png` }
    : (id ? { id: Number(id), name: fallbackName || '', nameAr: fallbackName || '', logo: `https://images.fotmob.com/image_resources/logo/leaguelogo/${id}.png` } : null);
}
async function buildTeamIndex(force) {
  if (teamIndex.building) return teamIndex.building;
  if (!force && teamIndex.builtAt && Date.now() - teamIndex.builtAt < INDEX_TTL) return;
  teamIndex.building = (async () => {
    const byId = new Map(), byEn = new Map();
    const list = LEAGUES.filter(l => !leagueBad.has(l.id));
    await pool(list, 3, async (lg) => {
      try {
        const d = await fetchLeagueDetails(lg.id);
        const flat = !d.groups;
        for (const [i, r] of (d.standings || []).entries()) {
          if (!r || !r.id) continue;
          const t = byId.get(r.id) || { id: r.id, name: r.name, short: r.shortName || r.name, logo: teamLogo(r.id), domestic: null, fixtures: [] };
          byId.set(r.id, t);
          if (lg.type === 'league' && flat && (!t.domestic || t.domestic.leagueId === lg.id)) {
            t.domestic = { rank: r.rank ?? i + 1, pts: r.pts, played: r.played, gd: r.goalDiff, leagueId: lg.id, leagueName: lg.name, leagueNameAr: lg.nameAr, season: d.standingsSeason || d.season };
          }
        }
        for (const f of d.fixtures || []) {
          for (const tid of [f.homeId, f.awayId]) {
            if (!tid) continue;
            const t = byId.get(tid) || { id: tid, name: tid === f.homeId ? f.home : f.away, short: tid === f.homeId ? f.home : f.away, logo: teamLogo(tid), domestic: null, fixtures: [] };
            byId.set(tid, t);
            if (!t.fixtures.some(x => x.id === f.id)) t.fixtures.push({ ...f, leagueId: lg.id, leagueNameAr: lg.nameAr });
          }
        }
      } catch (e) {
        console.error('[Index]', lg.id, e.message);
        if (lg.verify && /not found/i.test(e.message)) leagueBad.add(lg.id);
      }
    });
    for (const t of byId.values()) { putUnique(byEn, normEn(t.name), t.id); putUnique(byEn, normEn(t.short), t.id); }
    const byAr = new Map();
    for (const [arKey, ens] of AR2EN) for (const e of ens) { const id = byEn.get(normEn(e)); if (id && id > 0) putUnique(byAr, arKey, id); }
    if (byId.size) { teamIndex.byId = byId; teamIndex.byEn = byEn; teamIndex.byAr = byAr; teamIndex.builtAt = Date.now(); }
    console.log(`[Index] teams=${byId.size} ar=${byAr.size}`);
    attachInfo(cache.matches || []);
  })().finally(() => { teamIndex.building = null; });
  return teamIndex.building;
}
function resolveTeamByName(name) {
  if (!name) return null;
  const k = normAr(name), k2 = stripAl(k);
  let id = aliasLearn.get(k) ?? aliasLearn.get(k2);
  if (id) return id;
  id = teamIndex.byAr.get(k) ?? teamIndex.byAr.get(k2);
  if (id && id > 0) return id;
  for (const e of enCandidates(name)) { const x = teamIndex.byEn.get(e); if (x && x > 0) return x; }
  return null;
}
function rankOf(id) {
  const t = id && teamIndex.byId.get(id);
  if (!t || !t.domestic) return null;
  const d = t.domestic;
  return { rank: d.rank, pts: d.pts, played: d.played, gd: d.gd, leagueId: d.leagueId, league: d.leagueNameAr || d.leagueName };
}
function attachInfo(matches) {
  for (const m of matches || []) {
    const c = resolveCache.get(m.key), r = c && c.r;
    const hid = (r && r.homeId) || resolveTeamByName(m.home);
    const aid = (r && r.awayId) || resolveTeamByName(m.away);
    m.homeId = hid || null; m.awayId = aid || null;
    m.homeRank = rankOf(hid); m.awayRank = rankOf(aid);
    m.league = r ? leagueMeta(r.leagueId, r.leagueName) : null;
    if (typeof manualFor === 'function' && manualFor(m.key, m.link, m.home, m.away)) { m.hasStream = true; m.manual = true; }
  }
}
function teamArName(t) { return trAr(t.short || t.name); }
function teamAliasesAr(t) {
  const s = new Set();
  for (const n of [t.name, t.short]) { const k = normEn(n); (ARS_BY_EN.get(k) || []).forEach(x => s.add(x)); }
  for (const [k, id] of aliasLearn) if (id === t.id) s.add(k);
  return [...s];
}
function fxOutcome(f, teamId) {
  const m = String(f.score || '').match(/(\d+)\s*[-–:]\s*(\d+)/);
  if (!m) return null;
  const a = +m[1], b = +m[2], home = f.homeId === teamId;
  const my = home ? a : b, op = home ? b : a;
  return my > op ? 'W' : my < op ? 'L' : 'D';
}
function teamSummary(t) {
  const now = Date.now();
  const fx = t.fixtures.map(f => ({ ...f, ts: Date.parse(f.utcTime) || 0, homeAr: trAr(f.home), awayAr: trAr(f.away) }));
  const upcoming = fx.filter(f => f.statusType !== 'finished').sort((a, b) => a.ts - b.ts).slice(0, 6);
  const results = fx.filter(f => f.statusType === 'finished').sort((a, b) => b.ts - a.ts).slice(0, 6).map(f => ({ ...f, outcome: fxOutcome(f, t.id) }));
  return {
    id: t.id, name: t.name, nameAr: teamArName(t), logo: t.logo, aliases: teamAliasesAr(t),
    rank: t.domestic ? { rank: t.domestic.rank, pts: t.domestic.pts, played: t.domestic.played, gd: t.domestic.gd, leagueId: t.domestic.leagueId, league: t.domestic.leagueNameAr } : null,
    next: upcoming[0] || null, upcoming, results, form: results.slice(0, 5).map(r => r.outcome).filter(Boolean).join(''), now
  };
}

async function enrichFromFotmob(details, home, away, startIso) {
  const rm = await resolveFotmobMatch({ home, away, startMs: startIso ? Date.parse(startIso) : null });
  const matchId = rm && rm.fmId;
  if (!matchId) return false;

  const data = await fotmobGet(`https://www.fotmob.com/api/data/matchDetails?matchId=${matchId}`);
  if (!data || !data.content) return false;

  details.source = 'fotmob';
  details.fotmobId = matchId;

  const content = data.content;
  const infoBox = (content.matchFacts && content.matchFacts.infoBox) || {};
  const stadium = infoBox.Stadium || {};
  const referee = infoBox.Referee || {};
  const tournament = infoBox.Tournament || {};

  details.info = {
    competition: tournament.leagueName || (data.general && data.general.leagueName) || null,
    round: tournament.roundName || tournament.round || null,
    stadium: stadium.name || null,
    city: stadium.city || null,
    country: stadium.country || null,
    capacity: stadium.capacity || null,
    attendance: infoBox.Attendance || null,
    referee: referee.text || referee.name || null,
    refereeCountry: referee.country || null,
    date: (infoBox['Match Date'] && infoBox['Match Date'].utcTime) || (data.general && data.general.matchTimeUTC) || null,
    home: data.header?.teams?.[0]?.name || home,
    away: data.header?.teams?.[1]?.name || away,
    homeScore: data.header?.teams?.[0]?.score,
    awayScore: data.header?.teams?.[1]?.score,
    status: data.header?.status?.reason?.long || (data.general?.finished ? 'Full-Time' : null)
  };

  const lu = content.lineup || {};
  const ht = lu.homeTeam || {};
  const at = lu.awayTeam || {};
  details.homeLineup = mapFotmobPlayers(ht.starters);
  details.awayLineup = mapFotmobPlayers(at.starters);
  details.homeSubs = mapFotmobPlayers(ht.subs);
  details.awaySubs = mapFotmobPlayers(at.subs);
  details.formations = {
    home: ht.formation || null,
    away: at.formation || null,
    homeCoach: ht.coach?.name || null,
    awayCoach: at.coach?.name || null,
    homeCoachPhoto: ht.coach?.id ? fotmobPhoto(ht.coach.id) : null,
    awayCoachPhoto: at.coach?.id ? fotmobPhoto(at.coach.id) : null,
    confirmed: true
  };

  details.stats = mapFotmobStats(content.stats?.Periods);
  { const hl = content.matchFacts && content.matchFacts.highlights;
    if (hl && (hl.url || hl.image)) details.highlight = { url: hl.url || null, image: hl.image || null, source: hl.source || null }; }

  // ---- الأحداث الكاملة (أهداف / كروت / تبديلات / VAR) ----
  const all = [...details.homeLineup, ...details.awayLineup, ...details.homeSubs, ...details.awaySubs];
  const byId = new Map(all.map(p => [p.id, p]));
  const idName = new Map(all.map(p => [p.id, p.name]));
  const startersIds = new Set([...details.homeLineup, ...details.awayLineup].map(p => p.id));
  const subsIds = new Set([...details.homeSubs, ...details.awaySubs].map(p => p.id));
  let events = mapFotmobEvents(content.matchFacts, idName);
  resolveSubs(events, startersIds, subsIds);

  if (!events.length) {
    const headerEv = data.header?.events || {};
    for (const side of ['homeTeamGoals', 'awayTeamGoals']) {
      for (const [playerName, arr] of Object.entries(headerEv[side] || {})) {
        for (const g of arr || []) {
          events.push({
            minute: g.time != null ? String(g.time) : null, type: g.type || 'Goal',
            player: g.player?.name || playerName, team: side.startsWith('home') ? 'home' : 'away',
            detail: g.assistStr || '', text: g.player?.name || playerName
          });
        }
      }
    }
    for (const side of ['homeTeamRedCards', 'awayTeamRedCards']) {
      for (const [playerName, arr] of Object.entries(headerEv[side] || {})) {
        for (const c of arr || []) {
          events.push({ minute: c.time != null ? String(c.time) : null, type: 'Red card', player: playerName, team: side.startsWith('home') ? 'home' : 'away', text: playerName });
        }
      }
    }
  }
  events.forEach((e, i) => { e.n = i; });

  // ---- نطبّق الأحداث على اللاعبين (تبديل/أهداف/كروت) لو لسه مفيش من performance ----
  const mnum = x => { const n = parseInt(x, 10); return Number.isFinite(n) ? n : null; };
  const cnt = { g: new Map(), og: new Map(), y: new Map(), r: new Map(), a: new Map() };
  const inc = (m, id) => { if (id != null) m.set(id, (m.get(id) || 0) + 1); };
  for (const e of events) {
    if (e.type === 'Substitution') {
      const pi = byId.get(e.playerInId), po = byId.get(e.playerOutId);
      if (pi && pi.subIn == null) pi.subIn = mnum(e.minute);
      if (po && po.subOut == null) po.subOut = mnum(e.minute);
    } else if (e.type === 'Goal') inc(cnt.g, e.playerId);
    else if (e.type === 'Own goal') inc(cnt.og, e.playerId);
    else if (e.type === 'Yellow card') inc(cnt.y, e.playerId);
    else if (e.type === 'Red card') inc(cnt.r, e.playerId);
  }
  for (const p of all) {
    p.goals = Math.max(p.goals || 0, cnt.g.get(p.id) || 0);
    p.ownGoals = Math.max(p.ownGoals || 0, cnt.og.get(p.id) || 0);
    p.yellow = Math.max(p.yellow || 0, cnt.y.get(p.id) || 0);
    p.red = Math.max(p.red || 0, cnt.r.get(p.id) || 0);
  }
  details.events = events;

  // ---- ترتيب الفريقين ----
  const hid = rm.homeId, aid = rm.awayId;
  if (rm.swapped) swapDetails(details);
  details.ids = { home: hid || null, away: aid || null };
  details.ranks = { home: rankOf(hid), away: rankOf(aid) };
  return true;
}

// لو الموقع عارض الفريقين بترتيب عكس FotMob نقلب الجهات عشان تطابق كروت الموقع
function swapDetails(d) {
  [d.homeLineup, d.awayLineup] = [d.awayLineup, d.homeLineup];
  [d.homeSubs, d.awaySubs] = [d.awaySubs, d.homeSubs];
  const f = d.formations || {};
  d.formations = { ...f, home: f.away, away: f.home, homeCoach: f.awayCoach, awayCoach: f.homeCoach, homeCoachPhoto: f.awayCoachPhoto, awayCoachPhoto: f.homeCoachPhoto };
  d.stats = (d.stats || []).map(s => ({ label: s.label, home: s.away, away: s.home }));
  d.events = (d.events || []).map(e => ({ ...e, team: e.team === 'home' ? 'away' : e.team === 'away' ? 'home' : e.team }));
  const i = d.info || {};
  d.info = { ...i, home: i.away, away: i.home, homeScore: i.awayScore, awayScore: i.homeScore };
}

// keep sportscore as weak fallback for lineups only
async function enrichFromSportScore(details, home, away) {
  try {
    const h = teamEn(home).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const a = teamEn(away).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const slugs = [`${h}-vs-${a}`, `${a}-vs-${h}`, `fc-${h}-vs-${a}`, `${h}-vs-fc-${a}`];
    for (const slug of [...new Set(slugs)]) {
      try {
        const { data } = await get(
          `https://sportscore.com/api/widget/match/?sport=football&slug=${encodeURIComponent(slug)}`,
          { headers: { Accept: 'application/json' }, timeout: 9000 },
          0
        );
        const match = data && data.match;
        if (!match) continue;
        if (!details.source) details.source = 'sportscore';
        if (!details.events.length && match.incidents) {
          details.events = (match.incidents || []).map(e => ({
            minute: e.time != null ? String(e.time) : null,
            type: e.type || '',
            player: e.player || e.player_in || '',
            team: e.side === 'home' ? 'home' : e.side === 'away' ? 'away' : '',
            text: e.player || [e.player_in, e.player_out].filter(Boolean).join(' ← ') || e.type
          }));
        }
        const lu = match.lineups || {};
        if (!details.homeLineup.length && lu.home_xi) {
          details.homeLineup = (lu.home_xi || []).map(p => ({
            name: p.name, number: p.number, position: p.position, rating: p.rating,
            captain: !!p.captain, photo: null
          }));
        }
        if (!details.awayLineup.length && lu.away_xi) {
          details.awayLineup = (lu.away_xi || []).map(p => ({
            name: p.name, number: p.number, position: p.position, rating: p.rating,
            captain: !!p.captain, photo: null
          }));
        }
        if (!details.formations.home && lu.home_formation) {
          details.formations = {
            home: lu.home_formation, away: lu.away_formation,
            homeCoach: lu.home_coach, awayCoach: lu.away_coach, confirmed: !!lu.confirmed
          };
        }
        return true;
      } catch (_) {}
    }
  } catch (_) {}
  return false;
}

async function trySirTvPage(url, details) {
  try {
    const { data } = await get(url, { headers: { Referer: SOURCE } }, 0);
    const $ = cheerio.load(data);
    if (!details.source) details.source = 'sir-tv';
  } catch (_) {}
}

async function fetchMatchDetails(matchLink, externalId, home, away) {
  let startIso = null;
  if ((!home || !away) && (matchLink || externalId)) {
    const m = cache.matches.find(x =>
      (externalId && (x.externalId === externalId || x.id === externalId)) ||
      (matchLink && x.link === matchLink)
    );
    if (m) {
      home = home || m.home;
      away = away || m.away;
      matchLink = matchLink || m.link;
      startIso = m.start || null;
    }
  } else if (home && away) {
    const m = cache.matches.find(x => x.home === home && x.away === away);
    if (m) startIso = m.start || null;
  }

  const key = String(externalId || matchLink || `${home}-${away}`);
  const hit = detailsCache.get(key);
  if (hit && Date.now() - hit.ts < DETAILS_TTL) return hit.data;

  const details = emptyDetails();

  if (home && away) {
    try {
      await enrichFromFotmob(details, home, away, startIso);
    } catch (e) {
      console.error('[FotMob]', e.message);
    }
  }

  // fallback
  if (!details.homeLineup.length && home && away) {
    await enrichFromSportScore(details, home, away);
  }
  if (matchLink && /sir-tv\.vip/i.test(matchLink)) {
    await trySirTvPage(matchLink, details);
  }

  details.updatedAt = new Date().toISOString();
  detailsCache.set(key, { ts: Date.now(), data: details });
  return details;
}

// ========== STREAM ==========
async function resolveStream(matchLink, ctx = {}) {
  if (!matchLink) throw new Error('No link provided');
  const hit = streamCache.get(matchLink);
  if (hit && Date.now() - hit.ts < STREAM_TTL) return hit.data;

  const headers = { 'User-Agent': UA, 'Accept-Language': 'ar,en;q=0.9', Referer: 'https://sir-tv.vip/' };

  const page1 = await get(matchLink, { headers }, 1);
  let playerUrl = extractPlayerUrl(page1.data, matchLink);
  if (!playerUrl) {
    const mid = matchLink.match(/[?&]m=(\d+)/);
    if (mid) playerUrl = `https://n1.sirftv.com/hard/player.html?match=${mid[1]}`;
  } else ctx.embed = playerUrl;
  if (!playerUrl) throw new Error('Player page not found');

  const page2 = await get(playerUrl, { headers: { ...headers, Referer: matchLink } }, 1);
  let streams = extractStreams(page2.data);
  if (streams.length) {
    const result = buildResult(streams, playerUrl);
    result.embed = ctx.embed;
    streamCache.set(matchLink, { ts: Date.now(), data: result });
    return result;
  }

  let finalPlayer = extractFinalPlayer(page2.data, playerUrl);
  if (!finalPlayer) throw new Error('Final player not found');
  if (!finalPlayer.startsWith('http')) finalPlayer = new URL(finalPlayer, playerUrl).href;
  ctx.embed = finalPlayer;

  const page3 = await get(finalPlayer, { headers: { ...headers, Referer: playerUrl } }, 1);
  streams = extractStreams(page3.data);
  if (!streams.length) throw new Error('No stream URL found');

  const result = buildResult(streams, finalPlayer);
  result.embed = ctx.embed;
  streamCache.set(matchLink, { ts: Date.now(), data: result });
  return result;
}

// يفك الـ escape والـ base64 عشان الروابط المخبية جوه JS تتلاقي
function normHtml(html) {
  let h = String(html || '');
  h = h.replace(/\\u002F/gi, '/').replace(/\\\//g, '/').replace(/&amp;/g, '&');
  const extra = [];
  const re = /atob\(\s*['"]([A-Za-z0-9+\/=]{16,})['"]\s*\)/g;
  let m;
  while ((m = re.exec(h))) { try { extra.push(Buffer.from(m[1], 'base64').toString('utf8')); } catch (_) {} }
  return extra.length ? h + '\n' + extra.join('\n') : h;
}
const PLAYER_RX = /https?:\/\/[^"'\s<>\\]*(?:sirtv\.top|sirftv\.com)[^"'\s<>\\]*player[^"'\s<>\\]*/i;
function extractPlayerUrl(html, base) {
  const n = normHtml(html);
  const $ = cheerio.load(n);
  const iframe = $('iframe#player, iframe[src*="sirtv"], iframe[src*="sirftv"], iframe[src*="playerv"], iframe[src*="player"], iframe').first().attr('src')
    || $('iframe[data-src]').first().attr('data-src');
  if (iframe && !/^about:|^javascript:/i.test(iframe)) return iframe.startsWith('http') ? iframe : new URL(iframe, base).href;
  const m = n.match(PLAYER_RX) || n.match(/https?:\/\/[^"'\s<>]+player\w*\.php\?[^"'\s<>]+/i);
  return m ? m[0] : null;
}

function extractFinalPlayer(html, base) {
  const $ = cheerio.load(html);
  let src = $('iframe').first().attr('src');
  if (src) return src.startsWith('http') ? src : new URL(src, base).href;
  const m = html.match(/https?:\/\/[^"'\s]+playerv5\.php[^"'\s]*/i);
  return m ? m[0] : null;
}

function extractStreams(html) {
  html = normHtml(html);
  const set = new Set();
  const patterns = [
    /https?:\/\/[a-z0-9.-]+\.live--koora\.com\/[^\s"'<>]+/gi,
    /https?:\/\/[^"'\s]+\/kooora\/[^\s"'<>]*/gi,
    /https?:\/\/[^"'\s]+\.m3u8[^"'\s]*/gi
  ];
  for (const re of patterns) (html.match(re) || []).forEach(u => set.add(u.replace(/\\$/, '')));
  return [...set];
}

function buildResult(streams, referer) {
  const hd = streams.find(s => /_hd|\/hd|1080|720|high/i.test(s));
  const sd = streams.find(s => !/_hd|\/hd|1080|720|high/i.test(s)) || streams[0];
  const chosen = hd || sd;
  const qualities = [];
  if (hd) qualities.push({ label: 'HD', url: hd });
  if (sd && sd !== hd) qualities.push({ label: 'SD', url: sd });
  streams.forEach(s => { if (s !== hd && s !== sd) qualities.push({ label: 'ALT', url: s }); });
  return { streamUrl: chosen, qualities, quality: hd ? 'HD' : 'SD', type: 'hls', referer, resolvedAt: new Date().toISOString() };
}

async function proxyHls(req, res, targetUrl, referer) {
  try {
    const mk = req.query.k ? manualStreams.get(String(req.query.k)) : null;
    const targetHost = new URL(targetUrl).hostname.toLowerCase();

    // استخدم هيدرز مصدر Shootsimo نفسها لكل من playlist وملفات TS.
    // مهم: الطلبات الفرعية للـ HLS تمر من /proxy أيضاً، لذلك يجب أن تستخدم
    // نفس Origin / Referer / Cookie / User-Agent، وليس هيدرز SirTV الافتراضية.
    const isShootsimo = targetHost === 'shootsimo.net' ||
      targetHost.endsWith('.shootsimo.net');
    const requestHeaders = mk
      ? streamHeaders(mk)
      : isShootsimo
        ? streamHeaders({
            referer: process.env.STREAM_REFERER || 'https://2.shootsimo.net/',
            origin: process.env.STREAM_ORIGIN || 'https://2.shootsimo.net',
            ua: process.env.STREAM_UA,
            accept: process.env.STREAM_ACCEPT,
            cookie: process.env.STREAM_COOKIE
          })
        : {
            'User-Agent': UA,
            Accept: '*/*',
            Origin: 'https://912acsss8af382.sirtv.top',
            Referer: referer || 'https://912acsss8af382.sirtv.top/',
            'Accept-Encoding': 'identity',
            Connection: 'keep-alive'
          };

    const response = await axios.get(targetUrl, {
      headers: requestHeaders,
      responseType: 'arraybuffer',
      timeout: 22000,
      maxRedirects: 5,
      validateStatus: () => true
    });
    if (response.status >= 400) return res.status(response.status).send('Upstream error ' + response.status);

    const ct = (response.headers['content-type'] || '').toLowerCase();
    const isPlaylist = ct.includes('mpegurl') || ct.includes('m3u8') || /\.m3u8($|\?)/i.test(targetUrl) || /_sc|_hd|_sd/i.test(targetUrl);

    res.set({
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Cache-Control': 'no-cache, no-store'
    });

    if (isPlaylist) {
      let body = Buffer.from(response.data).toString('utf8');
      const base = new URL(targetUrl);
      const host = publicBaseUrl(req);
      const proxyBase = `${host}/proxy?url=`;
      const refQ = (mk ? `&k=${encodeURIComponent(String(req.query.k))}` : '') + (referer ? `&ref=${encodeURIComponent(referer)}` : '');
      body = body.replace(/(https?:\/\/[^\s\n\r"']+)/g, m => proxyBase + encodeURIComponent(m) + refQ);
      body = body.replace(/^([a-zA-Z0-9_\-\.\/]+\.(ts|m4s|key|m3u8)[^\s]*)$/gm, m => {
        try { return proxyBase + encodeURIComponent(new URL(m, base).href) + refQ; } catch { return m; }
      });
      body = body.replace(/URI="([^"]+)"/g, (m0, u) => { if (u.startsWith(proxyBase)) return m0; try { return 'URI="' + proxyBase + encodeURIComponent(new URL(u, base).href) + refQ + '"'; } catch { return m0; } });
      res.set('Content-Type', 'application/vnd.apple.mpegurl');
      return res.send(body);
    }

    res.set('Content-Type', ct || 'application/octet-stream');
    return res.send(Buffer.from(response.data));
  } catch (err) {
    console.error('[Proxy]', err.message);
    if (!res.headersSent) res.status(502).json({ error: 'Proxy failed', message: err.message });
  }
}


// ========== LEAGUES (FotMob) ==========
const leagueCache = new Map();
const LEAGUE_TTL = 5 * 60 * 1000;
const leagueBad = new Set();

const LEAGUES = [
  { id: 519, name: 'Egyptian Premier League', nameAr: 'الدوري المصري', country: 'Egypt', type: 'league' },
  { id: 47, name: 'Premier League', nameAr: 'الدوري الإنجليزي', country: 'England', type: 'league' },
  { id: 87, name: 'LaLiga', nameAr: 'الدوري الإسباني', country: 'Spain', type: 'league' },
  { id: 55, name: 'Serie A', nameAr: 'الدوري الإيطالي', country: 'Italy', type: 'league' },
  { id: 54, name: 'Bundesliga', nameAr: 'الدوري الألماني', country: 'Germany', type: 'league' },
  { id: 53, name: 'Ligue 1', nameAr: 'الدوري الفرنسي', country: 'France', type: 'league' },
  { id: 536, name: 'Saudi Pro League', nameAr: 'الدوري السعودي', country: 'Saudi Arabia', type: 'league', verify: true },
  { id: 71, name: 'Süper Lig', nameAr: 'الدوري التركي', country: 'Turkey', type: 'league', verify: true },
  { id: 61, name: 'Liga Portugal', nameAr: 'الدوري البرتغالي', country: 'Portugal', type: 'league', verify: true },
  { id: 57, name: 'Eredivisie', nameAr: 'الدوري الهولندي', country: 'Netherlands', type: 'league', verify: true },
  { id: 42, name: 'Champions League', nameAr: 'دوري أبطال أوروبا', country: 'Europe', type: 'cup' },
  { id: 73, name: 'Europa League', nameAr: 'الدوري الأوروبي', country: 'Europe', type: 'cup' },
  { id: 526, name: 'CAF Champions League', nameAr: 'دوري أبطال أفريقيا', country: 'Africa', type: 'cup' },
  { id: 9468, name: 'CAF Confederation Cup', nameAr: 'كأس الكونفدرالية الأفريقية', country: 'Africa', type: 'cup' }
];

function mapTableRows(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.map(r => ({
    rank: r.idx ?? r.rank ?? null,
    id: r.id,
    name: r.name,
    shortName: r.shortName || r.name,
    played: r.played,
    wins: r.wins,
    draws: r.draws,
    losses: r.losses,
    goalsFor: r.scoresStr ? Number(String(r.scoresStr).split('-')[0]) : null,
    goalsAgainst: r.scoresStr ? Number(String(r.scoresStr).split('-')[1]) : null,
    goalsStr: r.scoresStr || null,
    goalDiff: r.goalConDiff ?? null,
    pts: r.pts,
    qualColor: r.qualColor || null,
    logo: r.id ? `https://images.fotmob.com/image_resources/logo/teamlogo/${r.id}_small.png` : null
  }));
}

function mapFixtures(list) {
  if (!Array.isArray(list)) return [];
  return list.map(m => {
    const st = m.status || {};
    let statusType = 'upcoming';
    if (st.finished) statusType = 'finished';
    else if (st.started && !st.finished) statusType = 'live';
    return {
      id: m.id,
      round: m.roundName || m.round || null,
      home: m.home?.name || m.home?.shortName,
      away: m.away?.name || m.away?.shortName,
      homeId: m.home?.id,
      awayId: m.away?.id,
      homeLogo: m.home?.id ? `https://images.fotmob.com/image_resources/logo/teamlogo/${m.home.id}_small.png` : null,
      awayLogo: m.away?.id ? `https://images.fotmob.com/image_resources/logo/teamlogo/${m.away.id}_small.png` : null,
      score: st.scoreStr || null,
      status: st.reason?.long || (st.finished ? 'انتهت' : st.started ? 'مباشر' : 'لم تبدأ'),
      statusType,
      utcTime: st.utcTime || null,
      pageUrl: m.pageUrl || null
    };
  });
}

function mapScorers(playersStats) {
  if (!Array.isArray(playersStats)) return [];
  const goals = playersStats.find(p => p.name === 'goals' || /top scorer/i.test(p.header || ''));
  if (!goals) return [];
  const list = [];
  const seen = new Set();
  const push = (p) => {
    if (!p) return;
    const id = p.id || p.ParticiantId || p.ParticipantId;
    if (!id || seen.has(id)) return;
    seen.add(id);
    list.push({
      id,
      rank: p.rank ?? p.Rank ?? list.length + 1,
      name: p.name || p.ParticipantName,
      teamId: p.teamId || p.TeamId,
      teamName: p.teamName || p.TeamName,
      goals: p.value ?? p.StatValue ?? p.stat?.value ?? null,
      photo: fotmobPhoto(id),
      teamLogo: (p.teamId || p.TeamId) ? `https://images.fotmob.com/image_resources/logo/teamlogo/${p.teamId || p.TeamId}_small.png` : null
    });
  };
  (goals.topThree || []).forEach(push);
  if (goals.participant) push(goals.participant);
  return list;
}

async function fetchFullScorers(fetchAllUrl) {
  if (!fetchAllUrl) return [];
  try {
    const { data } = await axios.get(fetchAllUrl, {
      headers: {
        'User-Agent': UA,
        Accept: 'application/json,text/plain,*/*',
        'Accept-Encoding': 'gzip, deflate',
        Referer: 'https://www.fotmob.com/'
      },
      timeout: 14000,
      decompress: true,
      validateStatus: s => s < 500
    });

    let list = [];
    if (Array.isArray(data)) {
      list = data;
    } else if (data && Array.isArray(data.TopLists) && data.TopLists[0]) {
      list = data.TopLists[0].StatList || [];
    } else if (data && Array.isArray(data.statsList)) {
      list = data.statsList;
    } else if (data && Array.isArray(data.players)) {
      list = data.players;
    }

    return (list || []).slice(0, 30).map((p, i) => {
      const id = p.ParticiantId || p.ParticipantId || p.id || p.playerId;
      const teamId = p.TeamId || p.teamId;
      return {
        id,
        rank: p.Rank ?? p.rank ?? i + 1,
        name: p.ParticipantName || p.ParticiantName || p.name || p.playerName,
        teamId,
        teamName: p.TeamName || p.teamName,
        goals: p.StatValue ?? p.value ?? p.stat?.value ?? null,
        photo: fotmobPhoto(id),
        teamLogo: teamId ? `https://images.fotmob.com/image_resources/logo/teamlogo/${teamId}_small.png` : null
      };
    }).filter(p => p.name);
  } catch (e) {
    console.error('[Scorers full]', e.message);
    return [];
  }
}

async function fetchLeagueDetails(leagueId) {
  const id = Number(leagueId);
  const hit = leagueCache.get(id);
  if (hit && Date.now() - hit.ts < LEAGUE_TTL) return hit.data;

  // Prefer latest season (e.g. Egypt 2026/2027)
  let data = await fotmobGet(`https://www.fotmob.com/api/data/leagues?id=${id}`);
  if (!data || !data.details) throw new Error('League not found');
  const seasons = data.allAvailableSeasons || [];
  const latest = seasons[0] || data.details.selectedSeason;
  if (latest && data.details.selectedSeason !== latest) {
    try {
      const dLatest = await fotmobGet(`https://www.fotmob.com/api/data/leagues?id=${id}&season=${encodeURIComponent(latest)}`);
      if (dLatest && dLatest.details) data = dLatest;
    } catch (_) {}
  }

  const hasTable = (d) => {
    if (Array.isArray(d?.table) && d.table.length) return true;
    if (Array.isArray(d?.overview?.table) && d.overview.table.length) return true;
    return false;
  };

  // Keep latest season as primary; only borrow standings from previous season if empty
  let standingsSeason = data.details?.selectedSeason || latest || null;
  let standingsSource = data;
  if (!hasTable(data)) {
    for (const season of seasons.slice(0, 5)) {
      if (season === standingsSeason) continue;
      try {
        const d2 = await fotmobGet(`https://www.fotmob.com/api/data/leagues?id=${id}&season=${encodeURIComponent(season)}`);
        if (hasTable(d2)) { standingsSource = d2; break; }
      } catch (_) {}
    }
  }

  // table — support top-level table OR overview.table; multi-group tables
  let standings = [];
  let groups = [];
  try {
    const tableSrc = standingsSource || data;
    const tableRoot = (Array.isArray(tableSrc.table) && tableSrc.table.length)
      ? tableSrc.table
      : (Array.isArray(tableSrc.overview?.table) ? tableSrc.overview.table : []);

    for (const t0 of tableRoot) {
      const td = t0?.data || t0 || {};
      const rows = td?.table?.all || td?.table?.All || (Array.isArray(td?.table) ? td.table : []);
      const mapped = mapTableRows(rows);
      const groupName = td.leagueName || td.groupName || t0?.leagueName || null;
      if (mapped.length) {
        groups.push({ name: groupName, standings: mapped });
        standings = standings.concat(mapped);
      }
    }
    // if single group, keep flat standings; if multi, prefer first or all
    if (groups.length === 1) standings = groups[0].standings;
  } catch (e) {
    console.error('[table parse]', e.message);
  }

  // fixtures
  let fixtures = [];
  try {
    fixtures = mapFixtures(data.fixtures?.allMatches || []);
  } catch (_) {}

  // scorers
  let scorers = mapScorers(data.stats?.players || []);
  const goalsBlock = (data.stats?.players || []).find(p => p.name === 'goals' || /top scorer/i.test(p.header || ''));
  if (goalsBlock?.fetchAllUrl) {
    const full = await fetchFullScorers(goalsBlock.fetchAllUrl);
    if (full.length) scorers = full;
  }

  // assists
  let assists = [];
  const ass = (data.stats?.players || []).find(p => p.name === 'goal_assist' || /assist/i.test(p.header || ''));
  if (ass) {
    assists = (ass.topThree || []).map((p, i) => ({
      id: p.id,
      rank: p.rank ?? i + 1,
      name: p.name,
      teamId: p.teamId,
      teamName: p.teamName,
      assists: p.value,
      photo: fotmobPhoto(p.id),
      teamLogo: p.teamId ? `https://images.fotmob.com/image_resources/logo/teamlogo/${p.teamId}_small.png` : null
    }));
  }

  // v4.0: assists كاملة + ترتيب فريق اللاعب
  try {
    if (ass && ass.fetchAllUrl) {
      const fa = await fetchFullScorers(ass.fetchAllUrl);
      if (fa.length) assists = fa.map(p => ({ ...p, assists: p.goals, goals: undefined }));
    }
    const amap = new Map(assists.map(a => [Number(a.id), a.assists]));
    const srow = new Map(standings.map(s => [Number(s.id), s]));
    const enrichP = p => { const t = srow.get(Number(p.teamId)); p.teamNameAr = p.teamName ? trAr(p.teamName) : null; if (t) { p.teamRank = t.rank; p.teamPlayed = t.played; } };
    scorers.forEach(p => { if (amap.has(Number(p.id))) p.assists = amap.get(Number(p.id)); enrichP(p); });
    assists.forEach(enrichP);
  } catch (e) { console.error('[scorers enrich]', e.message); }

  const meta = LEAGUES.find(l => l.id === id) || {};
  const result = {
    id,
    name: data.details.name || meta.name,
    nameAr: meta.nameAr || data.details.name,
    shortName: data.details.shortName || null,
    country: data.details.country || meta.country || null,
    season: data.details.selectedSeason || latest || null,
    standingsSeason: (standingsSource && standingsSource.details && standingsSource.details.selectedSeason) || standingsSeason || null,
    type: meta.type || 'league',
    logo: `https://images.fotmob.com/image_resources/logo/leaguelogo/${id}.png`,
    standings,
    groups: groups.length > 1 ? groups : undefined,
    scorers,
    assists,
    fixtures,
    counts: {
      teams: standings.length,
      scorers: scorers.length,
      fixtures: fixtures.length
    },
    updatedAt: new Date().toISOString()
  };

  leagueCache.set(id, { ts: Date.now(), data: result });
  return result;
}

// ========== PUSH NOTIFICATIONS ==========
const SUBS_FILE = path.join(DATA_DIR, 'push-subs.json');
const VAPID_FILE = path.join(DATA_DIR, 'vapid.json');
const SENT_FILE = path.join(DATA_DIR, 'push-sent.json');

let VAPID = { publicKey: process.env.VAPID_PUBLIC_KEY || null, privateKey: process.env.VAPID_PRIVATE_KEY || null, source: 'env' };
if (!VAPID.publicKey || !VAPID.privateKey) {
  try {
    const j = JSON.parse(fs.readFileSync(VAPID_FILE, 'utf8'));
    if (j.publicKey && j.privateKey) VAPID = { publicKey: j.publicKey, privateKey: j.privateKey, source: 'file' };
  } catch (_) {}
}
if (!VAPID.publicKey || !VAPID.privateKey) {
  const gen = webpush.generateVAPIDKeys();
  VAPID = { publicKey: gen.publicKey, privateKey: gen.privateKey, source: 'generated' };
  try { fs.writeFileSync(VAPID_FILE, JSON.stringify({ publicKey: gen.publicKey, privateKey: gen.privateKey })); } catch (_) {}
  console.log('\n[Push] ⚠ اتولّدت مفاتيح VAPID جديدة. عشان متضيعش بعد أي Redeploy على Railway ضيفهم في Variables:');
  console.log('VAPID_PUBLIC_KEY=' + gen.publicKey);
  console.log('VAPID_PRIVATE_KEY=' + gen.privateKey + '\n');
}
webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:push@sirtv-live.example.com', VAPID.publicKey, VAPID.privateKey);

/** endpoint → { subscription, teams:[{id,names[]}], matches:[key], prefs } */
const pushSubs = new Map();
const DEF_PREFS = { goals: 'all', remind: true, kickoff: true, final: true };

function indexSub(e) {
  e.prefs = { ...DEF_PREFS, ...(e.prefs || {}) };
  e._tid = new Set((e.teams || []).map(t => Number(t.id)).filter(Boolean));
  e._tn = new Set();
  for (const t of e.teams || []) for (const n of t.names || []) { const k = normAr(n); if (k) { e._tn.add(k); e._tn.add(stripAl(k)); } }
  e._mk = new Set((e.matches || []).map(String));
  e._lg = new Set((e.leagues || []).map(Number).filter(Boolean));
  return e;
}
function loadSubs() {
  try {
    if (!fs.existsSync(SUBS_FILE)) return;
    const arr = JSON.parse(fs.readFileSync(SUBS_FILE, 'utf8'));
    if (Array.isArray(arr)) {
      for (const e of arr) if (e && e.subscription && e.subscription.endpoint) pushSubs.set(e.subscription.endpoint, indexSub(e));
      console.log('[Push] Loaded', pushSubs.size, 'subscriptions');
    }
  } catch (e) { console.error('[Push] loadSubs', e.message); }
}
let saveT = null;
function saveSubs() {
  clearTimeout(saveT);
  saveT = setTimeout(() => {
    try {
      const arr = [...pushSubs.values()].map(({ _tid, _tn, _mk, _lg, ...rest }) => rest);
      fs.writeFileSync(SUBS_FILE, JSON.stringify(arr));
    } catch (e) { console.error('[Push] saveSubs', e.message); }
  }, 500);
}
loadSubs();

function cleanBody(b) {
  const teams = (Array.isArray(b.teams) ? b.teams : []).slice(0, 40).map(t => ({
    id: Number(t.id) || null,
    names: (Array.isArray(t.names) ? t.names : []).slice(0, 10).map(x => String(x).slice(0, 60))
  }));
  const matches = (Array.isArray(b.matches) ? b.matches : []).slice(0, 200).map(x => String(x).slice(0, 300));
  const leagues = (Array.isArray(b.leagues) ? b.leagues : []).slice(0, 30).map(Number).filter(Boolean);
  const p = b.prefs || {};
  const prefs = {
    goals: p.goals === 'mine' ? 'mine' : 'all',
    remind: p.remind !== false, kickoff: p.kickoff !== false, final: p.final !== false
  };
  return { teams, matches, leagues, prefs };
}
function upsertSub(body) {
  const { subscription } = body || {};
  if (!subscription || !subscription.endpoint || !subscription.keys) return null;
  const old = pushSubs.get(subscription.endpoint);
  const e = indexSub({ subscription, ...cleanBody(body), created: (old && old.created) || Date.now(), updated: Date.now() });
  pushSubs.set(subscription.endpoint, e);
  saveSubs();
  return e;
}

async function pushOne(entry, payload, ttl) {
  try {
    await webpush.sendNotification(entry.subscription, JSON.stringify(payload), { TTL: ttl || 120, urgency: 'high' });
    return { ok: true };
  } catch (e) {
    const code = e.statusCode || 0;
    console.error('[Push] send fail', code, (e.body || e.message || '').toString().slice(0, 120));
    if ([401, 403, 404, 410].includes(code)) { pushSubs.delete(entry.subscription.endpoint); saveSubs(); }
    return { ok: false, code, body: e.body || e.message };
  }
}
async function pushMany(list, payload, ttl) {
  let sent = 0;
  await pool(list, 8, async (e) => { const r = await pushOne(e, payload, ttl); if (r.ok) sent++; });
  return sent;
}

function followsMatch(e, m) {
  if (e._mk.has(String(m.key))) return true;
  if (m.league && m.league.id && e._lg.has(Number(m.league.id))) return true;
  if (m.homeId && e._tid.has(m.homeId)) return true;
  if (m.awayId && e._tid.has(m.awayId)) return true;
  for (const n of [m.home, m.away]) { const k = normAr(n); if (e._tn.has(k) || e._tn.has(stripAl(k))) return true; }
  return false;
}

const sentKeys = new Map();
try {
  if (fs.existsSync(SENT_FILE)) for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(SENT_FILE, 'utf8')))) sentKeys.set(k, v);
} catch (_) {}
let sentDirty = false;
function once(k) {
  if (sentKeys.has(k)) return false;
  sentKeys.set(k, Date.now()); sentDirty = true; return true;
}
setInterval(() => {
  const cut = Date.now() - 2 * 86400000;
  for (const [k, v] of sentKeys) if (v < cut) { sentKeys.delete(k); sentDirty = true; }
  if (sentDirty) { sentDirty = false; try { fs.writeFileSync(SENT_FILE, JSON.stringify(Object.fromEntries(sentKeys))); } catch (_) {} }
}, 60 * 1000);

const snap = new Map(); // key → { score, st }
const scoreOf = m => (m.homeScore != null && m.awayScore != null) ? [m.homeScore, m.awayScore] : null;
function seedSnapshot(matches) {
  for (const m of matches || []) snap.set(m.key, { score: scoreOf(m), st: m.statusType });
}
async function fire(type, m, extra) {
  const hs = m.homeScore ?? 0, as = m.awayScore ?? 0;
  let title, body, ttl = 120;
  if (type === 'goal') { title = `⚽ جوووول! ${extra.team || ''}`.trim(); body = `${m.home} ${hs} - ${as} ${m.away}${m.status ? ' • ' + m.status : ''}`; }
  else if (type === 'remind') { title = '⏰ المباراة بعد 15 دقيقة'; body = `${m.home} × ${m.away}${m.time ? ' — ' + m.time : ''}`; ttl = 600; }
  else if (type === 'kickoff') { title = '🔔 بدأت المباراة'; body = `${m.home} × ${m.away}`; ttl = 300; }
  else { title = '🏁 انتهت المباراة'; body = `${m.home} ${hs} - ${as} ${m.away}`; ttl = 3600; }
  const payload = {
    title, body, tag: `${type}-${m.key}${type === 'goal' ? '-' + hs + '-' + as : ''}`,
    icon: m.homeLogo || undefined,
    data: { type, key: m.key, link: m.link, home: m.home, away: m.away, url: '#m=' + encodeURIComponent(m.key) }
  };
  const targets = [...pushSubs.values()].filter(e => {
    const mine = followsMatch(e, m);
    if (type === 'goal') return e.prefs.goals === 'all' || mine;
    if (!mine) return false;
    return type === 'remind' ? e.prefs.remind : type === 'kickoff' ? e.prefs.kickoff : e.prefs.final;
  });
  try { io.emit('notify', { ...payload, matchKey: m.key, homeId: m.homeId, awayId: m.awayId }); } catch (_) {}
  const n = await pushMany(targets, payload, ttl);
  console.log(`[Push] ${type} ${m.home} x ${m.away} → ${n}/${targets.length}`);
}
function notifyTick(matches) {
  const now = Date.now();
  for (const m of matches || []) {
    const prev = snap.get(m.key);
    const score = scoreOf(m);
    snap.set(m.key, { score, st: m.statusType });

    if (m.statusType === 'upcoming' && m.startMs) {
      const dt = m.startMs - now;
      if (dt > 0 && dt <= 15 * 60000 + 30000 && once('rem:' + m.key)) fire('remind', m);
    }
    if (!prev) continue;
    if (prev.st === 'upcoming' && m.statusType === 'live' && once('ko:' + m.key)) fire('kickoff', m);
    if (prev.st !== 'finished' && m.statusType === 'finished' && once('ft:' + m.key)) fire('final', m);
    if (score && m.statusType !== 'upcoming') {
      const p = prev.score || [0, 0];
      if (score[0] + score[1] > p[0] + p[1] && once(`g:${m.key}:${score[0]}-${score[1]}`)) {
        fire('goal', m, { team: score[0] > p[0] ? m.home : m.away });
      }
    }
  }
}

// ========== v4.0: أخبار / ملخصات / ملخص تلقائي / لاعب ==========
const NEWS_TTL = 10 * 60 * 1000;
const gnews = q => `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=ar&gl=EG&ceid=EG:ar`;
let NEWS_FEEDS = [
  { id: 'gn-football', name: 'أخبار كرة القدم', url: gnews('كرة القدم when:2d') },
  { id: 'gn-egypt',    name: 'الكرة المصرية',    url: gnews('الدوري المصري when:2d') },
  { id: 'gn-world',    name: 'الكرة العالمية',   url: gnews('الدوري الإنجليزي OR الدوري الإسباني OR دوري أبطال أوروبا when:2d') },
  { id: 'bbc-sport',   name: 'BBC عربي رياضة',  url: 'https://feeds.bbci.co.uk/arabic/sports/rss.xml' }
];
try {
  const extra = JSON.parse(process.env.NEWS_FEEDS || '[]');   // [{id,name,url}]
  if (Array.isArray(extra)) NEWS_FEEDS = NEWS_FEEDS.concat(extra.filter(f => f && f.url));
} catch (_) {}
const HL_CHANNELS = String(process.env.HL_CHANNELS || '').split(',').map(s => s.trim()).filter(Boolean); // channel_id أو channel_id:اسم

const feedCache = new Map();   // url → { ts, items, ok, err }
const feedStatus = new Map();  // id → { ok, count, err, ts }
const ytCache = new Map();     // q → { ts, items }

function stripHtml(s) {
  return String(s || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
}
function hashStr(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); }

function xmlUnesc(s) {
  return String(s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'").replace(/&amp;/g, '&');
}
const xmlTag = (blk, tag) => { const m = blk.match(new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + tag + '>', 'i')); return m ? xmlUnesc(m[1]).trim() : ''; };
const xmlAttr = (blk, tag, attr) => { const m = blk.match(new RegExp('<' + tag + '\\s[^>]*?' + attr + '=["\']([^"\']+)["\']', 'i')); return m ? xmlUnesc(m[1]) : null; };
function parseRss(xml, feedName) {
  const out = [];
  const blocks = String(xml).match(/<(item|entry)[\s>][\s\S]*?<\/\1>/gi) || [];
  for (const blk of blocks) {
    let title = xmlTag(blk, 'title');
    let link = xmlTag(blk, 'link') || xmlAttr(blk, 'link', 'href') || '';
    if (!title || !link) continue;
    let source = xmlTag(blk, 'source') || feedName;
    const m = title.match(/^(.*\S)\s+-\s+([^-]{2,40})$/);
    if (m && /news\.google\./.test(link)) { title = m[1]; source = m[2]; }
    const ts = Date.parse(xmlTag(blk, 'pubDate') || xmlTag(blk, 'published') || xmlTag(blk, 'updated') || '') || null;
    const descRaw = xmlTag(blk, 'description') || xmlTag(blk, 'summary');
    let img = xmlAttr(blk, 'media:thumbnail', 'url') || xmlAttr(blk, 'media:content', 'url') || xmlAttr(blk, 'enclosure', 'url');
    if (!img) { const im = descRaw.match(/<img[^>]+src=["']([^"']+)/i); if (im) img = im[1]; }
    title = stripHtml(title);
    let summary = stripHtml(descRaw);
    if (summary.length < 25 || summary.startsWith(title.slice(0, 20))) summary = '';
    out.push({ id: hashStr(link), title, link, source: stripHtml(source), ts, img, summary: summary.slice(0, 240) });
  }
  return out;
}

async function fetchFeed(url, name) {
  const hit = feedCache.get(url);
  if (hit && Date.now() - hit.ts < NEWS_TTL) return hit;
  try {
    const r = await axios.get(url, { headers: { 'User-Agent': UA, Accept: 'application/rss+xml,application/xml,text/xml,*/*' }, timeout: 12000, responseType: 'text', validateStatus: s => s < 500 });
    if (r.status !== 200) throw new Error('HTTP ' + r.status);
    const items = parseRss(String(r.data), name);
    const rec = { ts: Date.now(), items, ok: true };
    feedCache.set(url, rec);
    return rec;
  } catch (e) {
    const rec = { ts: Date.now() - NEWS_TTL + 60 * 1000, items: (hit && hit.items) || [], ok: false, err: e.message }; // نعيد المحاولة بعد دقيقة
    feedCache.set(url, rec);
    return rec;
  }
}

function dedupeNews(list) {
  const seen = new Set(), out = [];
  for (const n of list.sort((a, b) => (b.ts || 0) - (a.ts || 0))) {
    const k = normAr(n.title).slice(0, 48);
    if (seen.has(k) || seen.has(n.id)) continue;
    seen.add(k); seen.add(n.id); out.push(n);
  }
  return out;
}

async function getGeneralNews() {
  const res = await Promise.all(NEWS_FEEDS.map(async f => {
    const r = await fetchFeed(f.url, f.name);
    feedStatus.set(f.id, { name: f.name, ok: r.ok, count: r.items.length, err: r.err || null, ts: r.ts });
    return r.items.map(i => ({ ...i, feed: f.id }));
  }));
  return dedupeNews(res.flat());
}
async function getTopicNews(q, name) {
  const r = await fetchFeed(gnews(`${q} كرة القدم when:7d`), name || q);
  return r.items.map(i => ({ ...i, topic: q }));
}

// ---- يوتيوب: بحث عن ملخصات ----
function ytWalk(o, out) {
  if (!o || typeof o !== 'object') return;
  if (o.videoRenderer && o.videoRenderer.videoId) {
    const v = o.videoRenderer;
    out.push({
      id: v.videoId,
      title: (v.title && (v.title.runs || []).map(r => r.text).join('')) || '',
      channel: (v.ownerText && v.ownerText.runs && v.ownerText.runs[0] && v.ownerText.runs[0].text) || '',
      dur: (v.lengthText && v.lengthText.simpleText) || '',
      ago: (v.publishedTimeText && v.publishedTimeText.simpleText) || '',
      views: (v.shortViewCountText && v.shortViewCountText.simpleText) || '',
      thumb: `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`
    });
    return;
  }
  for (const k in o) ytWalk(o[k], out);
}
async function ytSearch(q) {
  const hit = ytCache.get(q);
  if (hit && Date.now() - hit.ts < 20 * 60 * 1000) return hit.items;
  let items = [];
  try {
    const r = await axios.get('https://www.youtube.com/results', {
      params: { search_query: q, hl: 'ar', gl: 'EG', sp: 'EgIQAQ%253D%253D' },
      headers: { 'User-Agent': UA, 'Accept-Language': 'ar,en;q=0.8', Cookie: 'CONSENT=YES+1' },
      timeout: 12000, responseType: 'text', validateStatus: s => s < 500
    });
    const m = String(r.data).match(/var ytInitialData\s*=\s*(\{.*?\});<\/script>/s);
    if (m) { const out = []; ytWalk(JSON.parse(m[1]), out); items = out; }
  } catch (e) { console.error('[yt]', e.message); }
  ytCache.set(q, { ts: Date.now() - (items.length ? 0 : 15 * 60 * 1000), items });
  return items;
}
async function ytChannelFeed(spec) {
  const [cid, ...rest] = spec.split(':');
  const r = await fetchFeed(`https://www.youtube.com/feeds/videos.xml?channel_id=${cid}`, rest.join(':') || cid);
  return r.items.map(i => {
    const vid = (String(i.link).match(/[?&]v=([\w-]{6,})/) || [])[1];
    return vid ? { id: vid, title: i.title, channel: i.source, ago: '', dur: '', thumb: `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`, ts: i.ts } : null;
  }).filter(Boolean);
}
const HL_RX = /ملخص|أهداف|اهداف|highlights|goals/i;
async function getHighlights(q) {
  let vids = await ytSearch(q);
  vids = vids.filter(v => HL_RX.test(v.title));
  if (HL_CHANNELS.length && q) {
    const chs = (await Promise.all(HL_CHANNELS.map(ytChannelFeed))).flat();
    const qs = normAr(q).split(' ').filter(w => w.length > 2);
    const hit = chs.filter(v => { const t = normAr(v.title); return qs.filter(w => t.includes(w)).length >= Math.min(2, qs.length); });
    vids = hit.concat(vids);
  }
  const seen = new Set();
  return vids.filter(v => !seen.has(v.id) && seen.add(v.id)).slice(0, 8);
}

// ---- ملخص نصي تلقائي للمباراة (من بيانات FotMob) ----
function buildSummary(d, home, away) {
  if (!d || !d.info) return null;
  const hs = d.info.homeScore, as = d.info.awayScore;
  const h = home || trAr(d.info.home), a = away || trAr(d.info.away);
  const evs = d.events || [];
  const isGoal = e => /goal|هدف/i.test(e.type || '') && !/disallow|cancel|miss/i.test(e.type || '');
  const goals = evs.filter(isGoal);
  const reds = evs.filter(e => /red/i.test(e.type || ''));
  const fin = /full|ft|انتهت|finished/i.test(d.info.status || '') || (d.info.status && /ended/i.test(d.info.status));
  const lines = [];
  const hasScore = hs != null && as != null;
  if (hasScore) {
    if (fin) lines.push(hs === as ? `انتهت المباراة بالتعادل ${hs}-${as} بين ${h} و${a}.` : `انتهت المباراة بفوز ${hs > as ? h : a} على ${hs > as ? a : h} بنتيجة ${Math.max(hs, as)}-${Math.min(hs, as)}.`);
    else lines.push(`النتيجة الحالية: ${h} ${hs} - ${as} ${a}.`);
  }
  if (goals.length) {
    const g = goals.map(e => `${e.player || e.text || '؟'}${e.minute ? ` (${String(e.minute).replace(/'$/, '')}')` : ''}${/own/i.test(e.type) ? ' [عكسي]' : ''}${/pen/i.test(e.type + (e.detail || '')) ? ' [ركلة جزاء]' : ''}`);
    lines.push('الأهداف: ' + g.join('، ') + '.');
  }
  if (reds.length) lines.push('طرد: ' + reds.map(e => `${e.player || e.text || '؟'}${e.minute ? ` (${e.minute}')` : ''}`).join('، ') + '.');
  const poss = (d.stats || []).flatMap(g => g.stats || g.items || []).find(s => /possession|استحواذ/i.test(s.title || s.name || ''));
  if (poss && poss.home != null && poss.away != null) lines.push(`الاستحواذ: ${h} ${poss.home}% مقابل ${poss.away}% لـ${a}.`);
  const i = d.info;
  const where = [i.stadium, i.city].filter(Boolean).join(' - ');
  if (where) lines.push('الملعب: ' + where + (i.referee ? ` • الحكم: ${i.referee}` : '') + '.');
  if (i.competition) lines.push('البطولة: ' + i.competition + (i.round ? ` (${i.round})` : '') + '.');
  return lines.length ? lines : null;
}


// ---- v4.3: قارئ المقالات ----
const articleCache = new Map();
const privateHost = h => /^(localhost|0\.0\.0\.0|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1)/i.test(h) || !/\./.test(h);
async function resolveGoogleNews(url) {
  const m = url.match(/news\.google\.com\/(?:rss\/)?articles\/([^?/#]+)/i);
  if (!m) return url;
  const id = m[1];
  try { // الصيغة القديمة: base64 فيه الرابط
    const raw = Buffer.from(id.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('latin1');
    const u = raw.match(/https?:\/\/[\x21-\x7e]+/);
    if (u && !/news\.google/.test(u[0])) return u[0];
  } catch (_) {}
  try {
    const page = await axios.get(`https://news.google.com/rss/articles/${id}`, { headers: { 'User-Agent': UA, Cookie: 'CONSENT=YES+1' }, timeout: 12000, responseType: 'text', validateStatus: s => s < 500 });
    const html = String(page.data);
    const sg = (html.match(/data-n-a-sg="([^"]+)"/) || [])[1], ts = (html.match(/data-n-a-ts="([^"]+)"/) || [])[1];
    if (!sg || !ts) return url;
    const inner = `["garturlreq",[["X","X",["X","X"],null,null,1,1,"US:en",null,1,null,null,null,null,null,0,1],"X","X",1,[1,1,1],1,1,null,0,0,null,0],"${id}",${ts},"${sg}"]`;
    const body = 'f.req=' + encodeURIComponent(JSON.stringify([[['Fbv4je', inner, null, 'generic']]]));
    const r = await axios.post('https://news.google.com/_/DotsSplashUi/data/batchexecute', body, { headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8', 'User-Agent': UA }, timeout: 12000, responseType: 'text' });
    const t = String(r.data).split('\n\n')[1];
    const arr = JSON.parse(JSON.parse(t)[0][2]);
    if (arr && /^https?:/.test(arr[1])) return arr[1];
  } catch (e) { console.error('[gnews resolve]', e.message); }
  return url;
}
function metaOf(html, names) {
  for (const n of names) {
    const m = html.match(new RegExp('<meta[^>]+(?:property|name)=["\']' + n + '["\'][^>]*content=["\']([^"\']*)["\']', 'i')) || html.match(new RegExp('<meta[^>]+content=["\']([^"\']*)["\'][^>]*(?:property|name)=["\']' + n + '["\']', 'i'));
    if (m && m[1]) return xmlUnesc(m[1]).trim();
  }
  return '';
}
function extractArticle(html, url) {
  const title = metaOf(html, ['og:title', 'twitter:title']) || stripHtml((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '');
  const image = metaOf(html, ['og:image', 'twitter:image']);
  const site = metaOf(html, ['og:site_name']);
  const ts = Date.parse(metaOf(html, ['article:published_time', 'og:updated_time', 'pubdate']) || '') || null;
  let body = html.replace(/<(script|style|noscript|svg|form|nav|footer|aside|header)[\s\S]*?<\/\1>/gi, ' ');
  const art = body.match(/<article[\s\S]*?<\/article>/i);
  if (art) body = art[0];
  const paras = [], seen = new Set();
  const re = /<(p|h2|h3)[^>]*>([\s\S]*?)<\/\1>/gi;
  let m;
  while ((m = re.exec(body)) && paras.length < 60) {
    const x = stripHtml(xmlUnesc(m[2])).replace(/\s+/g, ' ').trim();
    const isH = m[1] !== 'p';
    if (isH ? (x.length < 4 || x.length > 120) : x.length < 45) continue;
    if (/^(اقرأ أيضا|اقرأ ايضا|شاهد أيضا|مواضيع ذات صلة|حقوق النشر|جميع الحقوق|تابعنا|اشترك|Copyright|Read more|Advertisement)/i.test(x)) continue;
    const k = x.slice(0, 60);
    if (seen.has(k)) continue;
    seen.add(k);
    paras.push({ t: isH ? 'h' : 'p', x: x.slice(0, 1200) });
  }
  while (paras.length && paras[paras.length - 1].t === 'h') paras.pop();
  const good = paras.filter(p => p.t === 'p').length >= 2;
  return { title: stripHtml(title), image: image && /^https?:/i.test(image) ? image : null, site, ts, paras: good ? paras : [] };
}
async function getArticle(url) {
  const hit = articleCache.get(url);
  if (hit && Date.now() - hit.ts < 30 * 60 * 1000) return hit.data;
  let real = await resolveGoogleNews(url);
  const host = new URL(real).hostname;
  if (privateHost(host)) throw new Error('bad host');
  const r = await axios.get(real, { headers: { 'User-Agent': UA, 'Accept-Language': 'ar,en;q=0.8', Accept: 'text/html,*/*' }, timeout: 14000, maxContentLength: 3e6, responseType: 'text', maxRedirects: 5, validateStatus: s => s < 500 });
  if (r.status >= 400) throw new Error('HTTP ' + r.status);
  const a = extractArticle(String(r.data), real);
  a.url = real; a.host = host.replace(/^www\./, '');
  articleCache.set(url, { ts: Date.now(), data: a });
  return a;
}

const extrasCache = new Map();
async function getExtras({ link, id, home, away, hAr, aAr }) {
  const ck = `${link || ''}|${id || ''}|${home || ''}|${away || ''}|${hAr || ''}|${aAr || ''}`;
  const hit = extrasCache.get(ck);
  if (hit && Date.now() - hit.ts < 5 * 60 * 1000) return hit.data;
  let d = null;
  try { d = await fetchMatchDetails(link, id, home, away); } catch (_) {}
  const finished = d && d.info && /full|ft|انتهت|ended|finished/i.test(d.info.status || '');
  const h = hAr || home || (d && d.info && trAr(d.info.home)), a = aAr || away || (d && d.info && trAr(d.info.away));
  const jobs = [
    (finished || (d && d.highlight)) && h && a ? getHighlights(`${h} ${a} ملخص`) : Promise.resolve([]),
    h && a ? getTopicNews(`${h} ${a}`, 'المباراة') : Promise.resolve([])
  ];
  const [vids, news] = await Promise.all(jobs);
  const data = {
    summary: buildSummary(d, h, a),
    officialHighlight: (d && d.highlight) || null,
    videos: vids,
    news: news.slice(0, 6),
    searchUrl: h && a ? `https://www.youtube.com/results?search_query=${encodeURIComponent(`${h} ${a} ملخص`)}` : null,
    finished: !!finished
  };
  extrasCache.set(ck, { ts: Date.now(), data });
  return data;
}

// ---- بيانات اللاعب (FotMob playerData) ----
const playerCache = new Map();
const INFO_AR = { height: 'الطول', shirt: 'رقم القميص', age: 'السن', preferred_foot: 'القدم المفضلة', country: 'الجنسية', transfer_value: 'القيمة السوقية', contract_end: 'نهاية العقد', position: 'المركز' };
const FOOT_AR = { right: 'اليمنى', left: 'اليسرى', both: 'الاتنين', Right: 'اليمنى', Left: 'اليسرى', Both: 'الاتنين' };
async function getPlayer(id) {
  id = Number(id);
  const hit = playerCache.get(id);
  if (hit && Date.now() - hit.ts < 30 * 60 * 1000) return hit.data;
  const d = await fotmobGet(`https://www.fotmob.com/api/data/playerData?id=${id}`);
  if (!d || !d.name) return null;
  const info = [];
  const val = v => { if (v == null) return null; if (typeof v !== 'object') return String(v); const x = v.fallback ?? v.numberValue ?? v.key ?? null; return x == null ? null : String(x); };
  for (const it of d.playerInformation || []) {
    const key = it.translationKey || (it.title && it.title.key) || '';
    let value = val(it.value);
    if (value == null) continue;
    if (key === 'preferred_foot') value = FOOT_AR[value] || value;
    if (key === 'country') value = trAr(value);
    const unit = it.value && it.value.numberValue != null && key === 'height' ? ' سم' : '';
    info.push({ key, label: INFO_AR[key] || (it.title && it.title.fallback) || (typeof it.title === 'string' ? it.title : key), value: value + unit });
  }
  const bd = d.birthDate && (d.birthDate.utcTime || d.birthDate);
  const stats = [];
  const ml = d.mainLeague || {};
  for (const s of ml.stats || []) {
    const v = s.value != null ? s.value : s.statValue;
    if (v == null || !(s.title || s.localizedTitleId)) continue;
    stats.push({ key: s.localizedTitleId || s.title, title: s.title || s.localizedTitleId, value: v });
  }
  const pos = d.positionDescription || {};
  const recent = (d.recentMatches || []).slice(0, 6).map(m => ({
    date: m.matchDate && (m.matchDate.utcTime || m.matchDate), opp: m.opponentTeamName || null,
    home: m.isHomeTeam, score: m.homeScore != null ? `${m.homeScore}-${m.awayScore}` : null,
    rating: m.ratingProps && m.ratingProps.num ? m.ratingProps.num : null,
    goals: m.goals || 0, assists: m.assists || 0, minutes: m.minutesPlayed || null
  }));
  const data = {
    id, name: d.name, photo: fotmobPhoto(id),
    teamId: d.primaryTeam && d.primaryTeam.teamId, team: d.primaryTeam && d.primaryTeam.teamName,
    teamAr: d.primaryTeam && d.primaryTeam.teamName ? trAr(d.primaryTeam.teamName) : null,
    teamLogo: d.primaryTeam && d.primaryTeam.teamId ? `https://images.fotmob.com/image_resources/logo/teamlogo/${d.primaryTeam.teamId}_small.png` : null,
    position: (pos.primaryPosition && pos.primaryPosition.label) || null,
    positions: (pos.positions || []).map(p => p.strPos && p.strPos.label || p.label).filter(Boolean),
    birth: bd || null, captain: !!d.isCaptain,
    info, league: ml.leagueName || null, season: ml.season || null, stats, recent
  };
  playerCache.set(id, { ts: Date.now(), data });
  return data;
}

// ========== v5.0: روابط البث اليدوية (لوحة تحكم + Firebase) ==========
const crypto = require('crypto');
const FIREBASE_URL = String(process.env.FIREBASE_DB_URL || 'https://english-73376-default-rtdb.firebaseio.com').replace(/\/+$/, '');
const FIREBASE_SECRET = process.env.FIREBASE_SECRET || '';           // اختياري: Database secret لو الـ rules مقفولة
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const STREAMS_FILE = path.join(DATA_DIR, 'manual-streams.json');
const fbAuth = FIREBASE_SECRET ? `?auth=${encodeURIComponent(FIREBASE_SECRET)}` : '';
const fbUrl = p => `${FIREBASE_URL}/${p}.json${fbAuth}`;

const manualStreams = new Map();   // safeKey → entry
const manualByTeams = new Map();   // "home|away" → safeKey
let fbState = { ok: null, err: null, ts: 0 };
const safeKey = k => Buffer.from(String(k || ''), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '').slice(0, 120);
const teamsKey = (h, a) => `${stripAl(normAr(h))}|${stripAl(normAr(a))}`;

function cleanEntry(b, old) {
  const urlOk = u => /^https?:\/\/[^\s]+$/i.test(u || '') && !privateHost(new URL(u).hostname);
  const sources = (Array.isArray(b.sources) ? b.sources : []).slice(0, 8)
    .map(s => ({ label: String((s && s.label) || '').slice(0, 20), url: String((s && s.url) || '').trim() }))
    .filter(s => { try { return urlOk(s.url); } catch (_) { return false; } });
  const embed = String(b.embed || '').trim();
  if (!sources.length && !/^https?:\/\//i.test(embed)) return null;
  const str = (x, n) => String(x || '').trim().slice(0, n);
  return {
    key: str(b.key, 300), home: str(b.home, 80), away: str(b.away, 80),
    sources, embed: /^https?:\/\//i.test(embed) ? embed.slice(0, 600) : '',
    referer: str(b.referer, 400), origin: str(b.origin, 200), ua: str(b.ua, 400), cookie: str(b.cookie, 2000).replace(/[\r\n]/g, ''), accept: str(b.accept, 300).replace(/[\r\n]/g, ''),
    mode: b.mode === 'direct' ? 'direct' : 'proxy', note: str(b.note, 200),
    created: (old && old.created) || Date.now(), updated: Date.now()
  };
}
function indexManual() {
  manualByTeams.clear();
  for (const [sk, e] of manualStreams) if (e.home && e.away) manualByTeams.set(teamsKey(e.home, e.away), sk);
}
function saveManualLocal() { try { fs.writeFileSync(STREAMS_FILE, JSON.stringify([...manualStreams.values()])); } catch (_) {} }
try {
  const arr = JSON.parse(fs.readFileSync(STREAMS_FILE, 'utf8'));
  for (const e of arr) if (e && e.key) manualStreams.set(safeKey(e.key), e);
  indexManual();
} catch (_) {}

async function loadManualFromFirebase() {
  try {
    const r = await axios.get(fbUrl('streams'), { timeout: 12000, validateStatus: s => s < 500 });
    if (r.status >= 400) throw new Error('HTTP ' + r.status + (r.status === 401 ? ' (الـ rules مقفولة — ضيف FIREBASE_SECRET)' : ''));
    const data = r.data && typeof r.data === 'object' ? r.data : {};
    manualStreams.clear();
    for (const [sk, e] of Object.entries(data)) if (e && e.key) manualStreams.set(sk, e);
    indexManual(); saveManualLocal();
    fbState = { ok: true, err: null, ts: Date.now() };
  } catch (e) { fbState = { ok: false, err: e.message, ts: Date.now() }; console.error('[Firebase load]', e.message); }
}
async function pushManualToFirebase(sk, entry) {
  const r = entry
    ? await axios.put(fbUrl('streams/' + sk), entry, { timeout: 12000, validateStatus: s => s < 500 })
    : await axios.delete(fbUrl('streams/' + sk), { timeout: 12000, validateStatus: s => s < 500 });
  if (r.status >= 400) throw new Error('Firebase HTTP ' + r.status + (r.status === 401 || r.status === 403 ? ' — الـ rules مقفولة، ضيف FIREBASE_SECRET في Railway أو افتح الكتابة' : ''));
}
function manualFor(key, link, home, away) {
  if (key && manualStreams.has(safeKey(key))) return manualStreams.get(safeKey(key));
  let m = null;
  if (link) m = cache.matches.find(x => x.link === link);
  else if (key) m = cache.matches.find(x => String(x.key) === String(key));
  if (m) {
    const e = manualStreams.get(safeKey(m.key)) || manualStreams.get(manualByTeams.get(teamsKey(m.home, m.away)));
    if (e) return e;
  }
  if (home && away) { const sk = manualByTeams.get(teamsKey(home, away)); if (sk) return manualStreams.get(sk); }
  return null;
}
const expiryOf = u => { try { const e = Number(new URL(u).searchParams.get('expires')); return e > 1e9 ? e * 1000 : null; } catch (_) { return null; } };

function adminAuth(req, res, next) {
  if (!ADMIN_PASSWORD) return res.status(503).json({ success: false, error: 'ADMIN_PASSWORD مش متحدد في متغيرات Railway' });
  const ip = req.ip || '';
  const f = adminFails.get(ip);
  if (f && f.n >= 10 && Date.now() - f.ts < 10 * 60 * 1000) return res.status(429).json({ success: false, error: 'محاولات كتير — استنى شوية' });
  const a = crypto.createHash('sha256').update(String(req.headers['x-admin-key'] || '')).digest();
  const b = crypto.createHash('sha256').update(ADMIN_PASSWORD).digest();
  if (!crypto.timingSafeEqual(a, b)) {
    adminFails.set(ip, { n: ((f && Date.now() - f.ts < 10 * 60 * 1000) ? f.n : 0) + 1, ts: Date.now() });
    return res.status(401).json({ success: false, error: 'كلمة السر غلط' });
  }
  adminFails.delete(ip);
  next();
}
const adminFails = new Map();
const pubEntry = (sk, e) => ({ id: sk, ...e, sources: (e.sources || []).map(s => ({ ...s, expiresAt: expiryOf(s.url) })) });

app.post('/api/admin/login', adminAuth, (req, res) => res.json({ success: true, firebase: fbState, firebaseUrl: FIREBASE_URL }));
app.get('/api/admin/matches', adminAuth, (req, res) => {
  const list = (cache.matches || []).map(m => {
    const e = manualFor(m.key, m.link, m.home, m.away);
    return { key: m.key, home: m.home, away: m.away, homeLogo: m.homeLogo, awayLogo: m.awayLogo, time: m.time, start: m.start, status: m.status, statusType: m.statusType, league: m.league && m.league.nameAr, hasSiteStream: !!m.hasStream, manual: e ? pubEntry(safeKey(e.key), e) : null };
  });
  const keys = new Set(list.filter(x => x.manual).map(x => x.manual.id));
  const orphans = [...manualStreams.entries()].filter(([sk]) => !keys.has(sk)).map(([sk, e]) => pubEntry(sk, e));
  res.json({ success: true, matches: list, orphans, firebase: fbState });
});
app.put('/api/admin/stream', adminAuth, async (req, res) => {
  const old = manualStreams.get(safeKey(req.body && req.body.key));
  const e = cleanEntry(req.body || {}, old);
  if (!e || !e.key) return res.status(400).json({ success: false, error: 'محتاج key + رابط بث (أو iframe) صالح' });
  const sk = safeKey(e.key);
  manualStreams.set(sk, e); indexManual(); saveManualLocal();
  streamCache.clear();
  try { await pushManualToFirebase(sk, e); res.json({ success: true, entry: pubEntry(sk, e), saved: 'firebase' }); }
  catch (err) { res.json({ success: true, entry: pubEntry(sk, e), saved: 'local', warning: err.message }); }
});
app.delete('/api/admin/stream', adminAuth, async (req, res) => {
  const sk = String(req.query.id || safeKey(req.query.key));
  manualStreams.delete(sk); indexManual(); saveManualLocal(); streamCache.clear();
  try { await pushManualToFirebase(sk, null); res.json({ success: true }); }
  catch (err) { res.json({ success: true, warning: err.message }); }
});
app.post('/api/admin/test', adminAuth, async (req, res) => {
  const b = req.body || {};
  const url = String(b.url || '');
  try {
    if (!/^https?:\/\//i.test(url) || privateHost(new URL(url).hostname)) throw new Error('رابط غير صالح');
    const hdr = streamHeaders({ referer: b.referer, origin: b.origin, ua: b.ua, cookie: b.cookie, accept: b.accept });
    const r = await axios.get(url, { headers: hdr, timeout: 15000, responseType: 'text', validateStatus: () => true, maxContentLength: 2e6 });
    const body = String(r.data || '');
    const isM3u8 = body.trim().startsWith('#EXTM3U');
    let seg = null;
    if (isM3u8) {
      const line = body.split(/\r?\n/).find(l => l && !l.startsWith('#'));
      if (line) {
        try {
          const sr = await axios.get(new URL(line, url).href, { headers: hdr, timeout: 15000, responseType: 'arraybuffer', validateStatus: () => true, maxContentLength: 3e6 });
          seg = { status: sr.status, bytes: (sr.data && sr.data.byteLength) || 0 };
        } catch (e) { seg = { error: e.message }; }
      }
    }
    res.json({ success: true, status: r.status, isM3u8, master: /#EXT-X-STREAM-INF/.test(body), segment: seg, expiresAt: expiryOf(url), snippet: body.slice(0, 300) });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// هيدرز الطلب للمصدر (نفس اللي المتصفح بيبعته)
// هيدرز ثابتة — نفس الطلب اللي المتصفح بيبعته للمصدر (قابلة للتغيير من متغيرات Railway)
const STREAM_DEFAULTS = {
  referer: process.env.STREAM_REFERER || 'https://2.shootsimo.net/',
  origin: process.env.STREAM_ORIGIN || 'https://2.shootsimo.net',
  ua: process.env.STREAM_UA || 'Mozilla/5.0 (Linux; Android 15; CPH2591 Build/AP3A.240617.008) AppleWebKit/537.36 (KHTML, like Gecko) Jrryilw/4.0 Chrome/155.0.8059.43 Mobile Safari/537.36',
  accept: process.env.STREAM_ACCEPT || 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9',
  cookie: process.env.STREAM_COOKIE || 'twk_idm_key=oTP2PN1sVaXKX64FXRcDv; TawkConnectionTime=0; twk_uuid_6a5199a020e17a1d43af9db4=%7B%22uuid%22%3A%221.1vXroIhhviNS0LXiqv0qN8nqMJ9WdftZvPq5nXlFzrhY2OC9M7aKn3D47MmK57GENy0huIqWXXJwnD3vmeAgxfuGPVINoWvxbuZ0GVvkPCGfbcGfOkEjfg2%22%2C%22version%22%3A3%2C%22domain%22%3A%22shootsimo.net%22%2C%22ts%22%3A1793134147168%7D'
};
function streamHeaders(e) {
  e = e || {};
  const ref = e.referer || (e.origin ? e.origin + '/' : STREAM_DEFAULTS.referer);
  let origin = e.origin;
  if (!origin) { try { origin = new URL(ref).origin; } catch (_) { origin = STREAM_DEFAULTS.origin; } }
  const h = {
    Origin: origin,
    Accept: e.accept || STREAM_DEFAULTS.accept,
    'Accept-Encoding': 'identity',
    'User-Agent': e.ua || STREAM_DEFAULTS.ua,
    Referer: ref,
    Connection: 'keep-alive'
  };
  const ck = e.cookie || STREAM_DEFAULTS.cookie;
  if (ck) h.Cookie = ck;
  return h;
}
setInterval(loadManualFromFirebase, 30 * 1000);
loadManualFromFirebase();

// ========== ROUTES ==========
app.get('/api/matches', (req, res) => res.json({ success: true, ...cache }));

// قائمة الدوريات والبطولات
app.get('/api/leagues', (req, res) => {
  res.json({
    success: true,
    leagues: LEAGUES.filter(l => !leagueBad.has(l.id)).map(l => ({
      id: l.id, name: l.name, nameAr: l.nameAr, country: l.country, type: l.type,
      logo: `https://images.fotmob.com/image_resources/logo/leaguelogo/${l.id}.png`
    }))
  });
});
// تفاصيل دوري: ترتيب + هدافين + مباريات
app.get('/api/league/:id', async (req, res) => {
  try {
    const data = await fetchLeagueDetails(req.params.id);
    res.json({ success: true, league: data });
  } catch (e) {
    console.error('[League]', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/api/league', async (req, res) => {
  const id = req.query.id;
  if (!id) return res.status(400).json({ success: false, error: 'id required' });
  try {
    const data = await fetchLeagueDetails(id);
    res.json({ success: true, league: data });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});


app.get('/api/match/details', async (req, res) => {
  const link = req.query.link ? decodeURIComponent(req.query.link) : null;
  const id = req.query.id || null;
  const home = req.query.home ? decodeURIComponent(req.query.home) : null;
  const away = req.query.away ? decodeURIComponent(req.query.away) : null;

  if (!link && !id && !(home && away)) {
    return res.status(400).json({ success: false, error: 'link, id, or home+away required' });
  }

  try {
    const details = await fetchMatchDetails(link, id, home, away);
    res.json({ success: true, details });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});


// ===== v3.9: ترتيب الفرق / متابعة الفرق / فحص الوقت =====
const teamBrief = t => ({
  id: t.id, name: t.name, nameAr: teamArName(t), logo: t.logo, aliases: teamAliasesAr(t),
  rank: t.domestic ? { rank: t.domestic.rank, pts: t.domestic.pts, played: t.domestic.played, gd: t.domestic.gd, leagueId: t.domestic.leagueId, league: t.domestic.leagueNameAr } : null
});

app.get('/api/ranks', async (req, res) => {
  if (!teamIndex.byId.size) { try { await buildTeamIndex(true); } catch (_) {} }
  const teams = {};
  for (const t of teamIndex.byId.values()) if (t.domestic) teams[t.id] = teamBrief(t);
  res.json({ success: true, count: Object.keys(teams).length, builtAt: teamIndex.builtAt, teams });
});

app.get('/api/teams/search', async (req, res) => {
  if (!teamIndex.byId.size) { try { await buildTeamIndex(true); } catch (_) {} }
  const q = String(req.query.q || '').trim();
  const k = normAr(q), k2 = stripAl(k), ke = normEn(q);
  if (k.length < 2) return res.json({ success: true, teams: [] });
  const scored = [];
  for (const t of teamIndex.byId.values()) {
    const names = [normEn(t.name), normEn(t.short), ...teamAliasesAr(t).map(normAr)].filter(Boolean);
    let sc = 0;
    for (const n of names) {
      for (const x of [k, k2, ke]) {
        if (!x) continue;
        if (n === x || stripAl(n) === x) sc = Math.max(sc, 3);
        else if (n.startsWith(x) || stripAl(n).startsWith(x)) sc = Math.max(sc, 2);
        else if (n.includes(x)) sc = Math.max(sc, 1);
      }
    }
    if (sc) scored.push({ sc, t });
  }
  scored.sort((a, b) => b.sc - a.sc || (a.t.domestic ? 0 : 1) - (b.t.domestic ? 0 : 1));
  res.json({ success: true, teams: scored.slice(0, 15).map(x => teamBrief(x.t)) });
});

app.get('/api/team/:id', async (req, res) => {
  if (!teamIndex.byId.size) { try { await buildTeamIndex(true); } catch (_) {} }
  const t = teamIndex.byId.get(Number(req.params.id));
  if (!t) return res.status(404).json({ success: false, error: 'team not found' });
  res.json({ success: true, team: teamSummary(t) });
});

// بيرجّع الوقت الخام من المصدر والوقت بعد التصحيح — عشان تتأكد من SRC_SHIFT_MIN
// ===== v4.0: routes =====
app.get('/api/news', async (req, res) => {
  try {
    const limit = Math.min(60, Number(req.query.limit) || 30);
    const topics = String(req.query.topics || req.query.team || req.query.league || '').split('|').map(s => s.trim()).filter(Boolean).slice(0, 6);
    let items;
    if (topics.length) items = dedupeNews((await Promise.all(topics.map(t => getTopicNews(t)))).flat());
    else items = await getGeneralNews();
    res.json({ success: true, count: items.length, items: items.slice(0, limit), updatedAt: new Date().toISOString() });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});
app.get('/api/article', async (req, res) => {
  const url = String(req.query.url || '');
  if (!/^https?:\/\//i.test(url) || url.length > 1500) return res.status(400).json({ success: false, error: 'bad url' });
  try { res.json({ success: true, article: await getArticle(url) }); }
  catch (e) { res.status(502).json({ success: false, error: e.message }); }
});
app.get('/api/news/status', (req, res) => {
  res.json({ success: true, feeds: NEWS_FEEDS.map(f => ({ id: f.id, url: f.url, ...(feedStatus.get(f.id) || { ok: null }) })), highlightsChannels: HL_CHANNELS });
});
app.get('/api/highlights', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim() || 'ملخص مباراة اليوم كرة القدم';
    res.json({ success: true, items: await getHighlights(q) });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});
app.get('/api/match/extras', async (req, res) => {
  const link = req.query.link ? decodeURIComponent(req.query.link) : null;
  const id = req.query.id || null;
  const home = req.query.home ? decodeURIComponent(req.query.home) : null;
  const away = req.query.away ? decodeURIComponent(req.query.away) : null;
  if (!link && !id && !(home && away)) return res.status(400).json({ success: false, error: 'link, id, or home+away required' });
  const hAr = req.query.hAr ? String(req.query.hAr).slice(0, 60) : null, aAr = req.query.aAr ? String(req.query.aAr).slice(0, 60) : null;
  try { res.json({ success: true, ...(await getExtras({ link, id, home, away, hAr, aAr })) }); }
  catch (e) { res.status(500).json({ success: false, error: e.message }); }
});
app.get('/api/player/:id', async (req, res) => {
  try {
    const p = await getPlayer(req.params.id);
    if (!p) return res.status(404).json({ success: false, error: 'not found' });
    res.json({ success: true, player: p });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/api/debug/stream', async (req, res) => {
  const link = req.query.link ? decodeURIComponent(req.query.link) : null;
  if (!link) return res.status(400).json({ error: 'link required' });
  const out = { link, steps: [] };
  const headers = { 'User-Agent': UA, 'Accept-Language': 'ar,en;q=0.9', Referer: 'https://sir-tv.vip/' };
  try {
    const p1 = await httpClient.get(link, { headers });
    const n1 = normHtml(p1.data);
    const player = extractPlayerUrl(p1.data, link);
    out.steps.push({ step: 'match page', status: p1.status, length: String(p1.data).length, iframes: (n1.match(/<iframe[^>]*>/gi) || []).slice(0, 5), playerUrl: player, snippet: String(p1.data).slice(0, 600) });
    if (player) {
      const p2 = await httpClient.get(player, { headers: { ...headers, Referer: link } });
      const streams = extractStreams(p2.data);
      out.steps.push({ step: 'player page', url: player, status: p2.status, length: String(p2.data).length, streams, finalPlayer: extractFinalPlayer(p2.data, player), snippet: String(p2.data).slice(0, 1500) });
    }
  } catch (e) { out.error = e.message; }
  res.json(out);
});

app.get('/embed', async (req, res) => {
  const url = String(req.query.url || '');
  if (!/^https?:\/\/[^/]*(sirtv\.top|sirftv\.com|sir-tv\.vip)\//i.test(url)) return res.status(400).send('bad url');
  try {
    const r = await httpClient.get(url, { headers: { 'User-Agent': UA, Referer: 'https://sir-tv.vip/' }, responseType: 'text', transformResponse: x => x });
    const origin = new URL(url).origin;
    let html = String(r.data).replace(/<head[^>]*>/i, m => `${m}<base href="${origin}/">`);
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (e) { res.status(502).send('embed failed: ' + e.message); }
});

app.get('/api/debug/time', (req, res) => {
  res.json({
    success: true, version: VERSION, tz: TZ, SRC_SHIFT_MIN, START_ADJUST_MIN,
    nowUtc: new Date().toISOString(), nowCairo: fmtClock12(Date.now()), sample: lastRaw
  });
});

// ===== Push =====
app.get('/api/push/vapid', (req, res) => {
  res.json({ success: true, publicKey: VAPID.publicKey, source: VAPID.source });
});

const subscribeHandler = (req, res) => {
  try {
    const e = upsertSub(req.body || {});
    if (!e) return res.status(400).json({ success: false, error: 'subscription required' });
    res.json({ success: true, subscribers: pushSubs.size, teams: e.teams.length, matches: e.matches.length, prefs: e.prefs });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};
app.post('/api/push/subscribe', subscribeHandler);
app.post('/api/push/sync', subscribeHandler);

app.post('/api/push/unsubscribe', (req, res) => {
  const { endpoint } = req.body || {};
  if (endpoint) { pushSubs.delete(endpoint); saveSubs(); }
  res.json({ success: true });
});

app.get('/api/push/status', (req, res) => {
  res.json({
    success: true, subscribers: pushSubs.size, vapidConfigured: !!VAPID.publicKey,
    vapidSource: VAPID.source, vapidStable: VAPID.source !== 'generated', publicKey: VAPID.publicKey
  });
});

// إشعار تجربة فورًا
app.post('/api/push/test', async (req, res) => {
  try {
    const { subscription } = req.body || {};
    const payload = {
      title: '⚽ كورة لايف', body: 'تم تفعيل الإشعارات بنجاح — هنبعتلك عند الجول',
      tag: 'test-koora', data: { test: true, url: '' }
    };
    if (subscription && subscription.endpoint) {
      await webpush.sendNotification(subscription, JSON.stringify(payload), { TTL: 60, urgency: 'high' });
      if (!pushSubs.has(subscription.endpoint)) upsertSub({ subscription });
      return res.json({ success: true, sent: 1, mode: 'direct' });
    }
    const sent = await pushMany([...pushSubs.values()], payload, 60);
    res.json({ success: true, sent, mode: 'broadcast', subscribers: pushSubs.size });
  } catch (e) {
    console.error('[Push test]', e.statusCode, e.body || e.message);
    res.status(500).json({ success: false, error: e.message, statusCode: e.statusCode || null, body: e.body || null });
  }
});

app.post('/api/refresh', async (req, res) => {
  try {
    const data = await fetchMatches();
    io.emit('matches', data);
    res.json({ success: true, ...data });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/api/stream', async (req, res) => {
  const link = req.query.link || (req.query.key ? 'key:' + req.query.key : '');
  if (!link) return res.status(400).json({ success: false, error: 'link or key required' });
  const ctx = {};
  const mlink = decodeURIComponent(link);
  const man = manualFor(req.query.key ? String(req.query.key) : null, mlink);
  if (man && man.sources && man.sources.length) {
    const host0 = publicBaseUrl(req), sk = safeKey(man.key);
    const qs = man.sources.map(s => ({ label: s.label || 'HD', url: man.mode === 'direct' ? s.url : `${host0}/proxy?url=${encodeURIComponent(s.url)}&k=${encodeURIComponent(sk)}` }));
    return res.json({ success: true, playUrl: qs[0].url, qualities: qs, quality: qs[0].label, type: 'hls', proxied: man.mode !== 'direct', manual: true, embedUrl: man.embed || null, resolvedAt: new Date().toISOString() });
  }
  if (man && man.embed) return res.json({ success: true, type: 'iframe', embedUrl: man.embed, manual: true });
  const idm = mlink.match(/[?&]m=(\d+)/);
  const fallbackEmbed = () => ctx.embed || null;
  try {
    const result = await resolveStream(mlink, ctx);
    const host = publicBaseUrl(req);
    const ref = encodeURIComponent(result.referer || '');
    const qualities = (result.qualities || []).map(q => ({
      label: q.label,
      url: `${host}/proxy?url=${encodeURIComponent(q.url)}&ref=${ref}`
    }));
    const playUrl = `${host}/proxy?url=${encodeURIComponent(result.streamUrl)}&ref=${ref}`;
    res.json({
      success: true, playUrl, qualities, quality: result.quality,
      type: 'hls', proxied: true, resolvedAt: result.resolvedAt, embedUrl: result.embed || fallbackEmbed()
    });
  } catch (e) {
    console.error('[Stream]', e.message);
    const emb = fallbackEmbed();
    if (emb) return res.json({ success: true, type: 'iframe', embedUrl: emb, fallback: true, reason: e.message });
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/proxy', async (req, res) => {
  const target = req.query.url;
  if (!target) return res.status(400).send('url required');
  // Express decodes query parameters automatically; don't decode target again,
  // otherwise escaped characters inside the source URL can be corrupted.
  await proxyHls(req, res, target, req.query.ref || null);
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok', version: '5.2', uptime: process.uptime(),
    lastUpdate: cache.lastUpdate, counts: cache.counts,
    caches: { details: detailsCache.size, streams: streamCache.size }
  });
});

app.get('/', (req, res) => {
  res.json({
    name: 'Sir TV Live Server', version: '5.2', status: 'running',
    features: ['news', 'highlights', 'match-extras', 'player', 'league-follow', 'matches', 'leagues', 'standings', 'scorers', 'fixtures', 'push-notifications', 'rich-details-fotmob', 'full-hls-proxy', 'team-follow', 'ranks', 'time-fix'],
    endpoints: {
      matches: 'GET /api/matches',
      leagues: 'GET /api/leagues',
      league: 'GET /api/league/:id',
      stream: 'GET /api/stream?link=  (type=hls أو iframe احتياطي)',
      details: 'GET /api/match/details?link=&id=&home=&away=',
      health: 'GET /health',
      ranks: 'GET /api/ranks',
      teamSearch: 'GET /api/teams/search?q=',
      team: 'GET /api/team/:id',
      news: 'GET /api/news?topics=a|b',
      newsStatus: 'GET /api/news/status',
      article: 'GET /api/article?url=',
      highlights: 'GET /api/highlights?q=',
      extras: 'GET /api/match/extras?home=&away=&link=',
      player: 'GET /api/player/:id',
      debugTime: 'GET /api/debug/time'
    }
  });
});

io.on('connection', (socket) => { socket.emit('matches', cache); });

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of detailsCache) if (now - v.ts > 10 * 60 * 1000) detailsCache.delete(k);
  for (const [k, v] of streamCache) if (now - v.ts > 5 * 60 * 1000) streamCache.delete(k);
  for (const [k, v] of leagueCache) if (now - v.ts > 30 * 60 * 1000) leagueCache.delete(k);
  for (const [k, v] of dayCache) if (now - v.ts > 10 * 60 * 1000) dayCache.delete(k);
}, 5 * 60 * 1000);

async function boot() {
  await fetchMatches();
  seedSnapshot(cache.matches);           // نزرع الحالة الحالية من غير ما نبعت إشعارات
  io.emit('matches', cache);
  buildTeamIndex(true).catch(e => console.error('[Index]', e.message));
  setInterval(async () => {
    const d = await fetchMatches();
    io.emit('matches', d);
    try { notifyTick(d.matches || []); } catch (e) { console.error('[notify]', e.message); }
  }, 20000);
  setInterval(() => buildTeamIndex().catch(() => {}), 5 * 60 * 1000);
}

boot().catch(console.error);

server.listen(PORT, () => {
  console.log(`\n🔥 Sir TV Live v${VERSION} — port ${PORT}`);
  console.log(`   TZ=${TZ} SRC_SHIFT_MIN=${SRC_SHIFT_MIN} | VAPID=${VAPID.source}`);
  console.log(`   Time fix | Ranks | Team follow | Rich details | Push\n`);
});
