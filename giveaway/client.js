(() => {
  const root = document.querySelector('[data-giveaway]');
  const obs = root.dataset.giveaway === 'obs';
  const find = selector => root.querySelector(selector);
  const status = find('[data-status]');
  const slot = find('[data-slot]');
  const reel = find('[data-reel]');
  const winner = find('[data-winner]');
  const api = `${window.KIP_GIVEAWAY_ORIGIN || ''}/giveaway-api/`;
  const labels = { tiktok: 'TikTok LIVE', kick: 'Kick', youtube: 'YouTube Live' };
  const sourceLabels = { disabled: 'neconfigurat', waiting: 'în așteptare', receiving: 'recepție verificată',
    quota: 'cotă epuizată', authorization: 'verifică autorizarea', retrying: 'se reîncearcă' };
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const login = find('[data-login]');
  const controls = find('[data-controls]');
  const feedback = find('[data-feedback]');
  let state;
  let token;
  let busy = false;
  let online = false;
  let animation;
  let animatedId;
  let shownId;

  function setText(element, text) {
    if (element.textContent !== text) element.textContent = text;
  }

  function entryElement(tag, entry) {
    const row = document.createElement(tag);
    const name = document.createElement('b');
    const platform = document.createElement('small');
    row.className = 'giveaway-name';
    name.textContent = entry?.name ?? '…';
    name.title = entry?.name ?? '';
    platform.textContent = labels[entry?.platform] ?? '';
    row.append(name, platform);
    return row;
  }

  function reveal(id, entry) {
    if (shownId === id) return;
    shownId = id;
    winner.replaceChildren(entryElement('div', entry));
    winner.hidden = false;
    setText(status, `Câștigător · ${entry.name} (${labels[entry.platform]})`);
  }

  function renderDraw(draw, serverTime) {
    slot.hidden = !draw;
    if (!draw) {
      if (animation) {
        animation.cancel();
        animation = undefined;
        reel.replaceChildren();
      }
      animatedId = shownId = undefined;
      winner.hidden = true;
      return;
    }
    if (draw.winner) {
      if (animatedId !== draw.id) reel.replaceChildren();
      if (animation?.playState === 'running') animation.finish();
      reveal(draw.id, draw.winner);
      return;
    }
    if (animatedId === draw.id) return;
    animation?.cancel();
    animatedId = draw.id;
    winner.hidden = true;
    const duration = draw.endsAt - draw.startsAt;
    if (reducedMotion.matches) {
      reel.replaceChildren();
      return;
    }
    reel.replaceChildren(...draw.reel.map(entry => entryElement('div', entry)));
    const start = `translateY(calc(-${draw.reel.length - 5} * var(--giveaway-row)))`;
    animation = reel.animate([{ transform: start }, { transform: 'translateY(0)' }], { duration, fill: 'both', easing: 'cubic-bezier(.18,.72,.25,1)',
      delay: Math.max(0, draw.startsAt - serverTime) });
    if (serverTime > draw.startsAt) animation.currentTime = Math.min(duration, serverTime - draw.startsAt);
  }

  function updateControls() {
    if (!controls) return;
    const enabled = online && !busy && state?.phase !== 'drawing';
    const allowed = { start: state?.phase === 'idle', draw: state?.phase === 'open' && state.count > 0,
      redraw: state?.phase === 'drawn' && state.remaining > 0, reset: state?.phase !== 'idle' };
    for (const button of controls.querySelectorAll('[name=action]')) button.disabled = !(enabled && allowed[button.value]);
    login.querySelector('button').disabled = busy;
  }

  function render(next, serverTime) {
    if (state && next.serverTime < state.serverTime) return;
    state = next;
    online = true;
    root.hidden = obs && next.phase === 'idle';
    if (next.phase === 'idle') setText(status, 'În așteptarea următorului giveaway.');
    if (next.phase === 'open') setText(status, `Înscrieri deschise · Scrie ${next.keyword} în chat${obs ? ` · ${next.count} participanți` : ''}`);
    if (next.phase === 'drawing' && shownId !== next.draw.id) setText(status, 'Extragere în desfășurare…');
    if (next.phase === 'drawn' && shownId === next.draw.id) {
      setText(status, `Câștigător · ${next.draw.winner.name} (${labels[next.draw.winner.platform]})`);
    }
    renderDraw(next.draw, serverTime);
    if (!obs) {
      setText(find('[data-count]'), String(next.count));
      if (next.participants) {
        const list = document.createDocumentFragment();
        for (const entry of next.participants) list.append(entryElement('li', entry));
        find('[data-list]').replaceChildren(list);
      }
      const sources = Object.entries(labels).map(([platform, label]) => {
        const source = next.sources[platform];
        const seen = source.lastSeenAt && new Date(source.lastSeenAt).toLocaleTimeString('ro-RO', { hour: '2-digit', minute: '2-digit' });
        return `${label} · ${sourceLabels[source.status]}${seen ? ` (${seen})` : ''}`;
      });
      setText(find('[data-sources]'), sources.join('  |  '));
      updateControls();
    }
  }

  async function request(path, secret, body) {
    const started = performance.now();
    const response = await fetch(api + path, {
      method: body ? 'POST' : 'GET', cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(8000),
      headers: body ? { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined
    });
    const result = await response.json();
    if (!response.ok) throw Object.assign(new Error(result.error || 'Serviciul Giveaway este indisponibil.'), { status: response.status });
    render(result, result.serverTime + (performance.now() - started) / 2);
  }

  async function poll() {
    const query = obs ? '?view=obs' : state ? `?known=${state.revision}:${state.count}` : '';
    try { await request(`state${query}`); }
    catch {
      online = false;
      setText(status, 'Conexiunea cu Giveaway este indisponibilă. Se reîncearcă…');
      if (obs) root.hidden = true;
      updateControls();
    }
    setTimeout(poll, online ? (state.phase === 'drawing' ? 350 : 1000) : 3000);
  }

  if (!obs) {
    function lock() {
      token = undefined;
      login.hidden = false;
      controls.hidden = true;
      feedback.textContent = '';
    }

    async function control(secret, payload) {
      busy = true;
      updateControls();
      feedback.textContent = '';
      try {
        await request('control', secret, payload);
        if (payload.action === 'check') {
          token = secret;
          login.hidden = true;
          controls.hidden = false;
        }
      } catch (error) {
        if (error.status === 401) lock();
        feedback.textContent = error.status ? error.message : 'Serviciul Giveaway este indisponibil.';
      } finally {
        busy = false;
        updateControls();
      }
    }

    login.addEventListener('submit', event => {
      event.preventDefault();
      if (busy) return;
      const input = find('[data-token]');
      const secret = input.value.trim();
      input.value = '';
      if (secret) control(secret, { action: 'check' });
    });
    controls.addEventListener('submit', event => {
      event.preventDefault();
      const button = event.submitter;
      if (!token || !online || busy || !button || button.disabled) return;
      if (button.value === 'reset' && !confirm('Ștergi lista și rezultatul rundei curente?')) return;
      control(token, { action: button.value, keyword: controls.elements.keyword.value, revision: state.revision });
    });
    find('[data-logout]').addEventListener('click', lock);
    updateControls();
  }

  poll();
})();
