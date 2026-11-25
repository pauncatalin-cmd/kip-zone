async function postEntry(options) {
  const doFetch = options.fetchImpl || globalThis.fetch;
  const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  let wait = 500;
  let lastError = null;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const response = await doFetch(options.url, {
        method: "POST",
        headers: {
          Authorization: "Bearer " + options.secret,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(options.payload),
      });
      const text = await response.text();
      let body = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch (error) {
        body = null;
      }
      if (response.ok) return { ok: true, retry: false, status: response.status, body };
      if (response.status === 429 || response.status >= 500) {
        lastError = new Error("status " + response.status);
      } else {
        return { ok: false, retry: false, status: response.status, body };
      }
    } catch (error) {
      lastError = error;
    }
    if (attempt === 5) break;
    await sleep(wait);
    wait *= 2;
  }
  return { ok: false, retry: true, status: 0, error: lastError };
}

module.exports = { postEntry };
