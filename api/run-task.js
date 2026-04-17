// api/run-task.js
// Role-based swarm: Architect (Gemini) → Coder (Groq) → Reviewer (Groq) → Judge
// Upgrades v2: surgical context extraction + Redis memory + fixed Judge loop

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_API_KEY_2 = process.env.GROQ_API_KEY_2;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// ─── DUAL GROQ LOAD BALANCER ───
let _groqIdx = 0;
function getGroqKey() {
  const keys = [GROQ_API_KEY, GROQ_API_KEY_2].filter(Boolean);
  if (!keys.length) throw new Error('No GROQ_API_KEY configured');
  const key = keys[_groqIdx % keys.length];
  _groqIdx++;
  return key;
}
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const UPSTASH_REDIS_REST_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_REDIS_REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

// ─── REDIS MEMORY ───
async function redisSet(key, value) {
  if (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) return;
  try {
    await fetch(`${UPSTASH_REDIS_REST_URL}/set/${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${UPSTASH_REDIS_REST_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(JSON.stringify(value))
    });
  } catch (e) { console.warn('Redis set failed:', e.message); }
}

async function redisGet(key) {
  if (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) return null;
  try {
    const res = await fetch(`${UPSTASH_REDIS_REST_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${UPSTASH_REDIS_REST_TOKEN}` }
    });
    const data = await res.json();
    return data.result ? JSON.parse(data.result) : null;
  } catch (e) { return null; }
}

async function redisList(prefix) {
  if (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) return [];
  try {
    const res = await fetch(`${UPSTASH_REDIS_REST_URL}/keys/${encodeURIComponent(prefix + '*')}`, {
      headers: { Authorization: `Bearer ${UPSTASH_REDIS_REST_TOKEN}` }
    });
    const data = await res.json();
    return data.result || [];
  } catch (e) { return []; }
}

// ─── GROQ CALL ───
async function callGroq(systemPrompt, userPrompt, maxTokens = 2000, model = 'llama-3.3-70b-versatile') {
  const apiKey = getGroqKey();

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: model,
      max_tokens: maxTokens,
      temperature: 0.2,
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

// ─── GEMINI CALL ───
async function callGemini(systemPrompt, userPrompt, maxTokens = 2000) {
  if (!GEMINI_API_KEY) {
    console.warn('No GEMINI_API_KEY — falling back to Groq for Architect');
    return callGroq(systemPrompt, userPrompt, maxTokens);
  }

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents: [{ parts: [{ text: userPrompt }] }],
        generationConfig: { maxOutputTokens: maxTokens, temperature: 0.2 }
      })
    }
  );

  if (!res.ok) {
    console.warn('Gemini error, falling back to Groq');
    return callGroq(systemPrompt, userPrompt, maxTokens);
  }

  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

// ─── SURGICAL CONTEXT: fetch only the relevant section of a file ───
async function fetchTargetFileSlice(repo, filePath, keyword) {
  if (!GITHUB_TOKEN || !filePath) return null;

  try {
    const res = await fetch(
      `https://api.github.com/repos/${repo}/contents/${filePath}`,
      {
        headers: {
          Accept: 'application/vnd.github.v3+json',
          Authorization: `token ${GITHUB_TOKEN}`,
          'User-Agent': 'CODEX-Agent'
        }
      }
    );
    if (!res.ok) return null;

    const data = await res.json();
    if (!data.content) return null;

    const fullContent = Buffer.from(data.content, 'base64').toString('utf-8');
    const lines = fullContent.split('\n');

    // Small file — return all of it
    if (lines.length <= 150) {
      return { path: filePath, content: fullContent, lines: lines.length, sliced: false };
    }

    // Large file — find most relevant section via keyword scoring
    if (keyword) {
      const kwWords = keyword.toLowerCase().split(/\s+/).filter(w => w.length > 3);
      let bestLine = 0;
      let bestScore = 0;

      lines.forEach((line, i) => {
        const score = kwWords.reduce((s, w) => s + (line.toLowerCase().includes(w) ? 1 : 0), 0);
        if (score > bestScore) { bestScore = score; bestLine = i; }
      });

      const start = Math.max(0, bestLine - 20);
      const end = Math.min(lines.length, bestLine + 60);
      const slice = lines.slice(start, end).join('\n');

      return {
        path: filePath,
        content: `[Lines ${start + 1}–${end} of ${lines.length} total]\n\n${slice}`,
        lines: lines.length,
        sliced: true
      };
    }

    // No keyword — return first 150 lines
    return {
      path: filePath,
      content: lines.slice(0, 150).join('\n') + `\n\n[... ${lines.length - 150} more lines not shown]`,
      lines: lines.length,
      sliced: true
    };

  } catch (e) {
    console.warn('File slice fetch failed:', e.message);
    return null;
  }
}

// ─── IDENTIFY TARGET FILES FROM PROMPT ───
function identifyTargetFiles(prompt, fileList) {
  if (!fileList?.length) return [];

  const promptLower = prompt.toLowerCase();

  // Direct filename mentions in prompt
  const directMatches = fileList.filter(f => {
    const name = f.split('/').pop().toLowerCase();
    return promptLower.includes(name) || promptLower.includes(f.toLowerCase());
  });
  if (directMatches.length > 0) return directMatches.slice(0, 3);

  // Keyword scoring
  const keywords = promptLower.split(/\s+/).filter(w => w.length > 4);
  const scored = fileList
    .map(f => ({
      file: f,
      score: keywords.reduce((s, w) => s + (f.toLowerCase().includes(w) ? 2 : 0), 0)
    }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score);

  return scored.slice(0, 3).map(x => x.file);
}

// ─── LOAD REPO MEMORY ───
async function loadRepoMemory(repo) {
  const repoKey = repo.replace('/', '_');
  const keys = await redisList(`codex:${repoKey}:`);
  if (!keys.length) return null;

  const recentKeys = keys.slice(-5);
  const runs = await Promise.all(recentKeys.map(k => redisGet(k)));
  const validRuns = runs.filter(Boolean);
  if (!validRuns.length) return null;

  return {
    runCount: keys.length,
    recentPatterns: validRuns.map(r => ({
      task: r.prompt?.slice(0, 100),
      taskType: r.taskType,
      filesChanged: r.targetFiles,
      hadIssues: r.hadIssues
    }))
  };
}

// ─── BUILD CONTEXT STRING ───
function buildContextString(context, targetFileSlices, repoMemory) {
  if (!context) return 'No repo context available.';

  const parts = [];

  if (repoMemory) {
    parts.push(`CODEBASE HISTORY (${repoMemory.runCount} past agent runs):
${repoMemory.recentPatterns.map(r =>
  `- [${r.taskType}] ${r.task} → files: ${r.filesChanged?.join(', ') || 'unknown'}`
).join('\n')}`);
  }

  if (context.summary) {
    parts.push(`PROJECT SUMMARY:\n${context.summary}`);
  }

  if (context.files?.length) {
    parts.push(`FILE STRUCTURE (${context.files.length} files):\n${context.files.slice(0, 60).join('\n')}`);
  }

  // Surgical slices take priority
  if (targetFileSlices?.length) {
    const sliceStr = targetFileSlices.map(f =>
      `=== TARGET FILE: ${f.path} (${f.lines} lines${f.sliced ? ', relevant section shown' : ', complete'}) ===\n${f.content}`
    ).join('\n\n');
    parts.push(`TARGET FILE CONTENTS:\n${sliceStr}`);
  } else if (context.fileContents?.length) {
    const snippets = context.fileContents.map(f =>
      `--- ${f.path} ---\n${f.content.slice(0, 1500)}`
    ).join('\n\n');
    parts.push(`KEY FILE CONTENTS:\n${snippets}`);
  }

  return parts.join('\n\n').slice(0, 12000);
}

// ─── SYSTEM PROMPTS ───
function getSystemPrompts(taskType) {
  return {
    architect: {
      feature: `You are a senior software architect. Given a codebase context and feature request:
1. Analyze what already exists
2. Identify exactly which files need to change
3. Write a clear implementation plan with steps
4. Flag any risks or dependencies
Be concise and precise. No fluff.`,
      bugfix: `You are a senior software architect debugging a codebase.
1. Analyze the bug description against the existing code
2. Identify the root cause
3. List the exact files and lines that need changing
4. Propose the fix approach
Be direct. No speculation.`,
      refactor: `You are a senior software architect planning a refactor.
1. Analyze the current code structure
2. Identify what needs to change and why
3. Define the refactor scope — which files, which patterns
4. List the steps in safe order (avoid breaking changes)`,
      review: `You are a senior code reviewer.
1. Analyze the codebase for quality issues
2. Flag bugs, security issues, performance problems
3. Note good patterns worth keeping
4. Prioritize issues by severity`,
      explain: `You are a senior engineer explaining a codebase.
1. Explain what this project does
2. Walk through the architecture
3. Explain key files and their roles
4. Note any unusual patterns or decisions`
    },

    coder: `You are an expert software engineer implementing code changes.
You receive the actual target file contents, an architect's plan, and the task.

Rules:
- Write complete, working code
- Match the EXACT style, patterns, and imports of the existing codebase
- Only modify what is necessary — surgical edits
- Wrap each file in a code block with the filename: \`\`\`js // api/filename.js
- Show the complete updated file, not just the changed section
- Never invent imports, functions, or variables that don't exist in the codebase
- Never break existing functionality`,

    reviewer: `You are a senior code reviewer doing a final check.
You receive: existing codebase context + new implementation.

Your job:
1. Check for conflicts with existing code
2. Check for bugs, edge cases, missing error handling
3. Check style consistency with the existing codebase
4. Rate confidence: LOW / MEDIUM / HIGH
5. List specific issues found, or confirm the code is clean
Be specific and direct.`
  };
}

// ─── MAIN HANDLER ───
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { repo, prompt, taskType = 'feature', context } = req.body;

  if (!repo) return res.status(400).json({ error: 'repo is required' });
  if (!prompt) return res.status(400).json({ error: 'prompt is required' });

  const prompts = getSystemPrompts(taskType);
  const repoKey = repo.replace('/', '_');
  const runId = `codex:${repoKey}:${Date.now()}`;

  try {
    // ── LOAD MEMORY ──
    const repoMemory = await loadRepoMemory(repo);

    // ── IDENTIFY + FETCH TARGET FILES (surgical context) ──
    const targetFiles = identifyTargetFiles(prompt, context?.files);
    const targetFileSlices = targetFiles.length
      ? (await Promise.all(targetFiles.map(f => fetchTargetFileSlice(repo, f, prompt)))).filter(Boolean)
      : [];

    // ── BUILD CONTEXT ──
    const contextStr = buildContextString(context, targetFileSlices, repoMemory);

    // ── STEP 1: ARCHITECT (Gemini) — plans the approach ──
    const architectPlan = await callGemini(
      prompts.architect[taskType] || prompts.architect.feature,
      `CODEBASE CONTEXT:\n${contextStr}\n\nTASK:\n${prompt}`,
      1000
    );

    // ── STEP 2: CODER (Groq) — implements the plan ──
    const coderOutput = await callGroq(
      prompts.coder,
      `CODEBASE CONTEXT:\n${contextStr}\n\nARCHITECT'S PLAN:\n${architectPlan}\n\nORIGINAL TASK:\n${prompt}\n\nWrite the complete implementation now.`,
      2500
    );

    // ── STEP 3: REVIEWER (Groq — fresh call) — catches bugs ──
    const reviewerOutput = await callGroq(
      prompts.reviewer,
      `EXISTING CODEBASE CONTEXT:\n${contextStr}\n\nNEW IMPLEMENTATION TO REVIEW:\n${coderOutput}\n\nOriginal task: ${prompt}`,
      1000,
      'llama-3.1-8b-instant'
    );

    // ── STEP 4: JUDGE — force corrected rewrite if issues found ──
    let finalOutput = coderOutput;
    let hadIssues = false;

    const issueSignals = [
      'confidence: low', 'potential issue', 'bug', 'not validated',
      'vulnerability', 'error handling', 'hardcoded', 'missing',
      'may cause', 'may lead', 'incorrect', 'will fail', 'undefined'
    ];

    hadIssues = issueSignals.some(s => reviewerOutput.toLowerCase().includes(s));

    if (hadIssues) {
      finalOutput = await callGroq(
        prompts.coder,
        `You are fixing code based on a reviewer's feedback.

ORIGINAL IMPLEMENTATION:
${coderOutput}

REVIEWER FEEDBACK (all issues must be fixed):
${reviewerOutput}

CODEBASE CONTEXT:
${contextStr.slice(0, 3000)}

Output ONLY the complete corrected code. No explanation. No preamble.
Use the exact same style as the original codebase.`,
        2500
      );
    }

    // ── SAVE RUN TO REDIS MEMORY ──
    await redisSet(runId, {
      repo,
      prompt: prompt.slice(0, 200),
      taskType,
      targetFiles,
      hadIssues,
      timestamp: Date.now()
    });

    return res.status(200).json({
      architectPlan,
      coderOutput,
      reviewerOutput,
      finalOutput,
      hadIssues,
      targetFiles,
      taskType,
      repo,
      memoryLoaded: !!repoMemory,
      runId
    });

  } catch (error) {
    console.error('Agent run error:', error);
    return res.status(500).json({ error: error.message });
  }
}
