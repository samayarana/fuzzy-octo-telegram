// Patch for Riffy Node initialization error in Node.js 20+
const originalDefineProperty = Object.defineProperty;
Object.defineProperty = function(obj, prop, descriptor) {
  if (descriptor && (descriptor.get || descriptor.set) && (Object.prototype.hasOwnProperty.call(descriptor, 'value') || Object.prototype.hasOwnProperty.call(descriptor, 'writable'))) {
    const newDescriptor = { ...descriptor };
    delete newDescriptor.value;
    delete newDescriptor.writable;
    return originalDefineProperty(obj, prop, newDescriptor);
  }
  return originalDefineProperty(obj, prop, descriptor);
};

require('dotenv').config();
const { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, ActivityType, StringSelectMenuBuilder, ComponentType, MessageFlags } = require('discord.js');
const { Riffy } = require('riffy');
const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;

const config = {
  ownerId: process.env.OWNER_ID || '1092773378101882951',
  supportServer: process.env.SUPPORT_SERVER || 'https://discord.gg/su57JWf2V5',
  voteLink: process.env.VOTE_LINK || 'https://top.gg/bot/1450084513513341050/vote',
  color: { success: '#00ff00', info: '#0099ff', error: '#ff0000' }
};

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates
  ]
});

let riffy;
let lavalinkConnected = false;

try {
  riffy = new Riffy(client, [
    {
      host: process.env.LAVALINK_HOST || 'lavalink.jirayu.net',
      port: parseInt(process.env.LAVALINK_PORT) || 13592,
      password: process.env.LAVALINK_PASSWORD || 'youshallnotpass',
      secure: process.env.LAVALINK_SECURE === 'true'
    }
  ], {
    send: (payload) => {
      // CRITICAL: This is how Discord.js sends voice payloads to Discord gateway
      // Must use guild_id from the payload data
      const guildId = payload.d?.guild_id;
      if (!guildId) return;
      const guild = client.guilds.cache.get(guildId);
      if (guild) {
        console.log(`[SEND] Sending payload op=${payload.op} to guild ${guildId}`);
        guild.shard.send(payload);
      } else {
        console.warn(`[SEND] Guild ${guildId} not found in cache`);
      }
    },
    defaultSearchPlatform: 'ytmsearch',
    restVersion: 'v4'
  });
} catch (error) {
  console.error('Failed to initialize Riffy:', error.message);
}

const startTime = Date.now();
const playerStates = new Map();

app.get('/', (req, res) => {
  res.json({
    status: 'online',
    bot: client.user?.tag || 'Not Ready',
    uptime: formatUptime(Date.now() - startTime),
    servers: client.guilds.cache.size,
    users: client.users.cache.size,
    lavalink: lavalinkConnected ? 'connected' : 'disconnected'
  });
});
app.get('/health', (req, res) => res.json({ status: 'ok', uptime: Date.now() - startTime }));
app.listen(PORT, () => console.log(`Express server running on port ${PORT}`));

const commands = {
  play: ['play', 'p'],
  pause: ['pause'],
  resume: ['resume', 'r'],
  skip: ['skip', 's', 'next'],
  stop: ['stop', 'disconnect', 'dc'],
  queue: ['queue', 'q'],
  nowplaying: ['nowplaying', 'np', 'current'],
  join: ['join', 'connect'],
  leave: ['leave'],
  volume: ['volume', 'vol', 'v'],
  loop: ['loop', 'repeat'],
  autoplay: ['autoplay', 'ap'],
  shuffle: ['shuffle', 'sh'],
  clearqueue: ['clearqueue', 'cq', 'clear'],
  remove: ['remove', 'rm'],
  move: ['move', 'mv'],
  search: ['search', 'find'],
  lyrics: ['lyrics', 'ly'],
  filters: ['filters', 'filter', 'fx'],
  '247': ['247', '24/7', 'stay'],
  help: ['help', 'h', 'commands'],
  ping: ['ping'],
  uptime: ['uptime', 'ut'],
  botinfo: ['botinfo', 'bi', 'info'],
  stats: ['stats', 'statistics'],
  support: ['support'],
  invite: ['invite', 'inv'],
  vote: ['vote'],
  restart: ['restart']
};

const audioFilters = {
  '8d': { rotation: { rotationHz: 0.2 } },
  'bassboost': { equalizer: [{ band: 0, gain: 0.2 }, { band: 1, gain: 0.15 }, { band: 2, gain: 0.1 }, { band: 3, gain: 0.05 }] },
  'nightcore': { timescale: { speed: 1.3, pitch: 1.3, rate: 1 }, tremolo: { frequency: 2.0, depth: 0.5 } },
  'vaporwave': { equalizer: [{ band: 1, gain: 0.3 }, { band: 0, gain: 0.3 }], timescale: { pitch: 0.5 }, tremolo: { frequency: 14.0, depth: 0.5 } },
  'karaoke': { karaoke: { level: 1.0, monoLevel: 1.0, filterBand: 220.0, filterWidth: 100.0 } },
  'soft': { lowPass: { smoothing: 20.0 } },
  'treble': { equalizer: [{ band: 13, gain: 0.25 }, { band: 14, gain: 0.25 }] },
  'pop': { equalizer: [{ band: 0, gain: 0.15 }, { band: 1, gain: 0.1 }, { band: 2, gain: 0.05 }] },
  'party': { equalizer: [{ band: 0, gain: 0.1 }, { band: 1, gain: 0.15 }], timescale: { speed: 1.15, pitch: 1.0, rate: 1.0 } },
  'vibrato': { vibrato: { frequency: 10.0, depth: 0.9 } }
};

