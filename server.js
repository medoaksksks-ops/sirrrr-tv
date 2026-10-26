/**
 * Sir TV Live Server v3.1 — Rich details + stable streams
 */
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');

const app = express();
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
  lastUpdate: null, error: null, version: '3.1'
};

const detailsCache = new Map();
const streamCache = new Map();
const DETAILS_TTL = 90 * 1000;
const STREAM_TTL = 45 * 1000;

// Arabic / common team name → SportScore slug token
const TEAM_SLUGS = {
  'برشلونة': 'fc-barcelona', 'barcelona': 'fc-barcelona', 'بارسا': 'fc-barcelona',
  'ريال مدريد': 'real-madrid', 'real madrid': 'real-madrid',
  'أتلتيكو مدريد': 'atletico-madrid', 'اتليتكو مدريد': 'atletico-madrid',
  'إشبيلية': 'sevilla', 'اشبيلية': 'sevilla', 'sevilla': 'sevilla',
  'أوساسونا': 'osasuna', 'اوسامونا': 'osasuna',
  'باريس سان جيرمان': 'paris-saint-germain', 'باريس': 'paris-saint-germain', 'psg': 'paris-saint-germain',
  'أولمبيك ليون': 'lyon', 'ليون': 'lyon',
  'غلطة سراي': 'galatasaray', 'جالطة سراي': 'galatasaray',
  'فنربخشة': 'fenerbahce', 'فنربخشه': 'fenerbahce',
  'الأهلي': 'al-ahly', 'الاهلي': 'al-ahly',
  'الغرافة': 'al-gharafa',
  'النصر': 'al-nassr', 'الوصل': 'al-wasl',
  'الاتحاد': 'al-ittihad', 'الهلال': 'al-hilal',
  'مانشستر سيتي': 'manchester-city', 'مانشستر يونايتد': 'manchester-united',
  'ليفربول': 'liverpool', 'آرسنال': 'arsenal', 'تشيلسي': 'chelsea',
  'يوفنتوس': 'juventus', 'ميلان': 'ac-milan', 'إنتر': 'inter',
  'بايرن ميونخ': 'bayern-munchen', 'دورتموند': 'borussia-dortmund'
};

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

