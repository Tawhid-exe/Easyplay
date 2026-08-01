function splitSetCookieHeader(value) {
  const parts = [];
  let buffer = "";
  for (const chunk of value.split(",")) {
    if (buffer && /^\s*[^=;,\s]+=/.test(chunk)) {
      parts.push(buffer);
      buffer = chunk;
    } else {
      buffer = buffer ? `${buffer},${chunk}` : chunk;
    }
  }
  if (buffer) parts.push(buffer);
  return parts;
}

export function collectCookies(res) {
  const raw = [];
  if (typeof res.headers.getSetCookie === "function") {
    raw.push(...res.headers.getSetCookie());
  } else {
    const single = res.headers.get("set-cookie");
    if (single) raw.push(...splitSetCookieHeader(single));
  }

  const jar = {};
  for (const entry of raw) {
    const pair = entry.split(";")[0];
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    const expires = entry.match(/expires=([^;]+)/i);
    if (expires && new Date(expires[1]).getTime() < Date.now()) {
      delete jar[name];
      continue;
    }
    jar[name] = value;
  }
  return jar;
}

export function mergeCookies(jar, next) {
  const merged = { ...(jar || {}) };
  for (const [name, value] of Object.entries(next || {})) {
    merged[name] = value;
  }
  return merged;
}

export function cookieString(jar) {
  return Object.entries(jar || {})
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
}
