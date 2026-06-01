
// SECURITY NOTE: Never commit a real GitHub token here.
// Set writeEnabled = true and replace the token value only in a local,
// gitignored copy of this file, or pass it via the settings dialog at runtime.
const CONFIG = {
  owner:        'boilerbill83',
  repo:         'my-books',
  branch:       'main',
  token:        '__REPLACE_WITH_GITHUB_TOKEN__',
  writeEnabled: false
};

export function isWriteConfigured() {
  return Boolean(CONFIG.writeEnabled && CONFIG.token && !CONFIG.token.includes('__REPLACE'));
}

function contentsUrl(path) {
  return `https://api.github.com/repos/${CONFIG.owner}/${CONFIG.repo}/contents/${path}`;
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${response.status} ${response.statusText}: ${text}`);
  }
  return response.json();
}

export async function fetchLocalJson(path) {
  const response = await fetch(path, { cache: 'no-store' });
  if (!response.ok) throw new Error(`Failed to load ${path}`);
  return response.json();
}

export async function fetchRepoJson(path) {
  const response = await requestJson(contentsUrl(path), {
    headers: {
      Authorization: `Bearer ${CONFIG.token}`,
      Accept: 'application/vnd.github+json'
    }
  });
  const decoded = atob((response.content || '').replace(/\n/g, ''));
  return { content: JSON.parse(decoded), sha: response.sha };
}

async function putRepoJson(path, content, sha, message) {
  return requestJson(contentsUrl(path), {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${CONFIG.token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      message,
      content: btoa(unescape(encodeURIComponent(JSON.stringify(content, null, 2)))),
      sha,
      branch: CONFIG.branch
    })
  });
}

export async function safeUpdateRepoJson(path, updateFn, message = 'Update app data') {
  if (!isWriteConfigured()) throw new Error('GitHub write mode is not enabled in storage.js');
  const firstRead = await fetchRepoJson(path);
  const updated   = updateFn(structuredClone(firstRead.content));
  try {
    return await putRepoJson(path, updated, firstRead.sha, message);
  } catch {
    const latest  = await fetchRepoJson(path);
    const retried = updateFn(structuredClone(latest.content));
    return putRepoJson(path, retried, latest.sha, message + ' (retry)');
  }
}
