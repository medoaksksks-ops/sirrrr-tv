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
  lastUpdate: null, error: null, version: '3.2'
};

const detailsCache = new Map();
const streamCache = new Map();
const DETAILS_TTL = 90 * 1000;
const STREAM_TTL = 45 * 1000;


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

// Arabic / common names → English for FotMob matching
const TEAM_EN = {
  'برشلونة': 'Barcelona', 'barcelona': 'Barcelona', 'بارسا': 'Barcelona',
  'ريال مدريد': 'Real Madrid', 'real madrid': 'Real Madrid',
  'أتلتيكو مدريد': 'Atletico Madrid', 'اتليتكو مدريد': 'Atletico Madrid',
  'إشبيلية': 'Sevilla', 'اشبيلية': 'Sevilla',
  'أوساسونا': 'Osasuna',
  'باريس سان جيرمان': 'Paris Saint-Germain', 'باريس': 'Paris Saint-Germain', 'psg': 'Paris Saint-Germain',
  'أولمبيك ليون': 'Lyon', 'ليون': 'Lyon',
  'غلطة سراي': 'Galatasaray', 'جالطة سراي': 'Galatasaray',
  'فنربخشة': 'Fenerbahce',
  'الأهلي': 'Al Ahly', 'الاهلي': 'Al Ahly',
  'الغرافة': 'Al Gharafa',
  'النصر': 'Al Nassr', 'الوصل': 'Al Wasl',
  'الاتحاد': 'Al Ittihad', 'الهلال': 'Al Hilal',
  'مانشستر سيتي': 'Manchester City', 'مانشستر يونايتد': 'Manchester United',
  'ليفربول': 'Liverpool', 'آرسنال': 'Arsenal', 'تشيلسي': 'Chelsea',
  'يوفنتوس': 'Juventus', 'ميلان': 'AC Milan', 'إنتر': 'Inter',
  'بايرن ميونخ': 'Bayern München', 'دورتموند': 'Borussia Dortmund',
  'نيفتشي فرغانة': 'Neftchi', 'الاتحاد': 'Al Ittihad'
};

function teamEn(name) {
  if (!name) return '';
  const n = String(name).trim();
  if (TEAM_EN[n]) return TEAM_EN[n];
  if (TEAM_EN[n.toLowerCase()]) return TEAM_EN[n.toLowerCase()];
  return n;
}

function normName(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9\u0600-\u06ff]+/g, ' ').trim();
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

function posFromId(positionId) {
  // FotMob rough groups
  const id = Number(positionId);
  if (id === 0 || id === 11) return 'G';
  if (id >= 1 && id <= 4) return 'D';
  if (id >= 5 && id <= 8) return 'M';
  if (id >= 9 && id <= 10) return 'F';
  return null;
}

