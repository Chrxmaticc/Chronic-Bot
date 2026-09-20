import 'dotenv/config';
import { Client, GatewayIntentBits, Partials, REST, Routes, SlashCommandBuilder } from 'discord.js';
import express from 'express';
import cors from 'cors';

/* ═══════════════════════════════════════════════════
   STATE
   ═══════════════════════════════════════════════════ */
const presenceCache = new Map();   // discordId → presence snapshot
const optedOut = new Set();        // discordId — user disabled tracking
const watchList = new Set();       // discordIds we've been asked about via /watch
const startedAt = Date.now();

/* ═══════════════════════════════════════════════════
   DISCORD CLIENT
   ═══════════════════════════════════════════════════ */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildPresences,
    GatewayIntentBits.GuildMessages,
  ],
  partials: [Partials.GuildMember, Partials.User],
});

client.once('ready', async () => {
  console.log(`[bot] logged in as ${client.user.tag}`);
  console.log(`[bot] watching ${client.guilds.cache.size} guild(s)`);

  // Register slash commands
  const commands = [
    new SlashCommandBuilder()
      .setName('opt-out')
      .setDescription('Stop Chromaticc from tracking your presence'),
    new SlashCommandBuilder()
      .setName('opt-in')
      .setDescription('Resume tracking your presence'),
    new SlashCommandBuilder()
      .setName('status')
      .setDescription('Check if Chromaticc is tracking you'),
    new SlashCommandBuilder()
      .setName('presence')
      .setDescription('Show your current Discord presence on Chromaticc')
      .addUserOption(o => o.setName('user').setDescription('User to check (defaults to you)').setRequired(false)),
    new SlashCommandBuilder()
      .setName('link')
      .setDescription('Get your Discord ID — paste it into your Chromaticc dashboard'),
    new SlashCommandBuilder()
      .setName('server-stats')
      .setDescription('Show Chromaticc bot stats'),
  ].map(c => c.toJSON());

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  try {
    await rest.put(
      Routes.applicationGuildCommands(client.user.id, process.env.GUILD_ID),
      { body: commands }
    );
    console.log('[bot] slash commands registered');
  } catch (e) {
    console.error('[bot] slash command registration failed:', e.message);
  }
});

/* ═══════════════════════════════════════════════════
   PRESENCE TRACKING
   ═══════════════════════════════════════════════════ */
client.on('presenceUpdate', (_, newP) => {
  if (!newP?.userId) return;
  const id = newP.userId;

  if (optedOut.has(id)) {
    presenceCache.delete(id);
    return;
  }

  const spotify = newP.activities?.find(a => a.name === 'Spotify');

  presenceCache.set(id, {
    userId: id,
    username: newP.user?.username || null,
    globalName: newP.user?.globalName || null,
    avatar: newP.user?.displayAvatarURL({ size: 256 }) || null,
    status: newP.status,                          // online | idle | dnd | offline
    platform: {
      desktop: newP.clientStatus?.desktop || null,
      mobile: newP.clientStatus?.mobile || null,
      web: newP.clientStatus?.web || null,
    },
    activities: (newP.activities || []).map(a => ({
      name: a.name,
      type: a.type,                               // 0 = Playing, 2 = Listening, 3 = Watching
      typeName: ['Playing','Streaming','Listening','Watching','Custom','Competing'][a.type] || 'Playing',
      details: a.details || null,
      state: a.state || null,
      startedAt: a.timestamps?.start || null,
      endsAt: a.timestamps?.end || null,
      largeImage: a.assets?.largeImage || null,
      largeText: a.assets?.largeText || null,
      smallImage: a.assets?.smallImage || null,
      smallText: a.assets?.smallText || null,
      url: a.url || null,
    })),
    spotify: spotify ? {
      song: spotify.details,
      artist: spotify.state,
      album: spotify.assets?.largeText || null,
      albumArt: spotify.assets?.largeImage
        ? `https://i.scdn.co/image/${spotify.assets.largeImage.replace('spotify:', '')}`
        : null,
      trackId: spotify.syncId || null,
      startedAt: spotify.timestamps?.start || null,
      endsAt: spotify.timestamps?.end || null,
    } : null,
    listeningToSpotify: !!spotify,
    updatedAt: Date.now(),
  });
});

