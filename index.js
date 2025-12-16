require('dotenv').config();
const { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, ActivityType } = require('discord.js');
const { Riffy } = require('riffy');
const express = require('express');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const OWNER_ID = '1092773378101882951';

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

// Express Server
app.get('/', (req, res) => {
  const html = fs.readFileSync('./index.html', 'utf8');
  res.send(html);
});

app.get('/api/stats', (req, res) => {
  res.json({
    status: 'online',
    bot: client.user?.tag || 'Drum',
    avatar: client.user?.displayAvatarURL() || '',
    uptime: formatUptime(Date.now() - startTime),
    servers: client.guilds.cache.size,
    users: client.users.cache.size,
    activePlayers: riffy ? riffy.players.size : 0,
    lavalink: lavalinkConnected ? 'connected' : 'disconnected',
    ping: Math.round(client.ws.ping),
    memoryUsage: (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2)
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
  leave: ['leave', 'disconnect'],
  volume: ['volume', 'vol', 'v'],
  help: ['help', 'h', 'commands'],
  ping: ['ping'],
  uptime: ['uptime', 'ut'],
  botinfo: ['botinfo', 'bi', 'info'],
  stats: ['stats', 'statistics'],
  support: ['support'],
  invite: ['invite', 'inv'],
  vote: ['vote'],
  restart: ['restart'] // Owner only, not in help
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
      .setColor('#00ff00')
      .setTitle('🎵 Now Playing')
      .setDescription(`[${track.info.title}](${track.info.uri})`)
      .setThumbnail(track.info.thumbnail || track.info.artworkUrl || null)
      .addFields(
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

    if (channel) channel.send('Queue ended. Leaving voice channel.');
    player.destroy();
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
    if (message.author.id !== OWNER_ID) {
      const embed = new EmbedBuilder()
        .setColor('#ff0000')
        .setDescription('❌ This command is owner-only!');
      return message.reply({ embeds: [embed] });
    }

    const embed = new EmbedBuilder()
      .setColor('#0099ff')
      .setDescription('🔄 Restarting bot...');
    
    await message.reply({ embeds: [embed] });
    
    console.log('Bot restart initiated by owner');
    await client.destroy();
    process.exit(0);
  }

  // Lavalink check for music commands
  const musicCommands = ['play', 'pause', 'resume', 'skip', 'stop', 'queue', 'nowplaying', 'volume'];
  if (musicCommands.includes(command) && !lavalinkConnected) {
    const embed = new EmbedBuilder()
      .setColor('#ff0000')
      .setTitle('❌ Lavalink Offline')
      .setDescription('Music features are currently unavailable. Please try again later.');
    return message.reply({ embeds: [embed] });
  }

  // PLAY Command
  if (command === 'play') {
    if (!message.member.voice.channel) {
      const embed = new EmbedBuilder()
        .setColor('#ff0000')
        .setDescription('❌ You need to be in a voice channel!');
      return message.reply({ embeds: [embed] });
    }

    const query = args.slice(1).join(' ');
    if (!query) {
      const embed = new EmbedBuilder()
        .setColor('#ff0000')
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
          .setColor('#ff0000')
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
          .setColor('#0099ff')
          .setTitle('📃 Playlist Added')
          .setDescription(`**${resolve.playlistInfo.name}**`)
          .addFields({ name: 'Tracks', value: `${tracks.length}`, inline: true });
        message.reply({ embeds: [embed] });
      } else {
        tracks[0].info.requester = message.author.id;
        player.queue.add(tracks[0]);

        const embed = new EmbedBuilder()
          .setColor('#0099ff')
          .setTitle('✅ Added to Queue')
          .setDescription(`[${tracks[0].info.title}](${tracks[0].info.uri})`)
          .setThumbnail(tracks[0].info.thumbnail || tracks[0].info.artworkUrl || null)
          .addFields(
            { name: 'Duration', value: formatTime(tracks[0].info.length), inline: true },
            { name: 'Position', value: `${player.queue.length}`, inline: true }
          );
        message.reply({ embeds: [embed] });
      }

      if (!player.playing && !player.paused) player.play();
    } catch (error) {
      const embed = new EmbedBuilder()
        .setColor('#ff0000')
        .setDescription('❌ An error occurred while loading the track.');
      message.reply({ embeds: [embed] });
    }
  }

  // PAUSE Command
  if (command === 'pause') {
    const player = riffy.players.get(message.guild.id);
    if (!player) {
      const embed = new EmbedBuilder().setColor('#ff0000').setDescription('❌ No music is playing!');
      return message.reply({ embeds: [embed] });
    }
    if (!message.member.voice.channel) {
      const embed = new EmbedBuilder().setColor('#ff0000').setDescription('❌ You need to be in a voice channel!');
      return message.reply({ embeds: [embed] });
    }

    player.pause(true);
    const embed = new EmbedBuilder().setColor('#0099ff').setDescription('⏸️ Paused the music!');
    message.reply({ embeds: [embed] });
  }

  // RESUME Command
  if (command === 'resume') {
    const player = riffy.players.get(message.guild.id);
    if (!player) {
      const embed = new EmbedBuilder().setColor('#ff0000').setDescription('❌ No music is playing!');
      return message.reply({ embeds: [embed] });
    }
    if (!message.member.voice.channel) {
      const embed = new EmbedBuilder().setColor('#ff0000').setDescription('❌ You need to be in a voice channel!');
      return message.reply({ embeds: [embed] });
    }

    player.pause(false);
    const embed = new EmbedBuilder().setColor('#0099ff').setDescription('▶️ Resumed the music!');
    message.reply({ embeds: [embed] });
  }

  // SKIP Command
  if (command === 'skip') {
    const player = riffy.players.get(message.guild.id);
    if (!player) {
      const embed = new EmbedBuilder().setColor('#ff0000').setDescription('❌ No music is playing!');
      return message.reply({ embeds: [embed] });
    }
    if (!message.member.voice.channel) {
      const embed = new EmbedBuilder().setColor('#ff0000').setDescription('❌ You need to be in a voice channel!');
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
      .setColor('#0099ff')
      .setDescription(`⏭️ Skipped: **${skipped.info.title}**`);
    message.reply({ embeds: [embed] });
  }

  // STOP Command
  if (command === 'stop') {
    const player = riffy.players.get(message.guild.id);
    if (!player) {
      const embed = new EmbedBuilder().setColor('#ff0000').setDescription('❌ No music is playing!');
      return message.reply({ embeds: [embed] });
    }
    if (!message.member.voice.channel) {
      const embed = new EmbedBuilder().setColor('#ff0000').setDescription('❌ You need to be in a voice channel!');
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
    const embed = new EmbedBuilder().setColor('#0099ff').setDescription('⏹️ Stopped and disconnected!');
    message.reply({ embeds: [embed] });
  }

  // QUEUE Command
  if (command === 'queue') {
    const player = riffy.players.get(message.guild.id);
    if (!player || !player.current) {
      const embed = new EmbedBuilder().setColor('#ff0000').setDescription('❌ No music is playing!');
      return message.reply({ embeds: [embed] });
    }

    const queue = player.queue;
    const current = player.current;

    const embed = new EmbedBuilder()
      .setColor('#0099ff')
      .setTitle('🎵 Music Queue')
      .setDescription(`**Now Playing:**\n[${current.info.title}](${current.info.uri})\n\n**Up Next:**\n${
        queue.length > 0 
          ? queue.slice(0, 10).map((track, i) => `\`${i + 1}.\` [${track.info.title}](${track.info.uri})`).join('\n')
          : 'No tracks in queue'
      }${queue.length > 10 ? `\n\n*And ${queue.length - 10} more...*` : ''}`)
      .setFooter({ text: `Total tracks: ${queue.length + 1}` });

    message.reply({ embeds: [embed] });
  }

  // NOW PLAYING Command
  if (command === 'nowplaying') {
    const player = riffy.players.get(message.guild.id);
    if (!player || !player.current) {
      const embed = new EmbedBuilder().setColor('#ff0000').setDescription('❌ No music is playing!');
      return message.reply({ embeds: [embed] });
    }

    const track = player.current;
    const embed = new EmbedBuilder()
      .setColor('#0099ff')
      .setTitle('🎵 Now Playing')
      .setDescription(`[${track.info.title}](${track.info.uri})`)
      .setThumbnail(track.info.thumbnail || track.info.artworkUrl || null)
      .addFields(
        { name: 'Duration', value: formatTime(track.info.length), inline: true },
        { name: 'Requested by', value: `<@${track.info.requester}>`, inline: true },
        { name: 'Status', value: player.paused ? '⏸️ Paused' : '▶️ Playing', inline: true }
      );

    message.reply({ embeds: [embed] });
  }

  // JOIN Command
  if (command === 'join') {
    if (!message.member.voice.channel) {
      const embed = new EmbedBuilder().setColor('#ff0000').setDescription('❌ You need to be in a voice channel!');
      return message.reply({ embeds: [embed] });
    }

    let player = riffy.players.get(message.guild.id);
    if (player) {
      const embed = new EmbedBuilder().setColor('#ff0000').setDescription('❌ Already connected to a voice channel!');
      return message.reply({ embeds: [embed] });
    }

    riffy.createConnection({
      guildId: message.guild.id,
      voiceChannel: message.member.voice.channel.id,
      textChannel: message.channel.id,
      deaf: true
    });

    const embed = new EmbedBuilder()
      .setColor('#00ff00')
      .setDescription(`✅ Joined ${message.member.voice.channel.name}`);
    message.reply({ embeds: [embed] });
  }

  // LEAVE Command
  if (command === 'leave') {
    const player = riffy.players.get(message.guild.id);
    if (!player) {
      const embed = new EmbedBuilder().setColor('#ff0000').setDescription('❌ Not connected to a voice channel!');
      return message.reply({ embeds: [embed] });
    }

    player.destroy();
    const embed = new EmbedBuilder().setColor('#0099ff').setDescription('👋 Disconnected from voice channel!');
    message.reply({ embeds: [embed] });
  }

  // VOLUME Command
  if (command === 'volume') {
    const player = riffy.players.get(message.guild.id);
    if (!player) {
      const embed = new EmbedBuilder().setColor('#ff0000').setDescription('❌ No music is playing!');
      return message.reply({ embeds: [embed] });
    }

    const volume = parseInt(args[1]);
    if (!volume || volume < 0 || volume > 100) {
      const embed = new EmbedBuilder()
        .setColor('#0099ff')
        .setDescription(`🔊 Current volume: **${player.volume}%**\n\nUsage: \`@${client.user.username} volume <0-100>\``);
      return message.reply({ embeds: [embed] });
    }

    player.setVolume(volume);
    const embed = new EmbedBuilder().setColor('#0099ff').setDescription(`🔊 Volume set to **${volume}%**`);
    message.reply({ embeds: [embed] });
  }

  // HELP Command
  if (command === 'help') {
    const embed = new EmbedBuilder()
      .setColor('#0099ff')
      .setTitle(`🎵 ${client.user.username} Commands`)
      .setDescription(`Mention me with a command! Example: \`@${client.user.username} play song name\``)
      .setThumbnail(client.user.displayAvatarURL())
      .addFields(
        { name: '🎵 Music', value: '`play (p)` `pause` `resume (r)` `skip (s, next)` `stop (dc)` `queue (q)` `nowplaying (np)` `volume (vol, v)`' },
        { name: '🔧 Utility', value: '`join (connect)` `leave (disconnect)` `ping` `uptime (ut)` `botinfo (bi, info)` `stats`' },
        { name: '🔗 Links', value: '`support` `invite (inv)` `vote`' },
        { name: '📝 Note', value: 'Commands in parentheses are aliases you can use as shortcuts!' }
      )
      .setFooter({ text: `Requested by ${message.author.tag}`, iconURL: message.author.displayAvatarURL() });

    const inviteUrl = `https://discord.com/api/oauth2/authorize?client_id=${client.user.id}&permissions=36700160&scope=bot`;
    const supportUrl = 'https://discord.gg/MpXyChY5yw';

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setLabel('Invite Me')
        .setURL(inviteUrl)
        .setStyle(ButtonStyle.Link),
      new ButtonBuilder()
        .setLabel('Support Server')
        .setURL(supportUrl)
        .setStyle(ButtonStyle.Link)
    );

    message.reply({ embeds: [embed], components: [row] });
  }

  // PING Command
  if (command === 'ping') {
    const embed = new EmbedBuilder()
      .setColor('#0099ff')
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
      .setColor('#0099ff')
      .setTitle(`⏰ ${client.user.username} Uptime`)
      .setDescription(`\`${formatUptime(uptime)}\``);

    message.reply({ embeds: [embed] });
  }

  // BOTINFO Command
  if (command === 'botinfo') {
    const embed = new EmbedBuilder()
      .setColor('#0099ff')
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
      .setColor('#0099ff')
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
      .setColor('#0099ff')
      .setTitle('💬 Support Server')
      .setDescription(`[Click here to join](https://discord.gg/MpXyChY5yw)`)

    message.reply({ embeds: [embed] });
  }

  // INVITE Command
  if (command === 'invite') {
    const invite = `https://discord.com/api/oauth2/authorize?client_id=${client.user.id}&permissions=36700160&scope=bot`;
    const embed = new EmbedBuilder()
      .setColor('#0099ff')
      .setTitle(`📨 Invite ${client.user.username}!`)
      .setDescription(`[Click here to invite](${invite})`)

    message.reply({ embeds: [embed] });
  }

  // VOTE Command
  if (command === 'vote') {
    const embed = new EmbedBuilder()
      .setColor('#0099ff')
      .setTitle(`🗳️ Vote for ${client.user.username}!`)
      .setDescription(`[Vote on Top.gg](https://top.gg/bot/${client.user.id}/vote)`)

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