// ─── READY ───────────────────────────────────────────────────────────────────
client.once('ready', () => {
  if (riffy) riffy.init(client.user.id);
  client.user.setPresence({
    activities: [{ name: `@${client.user.username} help`, type: ActivityType.Listening }],
    status: 'online'
  });
  console.log(`✅ ${client.user.tag} is ready!`);
});

// ─── RAW VOICE EVENTS → LAVALINK ─────────────────────────────────────────────
// CRITICAL: Lavalink needs VOICE_SERVER_UPDATE to get the actual voice server
// endpoint + token. Without this arriving BEFORE play(), audio never starts.
client.on('raw', (d) => {
  if (d.t === 'VOICE_STATE_UPDATE' || d.t === 'VOICE_SERVER_UPDATE') {
    console.log(`[RAW] ${d.t} guildId=${d.d?.guild_id} endpoint=${d.d?.endpoint || 'n/a'}`);
    if (riffy) riffy.updateVoiceState(d);
  }
});

// ─── RIFFY EVENTS ─────────────────────────────────────────────────────────────
if (riffy) {
  riffy.on('nodeConnect', (node) => {
    lavalinkConnected = true;
    console.log(`✅ Lavalink node "${node.name}" connected`);
  });

  riffy.on('nodeError', (node, error) => {
    lavalinkConnected = false;
    console.error(`❌ Lavalink node "${node.name}" error:`, error.message);
  });

  riffy.on('nodeDisconnect', (node) => {
    lavalinkConnected = false;
    console.warn(`⚠️ Lavalink node "${node.name}" disconnected`);
  });

  riffy.on('trackStart', async (player, track) => {
    console.log(`▶️ trackStart: "${track.info.title}" | guild=${player.guildId} | vc=${player.voiceChannel} | connected=${player.connected}`);
    const channel = client.channels.cache.get(player.textChannel);
    if (!channel) return;

    if (player.nowPlayingMessage) {
      try { await player.nowPlayingMessage.delete(); } catch (_) {}
    }

    const embed = new EmbedBuilder()
      .setColor(config.color.success)
      .setTitle('🎵 Now Playing')
      .setDescription(`[${track.info.title}](${track.info.uri})`)
      .setThumbnail(track.info.thumbnail || track.info.artworkUrl || null)
      .addFields(
        { name: 'Artist', value: track.info.author || 'Unknown', inline: true },
        { name: 'Duration', value: formatTime(track.info.length), inline: true },
        { name: 'Requested by', value: `<@${track.info.requester}>`, inline: true }
      );

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('pause').setEmoji('⏸️').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('skip').setEmoji('⏭️').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('stop').setEmoji('⏹️').setStyle(ButtonStyle.Danger)
    );

    player.nowPlayingMessage = await channel.send({ embeds: [embed], components: [row] });
  });

  riffy.on('trackError', async (player, track, error) => {
    console.error(`❌ trackError: "${track?.info?.title}" | error:`, error);
    const channel = client.channels.cache.get(player.textChannel);
    if (channel) {
      await channel.send({ embeds: [new EmbedBuilder()
        .setColor(config.color.error)
        .setDescription(`❌ Error playing **${track?.info?.title}**: \`${error?.message || JSON.stringify(error)}\`\nSkipping...`)] });
    }
    if (player.queue.length > 0) player.stop();
    else { player.destroy(); playerStates.delete(player.guildId); }
  });

  riffy.on('trackStuck', async (player, track) => {
    console.warn(`⚠️ trackStuck: "${track?.info?.title}"`);
    const channel = client.channels.cache.get(player.textChannel);
    if (channel) {
      await channel.send({ embeds: [new EmbedBuilder()
        .setColor(config.color.error)
        .setDescription(`⚠️ Track **${track?.info?.title}** got stuck. Skipping...`)] });
    }
    player.stop();
  });

  riffy.on('queueEnd', async (player) => {
    console.log(`📭 queueEnd | guild=${player.guildId}`);
    const channel = client.channels.cache.get(player.textChannel);
    const state = playerStates.get(player.guildId);

    if (player.nowPlayingMessage) {
      try {
        await player.nowPlayingMessage.edit({ components: [new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('pause').setEmoji('⏸️').setStyle(ButtonStyle.Primary).setDisabled(true),
          new ButtonBuilder().setCustomId('skip').setEmoji('⏭️').setStyle(ButtonStyle.Primary).setDisabled(true),
          new ButtonBuilder().setCustomId('stop').setEmoji('⏹️').setStyle(ButtonStyle.Danger).setDisabled(true)
        )] });
      } catch (_) {}
    }

    if (state?.autoplay) {
      try {
        const track = player.current;
        if (!track) return;
        const search = await riffy.resolve({ query: `${track.info.author} ${track.info.title}`, requester: track.info.requester });
        if (search?.tracks?.length > 0) {
          const next = search.tracks.slice(0, 5).find(t => t.info.identifier !== track.info.identifier);
          if (next) {
            next.info.requester = track.info.requester;
            player.queue.add(next);
            if (!player.playing && !player.paused) player.play();
            if (channel) channel.send(`🔄 **Autoplay:** Added **${next.info.title}**`);
            return;
          }
        }
      } catch (e) { console.error('Autoplay error:', e); }
    }

    if (state?.stay247) {
      if (channel) channel.send('✅ Queue ended. Staying in voice channel (24/7 mode).');
      return;
    }

    if (channel) channel.send('✅ Queue ended. Leaving voice channel.');
    player.destroy();
    playerStates.delete(player.guildId);
  });
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function getCommand(input) {
  for (const [cmd, aliases] of Object.entries(commands)) {
    if (aliases.includes(input)) return cmd;
  }
  return null;
}

