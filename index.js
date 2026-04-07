// Patch for Riffy Node initialization error in Node.js 20+
const originalDefineProperty = Object.defineProperty;
Object.defineProperty = function (obj, prop, descriptor) {
  if (
    descriptor &&
    (descriptor.get || descriptor.set) &&
    (Object.prototype.hasOwnProperty.call(descriptor, 'value') ||
      Object.prototype.hasOwnProperty.call(descriptor, 'writable'))
  ) {
    const d = { ...descriptor };
    delete d.value;
    delete d.writable;
    return originalDefineProperty(obj, prop, d);
  }
  return originalDefineProperty(obj, prop, descriptor);
};

require('dotenv').config();
const {
  Client, GatewayIntentBits,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  EmbedBuilder, ActivityType,
  StringSelectMenuBuilder, ComponentType, MessageFlags
} = require('discord.js');
const { Riffy } = require('riffy');
const express = require('express');

const app  = express();
const PORT = process.env.PORT || 3000;

const config = {
  ownerId:       process.env.OWNER_ID       || '1092773378101882951',
  supportServer: process.env.SUPPORT_SERVER || 'https://discord.gg/su57JWf2V5',
  voteLink:      process.env.VOTE_LINK      || 'https://top.gg/bot/1450084513513341050/vote',
  color: { success: '#00ff00', info: '#0099ff', error: '#ff0000' }
};

const lavalinkNodes = [{
  host:     process.env.LAVALINK_HOST     || 'lavalink-v4.triniumhost.com',
  port:     parseInt(process.env.LAVALINK_PORT) || 443,
  password: process.env.LAVALINK_PASSWORD || 'free',
  secure:   process.env.LAVALINK_SECURE === 'true'
}];

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates
  ]
});

let riffy;
let lavalinkConnected      = false;
let lavalinkReconnectTimer = null;
let isReconnecting         = false;
let heartbeatTimer         = null;

const playerStates = new Map();
const startTime    = Date.now();

// ═══════════════════════════════════════════════════════════════
//  NODE HEARTBEAT
//
//  WHY: Public Lavalink nodes (e.g. jirayu.net) keep the WebSocket
//  open for days but silently stop processing play ops after ~48 h
//  when their internal session expires. Riffy never fires
//  nodeError/nodeDisconnect, so lavalinkConnected stays true while
//  nothing actually plays — joins VC, sends embed, no audio.
//
//  FIX: Every 3 minutes, HTTP-ping /version on the node.
//  If it fails → force-reset everything and restart reconnect loop.
// ═══════════════════════════════════════════════════════════════
function startHeartbeat() {
  if (heartbeatTimer) return;
  heartbeatTimer = setInterval(async () => {
    if (!lavalinkConnected) return;
    try {
      const n     = lavalinkNodes[0];
      const proto = n.secure ? 'https' : 'http';
      const res   = await fetch(`${proto}://${n.host}:${n.port}/version`, {
        headers: { Authorization: n.password },
        signal:  AbortSignal.timeout(8000)
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // Node alive — nothing to do
    } catch (err) {
      console.warn(`[Heartbeat] Node failed: ${err.message} → forcing reconnect`);
      lavalinkConnected = false;
      // Tear down every active player so guilds aren't permanently stuck
      if (riffy) {
        for (const [, player] of riffy.players) {
          try {
            const ch = client.channels.cache.get(player.textChannel);
            ch?.send('⚠️ Music connection lost. Please use `play` again in ~30 seconds.').catch(() => {});
            await disableNowPlayingMessage(player);
            player.destroy();
          } catch (_) {}
        }
      }
      stopHeartbeat();
      startLavalinkReconnect();
    }
  }, 3 * 60 * 1000);
}

function stopHeartbeat() {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
}

// ═══════════════════════════════════════════════════════════════
//  SAFE PLAY
//
//  WHY: Even when the node looks connected, it can silently drop
//  play ops (stale session). trackStart never fires, the bot sits
//  in VC doing nothing, and the player is permanently broken for
//  that guild — even across bot restarts (because the player object
//  persists in Riffy's map).
//
//  FIX: After calling player.play(), wait up to 8 s for trackStart.
//  If it never arrives → node is broken → destroy the player,
//  notify the channel, and restart reconnect.
// ═══════════════════════════════════════════════════════════════
function safePlay(player, textChannelId) {
  return new Promise((resolve) => {
    let settled = false;

    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      riffy.removeListener('trackStart', onTrackStart);
      resolve(ok);
    };

    const onTrackStart = () => finish(true);
    riffy.once('trackStart', onTrackStart);

    const timer = setTimeout(async () => {
      if (settled) return;
      console.warn(`[safePlay] trackStart never fired in guild ${player.guildId} — node is stale`);

      const ch = client.channels.cache.get(textChannelId || player.textChannel);
      ch?.send('⚠️ Playback failed to start (Lavalink node issue). Reconnecting — please try `play` again in ~30 seconds.').catch(() => {});

      lavalinkConnected = false;
      stopHeartbeat();
      await disableNowPlayingMessage(player);
      try { player.destroy(); } catch (_) {}
      startLavalinkReconnect();
      finish(false);
    }, 8000);

    player.play();
  });
}

// ═══════════════════════════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════════════════════════

async function disableNowPlayingMessage(player) {
  if (!player.nowPlayingMessage) return;
  try {
    await player.nowPlayingMessage.edit({
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('pause').setEmoji('⏸️').setStyle(ButtonStyle.Primary).setDisabled(true),
        new ButtonBuilder().setCustomId('skip').setEmoji('⏭️').setStyle(ButtonStyle.Primary).setDisabled(true),
        new ButtonBuilder().setCustomId('stop').setEmoji('⏹️').setStyle(ButtonStyle.Danger).setDisabled(true)
      )]
    });
  } catch (_) {}
  player.nowPlayingMessage = null;
}