function slugifyTeam(name) {
  if (!name) return '';
  const n = String(name).trim();
  if (TEAM_SLUGS[n]) return TEAM_SLUGS[n];
  const lower = n.toLowerCase();
  if (TEAM_SLUGS[lower]) return TEAM_SLUGS[lower];
  // fallback latin slug
  return lower
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

// ========== MATCHES ==========
async function fetchMatches() {
  try {
    const { data } = await get(SOURCE, { headers: { Referer: SOURCE, 'Cache-Control': 'no-cache' } });
    const $ = cheerio.load(data);
    const matches = [];

    $('.AY_Match').each((_, el) => {
      const $el = $(el);
      const id = ($el.attr('id') || '').replace(/^m-/, '') || null;
      let link = $el.find('a').attr('href') || null;
      if (link && !link.startsWith('http')) link = new URL(link, SOURCE).href;

      const home = $el.find('.TM1 .TM_Name').text().trim();
      const away = $el.find('.TM2 .TM_Name').text().trim();
      const homeLogo = $el.find('.TM1 img').attr('src') || null;
      const awayLogo = $el.find('.TM2 img').attr('src') || null;
      const score = $el.find('.MT_Result').text().replace(/\s+/g, ' ').trim() || 'vs';
      const statusText = $el.find('.MT_Stat').text().trim();
      const timeRaw = $el.find('.MT_Time span, .MT_Time').first().text().trim();
      const isLiveClass = $el.hasClass('live') || $el.hasClass('now');
      const start = $el.attr('data-start') || null;

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

      if (home && away) {
        matches.push({
          id, externalId, home, away, homeLogo, awayLogo, score,
          status: statusText || (statusType === 'live' ? 'مباشر' : statusType === 'finished' ? 'انتهت' : 'لم تبدأ'),
          statusType, time: to12Hour(timeRaw), timeRaw: timeRaw || null,
          isLive: statusType === 'live', start, link, hasStream
        });
      }
    });

    const order = { live: 0, upcoming: 1, finished: 2 };
    matches.sort((a, b) => (order[a.statusType] ?? 3) - (order[b.statusType] ?? 3));
    const live = matches.filter(m => m.statusType === 'live');
    const finished = matches.filter(m => m.statusType === 'finished');
    const upcoming = matches.filter(m => m.statusType === 'upcoming');

    cache = {
      matches, live, finished, upcoming,
      counts: { total: matches.length, live: live.length, finished: finished.length, upcoming: upcoming.length },
      lastUpdate: new Date().toISOString(), error: null, version: '3.1'
    };
    console.log(`[Scraper] total=${matches.length} live=${live.length}`);
    return cache;
  } catch (err) {
    console.error('[Scraper]', err.message);
    cache.error = err.message;
    cache.lastUpdate = new Date().toISOString();
    return cache;
  }
}

// ========== RICH DETAILS ==========
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

function mapPlayers(list) {
  if (!Array.isArray(list)) return [];
  return list.map(p => ({
    name: p.name || p.player || '',
    number: p.number ?? p.shirt ?? null,
    position: p.position || p.pos || null,
    rating: p.rating || null,
    captain: !!p.captain
  })).filter(p => p.name);
}

function mapIncidents(list) {
  if (!Array.isArray(list)) return [];
  return list.map(e => {
    const type = e.type || '';
    let text = e.player || '';
    if (e.is_sub || /sub/i.test(type)) {
      text = [e.player_in, e.player_out].filter(Boolean).join(' ← ') || text;
    }
    return {
      minute: e.time != null ? String(e.time) : (e.minute || null),
      type,
      player: e.player || e.player_in || '',
      team: e.side === 'home' ? 'home' : e.side === 'away' ? 'away' : (e.team || ''),
      detail: e.player_out ? `out: ${e.player_out}` : '',
      text: text || type
    };
  });
}

function mapStats(stats) {
  if (!Array.isArray(stats) || !stats.length) return [];
  return stats.map(s => ({
    label: s.label || s.name || s.title || '',
    home: s.home ?? s.h ?? s.team1 ?? null,
    away: s.away ?? s.a ?? s.team2 ?? null
  })).filter(s => s.label && s.home != null && s.away != null);
}

async function fetchSportScoreByTeams(home, away) {
  const h = slugifyTeam(home);
  const a = slugifyTeam(away);
  if (!h || !a) return null;

  const slugs = [
    `${h}-vs-${a}`,
    `${a}-vs-${h}`,
    // common variants
    h.startsWith('fc-') ? `${h}-vs-${a}` : `fc-${h}-vs-${a}`,
    a.startsWith('fc-') ? `${h}-vs-${a}` : `${h}-vs-fc-${a}`
  ];

  for (const slug of [...new Set(slugs)]) {
    try {
      const { data } = await get(
        `https://sportscore.com/api/widget/match/?sport=football&slug=${encodeURIComponent(slug)}`,
        { headers: { Accept: 'application/json' }, timeout: 10000 },
        1
      );
      if (data && data.match && !data.error) return data.match;
    } catch (_) {}
  }

  // fallback: scan recent matches list
  try {
    const { data } = await get(
      'https://sportscore.com/api/widget/matches/?sport=football&limit=50',
      { headers: { Accept: 'application/json' }, timeout: 10000 },
      0
    );
    const list = data.matches || [];
    const hn = (home || '').toLowerCase();
    const an = (away || '').toLowerCase();
    const engH = h.replace(/-/g, ' ');
    const engA = a.replace(/-/g, ' ');
    const hit = list.find(m => {
      const mh = (m.home || '').toLowerCase();
      const ma = (m.away || '').toLowerCase();
      return (
        (mh.includes(engH) && ma.includes(engA)) ||
        (mh.includes(engA) && ma.includes(engH)) ||
        (hn && mh.includes(hn.slice(0, 4))) // weak
      );
    });
    if (hit && hit.url) {
      const slug = String(hit.url).split('/').filter(Boolean).pop();
      // url is like /football/match/real-madrid-vs-fc-barcelona/6ypq3nhvo1w0md7/
      const parts = String(hit.url).split('/').filter(Boolean);
      const maybeSlug = parts[parts.length - 2] || parts[parts.length - 1];
      const { data: d2 } = await get(
        `https://sportscore.com/api/widget/match/?sport=football&slug=${encodeURIComponent(maybeSlug)}`,
        { headers: { Accept: 'application/json' }, timeout: 10000 },
        0
      );
      if (d2 && d2.match) return d2.match;
    }
  } catch (_) {}

  return null;
}

async function enrichFromSportScore(details, home, away) {
  const match = await fetchSportScoreByTeams(home, away);
  if (!match) return false;

  details.source = 'sportscore';
  if (match.incidents) details.events = mapIncidents(match.incidents);

  const lu = match.lineups || {};
  if (lu.home_xi) details.homeLineup = mapPlayers(lu.home_xi);
  if (lu.away_xi) details.awayLineup = mapPlayers(lu.away_xi);
  if (lu.home_subs) details.homeSubs = mapPlayers(lu.home_subs);
  if (lu.away_subs) details.awaySubs = mapPlayers(lu.away_subs);
  details.formations = {
    home: lu.home_formation || null,
    away: lu.away_formation || null,
    homeCoach: lu.home_coach || null,
    awayCoach: lu.away_coach || null,
    confirmed: !!lu.confirmed
  };

  details.stats = mapStats(match.stats);

  details.info = {
    competition: match.competition || null,
    homeScore: match.home_score,
    awayScore: match.away_score,
    htHome: match.home_ht_score,
    htAway: match.away_ht_score,
    status: match.status_text || match.status,
    time: match.time,
    home: match.home,
    away: match.away
  };

  return true;
}

async function trySirTvPage(url, details) {
  try {
    const { data } = await get(url, { headers: { Referer: SOURCE } }, 1);
    const $ = cheerio.load(data);
    const events = [];
    $('.event, .match-event, .goal, .card, .aspi-event, #aspi_evebody li').each((_, el) => {
      const t = $(el).text().replace(/\s+/g, ' ').trim();
      if (t && t.length < 140) events.push({ text: t, minute: null, type: '', player: '', team: '' });
    });
    if (events.length && !details.events.length) details.events = events;

    const homePlayers = [], awayPlayers = [];
    $('.aspi_lineup .home li, .lineup .home li, .home-lineup li').each((_, el) => {
      const t = $(el).text().replace(/\s+/g, ' ').trim();
      if (t) homePlayers.push({ name: t });
    });
    $('.aspi_lineup .away li, .lineup .away li, .away-lineup li').each((_, el) => {
      const t = $(el).text().replace(/\s+/g, ' ').trim();
      if (t) awayPlayers.push({ name: t });
    });
    if (homePlayers.length && !details.homeLineup.length) details.homeLineup = homePlayers;
    if (awayPlayers.length && !details.awayLineup.length) details.awayLineup = awayPlayers;
    if (!details.source) details.source = 'sir-tv';
  } catch (_) {}
}

async function fetchMatchDetails(matchLink, externalId, home, away) {
  // resolve home/away from cache if missing
  if ((!home || !away) && (matchLink || externalId)) {
    const m = cache.matches.find(x =>
      (externalId && (x.externalId === externalId || x.id === externalId)) ||
      (matchLink && x.link === matchLink)
    );
    if (m) { home = home || m.home; away = away || m.away; matchLink = matchLink || m.link; }
  }

  const key = String(externalId || matchLink || `${home}-${away}`);
  const hit = detailsCache.get(key);
  if (hit && Date.now() - hit.ts < DETAILS_TTL) return hit.data;

  const details = emptyDetails();

  // Primary: SportScore rich data
  if (home && away) {
    try { await enrichFromSportScore(details, home, away); } catch (e) {
      console.error('[SportScore]', e.message);
    }
  }

  // Secondary: sir-tv page
  if (matchLink && /sir-tv\.vip/i.test(matchLink)) {
    await trySirTvPage(matchLink, details);
  }

  details.updatedAt = new Date().toISOString();
  detailsCache.set(key, { ts: Date.now(), data: details });
  return details;
}

// ========== STREAM ==========
async function resolveStream(matchLink) {
  if (!matchLink) throw new Error('No link provided');
  const hit = streamCache.get(matchLink);
  if (hit && Date.now() - hit.ts < STREAM_TTL) return hit.data;

  const headers = { 'User-Agent': UA, 'Accept-Language': 'ar,en;q=0.9', Referer: 'https://sir-tv.vip/' };

  const page1 = await get(matchLink, { headers }, 1);
  let playerUrl = extractPlayerUrl(page1.data, matchLink);
  if (!playerUrl) {
    const mid = matchLink.match(/[?&]m=(\d+)/);
    if (mid) playerUrl = `https://n1.sirftv.com/hard/player.html?match=${mid[1]}`;
  }
  if (!playerUrl) throw new Error('Player page not found');

  const page2 = await get(playerUrl, { headers: { ...headers, Referer: matchLink } }, 1);
  let streams = extractStreams(page2.data);
  if (streams.length) {
    const result = buildResult(streams, playerUrl);
    streamCache.set(matchLink, { ts: Date.now(), data: result });
    return result;
  }

  let finalPlayer = extractFinalPlayer(page2.data, playerUrl);
  if (!finalPlayer) throw new Error('Final player not found');
  if (!finalPlayer.startsWith('http')) finalPlayer = new URL(finalPlayer, playerUrl).href;

  const page3 = await get(finalPlayer, { headers: { ...headers, Referer: playerUrl } }, 1);
  streams = extractStreams(page3.data);
  if (!streams.length) throw new Error('No stream URL found');

  const result = buildResult(streams, finalPlayer);
  streamCache.set(matchLink, { ts: Date.now(), data: result });
  return result;
}

function extractPlayerUrl(html, base) {
  const $ = cheerio.load(html);
  const iframe = $('iframe#player, iframe[src*="sirftv"], iframe[src*="playerv"], iframe[src*="player"], iframe').first().attr('src');
  if (iframe) return iframe.startsWith('http') ? iframe : new URL(iframe, base).href;
  const m = html.match(/https?:\/\/[^"'\s]+sirftv\.com[^"'\s]*/i);
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
    const response = await axios.get(targetUrl, {
      headers: {
        'User-Agent': UA,
        Accept: '*/*',
        Origin: 'https://912acsss8af382.sirtv.top',
        Referer: referer || 'https://912acsss8af382.sirtv.top/'
      },
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
      const host = `${req.protocol}://${req.get('host')}`;
      const proxyBase = `${host}/proxy?url=`;
      const refQ = referer ? `&ref=${encodeURIComponent(referer)}` : '';
      body = body.replace(/(https?:\/\/[^\s\n\r"']+)/g, m => proxyBase + encodeURIComponent(m) + refQ);
      body = body.replace(/^([a-zA-Z0-9_\-\.\/]+\.(ts|m4s|key|m3u8)[^\s]*)$/gm, m => {
        try { return proxyBase + encodeURIComponent(new URL(m, base).href) + refQ; } catch { return m; }
      });
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

// ========== ROUTES ==========
app.get('/api/matches', (req, res) => res.json({ success: true, ...cache }));

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
  const link = req.query.link;
  if (!link) return res.status(400).json({ success: false, error: 'link required' });
  try {
    const result = await resolveStream(decodeURIComponent(link));
    const host = `${req.protocol}://${req.get('host')}`;
    const ref = encodeURIComponent(result.referer || '');
    const qualities = (result.qualities || []).map(q => ({
      label: q.label,
      url: `${host}/proxy?url=${encodeURIComponent(q.url)}&ref=${ref}`
    }));
    const playUrl = `${host}/proxy?url=${encodeURIComponent(result.streamUrl)}&ref=${ref}`;
    res.json({
      success: true, playUrl, qualities, quality: result.quality,
      type: 'hls', proxied: true, resolvedAt: result.resolvedAt
    });
  } catch (e) {
    console.error('[Stream]', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/proxy', async (req, res) => {
  const target = req.query.url;
  if (!target) return res.status(400).send('url required');
  await proxyHls(req, res, decodeURIComponent(target), req.query.ref ? decodeURIComponent(req.query.ref) : null);
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok', version: '3.1', uptime: process.uptime(),
    lastUpdate: cache.lastUpdate, counts: cache.counts,
    caches: { details: detailsCache.size, streams: streamCache.size }
  });
});

app.get('/', (req, res) => {
  res.json({
    name: 'Sir TV Live Server', version: '3.1', status: 'running',
    features: ['matches', 'rich-details-sportscore', 'lineups', 'events', 'stats', 'full-hls-proxy'],
    endpoints: {
      matches: 'GET /api/matches',
      stream: 'GET /api/stream?link=',
      details: 'GET /api/match/details?link=&id=&home=&away=',
      health: 'GET /health'
    }
  });
});

io.on('connection', (socket) => { socket.emit('matches', cache); });

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of detailsCache) if (now - v.ts > 10 * 60 * 1000) detailsCache.delete(k);
  for (const [k, v] of streamCache) if (now - v.ts > 5 * 60 * 1000) streamCache.delete(k);
}, 5 * 60 * 1000);

async function boot() {
  await fetchMatches();
  io.emit('matches', cache);
  setInterval(async () => {
    const d = await fetchMatches();
    io.emit('matches', d);
  }, 30000);
}

boot().catch(console.error);

server.listen(PORT, () => {
  console.log(`\n🔥 Sir TV Live v3.1 — port ${PORT}`);
  console.log(`   Rich details (SportScore) | Lineups | Events | Full proxy\n`);
});
