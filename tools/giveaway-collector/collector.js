const fs = require("fs");
const path = require("path");
const { isExactCommand } = require("./match");
const { extractTikTokChat } = require("./tiktok");
const { extractMessages, liveVideoIdFromSearch, liveChatIdFromVideos, nextPoll } = require("./youtube");
const { postEntry } = require("./post");
const { createStore } = require("./store");

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index === -1) continue;
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] == null || process.env[key] === "") process.env[key] = value;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function enabled(value, fallback) {
  if (value == null || String(value).trim() === "") return fallback;
  const text = String(value).trim();
  if (text === "off" || text === "-") return "";
  return text.replace(/^@+/, "");
}

let stopped = false;

function entryFrom(partial) {
  const messageId = partial.messageId || partial.userId + ":" + partial.liveId;
  return {
    platform: partial.platform,
    userId: partial.userId,
    handle: partial.handle || partial.displayName,
    displayName: partial.displayName || partial.handle,
    liveId: partial.liveId,
    ts: partial.ts || Date.now(),
    messageId,
    command: partial.message,
  };
}

async function submit(store, entry) {
  const key = store.key(entry);
  if (!entry.userId || !entry.liveId || store.has(key)) return;
  store.appendEvent({ type: "match", at: new Date().toISOString(), platform: entry.platform, handle: entry.handle, liveId: entry.liveId });
  const result = await postEntry({
    url: process.env.GIVEAWAY_API_URL,
    secret: process.env.GIVEAWAY_INGEST_SECRET,
    payload: entry,
  });
  const errorCode = result.body && result.body.error;
  store.appendEvent({
    type: "result",
    at: new Date().toISOString(),
    platform: entry.platform,
    handle: entry.handle,
    http: result.status,
    error: errorCode || null,
  });
  if (result.status === 401) {
    console.error("Secretul GIVEAWAY_INGEST_SECRET a fost respins. Verifică fișierul .env.");
    stopped = true;
    return;
  }
  if (result.ok || !result.retry) {
    store.mark(key);
    const label = result.ok ? (result.body && result.body.status) || "ok" : errorCode || "respins";
    console.log(entry.platform + " @" + entry.handle + " → " + label);
    return;
  }
  store.appendPending(entry);
  console.log("Nu am putut trimite @" + entry.handle + ". Reîncerc la repornire.");
}

async function replay(store) {
  for (const entry of store.readPending()) {
    if (stopped) return;
    await submit(store, entry);
  }
}

async function watchTikTok(store, uniqueId, signApiKey) {
  const imported = await import("tiktok-live-connector");
  const TikTokLiveConnection = imported.TikTokLiveConnection;
  const WebcastEvent = imported.WebcastEvent;
  const ControlEvent = imported.ControlEvent;
  while (!stopped) {
    const connection = new TikTokLiveConnection(uniqueId, signApiKey ? { signApiKey } : {});
    let roomId = "";
    connection.on(WebcastEvent.CHAT, (event) => {
      const chat = extractTikTokChat(event);
      const liveId = "tiktok:" + (chat.roomId || roomId);
      if (!isExactCommand(chat.message) || !chat.userId || liveId === "tiktok:") return;
      submit(store, entryFrom({
        platform: "tiktok",
        userId: chat.userId,
        handle: chat.handle,
        displayName: chat.displayName,
        liveId,
        message: chat.message,
        messageId: chat.messageId,
        ts: chat.ts || Date.now(),
      })).catch((error) => console.error("TikTok:", error.message));
    });
    try {
      const state = await connection.connect();
      roomId = String((state && state.roomId) || connection.roomId || "");
      console.log("TikTok conectat. Room " + roomId);
      await new Promise((resolve) => {
        const done = () => resolve();
        connection.once(ControlEvent.DISCONNECTED, done);
        connection.once(WebcastEvent.STREAM_END, done);
      });
      console.log("TikTok deconectat. Reîncerc în 15 secunde.");
    } catch (error) {
      console.error("TikTok nu este live sau conexiunea a eșuat. Reîncerc în 15 secunde.");
    }
    await sleep(15000);
  }
}

