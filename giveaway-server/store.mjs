import { randomInt, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export const platforms = ['tiktok', 'kick', 'youtube'];
const normalize = text => text.normalize('NFKC').trim().toLowerCase();
const animationDelay = 2200;
const animationDuration = 5800;

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function createStore(path) {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS round (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      revision INTEGER NOT NULL DEFAULT 0, keyword TEXT, openedAt INTEGER, draw TEXT
    );
    INSERT OR IGNORE INTO round (singleton) VALUES (1);
    CREATE TABLE IF NOT EXISTS entry (
      platform TEXT NOT NULL, account TEXT NOT NULL, name TEXT NOT NULL,
      PRIMARY KEY (platform, account)
    );
    CREATE TABLE IF NOT EXISTS excluded (
      platform TEXT NOT NULL, account TEXT NOT NULL, PRIMARY KEY (platform, account)
    );
  `);
  const round = db.prepare('SELECT revision, keyword, openedAt, draw FROM round WHERE singleton = 1');
  const list = db.prepare('SELECT platform, name FROM entry ORDER BY rowid');
  const count = db.prepare('SELECT COUNT(*) AS count FROM entry');
  const insert = db.prepare('INSERT OR IGNORE INTO entry VALUES (?, ?, ?)');
  const eligible = db.prepare(`
    SELECT platform, account, name FROM entry
    WHERE NOT EXISTS (SELECT 1 FROM excluded WHERE excluded.platform = entry.platform AND excluded.account = entry.account)
    ORDER BY rowid
  `);
  const exclude = db.prepare('INSERT INTO excluded VALUES (?, ?)');
  const saveDraw = db.prepare('UPDATE round SET revision = revision + 1, draw = ?');
  const replaceRound = db.prepare('UPDATE round SET revision = revision + 1, keyword = ?, openedAt = ?, draw = NULL');

  function transaction(write, work) {
    db.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN');
    try {
      const result = work();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function snapshot(overlay = false, now = Date.now(), knownParticipants) {
    return transaction(false, () => {
      const { revision, keyword, draw } = round.get();
      const result = JSON.parse(draw);
      const phase = result ? (now < result.endsAt ? 'drawing' : 'drawn') : keyword ? 'open' : 'idle';
      const participantCount = count.get().count;
      return {
        revision, keyword, phase, serverTime: now, count: participantCount,
        participants: overlay || knownParticipants === `${revision}:${participantCount}` ? undefined : list.all(),
        remaining: !overlay && result ? result.remaining : undefined,
        draw: phase === 'drawing' ? { id: result.id, startsAt: result.startsAt, endsAt: result.endsAt, reel: result.reel }
          : result ? { id: result.id, winner: result.winner } : null
      };
    });
  }

  function ingest(platform, messages) {
    if (!platforms.includes(platform)) throw new Error('Unknown platform');
    return transaction(true, () => {
      const { keyword, openedAt, draw } = round.get();
      if (!keyword || draw) return 0;
      let added = 0;
      const now = Date.now();
      for (const { account, name, text, sentAt } of messages) {
        if (typeof account !== 'string' || !account.trim() || account.length > 200 ||
            typeof name !== 'string' || !name.trim() || typeof text !== 'string' || text.length > 1000 ||
            !Number.isFinite(sentAt) || sentAt < openedAt || sentAt > now + 30_000 || normalize(text) !== keyword) continue;
        added += insert.run(platform, account, [...name.trim()].slice(0, 80).join('')).changes;
      }
      return added;
    });
  }

  function control({ action, revision, keyword }, now = Date.now()) {
    transaction(true, () => {
      const current = round.get();
      if (revision !== current.revision) throw new HttpError(409, 'Starea s-a schimbat. Verifică panoul și încearcă din nou.');
      const previous = JSON.parse(current.draw);
      if (previous && now < previous.endsAt) throw new HttpError(409, 'Extragerea este în desfășurare.');
      if (action === 'start' || action === 'reset') {
        if (action === 'start' && current.keyword) throw new HttpError(409, 'Resetează runda înainte de a porni alta.');
        const word = typeof keyword === 'string' && keyword.length <= 40 ? normalize(keyword) : '';
        if (action === 'start' && !/^[!#]?[\p{L}\p{N}_-]{1,30}$/u.test(word)) {
          throw new HttpError(400, 'Introdu un singur cuvânt-cheie (maximum 30 de caractere).');
        }
        db.exec('DELETE FROM entry; DELETE FROM excluded;');
        replaceRound.run(action === 'start' ? word : null, action === 'start' ? now : null);
        return;
      }
      if (action !== 'draw' && action !== 'redraw') throw new HttpError(400, 'Acțiune necunoscută.');
      if (!current.keyword || (action === 'redraw') !== Boolean(previous)) {
        throw new HttpError(409, 'Acțiunea nu este disponibilă în această rundă.');
      }
      const pool = eligible.all();
      if (!pool.length) throw new HttpError(409, 'Nu mai sunt participanți eligibili.');
      const winner = pool[randomInt(pool.length)];
      const reel = Array.from({ length: 46 }, (_, index) => {
        if (index === 2) return null;
        const entry = pool[randomInt(pool.length)];
        return { name: entry.name, platform: entry.platform };
      });
      exclude.run(winner.platform, winner.account);
      const startsAt = now + animationDelay;
      saveDraw.run(JSON.stringify({ id: randomUUID(), startsAt, endsAt: startsAt + animationDuration, reel,
        winner: { name: winner.name, platform: winner.platform }, remaining: pool.length - 1 }));
    });
    return snapshot(false, now);
  }

  return { snapshot, ingest, control, isOpen: () => {
    const { keyword, draw } = round.get();
    return Boolean(keyword && !draw);
  }, close: () => db.close() };
}
