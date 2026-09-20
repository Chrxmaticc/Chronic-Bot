import 'dotenv/config';
import { Client, GatewayIntentBits, Partials } from 'discord.js';
import express from 'express';
import cors from 'cors';

/* ═══════════════════════════════════════════════
   IN-MEMORY PRESENCE CACHE
   Keyed by Discord user ID. Wiped on restart.
   ═══════════════════════════════════════════════ */
const presenceCache = new Map();
const optedOut = new Set();

/* ═══════════════════════════════════════════════
   DISCORD BOT
   ═══════════════════════════════════════════════ */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildPresences,  // ← required for presenceUpdate
  ],
  partials: [Partials.GuildMember, Partials.User],
});

client.once('ready', () => {
  console.log(`[bot] logged in as ${client.user.tag}`);
  console.log(`[bot] watching ${client.guilds.cache.size} guild(s)`);
});

client.on('presenceUpdate', (oldPresence, newPresence) => {
  if (!newPresence || !newPresence.userId) return;

  const userId = newPresence.userId;

  if (optedOut.has(userId)) {
    presenceCache.delete(userId);
    return;
  }

  const activities = (newPresence.activities || []).map(a => ({
    name: a.name,
    type: a.type,               // 0 = Playing, 2 = Listening (Spotify), etc.
    details: a.details || null,
    state: a.state || null,
    startedAt: a.timestamps?.start || null,
    largeImage: a.assets?.largeImage || null,
    smallImage: a.assets?.smallImage || null,
    url: a.url || null,
  }));

  const spotify = newPresence.activities.find(a => a.name === 'Spotify');

  presenceCache.set(userId, {
    userId,
    username: newPresence.user?.username || null,
    globalName: newPresence.user?.globalName || null,
    avatar: newPresence.user?.displayAvatarURL({ size: 256 }) || null,
    status: newPresence.status,                    // online | idle | dnd | offline
    platform: {
      desktop: newPresence.clientStatus?.desktop || null,
      mobile: newPresence.clientStatus?.mobile || null,
      web: newPresence.clientStatus?.web || null,
    },
    activities,
    listeningToSpotify: !!spotify,
    spotify: spotify ? {
      song: spotify.details,
      artist: spotify.state,
      albumArt: spotify.assets?.largeImage
        ? `https://i.scdn.co/image/${spotify.assets.largeImage.replace('spotify:', '')}`
        : null,
      album: spotify.assets?.largeText || null,
      trackId: spotify.syncId || null,
      startedAt: spotify.timestamps?.start || null,
      endsAt: spotify.timestamps?.end || null,
    } : null,
    updatedAt: Date.now(),
  });
});

client.login(process.env.DISCORD_TOKEN);

/* ═══════════════════════════════════════════════
   EXPRESS API
   ═══════════════════════════════════════════════ */
const app = express();
app.use(cors());       // allow Chrome extension / browser fetch from chromaticc domain
app.use(express.json());

/* Auth middleware — every route except /health requires x-api-key */
function requireKey(req, res, next) {
  const key = req.headers['x-api-key'];
  if (!key || key !== process.env.API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

/* Health check — no auth, for Render + uptime monitors */
app.get('/health', (req, res) => {
  res.json({
    ok: true,
    bot: client.isReady() ? 'connected' : 'disconnected',
    guilds: client.guilds.cache.size,
    cachedUsers: presenceCache.size,
    uptime: process.uptime(),
  });
});

/* Get presence for one user */
app.get('/presence/:userId', requireKey, (req, res) => {
  const data = presenceCache.get(req.params.userId);
  if (!data) return res.status(404).json({ error: 'No presence cached for that user' });
  res.json(data);
});

/* Get presence for multiple users at once */
app.get('/presence', requireKey, (req, res) => {
  const ids = String(req.query.ids || '').split(',').filter(Boolean);
  if (!ids.length) return res.status(400).json({ error: 'Provide ?ids=id1,id2' });

  const out = {};
  for (const id of ids) {
    const d = presenceCache.get(id);
    if (d) out[id] = d;
  }
  res.json(out);
});

/* Stats */
app.get('/stats', requireKey, (req, res) => {
  const statuses = { online: 0, idle: 0, dnd: 0, offline: 0 };
  for (const p of presenceCache.values()) statuses[p.status] = (statuses[p.status] || 0) + 1;
  res.json({
    totalCached: presenceCache.size,
    totalOptedOut: optedOut.size,
    statuses,
  });
});

/* GDPR-style opt-out (public, no auth) */
app.post('/opt-out/:userId', (req, res) => {
  optedOut.add(req.params.userId);
  presenceCache.delete(req.params.userId);
  res.json({ ok: true });
});

app.post('/opt-in/:userId', (req, res) => {
  optedOut.delete(req.params.userId);
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[api] listening on :${PORT}`));
