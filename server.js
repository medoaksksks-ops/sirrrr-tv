/**
 * Sir TV Live Server v3.3 — Rich details + stable streams
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
  lastUpdate: null, error: null, version: '3.3'
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

// ========== MATCHES SCRAPER ==========
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
      lastUpdate: new Date().toISOString(), error: null, version: '3.3'
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
    homeCoachPhoto: ht.coach?.id ? fotmobPhoto(ht.coach.id) : null,
    awayCoachPhoto: at.coach?.id ? fotmobPhoto(at.coach.id) : null,
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


// ========== LEAGUES (FotMob) ==========
const leagueCache = new Map();
const LEAGUE_TTL = 5 * 60 * 1000;

const LEAGUES = [
  { id: 47, name: 'Premier League', nameAr: 'الدوري الإنجليزي', country: 'England', type: 'league' },
  { id: 87, name: 'LaLiga', nameAr: 'الدوري الإسباني', country: 'Spain', type: 'league' },
  { id: 55, name: 'Serie A', nameAr: 'الدوري الإيطالي', country: 'Italy', type: 'league' },
  { id: 54, name: 'Bundesliga', nameAr: 'الدوري الألماني', country: 'Germany', type: 'league' },
  { id: 53, name: 'Ligue 1', nameAr: 'الدوري الفرنسي', country: 'France', type: 'league' },
  { id: 42, name: 'Champions League', nameAr: 'دوري أبطال أوروبا', country: 'Europe', type: 'cup' },
  { id: 73, name: 'Europa League', nameAr: 'الدوري الأوروبي', country: 'Europe', type: 'cup' },
  { id: 57, name: 'Eredivisie', nameAr: 'الدوري الهولندي', country: 'Netherlands', type: 'league' },
  { id: 61, name: 'Liga Portugal', nameAr: 'الدوري البرتغالي', country: 'Portugal', type: 'league' },
  { id: 71, name: 'Saudi Pro League', nameAr: 'الدوري السعودي', country: 'Saudi Arabia', type: 'league' },
  { id: 46, name: 'Championship', nameAr: 'الشنبونة الإنجليزية', country: 'England', type: 'league' },
  { id: 130, name: 'MLS', nameAr: 'الدوري الأمريكي', country: 'USA', type: 'league' }
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
  // Prefer full list URL later; use topThree + participant as seed
  const list = [];
  const seen = new Set();
  const push = (p) => {
    if (!p || !p.id || seen.has(p.id)) return;
    seen.add(p.id);
    list.push({
      id: p.id,
      rank: p.rank ?? list.length + 1,
      name: p.name,
      teamId: p.teamId,
      teamName: p.teamName,
      goals: p.value ?? p.stat?.value ?? null,
      photo: fotmobPhoto(p.id),
      teamLogo: p.teamId ? `https://images.fotmob.com/image_resources/logo/teamlogo/${p.teamId}_small.png` : null
    });
  };
  (goals.topThree || []).forEach(push);
  if (goals.participant) push(goals.participant);
  return list;
}

async function fetchFullScorers(fetchAllUrl) {
  if (!fetchAllUrl) return [];
  try {
    // data.fotmob.com sometimes works
    const data = await fotmobGet(fetchAllUrl.replace('https://data.fotmob.com', 'https://www.fotmob.com').replace('https://data.fotmob.com', 'https://data.fotmob.com'));
    // try raw
  } catch (_) {}
  try {
    const { data } = await get(fetchAllUrl, {
      headers: { 'User-Agent': UA, Accept: 'application/json', Referer: 'https://www.fotmob.com/' },
      timeout: 12000
    }, 1);
    const arr = Array.isArray(data) ? data : (data?.statsList || data?.players || data?.TopLists || []);
    // common shape: [{ParticipantName, TeamName, StatValue, ParticipantId, TeamId, Rank}]
    if (Array.isArray(data) && data.length && data[0].StatValue != null) {
      return data.slice(0, 30).map((p, i) => ({
        id: p.ParticipantId || p.id,
        rank: p.Rank ?? i + 1,
        name: p.ParticipantName || p.name,
        teamId: p.TeamId || p.teamId,
        teamName: p.TeamName || p.teamName,
        goals: p.StatValue ?? p.value,
        photo: fotmobPhoto(p.ParticipantId || p.id),
        teamLogo: (p.TeamId || p.teamId) ? `https://images.fotmob.com/image_resources/logo/teamlogo/${p.TeamId || p.teamId}_small.png` : null
      }));
    }
    if (Array.isArray(arr) && arr.length) {
      return arr.slice(0, 30).map((p, i) => ({
        id: p.id || p.ParticipantId,
        rank: p.rank ?? p.Rank ?? i + 1,
        name: p.name || p.ParticipantName,
        teamId: p.teamId || p.TeamId,
        teamName: p.teamName || p.TeamName,
        goals: p.value ?? p.StatValue ?? p.stat?.value,
        photo: fotmobPhoto(p.id || p.ParticipantId),
        teamLogo: (p.teamId || p.TeamId) ? `https://images.fotmob.com/image_resources/logo/teamlogo/${p.teamId || p.TeamId}_small.png` : null
      }));
    }
  } catch (e) {
    console.error('[Scorers full]', e.message);
  }
  return [];
}

async function fetchLeagueDetails(leagueId) {
  const id = Number(leagueId);
  const hit = leagueCache.get(id);
  if (hit && Date.now() - hit.ts < LEAGUE_TTL) return hit.data;

  const data = await fotmobGet(`https://www.fotmob.com/api/data/leagues?id=${id}`);
  if (!data || !data.details) throw new Error('League not found');

  // table
  let standings = [];
  try {
    const t0 = (data.table || [])[0];
    const rows = t0?.data?.table?.all || t0?.data?.table?.All || [];
    standings = mapTableRows(rows);
  } catch (_) {}

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

  // also assists top 3
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

  const meta = LEAGUES.find(l => l.id === id) || {};
  const result = {
    id,
    name: data.details.name || meta.name,
    nameAr: meta.nameAr || data.details.name,
    shortName: data.details.shortName || null,
    country: data.details.country || meta.country || null,
    season: data.details.selectedSeason || null,
    type: meta.type || 'league',
    logo: `https://images.fotmob.com/image_resources/logo/leaguelogo/${id}.png`,
    standings,
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


// ========== ROUTES ==========

app.get('/api/matches', (req, res) => res.json({ success: true, ...cache }));

// قائمة الدوريات والبطولات
app.get('/api/leagues', (req, res) => {
  res.json({
    success: true,
    leagues: LEAGUES.map(l => ({
      ...l,
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
    status: 'ok', version: '3.3', uptime: process.uptime(),
    lastUpdate: cache.lastUpdate, counts: cache.counts,
    caches: { details: detailsCache.size, streams: streamCache.size }
  });
});

app.get('/', (req, res) => {
  res.json({
    name: 'Sir TV Live Server', version: '3.3', status: 'running',
    features: ['matches', 'leagues', 'standings', 'scorers', 'fixtures', 'rich-details-fotmob', 'full-hls-proxy'],
    endpoints: {
      matches: 'GET /api/matches',
      leagues: 'GET /api/leagues',
      league: 'GET /api/league/:id',
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
  for (const [k, v] of leagueCache) if (now - v.ts > 30 * 60 * 1000) leagueCache.delete(k);
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
  console.log(`\n🔥 Sir TV Live v3.3 — port ${PORT}`);
  console.log(`   Rich details (FotMob) | Lineups | Events | Full proxy\n`);
});