function formatTime(ms) {
  const s = Math.floor((ms / 1000) % 60);
  const m = Math.floor((ms / 60000) % 60);
  const h = Math.floor(ms / 3600000);
  return h > 0 ? `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}` : `${m}:${String(s).padStart(2,'0')}`;
}

function formatUptime(ms) {
  const parts = [];
  const d = Math.floor(ms / 86400000); if (d) parts.push(`${d}d`);
  const h = Math.floor((ms % 86400000) / 3600000); if (h) parts.push(`${h}h`);
  const m = Math.floor((ms % 3600000) / 60000); if (m) parts.push(`${m}m`);
  const s = Math.floor((ms % 60000) / 1000); if (s) parts.push(`${s}s`);
  return parts.join(' ') || '0s';
}

// FIXED: Create player then wait for BOTH voice state AND voice server events
// before resolving. Without waiting for VOICE_SERVER_UPDATE specifically,
// Lavalink doesn't have an endpoint to stream audio to.
async function getOrCreatePlayer(message) {
  let player = riffy.players.get(message.guild.id);

  if (!player) {
    player = riffy.createConnection({
      guildId: message.guild.id,
      voiceChannel: message.member.voice.channel.id,
      textChannel: message.channel.id,
      deaf: true
    });

    // Wait for VOICE_SERVER_UPDATE to arrive — this carries the endpoint
    // Lavalink needs. We listen on the raw event with a one-time handler.
    await new Promise((resolve) => {
      const timeout = setTimeout(resolve, 5000); // 5s max wait
      const handler = (d) => {
        if (d.t === 'VOICE_SERVER_UPDATE' && d.d?.guild_id === message.guild.id) {
          console.log(`[CONNECT] VOICE_SERVER_UPDATE received for guild ${message.guild.id} — endpoint: ${d.d.endpoint}`);
          client.removeListener('raw', handler);
          clearTimeout(timeout);
          // Small buffer so Riffy finishes processing the event
          setTimeout(resolve, 300);
        }
      };
      client.on('raw', handler);
    });

    console.log(`[CONNECT] Player ready for guild ${message.guild.id}`);
  } else if (player.voiceChannel !== message.member.voice.channel.id) {
    player.voiceChannel = message.member.voice.channel.id;
  }

  player.textChannel = message.channel.id;
  return player;
}

