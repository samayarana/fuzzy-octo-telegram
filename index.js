require("dotenv").config();

const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  Collection
} = require("discord.js");

const express = require("express");
const { Riffy } = require("riffy");

// ====== CONFIG ======
const BOT_ID = "1450084513513341050";
const OWNER_ID = "1092773378101882951";

const SUPPORT = "https://discord.gg/su57JWf2V5";
const VOTE = "https://discord.gg/su57JWf2V5"; // replace if needed

const LAVALINK = {
  host: "lavalink.jirayu.net",
  port: 13592,
  password: "youshallnotpass",
  secure: false
};

// ====== CLIENT ======
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages
  ]
});

// ====== EXPRESS SERVER ======
const app = express();
app.get("/", (req, res) => res.send("Bot is alive"));
app.listen(3000, () => console.log("🌐 Express server running"));

// ====== RIFFY ======
let lavalinkReady = false;

const riffy = new Riffy(client, [LAVALINK], {
  send: (id, payload) => {
    const guild = client.guilds.cache.get(id);
    if (guild) guild.shard.send(payload);
  }
});

client.on("ready", () => {
  console.log(`🤖 Logged in as ${client.user.tag}`);
  riffy.init(client.user.id);
});

riffy.on("nodeConnect", () => {
  lavalinkReady = true;
  console.log("✅ Lavalink Connected");
});

riffy.on("nodeDisconnect", () => {
  lavalinkReady = false;
  console.log("❌ Lavalink Disconnected");
});

// ====== HELPERS ======
function getEmbed(desc, color = "Blurple") {
  return new EmbedBuilder().setDescription(desc).setColor(color);
}

function lavalinkError() {
  return getEmbed("❌ Lavalink is currently offline. Music commands are disabled.", "Red");
}

// ====== COMMAND PARSER ======
client.on("messageCreate", async (message) => {
  if (!message.guild || message.author.bot) return;

  if (!message.mentions.has(BOT_ID)) return;

  const args = message.content
    .replace(/<@!?1450084513513341050>/g, "")
    .trim()
    .split(/ +/);

  const cmd = args.shift()?.toLowerCase();

  if (!cmd) return;

  const player = riffy.players.get(message.guild.id);

  // ===== OWNER COMMAND =====
  if (cmd === "restart") {
    if (message.author.id !== OWNER_ID)
      return message.reply({ embeds: [getEmbed("❌ Owner only command", "Red")] });

    await message.reply("🔄 Restarting...");
    process.exit(0);
  }

  // ===== UTILITY =====
  if (cmd === "ping")
    return message.reply(`🏓 Pong: ${client.ws.ping}ms`);

  if (cmd === "uptime")
    return message.reply(`⏱️ Uptime: ${Math.floor(process.uptime())}s`);

  if (cmd === "botinfo")
    return message.reply({
      embeds: [getEmbed("🤖 Drum Music Bot\nPowered by Riffy + Lavalink v4")]
    });

  if (cmd === "support")
    return message.reply(SUPPORT);

  if (cmd === "vote")
    return message.reply(VOTE);

  if (cmd === "stats")
    return message.reply({
      embeds: [
        getEmbed(
          `Servers: ${client.guilds.cache.size}\nLavalink: ${
            lavalinkReady ? "🟢 Online" : "🔴 Offline"
          }`
        )
      ]
    });

  if (cmd === "invite")
    return message.reply(
      `https://discord.com/api/oauth2/authorize?client_id=${BOT_ID}&permissions=8&scope=bot`
    );

  // ===== NON-MUSIC COMMANDS CONTINUE EVEN IF LAVALINK DOWN =====
  if (!lavalinkReady)
    return message.reply({ embeds: [lavalinkError()] });

  // ===== MUSIC =====
  if (cmd === "join") {
    if (!message.member.voice.channel)
      return message.reply("Join a voice channel first.");

    riffy.createConnection({
      guildId: message.guild.id,
      voiceChannel: message.member.voice.channel.id,
      textChannel: message.channel.id,
      deaf: true
    });

    return message.reply("🔊 Joined voice channel");
  }

  if (cmd === "leave" || cmd === "dc") {
    if (!player) return message.reply("Nothing playing.");
    player.destroy();
    return message.reply("👋 Disconnected");
  }

  if (cmd === "play" || cmd === "p") {
    const query = args.join(" ");
    if (!query) return message.reply("Provide a song name.");

    if (!message.member.voice.channel)
      return message.reply("Join a VC first");

    const res = await riffy.resolve(query);
    if (!res || !res.tracks.length)
      return message.reply("No results.");

    let player = riffy.createConnection({
      guildId: message.guild.id,
      voiceChannel: message.member.voice.channel.id,
      textChannel: message.channel.id,
      deaf: true
    });

    player.queue.add(res.tracks[0]);

    if (!player.playing && !player.paused) player.play();

    message.reply(`🎶 Playing: **${res.tracks[0].info.title}**`);
  }

  if (cmd === "pause")
    return player?.pause(true) && message.reply("⏸ Paused");

  if (cmd === "resume" || cmd === "r")
    return player?.pause(false) && message.reply("▶ Resumed");

  if (cmd === "skip" || cmd === "s")
    return player?.stop() && message.reply("⏭ Skipped");

  if (cmd === "queue" || cmd === "q") {
    if (!player || !player.queue.length)
      return message.reply("Queue empty");

    return message.reply(
      player.queue.map((t, i) => `${i + 1}. ${t.info.title}`).join("\n")
    );
  }

  if (cmd === "stop")
    return player?.destroy() && message.reply("🛑 Stopped");

  if (cmd === "volume" || cmd === "vol") {
    const vol = Number(args[0]);
    if (!vol) return;
    player.setVolume(vol);
    message.reply(`🔊 Volume set to ${vol}`);
  }

  if (cmd === "nowplaying" || cmd === "np") {
    if (!player?.current) return message.reply("Nothing playing");
    return message.reply(`🎧 ${player.current.info.title}`);
  }

  if (cmd === "clearqueue" || cmd === "cq") {
    player.queue.clear();
    return message.reply("🧹 Queue cleared");
  }

  if (cmd === "shuffle" || cmd === "sh") {
    player.queue.shuffle();
    return message.reply("🔀 Shuffled");
  }

  if (cmd === "loop") {
    player.setLoop(player.loop === "none" ? "track" : "none");
    return message.reply("🔁 Loop toggled");
  }

  if (cmd === "remove" || cmd === "rm") {
    const i = Number(args[0]) - 1;
    if (isNaN(i)) return;
    player.queue.remove(i);
    return message.reply("❌ Removed");
  }

  if (cmd === "move" || cmd === "mv") {
    const from = Number(args[0]) - 1;
    const to = Number(args[1]) - 1;
    player.queue.move(from, to);
    return message.reply("↕ Moved");
  }

  if (cmd === "lyrics" || cmd === "ly")
    return message.reply("🎤 Lyrics feature not implemented yet.");
});

// ===== LOGIN =====
client.login(process.env.BOT_TOKEN);
