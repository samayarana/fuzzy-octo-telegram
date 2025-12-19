require('dotenv').config();
const { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, ActivityType, StringSelectMenuBuilder, ComponentType } = require('discord.js');
const { Riffy } = require('riffy');
const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;

// Configuration
const config = {
  ownerId: process.env.OWNER_ID || '1092773378101882951',
  supportServer: process.env.SUPPORT_SERVER || 'https://discord.gg/MpXyChY5yw',
  voteLink: process.env.VOTE_LINK || 'https://top.gg/bot/1450084513513341050/vote',
  color: {
    success: '#00ff00',
    info: '#0099ff',
    error: '#ff0000'
  }
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

// Initialize Riffy with error handling
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
      const guild = client.guilds.cache.get(payload.d.guild_id);
      if (guild) guild.shard.send(payload);
    },
    defaultSearchPlatform: 'ytmsearch',
    restVersion: 'v4'
  });
} catch (error) {
  console.error('Failed to initialize Riffy:', error.message);
}

const startTime = Date.now();

// Player states for 24/7 and autoplay
const playerStates = new Map();

// Express Server
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

app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: Date.now() - startTime });
});

app.listen(PORT, () => {
  console.log(`Express server running on port ${PORT}`);
});

// Command aliases
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

// Available filters
const filters = {
  '8d': { rotation: { rotationHz: 0.2 } },
  'bassboost': { equalizer: [
    { band: 0, gain: 0.2 },
    { band: 1, gain: 0.15 },
    { band: 2, gain: 0.1 },
    { band: 3, gain: 0.05 }
  ]},
  'nightcore': { timescale: { speed: 1.3, pitch: 1.3, rate: 1 }, tremolo: { frequency: 2.0, depth: 0.5 } },
  'vaporwave': { equalizer: [{ band: 1, gain: 0.3 }, { band: 0, gain: 0.3 }], timescale: { pitch: 0.5 }, tremolo: { frequency: 14.0, depth: 0.5 } },
  'karaoke': { karaoke: { level: 1.0, monoLevel: 1.0, filterBand: 220.0, filterWidth: 100.0 } },
  'soft': { lowPass: { smoothing: 20.0 } },
  'treble': { equalizer: [{ band: 13, gain: 0.25 }, { band: 14, gain: 0.25 }] },
  'pop': { equalizer: [
    { band: 0, gain: 0.15 },
    { band: 1, gain: 0.1 },
    { band: 2, gain: 0.05 }
  ]},
  'party': { equalizer: [
    { band: 0, gain: 0.1 },
    { band: 1, gain: 0.15 }
  ], timescale: { speed: 1.15, pitch: 1.0, rate: 1.0 } },
  'vibrato': { vibrato: { frequency: 10.0, depth: 0.9 } }
};

client.once('ready', () => {
  if (riffy) riffy.init(client.user.id);

  client.user.setPresence({
    activities: [{ name: `@${client.user.username} help`, type: ActivityType.Listening }],
    status: 'online'
  });

  console.log(`${client.user.tag} is ready!`);
});

// Raw event handler for voice state updates
client.on('raw', (d) => {
  if (riffy) riffy.updateVoiceState(d);
});

// Riffy Events
if (riffy) {
  riffy.on('nodeConnect', (node) => {
    lavalinkConnected = true;
    console.log(`Node ${node.name} connected`);
  });

  riffy.on('nodeError', (node, error) => {
    lavalinkConnected = false;
    console.log(`Node ${node.name} error: ${error.message}`);
  });

  riffy.on('nodeDisconnect', (node) => {
    lavalinkConnected = false;
    console.log(`Node ${node.name} disconnected`);
  });

  riffy.on('trackStart', async (player, track) => {
    const channel = client.channels.cache.get(player.textChannel);
    if (!channel) return;

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

    const msg = await channel.send({ embeds: [embed], components: [row] });
    player.nowPlayingMessage = msg;
  });

  riffy.on('queueEnd', async (player) => {
    const channel = client.channels.cache.get(player.textChannel);
    const state = playerStates.get(player.guildId);

    if (player.nowPlayingMessage) {
      try {
        const disabledRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('pause').setEmoji('⏸️').setStyle(ButtonStyle.Primary).setDisabled(true),
          new ButtonBuilder().setCustomId('skip').setEmoji('⏭️').setStyle(ButtonStyle.Primary).setDisabled(true),
          new ButtonBuilder().setCustomId('stop').setEmoji('⏹️').setStyle(ButtonStyle.Danger).setDisabled(true)
        );
        await player.nowPlayingMessage.edit({ components: [disabledRow] });
      } catch (e) {}
    }

    // Check for 24/7 mode
    if (state?.stay247) {
      if (channel) channel.send('Queue ended. Staying in voice channel (24/7 mode enabled).');
      return;
    }

    if (channel) channel.send('Queue ended. Leaving voice channel.');
    player.destroy();
    playerStates.delete(player.guildId);
  });

  riffy.on('trackEnd', async (player, track) => {
    const state = playerStates.get(player.guildId);
    const channel = client.channels.cache.get(player.textChannel);

    // Check for autoplay when track ends and queue is empty
    if (state?.autoplay && player.queue.length === 0 && track) {
      try {
        console.log('[AUTOPLAY] Attempting to find related track...');

        // Search for related tracks using YouTube search
        const searchQuery = `${track.info.author} - ${track.info.title}`;
        console.log('[AUTOPLAY] Search query:', searchQuery);

        const search = await riffy.resolve({ 
          query: searchQuery,
          requester: track.info.requester 
        });

        console.log('[AUTOPLAY] Search result:', search.loadType, 'Tracks found:', search.tracks?.length);

        if (search && search.tracks && search.tracks.length > 0) {
          // Get a random track from first 5 results (excluding exact same track)
          const availableTracks = search.tracks.slice(0, 5).filter(t => t.info.identifier !== track.info.identifier);

          if (availableTracks.length > 0) {
            const randomTrack = availableTracks[Math.floor(Math.random() * availableTracks.length)];
            randomTrack.info.requester = track.info.requester;

            player.queue.add(randomTrack);
            console.log('[AUTOPLAY] Added track:', randomTrack.info.title);

            if (channel) {
              channel.send(`🔄 **Autoplay:** Added **${randomTrack.info.title}** by **${randomTrack.info.author}**`);
            }

            // Start playing if not already playing
            if (!player.playing) {
              player.play();
              console.log('[AUTOPLAY] Started playing');
            }
          } else {
            console.log('[AUTOPLAY] No different tracks found');
            if (channel) channel.send('❌ Autoplay: Could not find different tracks.');
          }
        } else {
          console.log('[AUTOPLAY] No search results');
          if (channel) channel.send('❌ Autoplay: No related tracks found.');
        }
      } catch (error) {
        console.error('[AUTOPLAY] Error:', error);
        if (channel) channel.send('❌ Autoplay: An error occurred while fetching tracks.');
      }
    }
  });
}