// ─── MESSAGE HANDLER ──────────────────────────────────────────────────────────
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  if (message.content.trim() === `<@!${client.user.id}>` || message.content.trim() === `<@${client.user.id}>`) {
    return message.reply({ embeds: [new EmbedBuilder()
      .setColor(config.color.info)
      .setTitle(`🎵 ${client.user.username}`)
      .setDescription(`Hello! Use \`@${client.user.username} help\` to see all commands.`)] });
  }

  if (!message.mentions.has(client.user.id)) return;

  const args = message.content.split(' ').slice(1);
  const input = args[0]?.toLowerCase();
  const command = getCommand(input);
  if (!command) return;

  // RESTART
  if (command === 'restart') {
    if (message.author.id !== config.ownerId) {
      return message.reply({ embeds: [new EmbedBuilder().setColor(config.color.error).setDescription('❌ Owner only!')] });
    }
    await message.reply({ embeds: [new EmbedBuilder().setColor(config.color.info).setDescription('🔄 Restarting...')] });
    await client.destroy();
    process.exit(0);
  }

  const musicCommands = ['play','pause','resume','skip','stop','queue','nowplaying','volume','loop','autoplay','shuffle','clearqueue','remove','move','search','lyrics','filters','join','leave'];
  if (musicCommands.includes(command) && !lavalinkConnected) {
    return message.reply({ embeds: [new EmbedBuilder().setColor(config.color.error).setTitle('❌ Lavalink Offline').setDescription('Music is currently unavailable.')] });
  }

  // PLAY
  if (command === 'play') {
    if (!message.member.voice.channel) {
      return message.reply({ embeds: [new EmbedBuilder().setColor(config.color.error).setDescription('❌ Join a voice channel first!')] });
    }
    const query = args.slice(1).join(' ');
    if (!query) {
      return message.reply({ embeds: [new EmbedBuilder().setColor(config.color.error).setDescription('❌ Provide a song name or URL!')] });
    }

    try {
      const resolve = await riffy.resolve({ query, requester: message.author.id });
      if (!resolve || resolve.loadType === 'error' || resolve.loadType === 'empty') {
        return message.reply({ embeds: [new EmbedBuilder().setColor(config.color.error).setDescription('❌ No results found!')] });
      }

      // Create player and wait for voice server handshake BEFORE adding tracks
      const player = await getOrCreatePlayer(message);

      if (resolve.loadType === 'playlist') {
        for (const t of resolve.tracks) {
          t.info.requester = message.author.id;
          player.queue.add(t);
        }
        await message.reply({ embeds: [new EmbedBuilder()
          .setColor(config.color.info)
          .setTitle('📃 Playlist Added')
          .setDescription(`**${resolve.playlistInfo.name}** — ${resolve.tracks.length} tracks`)] });
      } else {
        const track = resolve.tracks[0];
        track.info.requester = message.author.id;
        player.queue.add(track);
        await message.reply({ embeds: [new EmbedBuilder()
          .setColor(config.color.info)
          .setTitle('✅ Added to Queue')
          .setDescription(`[${track.info.title}](${track.info.uri})`)
          .setThumbnail(track.info.thumbnail || track.info.artworkUrl || null)
          .addFields(
            { name: 'Artist', value: track.info.author || 'Unknown', inline: true },
            { name: 'Duration', value: formatTime(track.info.length), inline: true },
            { name: 'Position', value: `${player.queue.length}`, inline: true }
          )] });
      }

      if (!player.playing && !player.paused) {
        console.log(`[PLAY] Calling player.play() for guild ${message.guild.id}`);
        player.play();
      }
    } catch (err) {
      console.error('[PLAY ERROR]', err);
      message.reply({ embeds: [new EmbedBuilder().setColor(config.color.error).setDescription(`❌ Error: ${err.message || 'Unknown'}`)] });
    }
  }

  // SEARCH
  if (command === 'search') {
    if (!message.member.voice.channel) {
      return message.reply({ embeds: [new EmbedBuilder().setColor(config.color.error).setDescription('❌ Join a voice channel first!')] });
    }
    const query = args.slice(1).join(' ');
    if (!query) return message.reply({ embeds: [new EmbedBuilder().setColor(config.color.error).setDescription('❌ Provide a search query!')] });

    try {
      const resolve = await riffy.resolve({ query });
      if (!resolve || resolve.loadType === 'error' || resolve.loadType === 'empty') {
        return message.reply({ embeds: [new EmbedBuilder().setColor(config.color.error).setDescription('❌ No results found!')] });
      }

      const tracks = resolve.tracks.slice(0, 10);
      const row = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('search_select')
          .setPlaceholder('Select a song to play')
          .addOptions(tracks.map((t, i) => ({
            label: t.info.title.substring(0, 100),
            description: `${t.info.author} - ${formatTime(t.info.length)}`.substring(0, 100),
            value: `search_${i}`
          })))
      );

      const msg = await message.reply({ embeds: [new EmbedBuilder()
        .setColor(config.color.info)
        .setTitle('🔍 Search Results')
        .setDescription(tracks.map((t, i) => `**${i+1}.** [${t.info.title}](${t.info.uri})\n${t.info.author} - ${formatTime(t.info.length)}`).join('\n\n'))
        .setFooter({ text: 'Select from the dropdown' })], components: [row] });

      const collector = msg.createMessageComponentCollector({ componentType: ComponentType.StringSelect, time: 60000 });
      collector.on('collect', async (i) => {
        if (i.user.id !== message.author.id) return i.reply({ content: '❌ Not your search!', flags: [MessageFlags.Ephemeral] });
        const selected = tracks[parseInt(i.values[0].split('_')[1])];
        const player = await getOrCreatePlayer(message);
        selected.info.requester = message.author.id;
        player.queue.add(selected);
        await i.update({ embeds: [new EmbedBuilder().setColor(config.color.success).setDescription(`✅ Added **${selected.info.title}** to queue!`)], components: [] });
        if (!player.playing && !player.paused) player.play();
        collector.stop();
      });
      collector.on('end', () => msg.edit({ components: [] }).catch(() => {}));
    } catch (err) {
      message.reply({ embeds: [new EmbedBuilder().setColor(config.color.error).setDescription('❌ Search error.')] });
    }
  }

  // PAUSE
  if (command === 'pause') {
    const player = riffy.players.get(message.guild.id);
    if (!player) return message.reply({ embeds: [new EmbedBuilder().setColor(config.color.error).setDescription('❌ Nothing playing!')] });
    if (!message.member.voice.channel) return message.reply({ embeds: [new EmbedBuilder().setColor(config.color.error).setDescription('❌ Join a voice channel!')] });
    player.pause(true);
    message.reply({ embeds: [new EmbedBuilder().setColor(config.color.info).setDescription('⏸️ Paused!')] });
  }

  // RESUME
  if (command === 'resume') {
    const player = riffy.players.get(message.guild.id);
    if (!player) return message.reply({ embeds: [new EmbedBuilder().setColor(config.color.error).setDescription('❌ Nothing playing!')] });
    if (!message.member.voice.channel) return message.reply({ embeds: [new EmbedBuilder().setColor(config.color.error).setDescription('❌ Join a voice channel!')] });
    player.pause(false);
    message.reply({ embeds: [new EmbedBuilder().setColor(config.color.info).setDescription('▶️ Resumed!')] });
  }

  // SKIP
  if (command === 'skip') {
    const player = riffy.players.get(message.guild.id);
    if (!player) return message.reply({ embeds: [new EmbedBuilder().setColor(config.color.error).setDescription('❌ Nothing playing!')] });
    if (!message.member.voice.channel) return message.reply({ embeds: [new EmbedBuilder().setColor(config.color.error).setDescription('❌ Join a voice channel!')] });
    const title = player.current?.info?.title || 'Unknown';
    player.stop();
    if (player.nowPlayingMessage) {
      try { await player.nowPlayingMessage.edit({ components: [disabledRow()] }); } catch (_) {}
    }
    message.reply({ embeds: [new EmbedBuilder().setColor(config.color.info).setDescription(`⏭️ Skipped: **${title}**`)] });
  }

  // STOP
  if (command === 'stop') {
    const player = riffy.players.get(message.guild.id);
    if (!player) return message.reply({ embeds: [new EmbedBuilder().setColor(config.color.error).setDescription('❌ Nothing playing!')] });
    if (!message.member.voice.channel) return message.reply({ embeds: [new EmbedBuilder().setColor(config.color.error).setDescription('❌ Join a voice channel!')] });
    if (player.nowPlayingMessage) { try { await player.nowPlayingMessage.edit({ components: [disabledRow()] }); } catch (_) {} }
    player.destroy();
    playerStates.delete(message.guild.id);
    message.reply({ embeds: [new EmbedBuilder().setColor(config.color.info).setDescription('⏹️ Stopped and disconnected!')] });
  }

  // QUEUE
  if (command === 'queue') {
    const player = riffy.players.get(message.guild.id);
    if (!player?.current) return message.reply({ embeds: [new EmbedBuilder().setColor(config.color.error).setDescription('❌ Nothing playing!')] });
    const state = playerStates.get(message.guild.id);
    message.reply({ embeds: [new EmbedBuilder()
      .setColor(config.color.info)
      .setTitle('🎵 Queue')
      .setDescription(`**Now Playing:**\n[${player.current.info.title}](${player.current.info.uri})\n\n**Up Next:**\n${
        player.queue.length > 0
          ? player.queue.slice(0, 10).map((t, i) => `\`${i+1}.\` [${t.info.title}](${t.info.uri})`).join('\n')
          : 'Empty'
      }${player.queue.length > 10 ? `\n\n*+${player.queue.length - 10} more*` : ''}`)
      .setFooter({ text: `Tracks: ${player.queue.length + 1} | Loop: ${state?.loop || 'off'} | 24/7: ${state?.stay247 ? 'on' : 'off'}` })] });
  }

  // NOW PLAYING
  if (command === 'nowplaying') {
    const player = riffy.players.get(message.guild.id);
    if (!player?.current) return message.reply({ embeds: [new EmbedBuilder().setColor(config.color.error).setDescription('❌ Nothing playing!')] });
    const track = player.current;
    const pos = player.position || 0;
    const len = track.info.length;
    const prog = Math.min(Math.floor((pos / len) * 20), 20);
    message.reply({ embeds: [new EmbedBuilder()
      .setColor(config.color.info)
      .setTitle('🎵 Now Playing')
      .setDescription(`[${track.info.title}](${track.info.uri})`)
      .setThumbnail(track.info.thumbnail || track.info.artworkUrl || null)
      .addFields(
        { name: 'Artist', value: track.info.author || 'Unknown', inline: true },
        { name: 'Duration', value: `${formatTime(pos)} / ${formatTime(len)}`, inline: true },
        { name: 'Status', value: player.paused ? '⏸️ Paused' : '▶️ Playing', inline: true },
        { name: 'Progress', value: '▬'.repeat(prog) + '🔘' + '▬'.repeat(20 - prog), inline: false },
        { name: 'Requested by', value: `<@${track.info.requester}>`, inline: true },
        { name: 'Volume', value: `${player.volume}%`, inline: true }
      )] });
  }

  // JOIN
  if (command === 'join') {
    if (!message.member.voice.channel) return message.reply({ embeds: [new EmbedBuilder().setColor(config.color.error).setDescription('❌ Join a voice channel!')] });
    if (riffy.players.get(message.guild.id)) return message.reply({ embeds: [new EmbedBuilder().setColor(config.color.error).setDescription('❌ Already connected!')] });
    await getOrCreatePlayer(message);
    message.reply({ embeds: [new EmbedBuilder().setColor(config.color.success).setDescription(`✅ Joined **${message.member.voice.channel.name}**`)] });
  }

  // LEAVE
  if (command === 'leave') {
    const player = riffy.players.get(message.guild.id);
    if (!player) return message.reply({ embeds: [new EmbedBuilder().setColor(config.color.error).setDescription('❌ Not connected!')] });
    player.destroy();
    playerStates.delete(message.guild.id);
    message.reply({ embeds: [new EmbedBuilder().setColor(config.color.info).setDescription('👋 Disconnected!')] });
  }

  // VOLUME
  if (command === 'volume') {
    const player = riffy.players.get(message.guild.id);
    if (!player) return message.reply({ embeds: [new EmbedBuilder().setColor(config.color.error).setDescription('❌ Nothing playing!')] });
    const vol = parseInt(args[1]);
    if (isNaN(vol) || vol < 0 || vol > 100) {
      return message.reply({ embeds: [new EmbedBuilder().setColor(config.color.info).setDescription(`🔊 Current volume: **${player.volume}%**\nUsage: \`@bot volume <0-100>\``)] });
    }
    player.setVolume(vol);
    message.reply({ embeds: [new EmbedBuilder().setColor(config.color.info).setDescription(`🔊 Volume: **${vol}%**`)] });
  }

  // LOOP
  if (command === 'loop') {
    const player = riffy.players.get(message.guild.id);
    if (!player?.current) return message.reply({ embeds: [new EmbedBuilder().setColor(config.color.error).setDescription('❌ Nothing playing!')] });
    const state = playerStates.get(message.guild.id) || {};
    const modes = ['off', 'track', 'queue'];
    const next = modes[(modes.indexOf(state.loop || 'off') + 1) % modes.length];
    state.loop = next;
    playerStates.set(message.guild.id, state);
    player.setLoop(next === 'off' ? 'none' : next);
    const emoji = { off: '➡️', track: '🔂', queue: '🔁' };
    const desc = { off: 'disabled', track: 'current track', queue: 'entire queue' };
    message.reply({ embeds: [new EmbedBuilder().setColor(config.color.info).setDescription(`${emoji[next]} Loop: **${desc[next]}**`)] });
  }

  // 24/7
  if (command === '247') {
    const player = riffy.players.get(message.guild.id);
    if (!player) return message.reply({ embeds: [new EmbedBuilder().setColor(config.color.error).setDescription('❌ Nothing playing!')] });
    const state = playerStates.get(message.guild.id) || {};
    state.stay247 = !state.stay247;
    playerStates.set(message.guild.id, state);
    message.reply({ embeds: [new EmbedBuilder().setColor(config.color.info).setDescription(`🎵 24/7 Mode: **${state.stay247 ? 'enabled' : 'disabled'}**`)] });
  }

  // AUTOPLAY
  if (command === 'autoplay') {
    const player = riffy.players.get(message.guild.id);
    if (!player?.current) return message.reply({ embeds: [new EmbedBuilder().setColor(config.color.error).setDescription('❌ Nothing playing!')] });
    if (message.author.id !== player.current.info.requester) return message.reply({ embeds: [new EmbedBuilder().setColor(config.color.error).setDescription('❌ Only the requester can toggle autoplay!')] });
    const state = playerStates.get(message.guild.id) || {};
    state.autoplay = !state.autoplay;
    playerStates.set(message.guild.id, state);
    message.reply({ embeds: [new EmbedBuilder().setColor(config.color.info).setDescription(`🔄 Autoplay: **${state.autoplay ? 'enabled' : 'disabled'}**`)] });
  }

  // SHUFFLE
  if (command === 'shuffle') {
    const player = riffy.players.get(message.guild.id);
    if (!player || player.queue.length === 0) return message.reply({ embeds: [new EmbedBuilder().setColor(config.color.error).setDescription('❌ Queue is empty!')] });
    player.queue.shuffle();
    message.reply({ embeds: [new EmbedBuilder().setColor(config.color.info).setDescription(`🔀 Shuffled **${player.queue.length}** tracks!`)] });
  }

  // CLEARQUEUE
  if (command === 'clearqueue') {
    const player = riffy.players.get(message.guild.id);
    if (!player || player.queue.length === 0) return message.reply({ embeds: [new EmbedBuilder().setColor(config.color.error).setDescription('❌ Queue is empty!')] });
    const count = player.queue.length;
    player.queue.clear();
    message.reply({ embeds: [new EmbedBuilder().setColor(config.color.info).setDescription(`🗑️ Cleared **${count}** tracks!`)] });
  }

  // REMOVE
  if (command === 'remove') {
    const player = riffy.players.get(message.guild.id);
    if (!player || player.queue.length === 0) return message.reply({ embeds: [new EmbedBuilder().setColor(config.color.error).setDescription('❌ Queue is empty!')] });
    const pos = parseInt(args[1]);
    if (!pos || pos < 1 || pos > player.queue.length) return message.reply({ embeds: [new EmbedBuilder().setColor(config.color.error).setDescription(`❌ Valid range: 1-${player.queue.length}`)] });
    const removed = player.queue.remove(pos - 1);
    message.reply({ embeds: [new EmbedBuilder().setColor(config.color.info).setDescription(`🗑️ Removed: **${removed.info.title}**`)] });
  }

  // MOVE
  if (command === 'move') {
    const player = riffy.players.get(message.guild.id);
    if (!player || player.queue.length === 0) return message.reply({ embeds: [new EmbedBuilder().setColor(config.color.error).setDescription('❌ Queue is empty!')] });
    const from = parseInt(args[1]), to = parseInt(args[2]);
    if (!from || !to || from < 1 || to < 1 || from > player.queue.length || to > player.queue.length) {
      return message.reply({ embeds: [new EmbedBuilder().setColor(config.color.error).setDescription(`❌ Usage: \`move <from> <to>\` (range: 1-${player.queue.length})`)] });
    }
    const track = player.queue[from - 1];
    player.queue.splice(from - 1, 1);
    player.queue.splice(to - 1, 0, track);
    message.reply({ embeds: [new EmbedBuilder().setColor(config.color.info).setDescription(`📋 Moved **${track.info.title}** → position ${to}`)] });
  }

  // LYRICS
  if (command === 'lyrics') {
    const player = riffy.players.get(message.guild.id);
    let q = args.slice(1).join(' ') || player?.current?.info?.title;
    if (!q) return message.reply({ embeds: [new EmbedBuilder().setColor(config.color.error).setDescription('❌ Provide a song name!')] });
    try {
      const res = await fetch(`https://lrclib.net/api/search?q=${encodeURIComponent(q)}`);
      const data = await res.json();
      if (!data?.length) return message.reply({ embeds: [new EmbedBuilder().setColor(config.color.error).setDescription('❌ No lyrics found!')] });
      const song = data[0];
      let lyrics = song.plainLyrics || song.syncedLyrics || 'Unavailable';
      if (lyrics.length > 4000) lyrics = lyrics.substring(0, 4000) + '...';
      message.reply({ embeds: [new EmbedBuilder().setColor(config.color.info).setTitle(`🎤 ${song.trackName}`).setDescription(lyrics).setFooter({ text: `${song.artistName} | ${song.albumName || 'Unknown album'}` })] });
    } catch { message.reply({ embeds: [new EmbedBuilder().setColor(config.color.error).setDescription('❌ Failed to fetch lyrics!')] }); }
  }

  // FILTERS
  if (command === 'filters') {
    const player = riffy.players.get(message.guild.id);
    if (!player?.current) return message.reply({ embeds: [new EmbedBuilder().setColor(config.color.error).setDescription('❌ Nothing playing!')] });
    if (message.author.id !== player.current.info.requester) return message.reply({ embeds: [new EmbedBuilder().setColor(config.color.error).setDescription('❌ Only the requester can use filters!')] });

    const options = [...Object.keys(audioFilters).map(name => ({ label: name.charAt(0).toUpperCase() + name.slice(1), description: `Apply ${name} filter`, value: `filter_${name}` })),
      { label: 'Clear Filters', description: 'Remove all filters', value: 'filter_clear' }];

    const row = new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('filter_select').setPlaceholder('Select a filter').addOptions(options));
    const msg = await message.reply({ embeds: [new EmbedBuilder().setColor(config.color.info).setTitle('🎚️ Audio Filters').setDescription(Object.keys(audioFilters).map(f => `• **${f}**`).join('\n')).setFooter({ text: 'Expires in 5 minutes' })], components: [row] });

    const collector = msg.createMessageComponentCollector({ componentType: ComponentType.StringSelect, time: 300000 });
    collector.on('collect', async (i) => {
      if (i.user.id !== message.author.id) return i.reply({ content: '❌ Not your menu!', flags: [MessageFlags.Ephemeral] });
      const name = i.values[0].replace('filter_', '');
      try {
        await player.node.rest.updatePlayer({ guildId: player.guildId, data: { filters: name === 'clear' ? {} : audioFilters[name] } });
        await i.reply({ content: name === 'clear' ? '✅ Cleared all filters!' : `✅ Applied **${name}** filter!`, flags: [MessageFlags.Ephemeral] });
      } catch (err) {
        await i.reply({ content: `❌ Failed: ${err.message}`, flags: [MessageFlags.Ephemeral] });
      }
    });
    collector.on('end', () => msg.edit({ components: [] }).catch(() => {}));
  }

  // HELP
  if (command === 'help') {
    const inviteUrl = `https://discord.com/api/oauth2/authorize?client_id=${client.user.id}&permissions=36700160&scope=bot`;
    message.reply({ embeds: [new EmbedBuilder()
      .setColor(config.color.info)
      .setTitle(`🎵 ${client.user.username} Commands`)
      .setDescription(`\`@${client.user.username} <command>\`\n\u200b`)
      .setThumbnail(client.user.displayAvatarURL())
      .addFields(
        { name: '🎵 Music', value: '`play` `search` `pause` `resume` `skip` `stop`\n`queue` `clearqueue` `shuffle` `remove` `move`\n`loop` `autoplay` `247` `filters` `nowplaying`\n`join` `leave` `volume` `lyrics`', inline: false },
        { name: '🔧 Utility', value: '`ping` `uptime` `botinfo` `stats` `support` `invite` `vote`', inline: false }
      )
      .setFooter({ text: `Requested by ${message.author.tag}`, iconURL: message.author.displayAvatarURL() })],
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setLabel('Invite Me').setURL(inviteUrl).setStyle(ButtonStyle.Link),
        new ButtonBuilder().setLabel('Support Server').setURL(config.supportServer).setStyle(ButtonStyle.Link)
      )] });
  }

  // PING
  if (command === 'ping') {
    message.reply({ embeds: [new EmbedBuilder().setColor(config.color.info).setTitle('🏓 Pong!')
      .addFields({ name: 'API Latency', value: `${Math.round(client.ws.ping)}ms`, inline: true }, { name: 'Lavalink', value: lavalinkConnected ? '✅ Connected' : '❌ Offline', inline: true })] });
  }

  // UPTIME
  if (command === 'uptime') {
    message.reply({ embeds: [new EmbedBuilder().setColor(config.color.info).setTitle('⏰ Uptime').setDescription(`\`${formatUptime(Date.now() - startTime)}\``)] });
  }

  // BOTINFO
  if (command === 'botinfo') {
    message.reply({ embeds: [new EmbedBuilder().setColor(config.color.info).setTitle(`ℹ️ ${client.user.username}`)
      .setThumbnail(client.user.displayAvatarURL())
      .addFields(
        { name: 'Tag', value: client.user.tag, inline: true },
        { name: 'Servers', value: `${client.guilds.cache.size}`, inline: true },
        { name: 'Uptime', value: formatUptime(Date.now() - startTime), inline: true },
        { name: 'Node.js', value: process.version, inline: true },
        { name: 'Library', value: 'discord.js', inline: true }
      )] });
  }

  // STATS
  if (command === 'stats') {
    const mem = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2);
    message.reply({ embeds: [new EmbedBuilder().setColor(config.color.info).setTitle('📊 Statistics')
      .addFields(
        { name: 'Servers', value: `${client.guilds.cache.size}`, inline: true },
        { name: 'Active Players', value: `${riffy?.players.size || 0}`, inline: true },
        { name: 'Memory', value: `${mem} MB`, inline: true },
        { name: 'Uptime', value: formatUptime(Date.now() - startTime), inline: true },
        { name: 'Lavalink', value: lavalinkConnected ? '✅ Online' : '❌ Offline', inline: true }
      )] });
  }

  if (command === 'support') message.reply({ embeds: [new EmbedBuilder().setColor(config.color.info).setTitle('💬 Support').setDescription(`[Join here](${config.supportServer})`)] });
  if (command === 'invite') message.reply({ embeds: [new EmbedBuilder().setColor(config.color.info).setTitle('📨 Invite').setDescription(`[Click here](https://discord.com/api/oauth2/authorize?client_id=${client.user.id}&permissions=36700160&scope=bot)`)] });
  if (command === 'vote') message.reply({ embeds: [new EmbedBuilder().setColor(config.color.info).setTitle('🗳️ Vote').setDescription(`[Vote on Top.gg](${config.voteLink})`)] });
});