function mapFotmobPlayers(list) {
  if (!Array.isArray(list)) return [];
  return list.map(p => ({
    id: p.id,
    name: p.name || `${p.firstName || ''} ${p.lastName || ''}`.trim(),
    number: p.shirtNumber != null ? String(p.shirtNumber) : null,
    position: posFromId(p.positionId) || p.positionLabel || null,
    rating: (p.performance && p.performance.rating) || p.rating || null,
    captain: !!p.captain,
    photo: fotmobPhoto(p.id)
  })).filter(p => p.name);
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

function mapFotmobEvents(headerEvents) {
  // header.events is nested by team goals etc. Prefer content.matchFacts.events if available
  return [];
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

function dateCandidates(startIso) {
  const dates = [];
  const push = (d) => {
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    dates.push(`${y}${m}${day}`);
  };
  if (startIso) {
    const d = new Date(startIso);
    if (!isNaN(d)) {
      push(d);
      const prev = new Date(d); prev.setUTCDate(prev.getUTCDate() - 1); push(prev);
      const next = new Date(d); next.setUTCDate(next.getUTCDate() + 1); push(next);
    }
  }
  const now = new Date();
  push(now);
  const yday = new Date(now); yday.setUTCDate(yday.getUTCDate() - 1); push(yday);
  return [...new Set(dates)];
}

async function findFotmobMatchId(home, away, startIso) {
  const hEn = teamEn(home);
  const aEn = teamEn(away);
  for (const date of dateCandidates(startIso)) {
    try {
      const data = await fotmobGet(`https://www.fotmob.com/api/data/matches?date=${date}`);
      for (const lg of data.leagues || []) {
        for (const m of lg.matches || []) {
          const hn = m.home?.name || m.home?.longName || '';
          const an = m.away?.name || m.away?.longName || '';
          if (
            (namesMatch(hn, hEn) && namesMatch(an, aEn)) ||
            (namesMatch(hn, aEn) && namesMatch(an, hEn)) ||
            (namesMatch(hn, home) && namesMatch(an, away))
          ) {
            return m.id;
          }
        }
      }
    } catch (e) {
      console.error('[FotMob matches]', date, e.message);
    }
  }
  return null;
}

async function enrichFromFotmob(details, home, away, startIso) {
  const matchId = await findFotmobMatchId(home, away, startIso);
  if (!matchId) return false;

  const data = await fotmobGet(`https://www.fotmob.com/api/data/matchDetails?matchId=${matchId}`);
  if (!data || !data.content) return false;

  details.source = 'fotmob';
  details.fotmobId = matchId;

  const content = data.content;
  const infoBox = content.matchFacts?.infoBox || {};
  const stadium = infoBox.Stadium || {};
  const referee = infoBox.Referee || {};
  const tournament = infoBox.Tournament || {};

  details.info = {
    competition: tournament.leagueName || data.general?.leagueName || null,
    round: tournament.roundName || tournament.round || null,
    stadium: stadium.name || null,
    city: stadium.city || null,
    country: stadium.country || null,
    capacity: stadium.capacity || null,
    attendance: infoBox.Attendance || null,
    referee: referee.text || referee.name || null,
    refereeCountry: referee.country || null,
    date: infoBox['Match Date']?.utcTime || data.general?.matchTimeUTC || null,
    home: data.header?.teams?.[0]?.name || home,
    away: data.header?.teams?.[1]?.name || away,
    homeScore: data.header?.teams?.[0]?.score,
    awayScore: data.header?.teams?.[1]?.score,
    status: data.header?.status?.reason?.long || (data.general?.finished ? 'Full-Time' : null)
  };

  // lineups + coaches
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
    confirmed: true
  };

  // stats
  details.stats = mapFotmobStats(content.stats?.Periods);

  // events from matchFacts
  const ev = content.matchFacts?.events || {};
  const events = [];
  // FotMob structure varies; also pull from header.events goals
  const headerEv = data.header?.events || {};
  for (const side of ['homeTeamGoals', 'awayTeamGoals']) {
    const bag = headerEv[side] || {};
    for (const [playerName, arr] of Object.entries(bag)) {
      for (const g of arr || []) {
        events.push({
          minute: g.time != null ? String(g.time) : null,
          type: g.type || 'Goal',
          player: g.player?.name || playerName,
          team: side.startsWith('home') ? 'home' : 'away',
          detail: g.assistStr || '',
          text: g.player?.name || playerName
        });
      }
    }
  }
  // cards if present
  for (const side of ['homeTeamRedCards', 'awayTeamRedCards']) {
    const bag = headerEv[side] || {};
    for (const [playerName, arr] of Object.entries(bag)) {
      for (const c of arr || []) {
        events.push({
          minute: c.time != null ? String(c.time) : null,
          type: 'Red card',
          player: playerName,
          team: side.startsWith('home') ? 'home' : 'away',
          text: playerName
        });
      }
    }
  }
  if (events.length) {
    events.sort((a, b) => (parseInt(a.minute) || 0) - (parseInt(b.minute) || 0));
    details.events = events;
  }

  return true;
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
    status: 'ok', version: '3.2', uptime: process.uptime(),
    lastUpdate: cache.lastUpdate, counts: cache.counts,
    caches: { details: detailsCache.size, streams: streamCache.size }
  });
});

app.get('/', (req, res) => {
  res.json({
    name: 'Sir TV Live Server', version: '3.2', status: 'running',
    features: ['matches', 'rich-details-fotmob', 'lineups', 'events', 'stats', 'full-hls-proxy'],
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
  console.log(`\n🔥 Sir TV Live v3.2 — port ${PORT}`);
  console.log(`   Rich details (SportScore) | Lineups | Events | Full proxy\n`);
});
