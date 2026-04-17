// api/summarize.js
// Deep repo summarizer — reads more files, understands architecture, not just file list
// Dual Groq key load balancing to avoid TPM limits

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_API_KEY_2 = process.env.GROQ_API_KEY_2;

// ─── DUAL GROQ LOAD BALANCER ───
let groqKeyIndex = 0;
function getGroqKey() {
  const keys = [GROQ_API_KEY, GROQ_API_KEY_2].filter(Boolean);
  if (!keys.length) throw new Error('No GROQ_API_KEY configured');
  const key = keys[groqKeyIndex % keys.length];
  groqKeyIndex++;
  return key;
}

async function callGroq(systemPrompt, userPrompt, maxTokens = 800) {
  const apiKey = getGroqKey();

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      max_tokens: maxTokens,
      temperature: 0.1,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ]
    })
  });

  if (!res.ok) {
    const err = await res.json();
    throw new Error(`Groq error: ${err.error?.message || res.status}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

// ─── FILE PRIORITY SCORING ───
function scoreFile(path) {
  const p = path.toLowerCase();
  let score = 0;

  // Entry points and config — highest priority
  if (p === 'package.json') score += 100;
  if (p === 'readme.md') score += 90;
  if (p.includes('index.') && !p.includes('/')) score += 85;
  if (p === 'vercel.json') score += 70;
  if (p.includes('.env.example')) score += 60;

  // Core logic files
  if (p.includes('index') || p.includes('main') || p.includes('app')) score += 50;
  if (p.includes('api/') && !p.includes('test') && !p.includes('debug')) score += 40;
  if (p.includes('lib/') || p.includes('utils/') || p.includes('helpers/')) score += 35;
  if (p.includes('config') || p.includes('constants')) score += 30;

  // Deprioritize
  if (p.includes('test') || p.includes('debug') || p.includes('spec')) score -= 20;
  if (p.includes('.min.') || p.includes('dist/') || p.includes('build/')) score -= 50;

  // Boost by extension
  const codeExts = ['.js', '.ts', '.jsx', '.tsx', '.py', '.go'];
  if (codeExts.some(ext => p.endsWith(ext))) score += 10;

  return score;
}

// ─── GITHUB HELPERS ───
const ghHeaders = () => ({
  'Accept': 'application/vnd.github.v3+json',
  'User-Agent': 'CODEX-Agent',
  ...(GITHUB_TOKEN && { 'Authorization': `token ${GITHUB_TOKEN}` })
});

async function fetchFileContent(repo, path, maxChars = 3000) {
  try {
    const res = await fetch(
      `https://api.github.com/repos/${repo}/contents/${encodeURIComponent(path)}`,
      { headers: ghHeaders() }
    );
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.content) return null;
    const content = Buffer.from(data.content, 'base64').toString('utf-8');
    return content.slice(0, maxChars);
  } catch { return null; }
}

// ─── EXTRACT KEY INFO FROM FILE ───
function extractFileSignature(path, content) {
  if (!content) return null;
  const lines = content.split('\n');
  const sig = { path, lines: lines.length, exports: [], imports: [], functions: [], patterns: [] };

  lines.forEach(line => {
    const l = line.trim();
    // Imports
    if (l.startsWith('import ') || l.startsWith('const ') && l.includes('require(')) {
      if (sig.imports.length < 6) sig.imports.push(l.slice(0, 80));
    }
    // Exports / route handlers
    if (l.includes('export default') || l.includes('module.exports')) {
      sig.exports.push(l.slice(0, 60));
    }
    // Function definitions
    if ((l.startsWith('async function') || l.startsWith('function') || l.includes('= async (') || l.includes('= function')) && sig.functions.length < 8) {
      sig.functions.push(l.slice(0, 80));
    }
    // API routes / endpoints
    if (l.includes("app.get(") || l.includes("app.post(") || l.includes("router.") || l.includes('/api/')) {
      if (sig.patterns.length < 5) sig.patterns.push(l.slice(0, 80));
    }
  });

  return sig;
}

// ─── BUILD DEEP CONTEXT FOR AI ───
function buildDeepContext(fileContents, signatures) {
  const parts = [];

  // Package.json — critical for understanding dependencies
  const pkg = fileContents.find(f => f.path === 'package.json');
  if (pkg) {
    try {
      const parsed = JSON.parse(pkg.content);
      parts.push(`PACKAGE.JSON:
Name: ${parsed.name || 'unknown'}
Version: ${parsed.version || 'unknown'}
Scripts: ${JSON.stringify(parsed.scripts || {})}
Dependencies: ${Object.keys(parsed.dependencies || {}).join(', ')}
Dev Dependencies: ${Object.keys(parsed.devDependencies || {}).join(', ')}`);
    } catch {
      parts.push(`PACKAGE.JSON:\n${pkg.content.slice(0, 500)}`);
    }
  }

  // README
  const readme = fileContents.find(f => f.path.toLowerCase() === 'readme.md');
  if (readme) {
    parts.push(`README:\n${readme.content.slice(0, 1500)}`);
  }

  // File signatures — functions, imports, exports
  const sigStr = signatures.map(sig => {
    const lines = [`FILE: ${sig.path} (${sig.lines} lines)`];
    if (sig.imports.length) lines.push(`  Imports: ${sig.imports.slice(0,3).join(' | ')}`);
    if (sig.functions.length) lines.push(`  Functions: ${sig.functions.slice(0,5).join(' | ')}`);
    if (sig.exports.length) lines.push(`  Exports: ${sig.exports[0]}`);
    if (sig.patterns.length) lines.push(`  Routes/Patterns: ${sig.patterns.join(' | ')}`);
    return lines.join('\n');
  }).join('\n\n');

  if (sigStr) parts.push(`FILE SIGNATURES:\n${sigStr}`);

  // Key file full contents (non-package, non-readme)
  const keyFiles = fileContents.filter(f =>
    f.path.toLowerCase() !== 'readme.md' && f.path !== 'package.json'
  ).slice(0, 5);

  if (keyFiles.length) {
    const contentStr = keyFiles.map(f =>
      `=== ${f.path} ===\n${f.content.slice(0, 1200)}`
    ).join('\n\n');
    parts.push(`KEY FILE CONTENTS:\n${contentStr}`);
  }

  return parts.join('\n\n').slice(0, 14000);
}

