'use strict';
// Website navigation uses the person's default browser. GitHub API/file requests stay in main.
function isGithubPage(value) {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && ['github.com', 'www.github.com', 'gist.github.com'].includes(url.hostname) && !url.username && !url.password;
  } catch { return false; }
}
module.exports = { isGithubPage };