// Poll for Riffy's internal voice handshake — no blind setTimeout
function waitForVoiceReady(player, timeout = 6000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const iv = setInterval(() => {
      if (player.voiceChannel || player.connected) { clearInterval(iv); return resolve(); }
      if (Date.now() - start >= timeout) {
        clearInterval(iv);
        console.warn('[Voice] Timed out waiting for voice ready — attempting play anyway');
        resolve();
      }
    }, 20);
  });
}

function getTotalUsers() {
  return client.guilds.cache.reduce((a, g) => a + g.memberCount, 0);
}

function formatTime(ms) {
  const s = Math.floor((ms / 1000) % 60);
  const m = Math.floor((ms / 60000) % 60);
  const h = Math.floor(ms / 3600000);
  return h > 0
    ? `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`
    : `${m}:${String(s).padStart(2,'0')}`;
}

function formatUptime(ms) {
  const s = Math.floor((ms / 1000) % 60);
  const m = Math.floor((ms / 60000) % 60);
  const h = Math.floor((ms / 3600000) % 24);
  const d = Math.floor(ms / 86400000);
  const p = [];
  if (d) p.push(`${d}d`);
  if (h) p.push(`${h}h`);
  if (m) p.push(`${m}m`);
  if (s) p.push(`${s}s`);
  return p.join(' ') || '0s';
}

// ═══════════════════════════════════════════════════════════════
//  LAVALINK RECONNECT LOOP
// ═══════════════════════════════════════════════════════════════
function getRandomInterval() { return Math.floor(Math.random() * 60_000) + 120_000; }

function startLavalinkReconnect() {
  if (lavalinkReconnectTimer) return;
  console.log('[Lavalink] Starting reconnect loop (2–3 min interval)...');

  function scheduleNext() {
    const delay = getRandomInterval();
    console.log(`[Lavalink] Next attempt in ${Math.round(delay / 1000)}s`);
    lavalinkReconnectTimer = setTimeout(async () => {
      lavalinkReconnectTimer = null;
      if (lavalinkConnected) { isReconnecting = false; return; }
      if (isReconnecting)    { scheduleNext(); return; }

      isReconnecting = true;
      console.log('[Lavalink] Reconnecting...');
      try {
        if (riffy) { try { riffy.removeAllListeners(); } catch (_) {} }
        riffy = new Riffy(client, lavalinkNodes, {
          send: (payload) => {
            const guild = client.guilds.cache.get(payload.d.guild_id);
            if (guild) guild.shard.send(payload);
          },
          defaultSearchPlatform: 'ytmsearch',
          restVersion: 'v4'
        });
        attachRiffyEvents();
        if (client.user) riffy.init(client.user.id);
      } catch (err) {
        console.error('[Lavalink] Reconnect error:', err.message);
      }
      isReconnecting = false;
      if (!lavalinkConnected) scheduleNext();
    }, delay);
  }

  scheduleNext();
}

function stopLavalinkReconnect() {
  if (lavalinkReconnectTimer) { clearTimeout(lavalinkReconnectTimer); lavalinkReconnectTimer = null; }
  isReconnecting = false;
  console.log('[Lavalink] Reconnect loop stopped.');
}

// ═══════════════════════════════════════════════════════════════
//  RIFFY EVENTS
// ═══════════════════════════════════════════════════════════════
function attachRiffyEvents() {
  if (!riffy) return;

  riffy.on('nodeConnect', (node) => {
    lavalinkConnected = true;
    console.log(`[Lavalink] "${node.name}" connected ✅`);
    stopLavalinkReconnect();
    startHeartbeat();
  });

  riffy.on('nodeError', (node, error) => {
    console.error(`[Lavalink] "${node.name}" error: ${error.message}`);
    lavalinkConnected = false;
    stopHeartbeat();
    startLavalinkReconnect();
  });

  riffy.on('nodeDisconnect', (node) => {
    console.warn(`[Lavalink] "${node.name}" disconnected ❌`);
    lavalinkConnected = false;
    stopHeartbeat();
    startLavalinkReconnect();
  });

  riffy.on('trackStart', async (player, track) => {
    const channel = client.channels.cache.get(player.textChannel);
    if (!channel) return;

    await disableNowPlayingMessage(player);

    const msg = await channel.send({
      embeds: [new EmbedBuilder()
        .setColor(config.color.success)
        .setTitle('🎵 Now Playing')
        .setDescription(`[${track.info.title}](${track.info.uri})`)
        .setThumbnail(track.info.thumbnail || track.info.artworkUrl || null)
        .addFields(
          { name: 'Artist',       value: track.info.author || 'Unknown', inline: true },
          { name: 'Duration',     value: formatTime(track.info.length),   inline: true },
          { name: 'Requested by', value: `<@${track.info.requester}>`,    inline: true }
        )],
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('pause').setEmoji('⏸️').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('skip').setEmoji('⏭️').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('stop').setEmoji('⏹️').setStyle(ButtonStyle.Danger)
      )]
    });
    player.nowPlayingMessage = msg;
  });

  riffy.on('trackEnd', (player) => {
    player.nowPlayingMessage = null;
  });

  riffy.on('queueEnd', async (player) => {
    const channel = client.channels.cache.get(player.textChannel);
    const state   = playerStates.get(player.guildId);
    await disableNowPlayingMessage(player);
    if (state?.stay247) {
      channel?.send('Queue ended. Staying in VC (24/7 mode on).').catch(() => {});
      return;
    }
    channel?.send('Queue ended. Leaving voice channel.').catch(() => {});
    player.destroy();
    playerStates.delete(player.guildId);
  });

  // Lavalink rejected the track (region-locked, bad URL, etc.)
  riffy.on('trackError', async (player, track, payload) => {
    console.error(`[trackError] ${player.guildId} | ${track?.info?.title} | ${payload?.exception?.message}`);
    const channel = client.channels.cache.get(player.textChannel);
    channel?.send(`❌ Error on **${track?.info?.title || 'track'}**: ${payload?.exception?.message || 'Unknown error'}. Skipping...`).catch(() => {});
    await disableNowPlayingMessage(player);
    player.queue.length > 0 ? player.stop() : (player.destroy(), playerStates.delete(player.guildId));
  });

  // Lavalink stalled mid-stream (buffer empty, network hiccup, etc.)
  riffy.on('trackStuck', async (player, track) => {
    console.warn(`[trackStuck] ${player.guildId} | ${track?.info?.title}`);
    const channel = client.channels.cache.get(player.textChannel);
    channel?.send(`⚠️ Track stuck: **${track?.info?.title || 'track'}**. Skipping...`).catch(() => {});
    await disableNowPlayingMessage(player);
    player.queue.length > 0 ? player.stop() : (player.destroy(), playerStates.delete(player.guildId));
  });
}

