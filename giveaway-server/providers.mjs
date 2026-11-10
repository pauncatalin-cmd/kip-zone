import { createPublicKey, verify } from 'node:crypto';
import { HttpError } from './store.mjs';

const kickKeyUrl = 'https://api.kick.com/public/v1/public-key';
const youtubeApi = 'https://www.googleapis.com/youtube/v3/';

export function createKickReader(channelId, fetcher = fetch) {
  let key;
  let lastRefresh = 0;
  let pending;

  async function refreshKey() {
    if (pending) return pending;
    if (Date.now() - lastRefresh < 30_000) return key;
    lastRefresh = Date.now();
    pending = (async () => {
      const response = await fetcher(kickKeyUrl, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error('Kick public key unavailable');
      const body = await response.text();
      key = createPublicKey(body.startsWith('-----BEGIN') ? body : JSON.parse(body).data.public_key);
      return key;
    })();
    try { return await pending; }
    finally { pending = null; }
  }

  return async (headers, raw) => {
    const id = headers['kick-event-message-id'];
    const timestamp = headers['kick-event-message-timestamp'];
    const signature = headers['kick-event-signature'];
    const age = Date.now() - Date.parse(timestamp);
    if (!id || !signature || !Number.isFinite(age) || age < -30_000 || age > 5 * 60_000) {
      throw new HttpError(401, 'Semnătură Kick invalidă sau expirată.');
    }
    const data = Buffer.concat([Buffer.from(`${id}.${timestamp}.`), raw]);
    const matches = publicKey => publicKey && verify('RSA-SHA256', data, publicKey, Buffer.from(signature, 'base64'));
    if (!matches(key)) {
      let refreshed;
      try { refreshed = await refreshKey(); }
      catch { throw new HttpError(503, 'Cheia publică Kick este momentan indisponibilă.'); }
      if (!refreshed) throw new HttpError(503, 'Cheia publică Kick este momentan indisponibilă.');
      if (!matches(refreshed)) throw new HttpError(401, 'Semnătură Kick invalidă.');
    }
    if (headers['kick-event-type'] !== 'chat.message.sent' || headers['kick-event-version'] !== '1') return null;
    let event;
    try { event = JSON.parse(raw); }
    catch { throw new HttpError(400, 'Eveniment Kick invalid.'); }
    if (String(event?.broadcaster?.user_id) !== channelId || event.sender?.is_anonymous ||
        !Number.isSafeInteger(event.sender?.user_id) || event.sender.user_id <= 0) return null;
    return { account: String(event.sender.user_id), name: event.sender.username, text: event.content, sentAt: Date.parse(event.created_at) };
  };
}

export function startYouTubeReader(config, store, report, fetcher = fetch) {
  let timer;
  let stopped = false;
  let chatId;
  let pageToken;
  let token;
  let expiresAt = 0;
  let failures = 0;

  async function getToken() {
    if (token && Date.now() < expiresAt) return token;
    const response = await fetcher('https://oauth2.googleapis.com/token', {
      method: 'POST', signal: AbortSignal.timeout(10_000),
      body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret,
        refresh_token: config.refreshToken, grant_type: 'refresh_token' })
    });
    const body = await response.json();
    if (!response.ok || !body.access_token) throw Object.assign(new Error('YouTube OAuth'), {
      reason: body.error === 'invalid_grant' || body.error === 'invalid_client' ? 'authorization' : 'temporary'
    });
    token = body.access_token;
    expiresAt = Date.now() + Math.max(0, (body.expires_in - 60) * 1000);
    return token;
  }

  async function request(resource, parameters) {
    const url = new URL(resource, youtubeApi);
    url.search = new URLSearchParams(parameters);
    const response = await fetcher(url, { headers: { Authorization: `Bearer ${await getToken()}` }, signal: AbortSignal.timeout(10_000) });
    if (response.status === 401) token = null;
    const body = await response.json();
    if (!response.ok) {
      throw Object.assign(new Error('YouTube API'), {
        reason: body.error?.errors?.[0]?.reason ?? (response.status === 403 ? 'forbidden' : 'temporary'),
        retryAfter: retryAfterMs(response.headers.get('Retry-After'))
      });
    }
    return body;
  }

  function retryAfterMs(value) {
    if (!value) return 0;
    return /^\d+$/.test(value) ? Number(value) * 1000 : Math.max(0, Date.parse(value) - Date.now()) || 0;
  }

  function schedule(delay) {
    if (!stopped) timer = setTimeout(poll, Math.min(delay, 2_147_483_647));
  }

  async function poll() {
    if (!store.isOpen()) return schedule(2500);
    let delay = config.pollMs;
    try {
      if (!chatId) {
        const video = await request('videos', { part: 'liveStreamingDetails,snippet', id: config.videoId });
        const broadcast = video.items?.[0];
        if (broadcast && broadcast.snippet?.channelId !== config.channelId) throw Object.assign(new Error('Wrong channel'), { reason: 'wrongChannel' });
        chatId = broadcast?.liveStreamingDetails?.activeLiveChatId;
        if (!chatId) {
          report('waiting');
          return schedule(60_000);
        }
      }
      const body = await request('liveChat/messages', { part: 'snippet,authorDetails', liveChatId: chatId,
        maxResults: '2000', ...(pageToken ? { pageToken } : {}) });
      if (stopped) return;
      const entries = (body.items ?? []).filter(item => item.snippet?.type === 'textMessageEvent').map(item => ({
        account: item.authorDetails?.channelId,
        name: item.authorDetails?.displayName,
        text: item.snippet.textMessageDetails?.messageText,
        sentAt: Date.parse(item.snippet.publishedAt)
      }));
      store.ingest('youtube', entries);
      pageToken = body.nextPageToken;
      failures = 0;
      report(body.offlineAt ? 'waiting' : 'receiving');
      delay = Math.max(delay, Number(body.pollingIntervalMillis) || 0);
      if (body.offlineAt) {
        chatId = pageToken = undefined;
        delay = Math.max(delay, 60_000);
      }
    } catch (error) {
      failures += 1;
      const reason = error.reason;
      if (['liveChatEnded', 'liveChatNotFound', 'liveChatDisabled', 'invalidPageToken'].includes(reason)) {
        chatId = pageToken = undefined;
        report('waiting');
        delay = Math.max(delay, 60_000);
      } else if (['quotaExceeded', 'dailyLimitExceeded', 'dailyLimitExceededUnreg'].includes(reason)) {
        report('quota');
        delay = 30 * 60_000;
      } else if (['authorization', 'forbidden', 'insufficientPermissions', 'wrongChannel', 'accessNotConfigured'].includes(reason)) {
        report('authorization');
        delay = 5 * 60_000;
      } else {
        report('retrying');
        delay = Math.max(delay, Math.min(15_000 * 2 ** Math.min(failures - 1, 5), 300_000));
      }
      delay = Math.max(delay, error.retryAfter ?? 0);
    }
    schedule(delay);
  }

  schedule(0);
  return () => { stopped = true; clearTimeout(timer); };
}
