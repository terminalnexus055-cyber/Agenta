// api/apply-patch.js
// Push code to GitHub with explicit user confirmation and permission checks

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { repo, filename, content, commitMessage, userConfirmed } = req.body;

  // Require explicit user confirmation (frontend checkbox)
  if (userConfirmed !== true) {
    return res.status(403).json({ error: 'Push requires explicit user confirmation (userConfirmed: true)' });
  }

  if (!repo || !filename || !content) {
    return res.status(400).json({ error: 'Missing repo, filename, or content' });
  }

  if (!GITHUB_TOKEN) {
    return res.status(500).json({ error: 'GITHUB_TOKEN not configured. Please add it to your environment variables.' });
  }

  const [owner, repoName] = repo.split('/');
  if (!owner || !repoName) {
    return res.status(400).json({ error: 'Invalid repo format. Use owner/repo' });
  }

  try {
    const getUrl = `https://api.github.com/repos/${owner}/${repoName}/contents/${encodeURIComponent(filename)}`;
    let sha = null;

    // Check repo access and permissions
    const repoCheck = await fetch(`https://api.github.com/repos/${owner}/${repoName}`, {
      headers: {
        Authorization: `token ${GITHUB_TOKEN}`,
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'CODEX-Agent'
      }
    });
    if (!repoCheck.ok) {
      if (repoCheck.status === 401) throw new Error('Invalid GitHub token. Please check your GITHUB_TOKEN.');
      if (repoCheck.status === 403) throw new Error('Token lacks permission to write to this repo. Ensure scope includes "repo" or "public_repo".');
      if (repoCheck.status === 404) throw new Error(`Repository ${repo} not found. Check owner/repo name.`);
      throw new Error(`GitHub API error: ${repoCheck.status}`);
    }

    // Get existing file SHA if it exists
    let getRes = await fetch(getUrl, {
      headers: {
        Authorization: `token ${GITHUB_TOKEN}`,
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'CODEX-Agent'
      }
    });

    if (getRes.status === 200) {
      const fileData = await getRes.json();
      sha = fileData.sha;
    } else if (getRes.status !== 404) {
      const errData = await getRes.json();
      throw new Error(`Failed to fetch file: ${errData.message || getRes.status}`);
    }

    // Prepare commit payload
    const payload = {
      message: commitMessage || '[CODEX] Update from agent',
      content: Buffer.from(content, 'utf-8').toString('base64'),
      branch: 'main'  // change to 'master' if needed
    };
    if (sha) payload.sha = sha;

    // Push the file
    const putRes = await fetch(getUrl, {
      method: 'PUT',
      headers: {
        Authorization: `token ${GITHUB_TOKEN}`,
        Accept: 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
        'User-Agent': 'CODEX-Agent'
      },
      body: JSON.stringify(payload)
    });

    if (!putRes.ok) {
      const errData = await putRes.json();
      if (putRes.status === 403) {
        throw new Error('Permission denied. Your token does not have write access to this repository.');
      }
      throw new Error(errData.message || `GitHub API error: ${putRes.status}`);
    }

    const data = await putRes.json();
    return res.status(200).json({
      success: true,
      action: sha ? 'updated' : 'created',
      commitUrl: data.commit.html_url,
      sha: data.commit.sha
    });
  } catch (error) {
    console.error('Apply patch error:', error);
    return res.status(500).json({ error: error.message });
  }
}