// ═══════════════════════════════════════════════════════════════
//  INITIAL RIFFY INIT
// ═══════════════════════════════════════════════════════════════
try {
  riffy = new Riffy(client, lavalinkNodes, {
    send: (payload) => {
      const guild = client.guilds.cache.get(payload.d.guild_id);
      if (guild) guild.shard.send(payload);
    },
    defaultSearchPlatform: 'ytmsearch',
    restVersion: 'v4'
  });
  attachRiffyEvents();
} catch (err) {
  console.error('[Riffy] Init failed:', err.message);
}

// ═══════════════════════════════════════════════════════════════
//  EXPRESS
// ═══════════════════════════════════════════════════════════════
app.get('/', (req, res) => res.json({
  status:       'online',
  bot:          client.user?.tag || 'Not Ready',
  uptime:       formatUptime(Date.now() - startTime),
  servers:      client.guilds.cache.size,
  users:        getTotalUsers(),
  lavalink:     lavalinkConnected ? 'connected' : 'disconnected',
  reconnecting: !lavalinkConnected && lavalinkReconnectTimer !== null
}));
app.get('/health', (req, res) => res.json({ status: 'ok', uptime: Date.now() - startTime }));
app.listen(PORT, () => console.log(`Express on port ${PORT}`));

// ═══════════════════════════════════════════════════════════════
//  COMMAND ALIASES
// ═══════════════════════════════════════════════════════════════
const commands = {
  play:       ['play', 'p'],
  pause:      ['pause'],
  resume:     ['resume', 'r'],
  skip:       ['skip', 's', 'next'],
  stop:       ['stop', 'disconnect', 'dc'],
  queue:      ['queue', 'q'],
  nowplaying: ['nowplaying', 'np', 'current'],
  join:       ['join', 'connect'],
  leave:      ['leave'],
  volume:     ['volume', 'vol', 'v'],
  loop:       ['loop', 'repeat'],
  shuffle:    ['shuffle', 'sh'],
  clearqueue: ['clearqueue', 'cq', 'clear'],
  remove:     ['remove', 'rm'],
  move:       ['move', 'mv'],
  search:     ['search', 'find'],
  lyrics:     ['lyrics', 'ly'],
  '247':      ['247', '24/7', 'stay'],
  help:       ['help', 'h', 'commands'],
  ping:       ['ping'],
  uptime:     ['uptime', 'ut'],
  botinfo:    ['botinfo', 'bi', 'info'],
  stats:      ['stats', 'statistics'],
  support:    ['support'],
  invite:     ['invite', 'inv'],
  vote:       ['vote'],
  restart:    ['restart']
};