// ─── MAIN HANDLER ───
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { repo } = req.body;
  if (!repo || !repo.includes('/')) {
    return res.status(400).json({ error: 'Invalid repo. Use owner/repo format' });
  }

  try {
    // 1. Fetch full file tree
    const treeRes = await fetch(
      `https://api.github.com/repos/${repo}/git/trees/HEAD?recursive=1`,
      { headers: ghHeaders() }
    );

    if (!treeRes.ok) {
      const err = await treeRes.json();
      throw new Error(err.message || `GitHub API error: ${treeRes.status}`);
    }

    const treeData = await treeRes.json();
    const allFiles = (treeData.tree || [])
      .filter(f => f.type === 'blob')
      .map(f => f.path);

    // 2. Filter noise
    const ignoredDirs = ['node_modules', 'dist', '.next', 'build', '.git', 'coverage', '__pycache__', '.venv'];
    const ignoredExts = ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.woff', '.woff2', '.ttf', '.eot', '.lock', '.min.js', '.min.css', '.map'];

    const relevantFiles = allFiles.filter(f => {
      const lower = f.toLowerCase();
      if (ignoredDirs.some(d => lower.startsWith(d + '/') || lower.includes('/' + d + '/'))) return false;
      if (ignoredExts.some(ext => lower.endsWith(ext))) return false;
      return true;
    });

    // 3. Score and rank files — read top 16
    const rankedFiles = relevantFiles
      .map(f => ({ path: f, score: scoreFile(f) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 16)
      .map(f => f.path);

    // 4. Fetch file contents in parallel
    // High priority files get more characters
    const fileContents = (await Promise.all(
      rankedFiles.map(async (path) => {
        const score = scoreFile(path);
        const maxChars = score >= 80 ? 4000 : score >= 40 ? 2000 : 1000;
        const content = await fetchFileContent(repo, path, maxChars);
        return content ? { path, content } : null;
      })
    )).filter(Boolean);

    // 5. Extract signatures from each file
    const signatures = fileContents
      .filter(f => f.path !== 'package.json' && !f.path.toLowerCase().endsWith('.md'))
      .map(f => extractFileSignature(f.path, f.content))
      .filter(Boolean);

    // 6. Build deep context for AI
    const deepContext = buildDeepContext(fileContents, signatures);

    // 7. Generate structured deep summary via Groq
    let summary = 'Repo indexed. AI summary unavailable — check GROQ_API_KEY.';

    if (GROQ_API_KEY || GROQ_API_KEY_2) {
      summary = await callGroq(
        `You are a senior software architect analyzing a codebase for an AI coding agent.
Your summary will be used as the primary context for code generation — it must be precise and actionable.

Output this exact structure:

PROJECT NAME & PURPOSE:
[one sentence]

TECH STACK:
[runtime, frameworks, key libraries, deployment]

ARCHITECTURE:
[how the system is structured — what talks to what]

KEY FILES & THEIR ROLES:
[for each important file: filename — what it does, key functions]

ENTRY POINTS:
[how the system starts / is triggered]

SHARED PATTERNS:
[naming conventions, export style, error handling patterns, env vars used]

DEPENDENCIES TO KNOW:
[critical npm/pip packages and what they're used for]

Do not pad. Be specific. A coding agent will use this to write accurate code.`,
        deepContext,
        1200
      );
    }

    // 8. Per-file mini summaries for the file tree display
    const fileSummaries = {};
    const apiFiles = relevantFiles.filter(f => f.startsWith('api/') && !f.includes('test') && !f.includes('debug')).slice(0, 8);

    if (apiFiles.length && (GROQ_API_KEY || GROQ_API_KEY_2)) {
      const batchContent = (await Promise.all(
        apiFiles.map(async f => {
          const content = await fetchFileContent(repo, f, 600);
          return content ? `${f}:\n${content}` : null;
        })
      )).filter(Boolean).join('\n\n---\n\n');

      if (batchContent) {
        const miniSummary = await callGroq(
          'For each file listed, write ONE line: "filename — what it does". Be specific, not generic.',
          batchContent,
          500
        );
        miniSummary.split('\n').forEach(line => {
          const match = line.match(/^[`]?(api\/[\w.]+)[`]?\s*[—\-:]\s*(.+)/);
          if (match) fileSummaries[match[1]] = match[2].trim();
        });
      }
    }

    return res.status(200).json({
      repo,
      files: relevantFiles,
      keyFiles: rankedFiles,
      fileSummaries,
      summary,
      totalFiles: allFiles.length,
      relevantCount: relevantFiles.length,
      fileContents: fileContents.map(f => ({
        path: f.path,
        content: f.content.slice(0, 1500)
      }))
    });

  } catch (error) {
    console.error('Summarize error:', error);
    return res.status(500).json({ error: error.message });
  }
}
