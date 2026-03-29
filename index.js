require("dotenv").config();

const {
  Client,
  GatewayIntentBits,
  EmbedBuilder
} = require("discord.js");

const express = require("express");
const { Riffy } = require("riffy");

// ===== CONFIG =====
const BOT_ID = "1450084513513341050";
const OWNER_ID = "1092773378101882951";

const SUPPORT = "https://discord.gg/su57JWf2V5";
const VOTE = "https://discord.gg/su57JWf2V5";

const LAVALINK = {
  host: "lavalink.jirayu.net",
  port: 13592,
  password: "youshallnotpass",
  secure: false
};

// ===== CLIENT =====
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages
  ]
});

// ===== EXPRESS =====
const app = express();
app.get("/", (req, res) => res.send("Bot Alive"));
app.listen(3000, () => console.log("🌐 Express server running"));

// ===== RIFFY =====
let lavalinkReady = false;

const riffy = new Riffy(client, [LAVALINK], {
  send: (id, payload) => {
    const guild = client.guilds.cache.get(id);
    if (guild) guild.shard.send(payload);
  }
});

// 🔥 REQUIRED FIX (voice updates)
client.on("raw", (d) => riffy.updateVoiceState(d));

// ===== READY =====
client.on("clientReady", () => {
  console.log(`🤖 Logged in as ${client.user.tag}`);
  riffy.init(client.user.id);
});

// ===== LAVALINK EVENTS =====
riffy.on("nodeConnect", () => {
  lavalinkReady = true;
  console.log("✅ Lavalink Connected");
});

riffy.on("nodeDisconnect", () => {
  lavalinkReady = false;
  console.log("❌ Lavalink Disconnected");
});

riffy.on("nodeError", (node, error) => {
  console.log("❌ Lavalink Error:", error);
});

riffy.on("debug", (msg) => {
  console.log("🔍", msg);
});

// ===== HELPERS =====
const embed = (msg, color = "Blurple") =>
  new EmbedBuilder().setDescription(msg).setColor(color);

const lavalinkError = () =>
  embed("❌ Lavalink is offline. Music commands disabled.", "Red");

// ===== COMMAND HANDLER =====
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

  // ===== OWNER =====
  if (cmd === "restart") {
    if (message.author.id !== OWNER_ID)
      return message.reply({ embeds: [embed("❌ Owner only", "Red")] });

    await message.reply("🔄 Restarting...");
    process.exit(0);
  }

  // ===== UTILITY =====
  if (cmd === "ping")
    return message.reply(`🏓 ${client.ws.ping}ms`);

  if (cmd === "uptime")
    return message.reply(`⏱ ${Math.floor(process.uptime())}s`);

  if (cmd === "botinfo")
    return message.reply({
      embeds: [embed("🤖 Drum Music Bot\nRiffy + Lavalink v4")]
    });

  if (cmd === "support") return message.reply(SUPPORT);
  if (cmd === "vote") return message.reply(VOTE);

  if (cmd === "stats")
    return message.reply({
      embeds: [
        embed(
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

  // ===== BLOCK MUSIC IF LAVALINK DOWN =====
  const musicCmds = [
    "play","p","pause","resume","r","skip","s","stop","dc",
    "queue","q","clearqueue","cq","shuffle","sh",
    "remove","rm","move","mv","loop",
    "nowplaying","np","join","leave","volume","vol","lyrics","ly"
  ];

  if (!lavalinkReady && musicCmds.includes(cmd))
    return message.reply({ embeds: [lavalinkError()] });

  // ===== MUSIC =====
  if (cmd === "join") {
    if (!message.member.voice.channel)
      return message.reply("Join VC first");

    riffy.createConnection({
      guildId: message.guild.id,
      voiceChannel: message.member.voice.channel.id,
      textChannel: message.channel.id,
      deaf: true
    });

    return message.reply("🔊 Joined");
  }

  if (cmd === "leave" || cmd === "dc") {
    if (!player) return message.reply("Nothing playing");
    player.destroy();
    return message.reply("👋 Left");
  }

  if (cmd === "play" || cmd === "p") {
    const query = args.join(" ");
    if (!query) return message.reply("Give song name");

    if (!message.member.voice.channel)
      return message.reply("Join VC");

    const res = await riffy.resolve(query);
    if (!res?.tracks?.length)
      return message.reply("No results");

    const player = riffy.createConnection({
      guildId: message.guild.id,
      voiceChannel: message.member.voice.channel.id,
      textChannel: message.channel.id,
      deaf: true
    });

    player.queue.add(res.tracks[0]);
    if (!player.playing) player.play();

    return message.reply(`🎶 ${res.tracks[0].info.title}`);
  }

  if (cmd === "pause")
    return player?.pause(true) && message.reply("⏸ Paused");

  if (cmd === "resume" || cmd === "r")
    return player?.pause(false) && message.reply("▶ Resumed");

  if (cmd === "skip" || cmd === "s")
    return player?.stop() && message.reply("⏭ Skipped");

  if (cmd === "stop")
    return player?.destroy() && message.reply("🛑 Stopped");

  if (cmd === "queue" || cmd === "q") {
    if (!player?.queue.length)
      return message.reply("Empty queue");

    return message.reply(
      player.queue.map((t, i) => `${i + 1}. ${t.info.title}`).join("\n")
    );
  }

  if (cmd === "clearqueue" || cmd === "cq") {
    player.queue.clear();
    return message.reply("🧹 Cleared");
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

  if (cmd === "volume" || cmd === "vol") {
    const v = Number(args[0]);
    if (!v) return;
    player.setVolume(v);
    return message.reply(`🔊 ${v}`);
  }

  if (cmd === "nowplaying" || cmd === "np") {
    if (!player?.current)
      return message.reply("Nothing playing");

    return message.reply(`🎧 ${player.current.info.title}`);
  }

  // ===== LYRICS (lrclib) =====
  if (cmd === "lyrics" || cmd === "ly") {
    try {
      let query = args.join(" ");

      if (!query) {
        if (!player?.current)
          return message.reply("Provide song name");

        query = player.current.info.title;
      }

      const res = await fetch(
        `https://lrclib.net/api/search?q=${encodeURIComponent(query)}`
      ).then(r => r.json());

      if (!res.length)
        return message.reply("No lyrics found");

      const lyrics = res[0].plainLyrics?.slice(0, 2000);

      return message.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle(`🎤 ${res[0].trackName}`)
            .setDescription(lyrics || "No lyrics")
            .setColor("Blurple")
        ]
      });

    } catch (e) {
      console.log(e);
      message.reply("Lyrics error");
    }
  }
});

// ===== LOGIN =====
client.login(process.env.BOT_TOKEN);