function getCommand(input) {
  for (const [cmd, aliases] of Object.entries(commands)) {
    if (aliases.includes(input)) return cmd;
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════
//  BOT READY
// ═══════════════════════════════════════════════════════════════
client.once('clientReady', () => {
  if (riffy) riffy.init(client.user.id);
  client.user.setPresence({
    activities: [{ name: `@${client.user.username} help`, type: ActivityType.Listening }],
    status: 'online'
  });
  console.log(`${client.user.tag} is ready!`);
  if (!lavalinkConnected) startLavalinkReconnect();
});

client.on('raw', (d) => { if (riffy) riffy.updateVoiceState(d); });

// ═══════════════════════════════════════════════════════════════
//  MESSAGE HANDLER
// ═══════════════════════════════════════════════════════════════
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  const mentionOnly =
    message.content.trim() === `<@!${client.user.id}>` ||
    message.content.trim() === `<@${client.user.id}>`;

  if (mentionOnly) {
    return message.reply({
      embeds: [new EmbedBuilder()
        .setColor(config.color.info)
        .setTitle(`🎵 ${client.user.username}`)
        .setDescription(`Use \`@${client.user.username} help\` to see all commands.`)
        .setFooter({ text: 'Mention me followed by a command' })]
    });
  }

  if (!message.mentions.has(client.user.id)) return;

  const args    = message.content.split(' ').slice(1);
  const input   = args[0]?.toLowerCase();
  const command = getCommand(input);
  if (!command) return;

  // ── restart ──────────────────────────────────────────────────
  if (command === 'restart') {
    if (message.author.id !== config.ownerId) {
      return message.reply({ embeds: [new EmbedBuilder().setColor(config.color.error).setDescription('❌ Owner only!')] });
    }
    await message.reply({ embeds: [new EmbedBuilder().setColor(config.color.info).setDescription('🔄 Restarting...')] });
    await client.destroy();
    process.exit(0);
  }

  // ── Lavalink gate ─────────────────────────────────────────────
  const musicCmds = ['play','pause','resume','skip','stop','queue','nowplaying','volume','loop','shuffle','clearqueue','remove','move','search','lyrics','join','leave'];
  if (musicCmds.includes(command) && !lavalinkConnected) {
    return message.reply({
      embeds: [new EmbedBuilder()
        .setColor(config.color.error)
        .setTitle('❌ Lavalink Offline')
        .setDescription('Music is unavailable right now. Auto-reconnect is running — try again in a few minutes.')]
    });
  }

  // ── play ──────────────────────────────────────────────────────
  if (command === 'play') {
    if (!message.member.voice.channel) {
      return message.reply({ embeds: [new EmbedBuilder().setColor(config.color.error).setDescription('❌ Join a voice channel first!')] });
    }
    const query = args.slice(1).join(' ');
    if (!query) {
      return message.reply({ embeds: [new EmbedBuilder().setColor(config.color.error).setDescription('❌ Provide a song name or URL!')] });
    }

    try {
      // Resolve FIRST — track data ready before we even touch the VC
      const resolve = await riffy.resolve({ query, requester: message.author.id });
      if (resolve.loadType === 'error' || resolve.loadType === 'empty') {
        return message.reply({ embeds: [new EmbedBuilder().setColor(config.color.error).setDescription('❌ No results found!')] });
      }

      let player = riffy.players.get(message.guild.id);
      const isNew = !player;
      if (!player) {
        player = riffy.createConnection({
          guildId: message.guild.id, voiceChannel: message.member.voice.channel.id,
          textChannel: message.channel.id, deaf: true
        });
      }

      const tracks = resolve.loadType === 'playlist' ? resolve.tracks : [resolve.tracks[0]];

      if (resolve.loadType === 'playlist') {
        for (const t of tracks) { t.info.requester = message.author.id; player.queue.add(t); }
        message.reply({
          embeds: [new EmbedBuilder().setColor(config.color.info).setTitle('📃 Playlist Added')
            .setDescription(`**${resolve.playlistInfo.name}**`)
            .addFields({ name: 'Tracks', value: `${tracks.length}`, inline: true })]
        });
      } else {
        tracks[0].info.requester = message.author.id;
        player.queue.add(tracks[0]);
        message.reply({
          embeds: [new EmbedBuilder().setColor(config.color.info).setTitle('✅ Added to Queue')
            .setDescription(`[${tracks[0].info.title}](${tracks[0].info.uri})`)
            .setThumbnail(tracks[0].info.thumbnail || tracks[0].info.artworkUrl || null)
            .addFields(
              { name: 'Artist',   value: tracks[0].info.author || 'Unknown', inline: true },
              { name: 'Duration', value: formatTime(tracks[0].info.length),   inline: true },
              { name: 'Position', value: `${player.queue.length}`,            inline: true }
            )]
        });
      }

      if (!player.playing && !player.paused) {
        if (isNew) await waitForVoiceReady(player);
        await safePlay(player, message.channel.id);
      }
    } catch (err) {
      console.error('[play]', err);
      message.reply({ embeds: [new EmbedBuilder().setColor(config.color.error).setDescription('❌ An error occurred while loading the track.')] });
    }
  }

  // ── search ────────────────────────────────────────────────────
  else if (command === 'search') {
    if (!message.member.voice.channel) {
      return message.reply({ embeds: [new EmbedBuilder().setColor(config.color.error).setDescription('❌ Join a voice channel first!')] });
    }
    const query = args.slice(1).join(' ');
    if (!query) {
      return message.reply({ embeds: [new EmbedBuilder().setColor(config.color.error).setDescription('❌ Provide a search query!')] });
    }

    try {
      const resolve = await riffy.resolve({ query });
      if (resolve.loadType === 'error' || resolve.loadType === 'empty') {
        return message.reply({ embeds: [new EmbedBuilder().setColor(config.color.error).setDescription('❌ No results found!')] });
      }

      const tracks  = resolve.tracks.slice(0, 10);
      const options = tracks.map((t, i) => ({
        label:       t.info.title.substring(0, 100),
        description: `${t.info.author} - ${formatTime(t.info.length)}`.substring(0, 100),
        value:       `search_${i}`
      }));

      const msg = await message.reply({
        embeds: [new EmbedBuilder().setColor(config.color.info).setTitle('🔍 Search Results')
          .setDescription(tracks.map((t, i) => `**${i+1}.** [${t.info.title}](${t.info.uri})\n${t.info.author} - ${formatTime(t.info.length)}`).join('\n\n'))
          .setFooter({ text: 'Select from the dropdown below' })],
        components: [new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder().setCustomId('search_select').setPlaceholder('Select a song').addOptions(options)
        )]
      });

      const collector = msg.createMessageComponentCollector({ componentType: ComponentType.StringSelect, time: 60000 });

      collector.on('collect', async (i) => {
        if (i.user.id !== message.author.id) {
          return i.reply({ content: '❌ This is not your search!', flags: [MessageFlags.Ephemeral] });
        }
        const selected = tracks[parseInt(i.values[0].split('_')[1])];
        let player     = riffy.players.get(message.guild.id);
        const isNew    = !player;
        if (!player) {
          player = riffy.createConnection({
            guildId: message.guild.id, voiceChannel: message.member.voice.channel.id,
            textChannel: message.channel.id, deaf: true
          });
        }
        selected.info.requester = message.author.id;
        player.queue.add(selected);
        await i.update({
          embeds: [new EmbedBuilder().setColor(config.color.success).setDescription(`✅ Added **${selected.info.title}** to queue!`)],
          components: []
        });
        if (!player.playing && !player.paused) {
          if (isNew) await waitForVoiceReady(player);
          await safePlay(player, message.channel.id);
        }
        collector.stop();
      });

      collector.on('end', () => msg.edit({ components: [] }).catch(() => {}));
    } catch (err) {
      message.reply({ embeds: [new EmbedBuilder().setColor(config.color.error).setDescription('❌ An error occurred while searching.')] });
    }
  }

  // ── pause ─────────────────────────────────────────────────────
  else if (command === 'pause') {
    const player = riffy.players.get(message.guild.id);
    if (!player || !player.playing) return message.reply({ embeds: [new EmbedBuilder().setColor(config.color.error).setDescription('❌ No music is playing!')] });
    if (!message.member.voice.channel) return message.reply({ embeds: [new EmbedBuilder().setColor(config.color.error).setDescription('❌ Join a voice channel!')] });
    player.pause(true);
    message.reply({ embeds: [new EmbedBuilder().setColor(config.color.info).setDescription('⏸️ Paused!')] });
  }

  // ── resume ────────────────────────────────────────────────────
  else if (command === 'resume') {
    const player = riffy.players.get(message.guild.id);
    if (!player) return message.reply({ embeds: [new EmbedBuilder().setColor(config.color.error).setDescription('❌ No music is playing!')] });
    if (!message.member.voice.channel) return message.reply({ embeds: [new EmbedBuilder().setColor(config.color.error).setDescription('❌ Join a voice channel!')] });
    player.pause(false);
    message.reply({ embeds: [new EmbedBuilder().setColor(config.color.info).setDescription('▶️ Resumed!')] });
  }

  // ── skip ──────────────────────────────────────────────────────
  else if (command === 'skip') {
    const player = riffy.players.get(message.guild.id);
    if (!player || !player.current) return message.reply({ embeds: [new EmbedBuilder().setColor(config.color.error).setDescription('❌ No music is playing!')] });
    if (!message.member.voice.channel) return message.reply({ embeds: [new EmbedBuilder().setColor(config.color.error).setDescription('❌ Join a voice channel!')] });
    const title = player.current.info.title;
    await disableNowPlayingMessage(player);
    player.stop();
    message.reply({ embeds: [new EmbedBuilder().setColor(config.color.info).setDescription(`⏭️ Skipped: **${title}**`)] });
  }

  // ── stop ──────────────────────────────────────────────────────
  else if (command === 'stop') {
    const player = riffy.players.get(message.guild.id);
    if (!player) return message.reply({ embeds: [new EmbedBuilder().setColor(config.color.error).setDescription('❌ No music is playing!')] });
    if (!message.member.voice.channel) return message.reply({ embeds: [new EmbedBuilder().setColor(config.color.error).setDescription('❌ Join a voice channel!')] });
    await disableNowPlayingMessage(player);
    player.destroy();
    playerStates.delete(message.guild.id);
    message.reply({ embeds: [new EmbedBuilder().setColor(config.color.info).setDescription('⏹️ Stopped and disconnected!')] });
  }

  // ── queue ─────────────────────────────────────────────────────
  else if (command === 'queue') {
    const player = riffy.players.get(message.guild.id);
    if (!player || !player.current || !player.playing) {
      return message.reply({ embeds: [new EmbedBuilder().setColor(config.color.error).setDescription('❌ No music is playing!')] });
    }
    const q     = player.queue;
    const state = playerStates.get(message.guild.id);
    message.reply({
      embeds: [new EmbedBuilder().setColor(config.color.info).setTitle('🎵 Music Queue')
        .setDescription(
          `**Now Playing:**\n[${player.current.info.title}](${player.current.info.uri}) - ${player.current.info.author}\n\n**Up Next:**\n${
            q.length > 0
              ? q.slice(0,10).map((t,i) => `\`${i+1}.\` [${t.info.title}](${t.info.uri}) - ${t.info.author}`).join('\n')
              : 'No tracks in queue'
          }${q.length > 10 ? `\n\n*And ${q.length-10} more...*` : ''}`
        )
        .setFooter({ text: `Total: ${q.length+1} | Loop: ${state?.loop || 'off'} | 24/7: ${state?.stay247 ? 'on' : 'off'}` })]
    });
  }

  // ── nowplaying ────────────────────────────────────────────────
  else if (command === 'nowplaying') {
    const player = riffy.players.get(message.guild.id);
    if (!player || !player.current || !player.playing) {
      return message.reply({ embeds: [new EmbedBuilder().setColor(config.color.error).setDescription('❌ No music is playing!')] });
    }
    const track    = player.current;
    const cur      = player.position || 0;
    const tot      = track.info.length;
    const progress = Math.min(20, Math.max(0, Math.floor((cur / tot) * 20)));
    const bar      = '▬'.repeat(progress) + '🔘' + '▬'.repeat(20 - progress);
    message.reply({
      embeds: [new EmbedBuilder().setColor(config.color.info).setTitle('🎵 Now Playing')
        .setDescription(`[${track.info.title}](${track.info.uri})`)
        .setThumbnail(track.info.thumbnail || track.info.artworkUrl || null)
        .addFields(
          { name: 'Artist',       value: track.info.author || 'Unknown',          inline: true },
          { name: 'Duration',     value: `${formatTime(cur)} / ${formatTime(tot)}`, inline: true },
          { name: 'Status',       value: player.paused ? '⏸️ Paused' : '▶️ Playing', inline: true },
          { name: 'Progress',     value: bar,                                      inline: false },
          { name: 'Requested by', value: `<@${track.info.requester}>`,             inline: true },
          { name: 'Volume',       value: `${player.volume}%`,                     inline: true }
        )]
    });
  }

  // ── join ──────────────────────────────────────────────────────
  else if (command === 'join') {
    if (!message.member.voice.channel) return message.reply({ embeds: [new EmbedBuilder().setColor(config.color.error).setDescription('❌ Join a voice channel!')] });
    if (riffy.players.get(message.guild.id)) return message.reply({ embeds: [new EmbedBuilder().setColor(config.color.error).setDescription('❌ Already in a voice channel!')] });
    riffy.createConnection({ guildId: message.guild.id, voiceChannel: message.member.voice.channel.id, textChannel: message.channel.id, deaf: true });
    message.reply({ embeds: [new EmbedBuilder().setColor(config.color.success).setDescription(`✅ Joined **${message.member.voice.channel.name}**`)] });
  }

  // ── leave ─────────────────────────────────────────────────────
  else if (command === 'leave') {
    const player = riffy.players.get(message.guild.id);
    if (!player) return message.reply({ embeds: [new EmbedBuilder().setColor(config.color.error).setDescription('❌ Not in a voice channel!')] });
    await disableNowPlayingMessage(player);
    player.destroy();
    playerStates.delete(message.guild.id);
    message.reply({ embeds: [new EmbedBuilder().setColor(config.color.info).setDescription('👋 Disconnected!')] });
  }

  // ── volume ────────────────────────────────────────────────────
  else if (command === 'volume') {
    const player = riffy.players.get(message.guild.id);
    if (!player) return message.reply({ embeds: [new EmbedBuilder().setColor(config.color.error).setDescription('❌ No music is playing!')] });
    const vol = parseInt(args[1]);
    if (isNaN(vol) || vol < 0 || vol > 100) {
      return message.reply({ embeds: [new EmbedBuilder().setColor(config.color.info).setDescription(`🔊 Current volume: **${player.volume}%**\n\nUsage: \`volume <0-100>\``)] });
    }
    player.setVolume(vol);
    message.reply({ embeds: [new EmbedBuilder().setColor(config.color.info).setDescription(`🔊 Volume set to **${vol}%**`)] });
  }

  // ── loop ──────────────────────────────────────────────────────
  else if (command === 'loop') {
    const player = riffy.players.get(message.guild.id);
    if (!player || !player.current) return message.reply({ embeds: [new EmbedBuilder().setColor(config.color.error).setDescription('❌ No music is playing!')] });
    if (!message.member.voice.channel) return message.reply({ embeds: [new EmbedBuilder().setColor(config.color.error).setDescription('❌ Join a voice channel!')] });
    const state = playerStates.get(message.guild.id) || {};
    const modes = ['off', 'track', 'queue'];
    const next  = modes[(modes.indexOf(state.loop || 'off') + 1) % modes.length];
    state.loop  = next;
    playerStates.set(message.guild.id, state);
    player.setLoop(next === 'off' ? 'none' : next);
    const emoji = { off: '➡️', track: '🔂', queue: '🔁' };
    const desc  = { off: 'Loop disabled', track: 'Looping current track', queue: 'Looping entire queue' };
    message.reply({ embeds: [new EmbedBuilder().setColor(config.color.info).setDescription(`${emoji[next]} **${desc[next]}**`)] });
  }

  // ── 247 ───────────────────────────────────────────────────────
  else if (command === '247') {
    const player = riffy.players.get(message.guild.id);
    if (!player) return message.reply({ embeds: [new EmbedBuilder().setColor(config.color.error).setDescription('❌ No music is playing!')] });
    if (!message.member.voice.channel) return message.reply({ embeds: [new EmbedBuilder().setColor(config.color.error).setDescription('❌ Join a voice channel!')] });
    const state   = playerStates.get(message.guild.id) || {};
    state.stay247 = !state.stay247;
    playerStates.set(message.guild.id, state);
    message.reply({ embeds: [new EmbedBuilder().setColor(config.color.info).setDescription(`🎵 24/7 Mode: **${state.stay247 ? 'enabled' : 'disabled'}**`)] });
  }

  // ── shuffle ───────────────────────────────────────────────────
  else if (command === 'shuffle') {
    const player = riffy.players.get(message.guild.id);
    if (!player || player.queue.length === 0) return message.reply({ embeds: [new EmbedBuilder().setColor(config.color.error).setDescription('❌ Queue is empty!')] });
    if (!message.member.voice.channel) return message.reply({ embeds: [new EmbedBuilder().setColor(config.color.error).setDescription('❌ Join a voice channel!')] });
    player.queue.shuffle();
    message.reply({ embeds: [new EmbedBuilder().setColor(config.color.info).setDescription(`🔀 Shuffled **${player.queue.length}** tracks!`)] });
  }

  // ── clearqueue ────────────────────────────────────────────────
  else if (command === 'clearqueue') {
    const player = riffy.players.get(message.guild.id);
    if (!player || player.queue.length === 0) return message.reply({ embeds: [new EmbedBuilder().setColor(config.color.error).setDescription('❌ Queue is empty!')] });
    if (!message.member.voice.channel) return message.reply({ embeds: [new EmbedBuilder().setColor(config.color.error).setDescription('❌ Join a voice channel!')] });
    const n = player.queue.length;
    player.queue.clear();
    message.reply({ embeds: [new EmbedBuilder().setColor(config.color.info).setDescription(`🗑️ Cleared **${n}** tracks!`)] });
  }

  // ── remove ────────────────────────────────────────────────────
  else if (command === 'remove') {
    const player = riffy.players.get(message.guild.id);
    if (!player || player.queue.length === 0) return message.reply({ embeds: [new EmbedBuilder().setColor(config.color.error).setDescription('❌ Queue is empty!')] });
    if (!message.member.voice.channel) return message.reply({ embeds: [new EmbedBuilder().setColor(config.color.error).setDescription('❌ Join a voice channel!')] });
    const pos = parseInt(args[1]);
    if (!pos || pos < 1 || pos > player.queue.length) {
      return message.reply({ embeds: [new EmbedBuilder().setColor(config.color.error).setDescription(`❌ Valid range: 1–${player.queue.length}`)] });
    }
    const removed = player.queue.remove(pos - 1);
    message.reply({ embeds: [new EmbedBuilder().setColor(config.color.info).setDescription(`🗑️ Removed: **${removed.info.title}**`)] });
  }

  // ── move ──────────────────────────────────────────────────────
  else if (command === 'move') {
    const player = riffy.players.get(message.guild.id);
    if (!player || player.queue.length === 0) return message.reply({ embeds: [new EmbedBuilder().setColor(config.color.error).setDescription('❌ Queue is empty!')] });
    if (!message.member.voice.channel) return message.reply({ embeds: [new EmbedBuilder().setColor(config.color.error).setDescription('❌ Join a voice channel!')] });
    const from = parseInt(args[1]), to = parseInt(args[2]);
    if (!from || !to || from < 1 || to < 1 || from > player.queue.length || to > player.queue.length) {
      return message.reply({ embeds: [new EmbedBuilder().setColor(config.color.error).setDescription(`❌ Usage: \`move <from> <to>\` (range 1–${player.queue.length})`)] });
    }
    const track = player.queue[from - 1];
    player.queue.splice(from - 1, 1);
    player.queue.splice(to - 1, 0, track);
    message.reply({ embeds: [new EmbedBuilder().setColor(config.color.info).setDescription(`📋 Moved **${track.info.title}** from #${from} to #${to}`)] });
  }

  // ── lyrics ────────────────────────────────────────────────────
  else if (command === 'lyrics') {
    const player = riffy.players.get(message.guild.id);
    let q = args.slice(1).join(' ');
    if (!q && player?.current) q = player.current.info.title;
    if (!q) return message.reply({ embeds: [new EmbedBuilder().setColor(config.color.error).setDescription('❌ Provide a song name or play something!')] });
    try {
      const res  = await fetch(`https://lrclib.net/api/search?q=${encodeURIComponent(q)}`);
      const data = await res.json();
      if (!data?.length) return message.reply({ embeds: [new EmbedBuilder().setColor(config.color.error).setDescription('❌ No lyrics found!')] });
      const song   = data[0];
      let   lyrics = song.plainLyrics || song.syncedLyrics || 'Lyrics not available';
      if (lyrics.length > 4000) lyrics = lyrics.substring(0, 4000) + '...';
      message.reply({
        embeds: [new EmbedBuilder().setColor(config.color.info).setTitle(`🎤 ${song.trackName}`)
          .setDescription(lyrics)
          .setFooter({ text: `Artist: ${song.artistName} | Album: ${song.albumName || 'Unknown'}` })]
      });
    } catch {
      message.reply({ embeds: [new EmbedBuilder().setColor(config.color.error).setDescription('❌ Failed to fetch lyrics!')] });
    }
  }

  // ── help ──────────────────────────────────────────────────────
  else if (command === 'help') {
    const inviteUrl = `https://discord.com/api/oauth2/authorize?client_id=${client.user.id}&permissions=36700160&scope=bot`;
    message.reply({
      embeds: [new EmbedBuilder().setColor(config.color.info)
        .setTitle(`🎵 ${client.user.username} Commands`)
        .setDescription(`Use \`@${client.user.username} <command>\`\n\u200b`)
        .setThumbnail(client.user.displayAvatarURL())
        .addFields(
          { name: '🎵 Music', value: '`play (p)` • `search` • `pause` • `resume (r)` • `skip (s)` • `stop (dc)`\n`queue (q)` • `clearqueue (cq)` • `shuffle (sh)` • `remove (rm)` • `move (mv)`\n`loop` • `247` • `nowplaying (np)` • `join` • `leave` • `volume (vol)` • `lyrics (ly)`', inline: false },
          { name: '🔧 Utility', value: '`ping` • `uptime (ut)` • `botinfo (bi)` • `stats` • `support` • `invite (inv)` • `vote`', inline: false },
          { name: '💡 Tip', value: 'Aliases shown in `(brackets)` are shortcuts.', inline: false }
        )
        .setFooter({ text: `Requested by ${message.author.tag}`, iconURL: message.author.displayAvatarURL() })],
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setLabel('Invite Me').setURL(inviteUrl).setStyle(ButtonStyle.Link),
        new ButtonBuilder().setLabel('Support Server').setURL(config.supportServer).setStyle(ButtonStyle.Link)
      )]
    });
  }

  // ── ping ──────────────────────────────────────────────────────
  else if (command === 'ping') {
    message.reply({
      embeds: [new EmbedBuilder().setColor(config.color.info).setTitle('🏓 Pong!')
        .addFields(
          { name: 'API Latency', value: `${Math.round(client.ws.ping)}ms`,                      inline: true },
          { name: 'Lavalink',    value: lavalinkConnected ? '✅ Connected' : '❌ Offline', inline: true }
        )]
    });
  }

  // ── uptime ────────────────────────────────────────────────────
  else if (command === 'uptime') {
    message.reply({ embeds: [new EmbedBuilder().setColor(config.color.info).setTitle('⏰ Uptime').setDescription(`\`${formatUptime(Date.now() - startTime)}\``)] });
  }

  // ── botinfo ───────────────────────────────────────────────────
  else if (command === 'botinfo') {
    message.reply({
      embeds: [new EmbedBuilder().setColor(config.color.info).setTitle(`ℹ️ ${client.user.username}`)
        .setThumbnail(client.user.displayAvatarURL())
        .addFields(
          { name: 'Bot Tag',  value: client.user.tag,                     inline: true },
          { name: 'Servers',  value: `${client.guilds.cache.size}`,        inline: true },
          { name: 'Users',    value: `${getTotalUsers()}`,                 inline: true },
          { name: 'Uptime',   value: formatUptime(Date.now() - startTime), inline: true },
          { name: 'Node.js',  value: process.version,                      inline: true },
          { name: 'Library',  value: 'discord.js',                         inline: true }
        )]
    });
  }

  // ── stats ─────────────────────────────────────────────────────
  else if (command === 'stats') {
    const mem = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2);
    message.reply({
      embeds: [new EmbedBuilder().setColor(config.color.info).setTitle('📊 Statistics')
        .addFields(
          { name: 'Servers',        value: `${client.guilds.cache.size}`,        inline: true },
          { name: 'Users',          value: `${getTotalUsers()}`,                 inline: true },
          { name: 'Active Players', value: `${riffy?.players.size || 0}`,        inline: true },
          { name: 'Memory',         value: `${mem} MB`,                          inline: true },
          { name: 'Uptime',         value: formatUptime(Date.now() - startTime), inline: true },
          { name: 'Lavalink',       value: lavalinkConnected ? '✅ Online' : '❌ Offline', inline: true }
        )]
    });
  }

  else if (command === 'support') {
    message.reply({ embeds: [new EmbedBuilder().setColor(config.color.info).setTitle('💬 Support').setDescription(`[Join here](${config.supportServer})`)] });
  } else if (command === 'invite') {
    message.reply({ embeds: [new EmbedBuilder().setColor(config.color.info).setTitle('📨 Invite').setDescription(`[Invite me](https://discord.com/api/oauth2/authorize?client_id=${client.user.id}&permissions=36700160&scope=bot)`)] });
  } else if (command === 'vote') {
    message.reply({ embeds: [new EmbedBuilder().setColor(config.color.info).setTitle('🗳️ Vote').setDescription(`[Vote on Top.gg](${config.voteLink})`)] });
  }
});

