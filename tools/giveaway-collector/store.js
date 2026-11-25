const fs = require("fs");
const path = require("path");

function createStore(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const seenPath = path.join(dir, "seen.log");
  const eventsPath = path.join(dir, "events.jsonl");
  const pendingPath = path.join(dir, "pending.jsonl");
  const seen = new Set();
  if (fs.existsSync(seenPath)) {
    for (const line of fs.readFileSync(seenPath, "utf8").split(/\r?\n/)) {
      if (line) seen.add(line);
    }
  }
  return {
    key(entry) {
      return entry.platform + "\t" + entry.userId + "\t" + entry.liveId;
    },
    has(key) {
      return seen.has(key);
    },
    mark(key) {
      if (seen.has(key)) return;
      seen.add(key);
      fs.appendFileSync(seenPath, key + "\n");
    },
    appendEvent(record) {
      fs.appendFileSync(eventsPath, JSON.stringify(record) + "\n");
    },
    appendPending(entry) {
      fs.appendFileSync(pendingPath, JSON.stringify(entry) + "\n");
    },
    readPending() {
      if (!fs.existsSync(pendingPath)) return [];
      const out = [];
      for (const line of fs.readFileSync(pendingPath, "utf8").split(/\r?\n/)) {
        if (!line) continue;
        try {
          out.push(JSON.parse(line));
        } catch (error) {
          /* Ignore a damaged line. The file is append-only. */
        }
      }
      return out;
    },
  };
}

module.exports = { createStore };