// Get command from aliases
function getCommand(input) {
  for (const [cmd, aliases] of Object.entries(commands)) {
    if (aliases.includes(input)) return cmd;
  }
  return null;
}

// Message Handler
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (!message.mentions.has(client.user.id)) return;

  const args = message.content.split(' ').slice(1);
  const input = args[0]?.toLowerCase();
  const command = getCommand(input);

  if (!command) return;

  // RESTART Command (Owner Only)
  if (command === 'restart') {
    if (message.author.id !== config.ownerId) {
      const embed = new EmbedBuilder()
        .setColor(config.color.error)
        .setDescription('❌ This command is owner-only!');
      return message.reply({ embeds: [embed] });
    }

    const embed = new EmbedBuilder()
      .setColor(config.color.info)
      .setDescription('🔄 Restarting bot...');

    await message.reply({ embeds: [embed] });

    console.log('Bot restart initiated by owner');
    await client.destroy();
    process.exit(0);
  }

  // Lavalink check for music commands
  const musicCommands = ['play', 'pause', 'resume', 'skip', 'stop', 'queue', 'nowplaying', 'volume', 'loop', 'autoplay', 'shuffle', 'clearqueue', 'remove', 'move', 'search', 'lyrics', 'filters', 'join', 'leave'];
  if (musicCommands.includes(command) && !lavalinkConnected) {
    const embed = new EmbedBuilder()
      .setColor(config.color.error)
      .setTitle('❌ Lavalink Offline')
      .setDescription('Music features are currently unavailable. Please try again later.');
    return message.reply({ embeds: [embed] });
  }

  // PLAY Command
  if (command === 'play') {
    if (!message.member.voice.channel) {
      const embed = new EmbedBuilder()
        .setColor(config.color.error)
        .setDescription('❌ You need to be in a voice channel!');
      return message.reply({ embeds: [embed] });
    }

    const query = args.slice(1).join(' ');
    if (!query) {
      const embed = new EmbedBuilder()
        .setColor(config.color.error)
        .setDescription('❌ Please provide a song name or URL!');
      return message.reply({ embeds: [embed] });
    }

    let player = riffy.players.get(message.guild.id);

    if (!player) {
      player = riffy.createConnection({
        guildId: message.guild.id,
        voiceChannel: message.member.voice.channel.id,
        textChannel: message.channel.id,
        deaf: true
      });
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    try {
      const resolve = await riffy.resolve({ query, requester: message.author.id });

      if (resolve.loadType === 'error' || resolve.loadType === 'empty') {
        const embed = new EmbedBuilder()
          .setColor(config.color.error)
          .setDescription('❌ No results found!');
        return message.reply({ embeds: [embed] });
      }

      const tracks = resolve.loadType === 'playlist' ? resolve.tracks : [resolve.tracks[0]];

      if (resolve.loadType === 'playlist') {
        for (const t of tracks) {
          t.info.requester = message.author.id;
          player.queue.add(t);
        }
        const embed = new EmbedBuilder()
          .setColor(config.color.info)
          .setTitle('📃 Playlist Added')
          .setDescription(`**${resolve.playlistInfo.name}**`)
          .addFields({ name: 'Tracks', value: `${tracks.length}`, inline: true });
        message.reply({ embeds: [embed] });
      } else {
        tracks[0].info.requester = message.author.id;
        player.queue.add(tracks[0]);

        const embed = new EmbedBuilder()
          .setColor(config.color.info)
          .setTitle('✅ Added to Queue')
          .setDescription(`[${tracks[0].info.title}](${tracks[0].info.uri})`)
          .setThumbnail(tracks[0].info.thumbnail || tracks[0].info.artworkUrl || null)
          .addFields(
            { name: 'Artist', value: tracks[0].info.author || 'Unknown', inline: true },
            { name: 'Duration', value: formatTime(tracks[0].info.length), inline: true },
            { name: 'Position', value: `${player.queue.length}`, inline: true }
          );
        message.reply({ embeds: [embed] });
      }

      if (!player.playing && !player.paused) player.play();
    } catch (error) {
      const embed = new EmbedBuilder()
        .setColor(config.color.error)
        .setDescription('❌ An error occurred while loading the track.');
      message.reply({ embeds: [embed] });
    }
  }

  // SEARCH Command
  if (command === 'search') {
    if (!message.member.voice.channel) {
      const embed = new EmbedBuilder()
        .setColor(config.color.error)
        .setDescription('❌ You need to be in a voice channel!');
      return message.reply({ embeds: [embed] });
    }

    const query = args.slice(1).join(' ');
    if (!query) {
      const embed = new EmbedBuilder()
        .setColor(config.color.error)
        .setDescription('❌ Please provide a search query!');
      return message.reply({ embeds: [embed] });
    }

    try {
      const resolve = await riffy.resolve({ query });

      if (resolve.loadType === 'error' || resolve.loadType === 'empty') {
        const embed = new EmbedBuilder()
          .setColor(config.color.error)
          .setDescription('❌ No results found!');
        return message.reply({ embeds: [embed] });
      }

      const tracks = resolve.tracks.slice(0, 10);
      const options = tracks.map((track, i) => ({
        label: track.info.title.substring(0, 100),
        description: `${track.info.author} - ${formatTime(track.info.length)}`.substring(0, 100),
        value: `search_${i}`
      }));

      const row = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('search_select')
          .setPlaceholder('Select a song to play')
          .addOptions(options)
      );

      const embed = new EmbedBuilder()
        .setColor(config.color.info)
        .setTitle('🔍 Search Results')
        .setDescription(tracks.map((t, i) => `**${i + 1}.** [${t.info.title}](${t.info.uri})\n${t.info.author} - ${formatTime(t.info.length)}`).join('\n\n'))
        .setFooter({ text: 'Select a song from the dropdown below' });

      const msg = await message.reply({ embeds: [embed], components: [row] });

      const collector = msg.createMessageComponentCollector({
        componentType: ComponentType.StringSelect,
        time: 60000
      });

      collector.on('collect', async (i) => {
        if (i.user.id !== message.author.id) {
          return i.reply({ content: '❌ This is not your search!', ephemeral: true });
        }

        const index = parseInt(i.values[0].split('_')[1]);
        const selected = tracks[index];

        let player = riffy.players.get(message.guild.id);
        if (!player) {
          player = riffy.createConnection({
            guildId: message.guild.id,
            voiceChannel: message.member.voice.channel.id,
            textChannel: message.channel.id,
            deaf: true
          });
          await new Promise(resolve => setTimeout(resolve, 500));
        }

        selected.info.requester = message.author.id;
        player.queue.add(selected);

        const addEmbed = new EmbedBuilder()
          .setColor(config.color.success)
          .setDescription(`✅ Added **${selected.info.title}** to queue!`);

        await i.update({ embeds: [addEmbed], components: [] });

        if (!player.playing && !player.paused) player.play();
        collector.stop();
      });

      collector.on('end', () => {
        msg.edit({ components: [] }).catch(() => {});
      });
    } catch (error) {
      const embed = new EmbedBuilder()
        .setColor(config.color.error)
        .setDescription('❌ An error occurred while searching.');
      message.reply({ embeds: [embed] });
    }
  }

  // PAUSE Command
  if (command === 'pause') {
    const player = riffy.players.get(message.guild.id);
    if (!player) {
      const embed = new EmbedBuilder().setColor(config.color.error).setDescription('❌ No music is playing!');
      return message.reply({ embeds: [embed] });
    }
    if (!message.member.voice.channel) {
      const embed = new EmbedBuilder().setColor(config.color.error).setDescription('❌ You need to be in a voice channel!');
      return message.reply({ embeds: [embed] });
    }

    player.pause(true);
    const embed = new EmbedBuilder().setColor(config.color.info).setDescription('⏸️ Paused the music!');
    message.reply({ embeds: [embed] });
  }

  // RESUME Command
  if (command === 'resume') {
    const player = riffy.players.get(message.guild.id);
    if (!player) {
      const embed = new EmbedBuilder().setColor(config.color.error).setDescription('❌ No music is playing!');
      return message.reply({ embeds: [embed] });
    }
    if (!message.member.voice.channel) {
      const embed = new EmbedBuilder().setColor(config.color.error).setDescription('❌ You need to be in a voice channel!');
      return message.reply({ embeds: [embed] });
    }

    player.pause(false);
    const embed = new EmbedBuilder().setColor(config.color.info).setDescription('▶️ Resumed the music!');
    message.reply({ embeds: [embed] });
  }

  // SKIP Command
  if (command === 'skip') {
    const player = riffy.players.get(message.guild.id);
    if (!player) {
      const embed = new EmbedBuilder().setColor(config.color.error).setDescription('❌ No music is playing!');
      return message.reply({ embeds: [embed] });
    }
    if (!message.member.voice.channel) {
      const embed = new EmbedBuilder().setColor(config.color.error).setDescription('❌ You need to be in a voice channel!');
      return message.reply({ embeds: [embed] });
    }

    const skipped = player.current;
    player.stop();

    if (player.nowPlayingMessage) {
      try {
        const disabledRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('pause').setEmoji('⏸️').setStyle(ButtonStyle.Primary).setDisabled(true),
          new ButtonBuilder().setCustomId('skip').setEmoji('⏭️').setStyle(ButtonStyle.Primary).setDisabled(true),
          new ButtonBuilder().setCustomId('stop').setEmoji('⏹️').setStyle(ButtonStyle.Danger).setDisabled(true)
        );
        await player.nowPlayingMessage.edit({ components: [disabledRow] });
      } catch (e) {}
    }

    const embed = new EmbedBuilder()
      .setColor(config.color.info)
      .setDescription(`⏭️ Skipped: **${skipped.info.title}**`);
    message.reply({ embeds: [embed] });
  }

  // STOP Command
  if (command === 'stop') {
    const player = riffy.players.get(message.guild.id);
    if (!player) {
      const embed = new EmbedBuilder().setColor(config.color.error).setDescription('❌ No music is playing!');
      return message.reply({ embeds: [embed] });
    }
    if (!message.member.voice.channel) {
      const embed = new EmbedBuilder().setColor(config.color.error).setDescription('❌ You need to be in a voice channel!');
      return message.reply({ embeds: [embed] });
    }

    if (player.nowPlayingMessage) {
      try {
        const disabledRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('pause').setEmoji('⏸️').setStyle(ButtonStyle.Primary).setDisabled(true),
          new ButtonBuilder().setCustomId('skip').setEmoji('⏭️').setStyle(ButtonStyle.Primary).setDisabled(true),
          new ButtonBuilder().setCustomId('stop').setEmoji('⏹️').setStyle(ButtonStyle.Danger).setDisabled(true)
        );
        await player.nowPlayingMessage.edit({ components: [disabledRow] });
      } catch (e) {}
    }

    player.destroy();
    playerStates.delete(message.guild.id);
    const embed = new EmbedBuilder().setColor(config.color.info).setDescription('⏹️ Stopped and disconnected!');
    message.reply({ embeds: [embed] });
  }

  // QUEUE Command
  if (command === 'queue') {
    const player = riffy.players.get(message.guild.id);
    if (!player || !player.current) {
      const embed = new EmbedBuilder().setColor(config.color.error).setDescription('❌ No music is playing!');
      return message.reply({ embeds: [embed] });
    }

    const queue = player.queue;
    const current = player.current;
    const state = playerStates.get(message.guild.id);

    const embed = new EmbedBuilder()
      .setColor(config.color.info)
      .setTitle('🎵 Music Queue')
      .setDescription(`**Now Playing:**\n[${current.info.title}](${current.info.uri}) - ${current.info.author}\n\n**Up Next:**\n${
        queue.length > 0 
          ? queue.slice(0, 10).map((track, i) => `\`${i + 1}.\` [${track.info.title}](${track.info.uri}) - ${track.info.author}`).join('\n')
          : 'No tracks in queue'
      }${queue.length > 10 ? `\n\n*And ${queue.length - 10} more...*` : ''}`)
      .setFooter({ text: `Total tracks: ${queue.length + 1} | Loop: ${state?.loop || 'off'} | 24/7: ${state?.stay247 ? 'on' : 'off'}` });

    message.reply({ embeds: [embed] });
  }

  // NOW PLAYING Command
  if (command === 'nowplaying') {
    const player = riffy.players.get(message.guild.id);
    if (!player || !player.current) {
      const embed = new EmbedBuilder().setColor(config.color.error).setDescription('❌ No music is playing!');
      return message.reply({ embeds: [embed] });
    }

    const track = player.current;
    const currentTime = player.position || 0;
    const totalTime = track.info.length;
    const progress = Math.floor((currentTime / totalTime) * 20);
    const progressBar = '▬'.repeat(progress) + '🔘' + '▬'.repeat(20 - progress);

    const embed = new EmbedBuilder()
      .setColor(config.color.info)
      .setTitle('🎵 Now Playing')
      .setDescription(`[${track.info.title}](${track.info.uri})`)
      .setThumbnail(track.info.thumbnail || track.info.artworkUrl || null)
      .addFields(
        { name: 'Artist', value: track.info.author || 'Unknown', inline: true },
        { name: 'Duration', value: `${formatTime(currentTime)} / ${formatTime(totalTime)}`, inline: true },
        { name: 'Status', value: player.paused ? '⏸️ Paused' : '▶️ Playing', inline: true },
        { name: 'Progress', value: progressBar, inline: false },
        { name: 'Requested by', value: `<@${track.info.requester}>`, inline: true },
        { name: 'Volume', value: `${player.volume}%`, inline: true }
      );

    message.reply({ embeds: [embed] });
  }

  // JOIN Command
  if (command === 'join') {
    if (!message.member.voice.channel) {
      const embed = new EmbedBuilder().setColor(config.color.error).setDescription('❌ You need to be in a voice channel!');
      return message.reply({ embeds: [embed] });
    }

    let player = riffy.players.get(message.guild.id);
    if (player) {
      const embed = new EmbedBuilder().setColor(config.color.error).setDescription('❌ Already connected to a voice channel!');
      return message.reply({ embeds: [embed] });
    }

    riffy.createConnection({
      guildId: message.guild.id,
      voiceChannel: message.member.voice.channel.id,
      textChannel: message.channel.id,
      deaf: true
    });

    const embed = new EmbedBuilder()
      .setColor(config.color.success)
      .setDescription(`✅ Joined ${message.member.voice.channel.name}`);
    message.reply({ embeds: [embed] });
  }

  // LEAVE Command
  if (command === 'leave') {
    const player = riffy.players.get(message.guild.id);
    if (!player) {
      const embed = new EmbedBuilder().setColor(config.color.error).setDescription('❌ Not connected to a voice channel!');
      return message.reply({ embeds: [embed] });
    }

    player.destroy();
    playerStates.delete(message.guild.id);
    const embed = new EmbedBuilder().setColor(config.color.info).setDescription('👋 Disconnected from voice channel!');
    message.reply({ embeds: [embed] });
  }

  // VOLUME Command
  if (command === 'volume') {
    const player = riffy.players.get(message.guild.id);
    if (!player) {
      const embed = new EmbedBuilder().setColor(config.color.error).setDescription('❌ No music is playing!');
      return message.reply({ embeds: [embed] });
    }

    const volume = parseInt(args[1]);
    if (isNaN(volume) || volume < 0 || volume > 100) {
      const embed = new EmbedBuilder()
        .setColor(config.color.info)
        .setDescription(`🔊 Current volume: **${player.volume}%**\n\nUsage: \`@${client.user.username} volume <0-100>\``);
      return message.reply({ embeds: [embed] });
    }

    player.setVolume(volume);
    const embed = new EmbedBuilder().setColor(config.color.info).setDescription(`🔊 Volume set to **${volume}%**`);
    message.reply({ embeds: [embed] });
  }

  // LOOP Command
  if (command === 'loop') {
    const player = riffy.players.get(message.guild.id);
    if (!player || !player.current) {
      const embed = new EmbedBuilder().setColor(config.color.error).setDescription('❌ No music is playing!');
      return message.reply({ embeds: [embed] });
    }
    if (!message.member.voice.channel) {
      const embed = new EmbedBuilder().setColor(config.color.error).setDescription('❌ You need to be in a voice channel!');
      return message.reply({ embeds: [embed] });
    }

    const state = playerStates.get(message.guild.id) || {};
    const modes = ['off', 'track', 'queue'];
    const currentMode = state.loop || 'off';
    const nextMode = modes[(modes.indexOf(currentMode) + 1) % modes.length];

    state.loop = nextMode;
    playerStates.set(message.guild.id, state);

    // Set loop mode using Riffy's method
    if (nextMode === 'track') {
      player.setLoop('track');
    } else if (nextMode === 'queue') {
      player.setLoop('queue');
    } else {
      player.setLoop('none');
    }

    const modeEmoji = { off: '➡️', track: '🔂', queue: '🔁' };
    const modeDesc = { 
      off: 'Loop disabled', 
      track: 'Looping current track', 
      queue: 'Looping entire queue' 
    };

    const embed = new EmbedBuilder()
      .setColor(config.color.info)
      .setDescription(`${modeEmoji[nextMode]} Loop: **${modeDesc[nextMode]}**`);
    message.reply({ embeds: [embed] });
  }

  // 24/7 Command
  if (command === '247') {
    const player = riffy.players.get(message.guild.id);
    if (!player) {
      const embed = new EmbedBuilder().setColor(config.color.error).setDescription('❌ No music is playing!');
      return message.reply({ embeds: [embed] });
    }
    if (!message.member.voice.channel) {
      const embed = new EmbedBuilder().setColor(config.color.error).setDescription('❌ You need to be in a voice channel!');
      return message.reply({ embeds: [embed] });
    }

    const state = playerStates.get(message.guild.id) || {};
    state.stay247 = !state.stay247;
    playerStates.set(message.guild.id, state);

    const embed = new EmbedBuilder()
      .setColor(config.color.info)
      .setDescription(`🎵 24/7 Mode: **${state.stay247 ? 'enabled' : 'disabled'}**`);
    message.reply({ embeds: [embed] });
  }

  // AUTOPLAY Command
  if (command === 'autoplay') {
    const player = riffy.players.get(message.guild.id);
    if (!player || !player.current) {
      const embed = new EmbedBuilder().setColor(config.color.error).setDescription('❌ No music is playing!');
      return message.reply({ embeds: [embed] });
    }
    if (!message.member.voice.channel) {
      const embed = new EmbedBuilder().setColor(config.color.error).setDescription('❌ You need to be in a voice channel!');
      return message.reply({ embeds: [embed] });
    }

    const state = playerStates.get(message.guild.id) || {};
    state.autoplay = !state.autoplay;
    playerStates.set(message.guild.id, state);

    // Riffy autoplay toggle
    player.data.set('autoplay', state.autoplay);

    const embed = new EmbedBuilder()
      .setColor(config.color.info)
      .setDescription(`🔄 Autoplay: **${state.autoplay ? 'enabled' : 'disabled'}**\n*Note: Bot will automatically play related songs when queue ends*`);
    message.reply({ embeds: [embed] });
  }

  // SHUFFLE Command
  if (command === 'shuffle') {
    const player = riffy.players.get(message.guild.id);
    if (!player || player.queue.length === 0) {
      const embed = new EmbedBuilder().setColor(config.color.error).setDescription('❌ Queue is empty!');
      return message.reply({ embeds: [embed] });
    }
    if (!message.member.voice.channel) {
      const embed = new EmbedBuilder().setColor(config.color.error).setDescription('❌ You need to be in a voice channel!');
      return message.reply({ embeds: [embed] });
    }

    player.queue.shuffle();

    const embed = new EmbedBuilder()
      .setColor(config.color.info)
      .setDescription(`🔀 Shuffled **${player.queue.length}** tracks!`);
    message.reply({ embeds: [embed] });
  }

  // CLEARQUEUE Command
  if (command === 'clearqueue') {
    const player = riffy.players.get(message.guild.id);
    if (!player || player.queue.length === 0) {
      const embed = new EmbedBuilder().setColor(config.color.error).setDescription('❌ Queue is empty!');
      return message.reply({ embeds: [embed] });
    }
    if (!message.member.voice.channel) {
      const embed = new EmbedBuilder().setColor(config.color.error).setDescription('❌ You need to be in a voice channel!');
      return message.reply({ embeds: [embed] });
    }

    const cleared = player.queue.length;
    player.queue.clear();

    const embed = new EmbedBuilder()
      .setColor(config.color.info)
      .setDescription(`🗑️ Cleared **${cleared}** tracks from queue!`);
    message.reply({ embeds: [embed] });
  }

  // REMOVE Command
  if (command === 'remove') {
    const player = riffy.players.get(message.guild.id);
    if (!player || player.queue.length === 0) {
      const embed = new EmbedBuilder().setColor(config.color.error).setDescription('❌ Queue is empty!');
      return message.reply({ embeds: [embed] });
    }
    if (!message.member.voice.channel) {
      const embed = new EmbedBuilder().setColor(config.color.error).setDescription('❌ You need to be in a voice channel!');
      return message.reply({ embeds: [embed] });
    }

    const position = parseInt(args[1]);
    if (!position || position < 1 || position > player.queue.length) {
      const embed = new EmbedBuilder()
        .setColor(config.color.error)
        .setDescription(`❌ Please provide a valid position (1-${player.queue.length})!`);
      return message.reply({ embeds: [embed] });
    }

    const removed = player.queue.remove(position - 1);
    const embed = new EmbedBuilder()
      .setColor(config.color.info)
      .setDescription(`🗑️ Removed: **${removed.info.title}**`);
    message.reply({ embeds: [embed] });
  }

  // MOVE Command
  if (command === 'move') {
    const player = riffy.players.get(message.guild.id);
    if (!player || player.queue.length === 0) {
      const embed = new EmbedBuilder().setColor(config.color.error).setDescription('❌ Queue is empty!');
      return message.reply({ embeds: [embed] });
    }
    if (!message.member.voice.channel) {
      const embed = new EmbedBuilder().setColor(config.color.error).setDescription('❌ You need to be in a voice channel!');
      return message.reply({ embeds: [embed] });
    }

    const from = parseInt(args[1]);
    const to = parseInt(args[2]);

    if (!from || !to || from < 1 || to < 1 || from > player.queue.length || to > player.queue.length) {
      const embed = new EmbedBuilder()
        .setColor(config.color.error)
        .setDescription(`❌ Usage: \`@${client.user.username} move <from> <to>\`\nValid range: 1-${player.queue.length}`);
      return message.reply({ embeds: [embed] });
    }

    const track = player.queue[from - 1];
    player.queue.splice(from - 1, 1);
    player.queue.splice(to - 1, 0, track);

    const embed = new EmbedBuilder()
      .setColor(config.color.info)
      .setDescription(`📋 Moved **${track.info.title}** from position ${from} to ${to}`);
    message.reply({ embeds: [embed] });
  }

  // LYRICS Command
  if (command === 'lyrics') {
    const player = riffy.players.get(message.guild.id);
    let searchQuery = args.slice(1).join(' ');

    if (!searchQuery && player && player.current) {
      searchQuery = player.current.info.title;
    }

    if (!searchQuery) {
      const embed = new EmbedBuilder()
        .setColor(config.color.error)
        .setDescription('❌ Please provide a song name or play a song!');
      return message.reply({ embeds: [embed] });
    }

    try {
      const response = await fetch(`https://lrclib.net/api/search?q=${encodeURIComponent(searchQuery)}`);
      const data = await response.json();

      if (!data || data.length === 0) {
        const embed = new EmbedBuilder()
          .setColor(config.color.error)
          .setDescription('❌ No lyrics found!');
        return message.reply({ embeds: [embed] });
      }

      const song = data[0];
      let lyrics = song.plainLyrics || song.syncedLyrics || 'Lyrics not available';

      if (lyrics.length > 4000) {
        lyrics = lyrics.substring(0, 4000) + '...';
      }

      const embed = new EmbedBuilder()
        .setColor(config.color.info)
        .setTitle(`🎤 ${song.trackName}`)
        .setDescription(lyrics)
        .setFooter({ text: `Artist: ${song.artistName} | Album: ${song.albumName || 'Unknown'}` });

      message.reply({ embeds: [embed] });
    } catch (error) {
      const embed = new EmbedBuilder()
        .setColor(config.color.error)
        .setDescription('❌ Failed to fetch lyrics!');
      message.reply({ embeds: [embed] });
    }
  }

  // FILTERS Command
  if (command === 'filters') {
    const player = riffy.players.get(message.guild.id);
    if (!player || !player.current) {
      const embed = new EmbedBuilder().setColor(config.color.error).setDescription('❌ No music is playing!');
      return message.reply({ embeds: [embed] });
    }
    if (!message.member.voice.channel) {
      const embed = new EmbedBuilder().setColor(config.color.error).setDescription('❌ You need to be in a voice channel!');
      return message.reply({ embeds: [embed] });
    }

    const filterOptions = Object.keys(filters).map(name => ({
      label: name.charAt(0).toUpperCase() + name.slice(1),
      description: `Apply ${name} filter`,
      value: `filter_${name}`
    }));

    filterOptions.push({
      label: 'Clear Filters',
      description: 'Remove all active filters',
      value: 'filter_clear'
    });

    const row = new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('filter_select')
        .setPlaceholder('Select a filter to apply')
        .addOptions(filterOptions)
    );

    const embed = new EmbedBuilder()
      .setColor(config.color.info)
      .setTitle('🎚️ Audio Filters')
      .setDescription('**Available Filters:**\n' + Object.keys(filters).map(f => `• **${f}**`).join('\n'))
      .addFields({
        name: '⚠️ Important Note',
        value: 'Filters are applied to the Lavalink server. Some filters may take a moment to activate or may not be supported by your Lavalink version.',
        inline: false
      })
      .setFooter({ text: 'This menu will expire in 5 minutes' });

    const msg = await message.reply({ embeds: [embed], components: [row] });

    const collector = msg.createMessageComponentCollector({
      componentType: ComponentType.StringSelect,
      time: 300000
    });

    collector.on('collect', async (i) => {
      if (i.user.id !== message.author.id) {
        return i.reply({ content: '❌ This is not your filter menu!', ephemeral: true });
      }

      const filterName = i.values[0].replace('filter_', '');

      try {
        if (filterName === 'clear') {
          // Clear all filters
          await player.node.rest.updatePlayer({
            guildId: player.guildId,
            data: { 
              filters: {}
            }
          });
          await i.reply({ content: '✅ Cleared all filters!', ephemeral: true });
        } else {
          // Apply selected filter
          const filterData = filters[filterName];
          await player.node.rest.updatePlayer({
            guildId: player.guildId,
            data: { 
              filters: filterData
            }
          });
          await i.reply({ content: `✅ Applied **${filterName}** filter! The effect may take a moment to activate.`, ephemeral: true });
        }
      } catch (error) {
        console.error('Filter error:', error);
        await i.reply({ content: `❌ Failed to apply filter: ${error.message || 'Unknown error'}`, ephemeral: true });
      }
    });

    collector.on('end', () => {
      msg.edit({ components: [] }).catch(() => {});
    });
  }

  // HELP Command
  if (command === 'help') {
    const embed = new EmbedBuilder()
      .setColor(config.color.info)
      .setTitle(`🎵 ${client.user.username} Commands`)
      .setDescription(`Mention me with a command! Example: \`@${client.user.username} play song name\`\n\u200b`)
      .setThumbnail(client.user.displayAvatarURL())
      .addFields(
        { 
          name: '🎵 Music Commands', 
          value: [
            '**Playback:**',
            '`play (p)` • `search (find)` • `pause` • `resume (r)` • `skip (s)` • `stop (dc)`',
            '',
            '**Queue Management:**',
            '`queue (q)` • `clearqueue (cq)` • `shuffle (sh)` • `remove (rm)` • `move (mv)`',
            '',
            '**Modes:**',
            '`loop` • `autoplay (ap)` • `247` • `filters (fx)`',
            '',
            '**Other:**',
            '`nowplaying (np)` • `join` • `leave` • `volume (vol)` • `lyrics (ly)`'
          ].join('\n'),
          inline: false
        },
        { 
          name: '\u200b',
          value: '\u200b',
          inline: false
        },
        { 
          name: '🔧 Utility Commands', 
          value: '`ping` • `uptime (ut)` • `botinfo (bi)` • `stats` • `support` • `invite (inv)` • `vote`',
          inline: false
        },
        { 
          name: '\u200b',
          value: '\u200b',
          inline: false
        },
        { 
          name: '💡 Command Info', 
          value: '• Commands in parentheses **(p, r, s)** are shortcuts\n• Use `@mention command` to interact with the bot',
          inline: false
        }
      )
      .setFooter({ text: `Requested by ${message.author.tag}`, iconURL: message.author.displayAvatarURL() });

    const inviteUrl = `https://discord.com/api/oauth2/authorize?client_id=${client.user.id}&permissions=36700160&scope=bot`;

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setLabel('Invite Me')
        .setURL(inviteUrl)
        .setStyle(ButtonStyle.Link),
      new ButtonBuilder()
        .setLabel('Support Server')
        .setURL(config.supportServer)
        .setStyle(ButtonStyle.Link)
    );

    message.reply({ embeds: [embed], components: [row] });
  }

  // PING Command
  if (command === 'ping') {
    const embed = new EmbedBuilder()
      .setColor(config.color.info)
      .setTitle('🏓 Pong!')
      .addFields(
        { name: 'API Latency', value: `${Math.round(client.ws.ping)}ms`, inline: true },
        { name: 'Lavalink', value: lavalinkConnected ? '✅ Connected' : '❌ Offline', inline: true }
      );

    message.reply({ embeds: [embed] });
  }

  // UPTIME Command
  if (command === 'uptime') {
    const uptime = Date.now() - startTime;
    const embed = new EmbedBuilder()
      .setColor(config.color.info)
      .setTitle(`⏰ ${client.user.username} Uptime`)
      .setDescription(`\`${formatUptime(uptime)}\``);

    message.reply({ embeds: [embed] });
  }

  // BOTINFO Command
  if (command === 'botinfo') {
    const embed = new EmbedBuilder()
      .setColor(config.color.info)
      .setTitle(`ℹ️ ${client.user.username} Information`)
      .setThumbnail(client.user.displayAvatarURL())
      .addFields(
        { name: 'Bot Tag', value: client.user.tag, inline: true },
        { name: 'Servers', value: `${client.guilds.cache.size}`, inline: true },
        { name: 'Users', value: `${client.users.cache.size}`, inline: true },
        { name: 'Uptime', value: formatUptime(Date.now() - startTime), inline: true },
        { name: 'Node.js', value: process.version, inline: true },
        { name: 'Library', value: 'discord.js', inline: true }
      );

    message.reply({ embeds: [embed] });
  }

  // STATS Command
  if (command === 'stats') {
    const memUsage = process.memoryUsage().heapUsed / 1024 / 1024;
    const totalPlayers = riffy ? riffy.players.size : 0;

    const embed = new EmbedBuilder()
      .setColor(config.color.info)
      .setTitle(`📊 ${client.user.username} Statistics`)
      .addFields(
        { name: 'Servers', value: `${client.guilds.cache.size}`, inline: true },
        { name: 'Users', value: `${client.users.cache.size}`, inline: true },
        { name: 'Active Players', value: `${totalPlayers}`, inline: true },
        { name: 'Memory Usage', value: `${memUsage.toFixed(2)} MB`, inline: true },
        { name: 'Uptime', value: formatUptime(Date.now() - startTime), inline: true },
        { name: 'Lavalink', value: lavalinkConnected ? '✅ Online' : '❌ Offline', inline: true }
      );

    message.reply({ embeds: [embed] });
  }

  // SUPPORT Command
  if (command === 'support') {
    const embed = new EmbedBuilder()
      .setColor(config.color.info)
      .setTitle('💬 Support Server')
      .setDescription(`[Click here to join](${config.supportServer})`)

    message.reply({ embeds: [embed] });
  }

  // INVITE Command
  if (command === 'invite') {
    const invite = `https://discord.com/api/oauth2/authorize?client_id=${client.user.id}&permissions=36700160&scope=bot`;
    const embed = new EmbedBuilder()
      .setColor(config.color.info)
      .setTitle(`📨 Invite ${client.user.username}!`)
      .setDescription(`[Click here to invite](${invite})`)

    message.reply({ embeds: [embed] });
  }

  // VOTE Command
  if (command === 'vote') {
    const embed = new EmbedBuilder()
      .setColor(config.color.info)
      .setTitle(`🗳️ Vote for ${client.user.username}!`)
      .setDescription(`[Vote on Top.gg](${config.voteLink})`)

    message.reply({ embeds: [embed] });
  }
});

