/**
 * Sir TV Live Server v2.1 - All-in-one
 * Scraper + Match Details + Stream Resolver + Full HLS Proxy
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

app.use(cors({ origin: true }));
app.options('*', cors({ origin: true }));
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});
app.use(express.json());

const io = new Server(server, { cors: { origin: true } });

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';

let cache = {
  matches: [], live: [], finished: [], upcoming: [],
  counts: { total: 0, live: 0, finished: 0, upcoming: 0 },
  lastUpdate: null, error: null
};

// details cache (by match id / link)
const detailsCache = new Map();

function to12Hour(timeStr) {
  if (!timeStr) return '';
  // already has AM/PM or Arabic
  if (/ص|م|am|pm/i.test(timeStr)) return timeStr;
  const m = timeStr.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return timeStr;
  let h = parseInt(m[1], 10);
  const min = m[2];
  const period = h >= 12 ? 'م' : 'ص';
  if (h === 0) h = 12;
  else if (h > 12) h = h - 12;
  return `${h}:${min} ${period}`;
}

// ========== SCRAPER ==========
async function fetchMatches() {
  try {
    const { data } = await axios.get(SOURCE, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'ar,en;q=0.9', 'Referer': SOURCE },
      timeout: 18000
    });

    const $ = cheerio.load(data);
    const matches = [];

    $('.AY_Match').each((_, el) => {
      const $el = $(el);
      const id = ($el.attr('id') || '').replace('m-', '') || null;
      const link = $el.find('a').attr('href') || null;
      const home = $el.find('.TM1 .TM_Name').text().trim();
      const away = $el.find('.TM2 .TM_Name').text().trim();
      const homeLogo = $el.find('.TM1 img').attr('src') || null;
      const awayLogo = $el.find('.TM2 img').attr('src') || null;
      const score = $el.find('.MT_Result').text().replace(/\s+/g, ' ').trim() || 'vs';
      const statusText = $el.find('.MT_Stat').text().trim();
      const timeRaw = $el.find('.MT_Time span, .MT_Time').first().text().trim();
      const isLiveClass = $el.hasClass('live');
      const start = $el.attr('data-start') || null;

      let externalId = null;
      if (link) {
        const mm = link.match(/[?&]m=(\d+)/);
        if (mm) externalId = mm[1];
      }

      let statusType = 'upcoming';
      const s = (statusText || '').toLowerCase();
      if (isLiveClass || s.includes('مباشر') || s.includes('live')) statusType = 'live';
      else if (s.includes('انتهت') || s.includes('انتهى') || s.includes('ft')) statusType = 'finished';

      const hasStream = !!(link && (link.includes('korat') || link.includes('hes-goals') || /[?&]m=\d+/.test(link)));

      if (home && away) {
        matches.push({
          id, externalId, home, away, homeLogo, awayLogo,
          score,
          status: statusText || (statusType === 'live' ? 'مباشر' : 'قريباً'),
          statusType,
          time: to12Hour(timeRaw),
          timeRaw,
          isLive: statusType === 'live',
          start, link, hasStream
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
      lastUpdate: new Date().toISOString(),
      error: null
    };

    console.log(`[Scraper] ${matches.length} | Live: ${live.length}`);
    return cache;
  } catch (err) {
    console.error('[Scraper]', err.message);
    cache.error = err.message;
    cache.lastUpdate = new Date().toISOString();
    return cache;
  }
}

// ========== MATCH DETAILS (lineup / events if available) ==========
async function fetchMatchDetails(matchLink, externalId) {
  const key = externalId || matchLink;
  if (detailsCache.has(key)) {
    const cached = detailsCache.get(key);
    if (Date.now() - cached.ts < 60000) return cached.data;
  }

  const details = { events: [], homeLineup: [], awayLineup: [], stats: null, source: null };

  try {
    // Try koora-l.live style APIs if we have external id
    if (externalId) {
      try {
        const [gameRes, statsRes] = await Promise.allSettled([
          axios.get(`https://www.koora-l.live/game/${externalId}`, {
            headers: { 'User-Agent': UA, 'Accept': 'application/json' }, timeout: 8000
          }),
          axios.get(`https://www.koora-l.live/stats/${externalId}`, {
            headers: { 'User-Agent': UA, 'Accept': 'application/json' }, timeout: 8000
          })
        ]);

        if (gameRes.status === 'fulfilled' && gameRes.value.data) {
          const g = gameRes.value.data;
          details.source = 'koora-l';
          if (g.events) details.events = g.events;
          if (g.home_lineup || g.lineup?.home) details.homeLineup = g.home_lineup || g.lineup.home || [];
          if (g.away_lineup || g.lineup?.away) details.awayLineup = g.away_lineup || g.lineup.away || [];
        }
        if (statsRes.status === 'fulfilled' && statsRes.value.data) {
          details.stats = statsRes.value.data;
        }
      } catch (_) {}
    }

    // Fallback: scrape match page on sir-tv
    if (matchLink && matchLink.includes('sir-tv.vip')) {
      try {
        const { data } = await axios.get(matchLink, {
          headers: { 'User-Agent': UA, 'Referer': SOURCE }, timeout: 10000
        });
        const $ = cheerio.load(data);
        // collect any visible events / lineup blocks
        $('.event, .match-event, .goal, .card').each((_, el) => {
          const t = $(el).text().replace(/\s+/g, ' ').trim();
          if (t) details.events.push({ text: t });
        });
        if (!details.source) details.source = 'sir-tv-page';
      } catch (_) {}
    }
  } catch (err) {
    console.error('[Details]', err.message);
  }

  detailsCache.set(key, { ts: Date.now(), data: details });
  return details;
}

// ========== STREAM RESOLVER (full extract, no iframe to client) ==========
async function resolveStream(matchLink) {
  if (!matchLink) throw new Error('No link');

  const headers = {
    'User-Agent': UA,
    'Accept-Language': 'ar,en;q=0.9',
    'Referer': 'https://sir-tv.vip/'
  };

  // Step 1: open korat / match link
  const page1 = await axios.get(matchLink, { headers, timeout: 14000, maxRedirects: 5 });
  let playerUrl = null;
  const $1 = cheerio.load(page1.data);
  const iframe1 = $1('iframe#player, iframe[src*="sirftv"], iframe[src*="playerv"], iframe').first().attr('src');
  if (iframe1) playerUrl = iframe1.startsWith('http') ? iframe1 : new URL(iframe1, matchLink).href;
  if (!playerUrl) {
    const m = page1.data.match(/https?:\/\/[^"'\s]+sirftv\.com[^"'\s]+/i);
    if (m) playerUrl = m[0];
  }
  if (!playerUrl) {
    const mid = matchLink.match(/[?&]m=(\d+)/);
    if (mid) playerUrl = `https://n1.sirftv.com/hard/player.html?match=${mid[1]}`;
  }
  if (!playerUrl) throw new Error('Player page not found');

  // Step 2
  const page2 = await axios.get(playerUrl, { headers: { ...headers, Referer: matchLink }, timeout: 14000 });
  let finalPlayer = cheerio.load(page2.data)('iframe').first().attr('src');
  if (!finalPlayer) {
    const m = page2.data.match(/https?:\/\/[^"'\s]+playerv5\.php[^"'\s]+/i);
    if (m) finalPlayer = m[0];
  }
  if (!finalPlayer) {
    const sm = page2.data.match(/https?:\/\/[^"'\s]+live--koora\.com[^"'\s]+/i);
    if (sm) return buildResult([sm[0]], playerUrl);
    throw new Error('Final player not found');
  }
  if (!finalPlayer.startsWith('http')) finalPlayer = new URL(finalPlayer, playerUrl).href;

  // Step 3: extract real stream URLs (NOT iframe)
  const page3 = await axios.get(finalPlayer, { headers: { ...headers, Referer: playerUrl }, timeout: 16000 });
  let streams = [...new Set(page3.data.match(/https?:\/\/[a-z0-9.-]+\.live--koora\.com\/[^\s"'<>]+/gi) || [])];
  if (!streams.length) {
    streams = [...new Set(page3.data.match(/https?:\/\/[^"'\s]+(?:m3u8|\/kooora\/)[^"'\s]*/gi) || [])];
  }
  if (!streams.length) throw new Error('No stream URL found');

  return buildResult(streams, finalPlayer);
}