async function youtubeGet(url) {
  const response = await fetch(url);
  if (!response.ok) {
    const error = new Error("youtube_" + response.status);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

async function watchYouTube(store, apiKey, channelId, pinnedVideo) {
  while (!stopped) {
    try {
      let videoId = pinnedVideo;
      if (!videoId) {
        const search = new URL("https://www.googleapis.com/youtube/v3/search");
        search.searchParams.set("part", "snippet");
        search.searchParams.set("channelId", channelId);
        search.searchParams.set("eventType", "live");
        search.searchParams.set("type", "video");
        search.searchParams.set("maxResults", "1");
        search.searchParams.set("key", apiKey);
        videoId = liveVideoIdFromSearch(await youtubeGet(search));
      }
      if (!videoId) {
        console.log("YouTube nu este live. Verific din nou în 20 de secunde.");
        await sleep(20000);
        continue;
      }
      const videos = new URL("https://www.googleapis.com/youtube/v3/videos");
      videos.searchParams.set("part", "liveStreamingDetails");
      videos.searchParams.set("id", videoId);
      videos.searchParams.set("key", apiKey);
      const chatId = liveChatIdFromVideos(await youtubeGet(videos));
      if (!chatId) {
        console.log("YouTube nu are chat activ. Verific din nou în 20 de secunde.");
        await sleep(20000);
        continue;
      }
      console.log("YouTube conectat. Video " + videoId);
      let pageToken = "";
      while (!stopped) {
        const messages = new URL("https://www.googleapis.com/youtube/v3/liveChat/messages");
        messages.searchParams.set("liveChatId", chatId);
        messages.searchParams.set("part", "snippet,authorDetails");
        messages.searchParams.set("key", apiKey);
        if (pageToken) messages.searchParams.set("pageToken", pageToken);
        const payload = await youtubeGet(messages);
        for (const item of extractMessages(payload)) {
          if (!isExactCommand(item.message)) continue;
          await submit(store, entryFrom({
            platform: "youtube",
            userId: item.userId,
            handle: item.handle,
            displayName: item.displayName,
            liveId: "youtube:" + videoId,
            message: item.message,
            messageId: item.messageId,
            ts: item.publishedAt || Date.now(),
          }));
        }
        pageToken = payload.nextPageToken || "";
        await sleep(nextPoll(payload));
      }
    } catch (error) {
      console.error("YouTube: " + (error.message || "eroare") + ". Reîncerc în 20 de secunde.");
      await sleep(20000);
    }
  }
}

async function main() {
  loadEnv(path.join(__dirname, ".env"));
  if (!process.env.GIVEAWAY_API_URL || !process.env.GIVEAWAY_INGEST_SECRET) {
    console.error("Completează GIVEAWAY_API_URL și GIVEAWAY_INGEST_SECRET în fișierul .env.");
    process.exit(1);
  }
  const tiktokId = enabled(process.env.TIKTOK_UNIQUE_ID, "kipzone.ro");
  const youtubeKey = enabled(process.env.YOUTUBE_API_KEY, "");
  const channelId = enabled(process.env.YOUTUBE_CHANNEL_ID, "UCto-qi-euTHISWnC8SQ93oQ");
  if (!tiktokId && !youtubeKey) {
    console.error("Activează TikTok sau pune YOUTUBE_API_KEY.");
    process.exit(1);
  }
  const store = createStore(path.resolve(process.env.DATA_DIR || path.join(__dirname, "data")));
  console.log("Pornit. TikTok: " + (tiktokId ? "@" + tiktokId : "oprit") + ". YouTube: " + (youtubeKey ? "pornit" : "oprit (lipsește YOUTUBE_API_KEY)") + ".");
  await replay(store);
  const jobs = [];
  if (tiktokId) jobs.push(watchTikTok(store, tiktokId, enabled(process.env.EULER_API_KEY, "")));
  if (youtubeKey) jobs.push(watchYouTube(store, youtubeKey, channelId, enabled(process.env.YOUTUBE_VIDEO_ID, "")));
  await Promise.all(jobs);
}

process.on("SIGINT", () => {
  stopped = true;
  console.log("Oprire.");
  process.exit(0);
});

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message || "Eroare.");
    process.exit(1);
  });
}

module.exports = { loadEnv, entryFrom };
