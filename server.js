/**
 * Sir TV Live Server - All-in-one
 * Scraper + Stream Resolver + HLS Proxy
 * Node 18+
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

// ========== CORS (مفتوح بالكامل) ==========
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

// ========== CACHE ==========
let cache = {
  matches: [], live: [], finished: [], upcoming: [],
  counts: { total: 0, live: 0, finished: 0, upcoming: 0 },
  lastUpdate: null, error: null
};

// ========== SCRAPER ==========
async function fetchMatches() {
  try {
    const { data } = await axios.get(SOURCE, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
        'Accept-Language': 'ar,en;q=0.9',
        'Cache-Control': 'no-cache',
        'Referer': 'https://sir-tv.vip/'
      },
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
      const time = $el.find('.MT_Time span, .MT_Time').first().text().trim();
      const isLiveClass = $el.hasClass('live');
      const start = $el.attr('data-start') || null;

      let externalId = null;
      if (link) {
        const m = link.match(/[?&]m=(\d+)/);
        if (m) externalId = m[1];
      }

      let statusType = 'upcoming';
      const s = (statusText || '').toLowerCase();
      if (isLiveClass || s.includes('مباشر') || s.includes('live')) statusType = 'live';
      else if (s.includes('انتهت') || s.includes('انتهى') || s.includes('ft')) statusType = 'finished';

      const hasStream = !!(link && (link.includes('korat') || link.includes('hes-goals') || link.includes('m=')));

      if (home && away) {
        matches.push({
          id, externalId, home, away, homeLogo, awayLogo,
          score, status: statusText || (statusType === 'live' ? 'مباشر' : 'قريباً'),
          statusType, time, isLive: statusType === 'live', start, link, hasStream
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

    console.log(`[Scraper] ${matches.length} matches | Live: ${live.length}`);
    return cache;
  } catch (err) {
    console.error('[Scraper]', err.message);
    cache.error = err.message;
    cache.lastUpdate = new Date().toISOString();
    return cache;
  }
}

// ========== STREAM RESOLVER ==========
async function resolveStream(matchLink) {
  if (!matchLink) throw new Error('No link');

  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
    'Accept-Language': 'ar,en;q=0.9',
    'Referer': 'https://sir-tv.vip/'
  };

  // Step 1
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

  // Step 3
  const page3 = await axios.get(finalPlayer, { headers: { ...headers, Referer: playerUrl }, timeout: 16000 });
  let streams = [...new Set(page3.data.match(/https?:\/\/[a-z0-9.-]+\.live--koora\.com\/[^\s"'<>]+/gi) || [])];
  if (!streams.length) {
    streams = [...new Set(page3.data.match(/https?:\/\/[^"'\s]+(?:m3u8|\/kooora\/)[^"'\s]*/gi) || [])];
  }
  if (!streams.length) throw new Error('No stream found');

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
  return { streamUrl: chosen, qualities, quality: hd ? 'HD' : 'SD', type: 'hls', referer, resolvedAt: new Date().toISOString() };
}

// ========== HLS PROXY ==========
async function proxyHls(req, res, targetUrl, referer) {
  try {
    const response = await axios.get(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
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
    const isPlaylist = ct.includes('mpegurl') || ct.includes('m3u8') || targetUrl.includes('.m3u8') || targetUrl.includes('_sc') || targetUrl.includes('_hd');

    res.set({
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Cache-Control': 'no-cache'
    });

    if (isPlaylist) {
      let body = Buffer.from(response.data).toString('utf8');
      const base = new URL(targetUrl);
      const proxyBase = `${req.protocol}://${req.get('host')}/proxy?url=`;
      body = body.replace(/(https?:\/\/[^\s\n]+)/g, m => proxyBase + encodeURIComponent(m));
      body = body.replace(/^([a-zA-Z0-9_\-\.\/]+\.(ts|m4s|key|m3u8))/gm, m => proxyBase + encodeURIComponent(new URL(m, base).href));
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
    const qualities = (result.qualities || []).map(q => ({
      label: q.label,
      url: `${host}/proxy?url=${encodeURIComponent(q.url)}&ref=${encodeURIComponent(result.referer || '')}`
    }));
    const playUrl = `${host}/proxy?url=${encodeURIComponent(result.streamUrl)}&ref=${encodeURIComponent(result.referer || '')}`;
    res.json({ success: true, playUrl, qualities, quality: result.quality, type: result.type, resolvedAt: result.resolvedAt });
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
  res.json({ status: 'ok', uptime: process.uptime(), lastUpdate: cache.lastUpdate, counts: cache.counts });
});

app.get('/', (req, res) => {
  res.json({ name: 'Sir TV Live Server', version: '2.0', status: 'running', endpoints: ['/api/matches', '/api/stream?link=', '/health'] });
});

// ========== SOCKET + START ==========
io.on('connection', (socket) => {
  console.log('[Socket] connected', socket.id);
  socket.emit('matches', cache);
});

// أول سحب + كل 30 ثانية
fetchMatches().then(d => io.emit('matches', d));
setInterval(async () => {
  const d = await fetchMatches();
  io.emit('matches', d);
}, 30000);

server.listen(PORT, () => {
  console.log(`\n🔥 Sir TV Live v2.0 → http://localhost:${PORT}`);
  console.log(`   CORS: OPEN | Matches every 30s\n`);
});