function buildResult(streams, referer) {
  const hd = streams.find(s => /_hd|hd|1080|720/i.test(s));
  const sd = streams.find(s => !/_hd|hd|1080|720/i.test(s)) || streams[0];
  const chosen = hd || sd;
  const qualities = [];
  if (hd) qualities.push({ label: 'HD', url: hd });
  if (sd && sd !== hd) qualities.push({ label: 'SD', url: sd });
  streams.forEach(s => { if (s !== hd && s !== sd) qualities.push({ label: 'ALT', url: s }); });
  return {
    streamUrl: chosen,
    qualities,
    quality: hd ? 'HD' : 'SD',
    type: 'hls',
    referer,
    resolvedAt: new Date().toISOString()
  };
}

// ========== FULL HLS PROXY (traffic through our server) ==========
async function proxyHls(req, res, targetUrl, referer) {
  try {
    const response = await axios.get(targetUrl, {
      headers: {
        'User-Agent': UA,
        'Accept': '*/*',
        'Origin': 'https://912acsss8af382.sirtv.top',
        'Referer': referer || 'https://912acsss8af382.sirtv.top/'
      },
      responseType: 'arraybuffer',
      timeout: 20000,
      maxRedirects: 5,
      validateStatus: () => true
    });

    if (response.status >= 400) return res.status(response.status).send('Upstream error');

    const ct = response.headers['content-type'] || '';
    const isPlaylist = ct.includes('mpegurl') || ct.includes('m3u8') ||
      targetUrl.includes('.m3u8') || targetUrl.includes('_sc') || targetUrl.includes('_hd');

    res.set({
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Cache-Control': 'no-cache'
    });

    if (isPlaylist) {
      let body = Buffer.from(response.data).toString('utf8');
      const base = new URL(targetUrl);
      const proxyBase = `${req.protocol}://${req.get('host')}/proxy?url=`;
      // rewrite every segment/key to go through US
      body = body.replace(/(https?:\/\/[^\s\n]+)/g, m => proxyBase + encodeURIComponent(m));
      body = body.replace(/^([a-zA-Z0-9_\-\.\/]+\.(ts|m4s|key|m3u8))/gm, m =>
        proxyBase + encodeURIComponent(new URL(m, base).href)
      );
      res.set('Content-Type', 'application/vnd.apple.mpegurl');
      return res.send(body);
    }

    res.set('Content-Type', ct || 'application/octet-stream');
    return res.send(Buffer.from(response.data));
  } catch (err) {
    console.error('[Proxy]', err.message);
    res.status(502).json({ error: 'Proxy failed', message: err.message });
  }
}

