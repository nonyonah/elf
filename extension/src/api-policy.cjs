const routes = {
  GET: /^\/api\/(runtime|report|config|onboarding|figma\/account)$/,
  PATCH: /^\/api\/config$/,
  POST: /^\/api\/(onboarding(?:\/(validate|pairing|start))?|figma\/(connect|disconnect)|slack\/(connect|disconnect|test)|project\/[a-z-]+)$/,
};
function allowedRequest(path, method, body) {
  if (typeof path === 'string' && /^\/api\/project\/(prepare|validate)-design-system$/.test(path)) return false;
  return typeof path === 'string' && Boolean(routes[method]?.test(path)) &&
    (body === undefined || body === null || (typeof body === 'string' && Buffer.byteLength(body) <= 256 * 1024));
}
function publicLink(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password &&
      (url.hostname === 'www.figma.com' || url.hostname === 'figma.com');
  } catch { return false; }
}
module.exports = { allowedRequest, publicLink };