// Button Handler
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton()) return;

  const player = riffy?.players.get(interaction.guild.id);
  if (!player) {
    return interaction.reply({ content: '❌ No music is playing!', ephemeral: true });
  }

  if (!interaction.member.voice.channel) {
    return interaction.reply({ content: '❌ You need to be in a voice channel!', ephemeral: true });
  }

  if (interaction.customId === 'pause') {
    if (player.paused) {
      player.pause(false);
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('pause').setEmoji('⏸️').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('skip').setEmoji('⏭️').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('stop').setEmoji('⏹️').setStyle(ButtonStyle.Danger)
      );
      await interaction.message.edit({ components: [row] });
      await interaction.reply({ content: '▶️ Resumed!', ephemeral: true });
    } else {
      player.pause(true);
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('pause').setEmoji('▶️').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('skip').setEmoji('⏭️').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('stop').setEmoji('⏹️').setStyle(ButtonStyle.Danger)
      );
      await interaction.message.edit({ components: [row] });
      await interaction.reply({ content: '⏸️ Paused!', ephemeral: true });
    }
  }

  if (interaction.customId === 'skip') {
    player.stop();
    const disabledRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('pause').setEmoji('⏸️').setStyle(ButtonStyle.Primary).setDisabled(true),
      new ButtonBuilder().setCustomId('skip').setEmoji('⏭️').setStyle(ButtonStyle.Primary).setDisabled(true),
      new ButtonBuilder().setCustomId('stop').setEmoji('⏹️').setStyle(ButtonStyle.Danger).setDisabled(true)
    );
    await interaction.message.edit({ components: [disabledRow] });
    await interaction.reply({ content: '⏭️ Skipped!', ephemeral: true });
  }

  if (interaction.customId === 'stop') {
    player.destroy();
    playerStates.delete(interaction.guild.id);
    const disabledRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('pause').setEmoji('⏸️').setStyle(ButtonStyle.Primary).setDisabled(true),
      new ButtonBuilder().setCustomId('skip').setEmoji('⏭️').setStyle(ButtonStyle.Primary).setDisabled(true),
      new ButtonBuilder().setCustomId('stop').setEmoji('⏹️').setStyle(ButtonStyle.Danger).setDisabled(true)
    );
    await interaction.message.edit({ components: [disabledRow] });
    await interaction.reply({ content: '⏹️ Stopped!', ephemeral: true });
  }
});

// Helper functions
function formatTime(ms) {
  const seconds = Math.floor((ms / 1000) % 60);
  const minutes = Math.floor((ms / (1000 * 60)) % 60);
  const hours = Math.floor(ms / (1000 * 60 * 60));

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  }
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

function formatUptime(ms) {
  const seconds = Math.floor((ms / 1000) % 60);
  const minutes = Math.floor((ms / (1000 * 60)) % 60);
  const hours = Math.floor((ms / (1000 * 60 * 60)) % 24);
  const days = Math.floor(ms / (1000 * 60 * 60 * 24));

  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (seconds > 0) parts.push(`${seconds}s`);

  return parts.join(' ') || '0s';
}

// Error handling
process.on('unhandledRejection', error => {
  console.error('Unhandled promise rejection:', error);
});

client.login(process.env.BOT_TOKEN);
