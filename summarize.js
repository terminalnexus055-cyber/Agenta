// api/summarize.js
// Fetches repo file tree + key files from GitHub, builds structured context

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { repo } = req.body;
  if (!repo || !repo.includes('/')) {
    return res.status(400).json({ error: 'Invalid repo format. Use owner/repo' });
  }

  const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
  const GROQ_API_KEY = process.env.GROQ_API_KEY;

  const headers = {
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'CODEX-Agent',
    ...(GITHUB_TOKEN && { 'Authorization': `token ${GITHUB_TOKEN}` })
  };

  try {
    // 1. Get full file tree (recursive)
    const treeRes = await fetch(
      `https://api.github.com/repos/${repo}/git/trees/HEAD?recursive=1`,
      { headers }
    );

    if (!treeRes.ok) {
      const err = await treeRes.json();
      throw new Error(err.message || `GitHub API error: ${treeRes.status}`);
    }

    const treeData = await treeRes.json();
    const allFiles = (treeData.tree || [])
      .filter(f => f.type === 'blob')
      .map(f => f.path);

    // 2. Filter to meaningful files only
    const ignoredExtensions = ['.png','.jpg','.jpeg','.gif','.svg','.ico','.woff','.woff2','.ttf','.eot','.lock','.min.js','.min.css'];
    const ignoredDirs = ['node_modules','dist','.next','build','.git','coverage','__pycache__','.venv'];
    
    const relevantFiles = allFiles.filter(f => {
      const lower = f.toLowerCase();
      if (ignoredDirs.some(d => lower.startsWith(d + '/') || lower.includes('/' + d + '/'))) return false;
      if (ignoredExtensions.some(ext => lower.endsWith(ext))) return false;
      return true;
    });

    // 3. Read key files for context (max 8 files, prioritize important ones)
    const priorityFiles = ['README.md', 'package.json', 'requirements.txt', 'pyproject.toml', '.env.example'];
    const codeExtensions = ['.js', '.ts', '.jsx', '.tsx', '.py', '.go', '.rs', '.java', '.cs'];
    
    const toRead = [
      ...priorityFiles.filter(f => relevantFiles.includes(f)),
      ...relevantFiles.filter(f => codeExtensions.some(ext => f.endsWith(ext))).slice(0, 6)
    ].slice(0, 8);

    const fileContents = await Promise.all(
      toRead.map(async (path) => {
        try {
          const r = await fetch(
            `https://api.github.com/repos/${repo}/contents/${path}`,
            { headers }
          );
          if (!r.ok) return null;
          const d = await r.json();
          if (!d.content) return null;
          const content = Buffer.from(d.content, 'base64').toString('utf-8');
          return { path, content: content.slice(0, 2000) }; // cap per file
        } catch { return null; }
      })
    );

    const validContents = fileContents.filter(Boolean);

    // 4. Build context string for summary
    const contextStr = validContents.map(f =>
      `=== ${f.path} ===\n${f.content}`
    ).join('\n\n');

    // 5. Generate AI summary via Groq
    let summary = 'Repo context loaded. Key files indexed above.';

    if (GROQ_API_KEY && contextStr.length > 0) {
      const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${GROQ_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          max_tokens: 400,
          messages: [
            {
              role: 'system',
              content: 'You are a senior engineer. Summarize this codebase concisely: tech stack, architecture, key files, purpose. Be precise, max 5 sentences.'
            },
            {
              role: 'user',
              content: contextStr.slice(0, 8000)
            }
          ]
        })
      });

      if (groqRes.ok) {
        const groqData = await groqRes.json();
        summary = groqData.choices?.[0]?.message?.content || summary;
      }
    }

    return res.status(200).json({
      repo,
      files: relevantFiles,
      keyFiles: toRead,
      fileContents: validContents,
      summary,
      totalFiles: allFiles.length,
      relevantCount: relevantFiles.length
    });

  } catch (error) {
    console.error('Summarize error:', error);
    return res.status(500).json({ error: error.message });
  }
}
