// api/apply-patch.js
// Writes a file back to GitHub repo using the GitHub Contents API
// Requires GITHUB_TOKEN with repo write access

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
  if (!GITHUB_TOKEN) return res.status(500).json({ error: 'GITHUB_TOKEN not configured' });

  const { repo, filename, content, commitMessage, branch = 'main' } = req.body;

  if (!repo || !filename || !content) {
    return res.status(400).json({ error: 'repo, filename, and content are required' });
  }

  if (!repo.includes('/')) {
    return res.status(400).json({ error: 'repo must be in owner/repo format' });
  }

  // Sanitize filename — prevent path traversal
  const safePath = filename.replace(/\.\./g, '').replace(/^\//, '');
  if (!safePath) return res.status(400).json({ error: 'Invalid filename' });

  const headers = {
    Accept: 'application/vnd.github.v3+json',
    Authorization: `token ${GITHUB_TOKEN}`,
    'User-Agent': 'CODEX-Agent',
    'Content-Type': 'application/json'
  };

  const apiBase = `https://api.github.com/repos/${repo}/contents/${safePath}`;

  try {
    // 1. Check if file already exists (need its SHA to update it)
    let existingSha = null;
    const checkRes = await fetch(apiBase, { headers });

    if (checkRes.ok) {
      const existing = await checkRes.json();
      existingSha = existing.sha;
    } else if (checkRes.status !== 404) {
      const err = await checkRes.json();
      throw new Error(`GitHub check failed: ${err.message || checkRes.status}`);
    }

    // 2. Encode content to base64
    const encodedContent = Buffer.from(content, 'utf-8').toString('base64');

    // 3. Build commit payload
    const payload = {
      message: commitMessage || `[CODEX] Update ${safePath}`,
      content: encodedContent,
      branch
    };

    // If file exists, include SHA to trigger update instead of create
    if (existingSha) payload.sha = existingSha;

    // 4. Write to GitHub
    const writeRes = await fetch(apiBase, {
      method: 'PUT',
      headers,
      body: JSON.stringify(payload)
    });

    if (!writeRes.ok) {
      const err = await writeRes.json();
      throw new Error(`GitHub write failed: ${err.message || writeRes.status}`);
    }

    const writeData = await writeRes.json();

    return res.status(200).json({
      success: true,
      file: safePath,
      action: existingSha ? 'updated' : 'created',
      commit: writeData.commit?.sha,
      commitUrl: writeData.commit?.html_url,
      repo,
      branch
    });

  } catch (error) {
    console.error('Apply patch error:', error);
    return res.status(500).json({ error: error.message });
  }
}