// ========== ROUTES ==========
app.get('/api/matches', (req, res) => res.json({ success: true, ...cache }));

app.get('/api/match/details', async (req, res) => {
  const { link, id } = req.query;
  if (!link && !id) return res.status(400).json({ success: false, error: 'link or id required' });
  try {
    const details = await fetchMatchDetails(link ? decodeURIComponent(link) : null, id || null);
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
  const { link } = req.query;
  if (!link) return res.status(400).json({ success: false, error: 'link required' });
  try {
    const result = await resolveStream(decodeURIComponent(link));
    const host = `${req.protocol}://${req.get('host')}`;
    // ALL playback URLs go through OUR proxy
    const qualities = (result.qualities || []).map(q => ({
      label: q.label,
      url: `${host}/proxy?url=${encodeURIComponent(q.url)}&ref=${encodeURIComponent(result.referer || '')}`
    }));
    const playUrl = `${host}/proxy?url=${encodeURIComponent(result.streamUrl)}&ref=${encodeURIComponent(result.referer || '')}`;
    res.json({
      success: true,
      playUrl,
      qualities,
      quality: result.quality,
      type: 'hls',
      proxied: true,
      resolvedAt: result.resolvedAt
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/proxy', async (req, res) => {
  const target = req.query.url;
  if (!target) return res.status(400).send('url required');
  await proxyHls(req, res, decodeURIComponent(target), req.query.ref ? decodeURIComponent(req.query.ref) : null);
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), lastUpdate: cache.lastUpdate, counts: cache.counts, version: '2.1' });
});

app.get('/', (req, res) => {
  res.json({
    name: 'Sir TV Live Server',
    version: '2.1',
    status: 'running',
    features: ['matches', 'details', 'full-hls-proxy', 'no-iframe'],
    endpoints: ['/api/matches', '/api/stream?link=', '/api/match/details?link=', '/health']
  });
});

io.on('connection', (socket) => {
  console.log('[Socket] connected', socket.id);
  socket.emit('matches', cache);
});

fetchMatches().then(d => io.emit('matches', d));
setInterval(async () => {
  const d = await fetchMatches();
  io.emit('matches', d);
}, 30000);

server.listen(PORT, () => {
  console.log(`\n🔥 Sir TV Live v2.1 → port ${PORT}`);
  console.log(`   Full HLS Proxy | 12h time | Match details\n`);
});
        