client.login(process.env.DISCORD_TOKEN);

/* ═══════════════════════════════════════════════════
   SLASH COMMANDS
   ═══════════════════════════════════════════════════ */
client.on('interactionCreate', async (i) => {
  if (!i.isChatInputCommand()) return;

  /* ─── /opt-out ─── */
  if (i.commandName === 'opt-out') {
    optedOut.add(i.user.id);
    presenceCache.delete(i.user.id);
    return i.reply({ content: '✅ Opted out. Your presence is no longer tracked by Chromaticc.', ephemeral: true });
  }

  /* ─── /opt-in ─── */
  if (i.commandName === 'opt-in') {
    optedOut.delete(i.user.id);
    return i.reply({ content: '✅ Opted in. Your presence will now show on Chromaticc.', ephemeral: true });
  }

  /* ─── /status ─── */
  if (i.commandName === 'status') {
    const tracking = !optedOut.has(i.user.id);
    const cached = presenceCache.get(i.user.id);
    const lines = [
      tracking ? '✅ **Being tracked**' : '🚫 **Not tracked** — use `/opt-in` to enable',
    ];
    if (cached) {
      lines.push(`Status: \`${cached.status}\``);
      if (cached.listeningToSpotify) lines.push(`🎵 Listening: **${cached.spotify.song}** — ${cached.spotify.artist}`);
      else if (cached.activities.length) lines.push(`${cached.activities[0].typeName}: **${cached.activities[0].name}**`);
    } else if (tracking) {
      lines.push('_(no activity yet — try playing a game or opening Spotify)_');
    }
    return i.reply({ content: lines.join('\n'), ephemeral: true });
  }

  /* ─── /link ─── */
  if (i.commandName === 'link') {
    return i.reply({
      content:
        `Your Discord ID: \`${i.user.id}\`\n\n` +
        `1. Copy the ID above\n` +
        `2. Open your Chromaticc dashboard → Profile tab\n` +
        `3. Paste it into the "Discord User ID" field\n` +
        `4. Save — your live status will now show on your profile`,
      ephemeral: true,
    });
  }

  /* ─── /presence ─── */
  if (i.commandName === 'presence') {
    const target = i.options.getUser('user') || i.user;
    const d = presenceCache.get(target.id);

    if (!d) {
      return i.reply({
        content: `No presence data for **${target.username}** yet. They may be opted out or haven't had activity since the bot started.`,
        ephemeral: true,
      });
    }

    const statusEmoji = { online: '🟢', idle: '🟡', dnd: '🔴', offline: '⚫' }[d.status] || '⚫';
    const lines = [
      `${statusEmoji} **${d.globalName || d.username}** — \`${d.status}\``,
    ];
    if (d.listeningToSpotify && d.spotify) {
      lines.push(`🎵 Listening: **${d.spotify.song}** — ${d.spotify.artist}`);
    }
    for (const a of d.activities) {
      if (a.name === 'Spotify') continue;
      lines.push(`${a.typeName === 'Playing' ? '🎮' : a.typeName === 'Watching' ? '📺' : a.typeName === 'Listening' ? '🎵' : '🎯'} ${a.typeName}: **${a.name}**${a.details ? ` — ${a.details}` : ''}${a.state ? ` (${a.state})` : ''}`);
    }
    return i.reply({ content: lines.join('\n'), ephemeral: true });
  }

  /* ─── /server-stats ─── */
  if (i.commandName === 'server-stats') {
    const statuses = { online: 0, idle: 0, dnd: 0, offline: 0 };
    for (const p of presenceCache.values()) statuses[p.status] = (statuses[p.status] || 0) + 1;
    const uptimeSec = Math.floor((Date.now() - startedAt) / 1000);
    const up = `${Math.floor(uptimeSec / 3600)}h ${Math.floor((uptimeSec % 3600) / 60)}m`;
    return i.reply({
      content:
        `**Chromaticc Bot Stats**\n` +
        `Cached users: \`${presenceCache.size}\`\n` +
        `Opted out: \`${optedOut.size}\`\n` +
        `Uptime: \`${up}\`\n\n` +
        `🟢 Online: ${statuses.online}\n` +
        `🟡 Idle: ${statuses.idle}\n` +
        `🔴 DND: ${statuses.dnd}\n` +
        `⚫ Offline: ${statuses.offline}`,
      ephemeral: true,
    });
  }
});

