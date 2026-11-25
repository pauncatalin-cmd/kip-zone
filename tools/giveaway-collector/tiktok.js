function asText(value) {
  if (value == null || value === "") return "";
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "object") {
    if (value.idStr) return String(value.idStr);
    if (typeof value.toString === "function" && value.toString !== Object.prototype.toString) {
      const text = value.toString();
      if (text && text !== "[object Object]") return text;
    }
    return "";
  }
  return String(value);
}

function first() {
  for (let i = 0; i < arguments.length; i++) {
    const text = asText(arguments[i]);
    if (text) return text;
  }
  return "";
}

function extractTikTokChat(event) {
  const user = (event && event.user) || {};
  const common = (event && event.common) || {};
  return {
    userId: first(user.idStr, user.id, user.userId, event && event.userId),
    handle: first(user.displayId, user.uniqueId, event && event.uniqueId),
    displayName: first(user.nickname, event && event.nickname, user.displayId, user.uniqueId),
    message: first(event && event.content, event && event.comment),
    messageId: first(common.msgId, event && event.msgId),
    roomId: first(common.roomId, event && event.roomId),
    ts: first(common.createTime, event && event.createTime),
  };
}

module.exports = { extractTikTokChat };