// ═══════════════════════════════════════════════════════════════
//  BUTTON HANDLER
// ═══════════════════════════════════════════════════════════════
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton()) return;

  const player = riffy?.players.get(interaction.guild.id);
  if (!player)                        return interaction.reply({ content: '❌ No music is playing!',             flags: [MessageFlags.Ephemeral] });
  if (!interaction.member.voice.channel) return interaction.reply({ content: '❌ Join a voice channel!',          flags: [MessageFlags.Ephemeral] });
  if (!player.current)                return interaction.reply({ content: '❌ No track loaded!',                  flags: [MessageFlags.Ephemeral] });
  if (interaction.user.id !== player.current.info.requester) {
    return interaction.reply({ content: '❌ Only the requester can use these buttons!', flags: [MessageFlags.Ephemeral] });
  }

  if (interaction.customId === 'pause') {
    if (player.paused) {
      player.pause(false);
      await interaction.message.edit({ components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('pause').setEmoji('⏸️').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('skip').setEmoji('⏭️').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('stop').setEmoji('⏹️').setStyle(ButtonStyle.Danger)
      )] });
      return interaction.reply({ content: '▶️ Resumed!', flags: [MessageFlags.Ephemeral] });
    } else {
      player.pause(true);
      await interaction.message.edit({ components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('pause').setEmoji('▶️').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('skip').setEmoji('⏭️').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('stop').setEmoji('⏹️').setStyle(ButtonStyle.Danger)
      )] });
      return interaction.reply({ content: '⏸️ Paused!', flags: [MessageFlags.Ephemeral] });
    }
  }

  if (interaction.customId === 'skip') {
    await disableNowPlayingMessage(player);
    player.stop();
    return interaction.reply({ content: '⏭️ Skipped!', flags: [MessageFlags.Ephemeral] });
  }

  if (interaction.customId === 'stop') {
    await disableNowPlayingMessage(player);
    player.destroy();
    playerStates.delete(interaction.guild.id);
    return interaction.reply({ content: '⏹️ Stopped!', flags: [MessageFlags.Ephemeral] });
  }
});

// ═══════════════════════════════════════════════════════════════
//  GLOBAL ERROR GUARD
// ═══════════════════════════════════════════════════════════════
process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err));

client.login(process.env.BOT_TOKEN);
