function extractMessages(payload) {
  const items = payload && Array.isArray(payload.items) ? payload.items : [];
  const out = [];
  for (const item of items) {
    const snippet = item && item.snippet;
    const author = item && item.authorDetails;
    if (!snippet || snippet.type !== "textMessageEvent" || !author || !author.channelId) continue;
    const text = snippet.displayMessage || (snippet.textMessageDetails && snippet.textMessageDetails.messageText) || "";
    out.push({
      userId: String(author.channelId),
      handle: String(author.displayName || author.channelId),
      displayName: String(author.displayName || ""),
      message: String(text),
      messageId: String(item.id || ""),
      publishedAt: snippet.publishedAt || "",
    });
  }
  return out;
}

function liveVideoIdFromSearch(payload) {
  const item = payload && Array.isArray(payload.items) ? payload.items[0] : null;
  return item && item.id && item.id.videoId ? String(item.id.videoId) : "";
}

function liveChatIdFromVideos(payload) {
  const item = payload && Array.isArray(payload.items) ? payload.items[0] : null;
  const details = item && item.liveStreamingDetails;
  return details && details.activeLiveChatId ? String(details.activeLiveChatId) : "";
}

function nextPoll(payload) {
  const wait = Number(payload && payload.pollingIntervalMillis);
  return Number.isFinite(wait) && wait >= 1000 ? wait : 5000;
}

module.exports = {
  extractMessages,
  liveVideoIdFromSearch,
  liveChatIdFromVideos,
  nextPoll,
};