// ─── BUTTON INTERACTIONS ──────────────────────────────────────────────────────
function disabledRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('pause').setEmoji('⏸️').setStyle(ButtonStyle.Primary).setDisabled(true),
    new ButtonBuilder().setCustomId('skip').setEmoji('⏭️').setStyle(ButtonStyle.Primary).setDisabled(true),
    new ButtonBuilder().setCustomId('stop').setEmoji('⏹️').setStyle(ButtonStyle.Danger).setDisabled(true)
  );
}

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton()) return;
  const player = riffy?.players.get(interaction.guild.id);
  if (!player) return interaction.reply({ content: '❌ Nothing playing!', flags: [MessageFlags.Ephemeral] });
  if (!interaction.member.voice.channel) return interaction.reply({ content: '❌ Join a voice channel!', flags: [MessageFlags.Ephemeral] });
  if (interaction.user.id !== player.current?.info?.requester) return interaction.reply({ content: '❌ Only the requester can use these!', flags: [MessageFlags.Ephemeral] });

  if (interaction.customId === 'pause') {
    if (player.paused) {
      player.pause(false);
      await interaction.message.edit({ components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('pause').setEmoji('⏸️').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('skip').setEmoji('⏭️').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('stop').setEmoji('⏹️').setStyle(ButtonStyle.Danger)
      )] });
      await interaction.reply({ content: '▶️ Resumed!', flags: [MessageFlags.Ephemeral] });
    } else {
      player.pause(true);
      await interaction.message.edit({ components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('pause').setEmoji('▶️').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('skip').setEmoji('⏭️').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('stop').setEmoji('⏹️').setStyle(ButtonStyle.Danger)
      )] });
      await interaction.reply({ content: '⏸️ Paused!', flags: [MessageFlags.Ephemeral] });
    }
  }

  if (interaction.customId === 'skip') {
    player.stop();
    await interaction.message.edit({ components: [disabledRow()] });
    await interaction.reply({ content: '⏭️ Skipped!', flags: [MessageFlags.Ephemeral] });
  }

  if (interaction.customId === 'stop') {
    player.destroy();
    playerStates.delete(interaction.guild.id);
    await interaction.message.edit({ components: [disabledRow()] });
    await interaction.reply({ content: '⏹️ Stopped!', flags: [MessageFlags.Ephemeral] });
  }
});

process.on('unhandledRejection', error => console.error('Unhandled rejection:', error));

client.login(process.env.BOT_TOKEN);