/* ═══════════════════════════════════════════════════
   EXPRESS API
   ═══════════════════════════════════════════════════ */
const app = express();
app.use(cors());
app.use(express.json());

/* ─── Health check (Render + uptime monitors) ─── */
app.get('/', (_, res) => res.json({ ok: true, service: 'chromaticc-bot' }));
app.get('/health', (_, res) => res.json({
  ok: true,
  bot: client.isReady() ? 'ready' : 'off',
  guilds: client.guilds.cache.size,
  cached: presenceCache.size,
  uptime: Math.floor((Date.now() - startedAt) / 1000),
}));

/* ─── Get presence for one user ─── */
app.get('/presence/:id', (req, res) => {
  const d = presenceCache.get(req.params.id);
  if (!d) return res.status(404).json({ error: 'No presence cached for that user' });
  res.json(d);
});

/* ─── Get presence for multiple users ───
   GET /presence?ids=id1,id2,id3 */
app.get('/presence', (req, res) => {
  const ids = String(req.query.ids || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!ids.length) return res.status(400).json({ error: 'Provide ?ids=id1,id2' });
  const out = {};
  for (const id of ids) {
    const d = presenceCache.get(id);
    if (d) out[id] = d;
  }
  res.json(out);
});

/* ─── Stats ─── */
app.get('/stats', (_, res) => {
  const statuses = { online: 0, idle: 0, dnd: 0, offline: 0 };
  for (const p of presenceCache.values()) statuses[p.status] = (statuses[p.status] || 0) + 1;
  res.json({
    cached: presenceCache.size,
    optedOut: optedOut.size,
    guilds: client.guilds.cache.size,
    uptime: Math.floor((Date.now() - startedAt) / 1000),
    statuses,
  });
});

/* ─── All cached users (leaderboard-style) ─── */
app.get('/users', (_, res) => {
  const users = [];
  for (const p of presenceCache.values()) {
    users.push({
      userId: p.userId,
      username: p.username,
      globalName: p.globalName,
      avatar: p.avatar,
      status: p.status,
      activity: p.listeningToSpotify
        ? `🎵 ${p.spotify.song} — ${p.spotify.artist}`
        : p.activities[0]
          ? `${p.activities[0].typeName}: ${p.activities[0].name}`
          : null,
      updatedAt: p.updatedAt,
    });
  }
  users.sort((a, b) => b.updatedAt - a.updatedAt);
  res.json({ count: users.length, users });
});

/* ─── Opt-in / opt-out via API ─── */
app.post('/opt-out/:id', (req, res) => {
  optedOut.add(req.params.id);
  presenceCache.delete(req.params.id);
  res.json({ ok: true });
});
app.post('/opt-in/:id', (req, res) => {
  optedOut.delete(req.params.id);
  res.json({ ok: true });
});

/* ─── Check if a user is opted out ─── */
app.get('/status/:id', (req, res) => {
  res.json({
    userId: req.params.id,
    optedOut: optedOut.has(req.params.id),
    tracked: presenceCache.has(req.params.id),
  });
});

/* ─── Serve the bot's avatar (for widgets) ─── */
app.get('/bot-info', (_, res) => {
  if (!client.user) return res.status(503).json({ error: 'Bot not ready' });
  res.json({
    id: client.user.id,
    username: client.user.username,
    tag: client.user.tag,
    avatar: client.user.displayAvatarURL({ size: 256 }),
  });
});

/* ═══════════════════════════════════════════════════
   SERVER
   ═══════════════════════════════════════════════════ */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[api] listening on :${PORT}`));

/* ═══════════════════════════════════════════════════
   GRACEFUL SHUTDOWN
   ═══════════════════════════════════════════════════ */
process.on('SIGTERM', () => {
  console.log('[bot] SIGTERM — shutting down');
  client.destroy();
  process.exit(0);
});
