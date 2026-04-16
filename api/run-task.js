// api/run-task.js
// Role-based swarm: Architect (Gemini) → Coder (Groq) → Reviewer (Groq)
// Each model has a distinct job. Not random parallel — sequential intelligence.

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// ─── GROQ CALL ───
async function callGroq(systemPrompt, userPrompt, maxTokens = 2000) {
  if (!GROQ_API_KEY) throw new Error('GROQ_API_KEY not set');

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${GROQ_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
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
    // Fallback to Groq if no Gemini key
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
        generationConfig: {
          maxOutputTokens: maxTokens,
          temperature: 0.2
        }
      })
    }
  );

  if (!res.ok) {
    const err = await res.json();
    console.warn('Gemini error, falling back to Groq:', err);
    return callGroq(systemPrompt, userPrompt, maxTokens);
  }

  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

// ─── BUILD CONTEXT STRING ───
function buildContextString(context) {
  if (!context) return 'No repo context available.';

  const parts = [];

  if (context.summary) {
    parts.push(`PROJECT SUMMARY:\n${context.summary}`);
  }

  if (context.files?.length) {
    const fileList = context.files.slice(0, 60).join('\n');
    parts.push(`FILE STRUCTURE (${context.files.length} files):\n${fileList}`);
  }

  if (context.fileContents?.length) {
    const snippets = context.fileContents.map(f =>
      `--- ${f.path} ---\n${f.content.slice(0, 1500)}`
    ).join('\n\n');
    parts.push(`KEY FILE CONTENTS:\n${snippets}`);
  }

  return parts.join('\n\n').slice(0, 10000); // hard cap for token safety
}

// ─── TASK-SPECIFIC PROMPTS ───
function getSystemPrompts(taskType) {
  const prompts = {
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

    coder: `You are an expert software engineer. You receive:
- A codebase context
- An architect's plan
- The user's task

Your job: Write the actual implementation code.
Rules:
- Write complete, working code
- Use the same patterns/style as the existing codebase
- Only modify what's necessary — surgical edits
- Wrap each file in a code block labeled with the filename
- If modifying an existing file, show only the changed sections with clear markers
- Never break existing functionality`,

    reviewer: `You are a senior code reviewer doing a final check.
You receive: existing codebase context + new implementation code.
Your job:
1. Check for conflicts with existing code
2. Check for bugs, edge cases, errors
3. Check style consistency with existing codebase
4. Rate confidence: LOW / MEDIUM / HIGH
5. List specific issues found (or confirm code is clean)
6. If issues found: provide the corrected version
Be specific. No vague feedback.`
  };

  return prompts;
}

// ─── MAIN HANDLER ───
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { repo, prompt, taskType = 'feature', context } = req.body;

  if (!repo) return res.status(400).json({ error: 'repo is required' });
  if (!prompt) return res.status(400).json({ error: 'prompt is required' });

  const prompts = getSystemPrompts(taskType);
  const contextStr = buildContextString(context);

  try {
    // ── STEP 1: ARCHITECT (Gemini) ──
    // Plans the approach before a single line is written
    const architectPrompt = `CODEBASE CONTEXT:\n${contextStr}\n\nTASK:\n${prompt}`;
    
    const [architectPlan, coderStartSignal] = await Promise.all([
      callGemini(
        prompts.architect[taskType] || prompts.architect.feature,
        architectPrompt,
        1000
      ),
      Promise.resolve('ready') // placeholder for future parallel work
    ]);

    // ── STEP 2: CODER (Groq) ──
    // Implements based on the architect's plan
    const coderPrompt = `CODEBASE CONTEXT:\n${contextStr}\n\nARCHITECT'S PLAN:\n${architectPlan}\n\nORIGINAL TASK:\n${prompt}\n\nNow write the implementation.`;
    
    const coderOutput = await callGroq(
      prompts.coder,
      coderPrompt,
      2000
    );

    // ── STEP 3: REVIEWER (Groq — second call, fresh context) ──
    // Reviews for conflicts, bugs, style issues
    const reviewerPrompt = `EXISTING CODEBASE CONTEXT:\n${contextStr}\n\nNEW IMPLEMENTATION TO REVIEW:\n${coderOutput}\n\nOriginal task: ${prompt}`;
    
    const reviewerOutput = await callGroq(
      prompts.reviewer,
      reviewerPrompt,
      1000
    );

    // ── STEP 4: JUDGE — determine final output ──
    // If reviewer flagged HIGH issues, use corrected version
    // Otherwise use coder output directly
    let finalOutput = coderOutput;
    let hadIssues = false;

    const issueSignals = [
      'confidence: low', 'potential issue', 'bug', 'not validated',
      'vulnerability', 'error handling', 'hardcoded', 'missing',
      'may cause', 'may lead'
    ];

    hadIssues = issueSignals.some(s => reviewerOutput.toLowerCase().includes(s));

    if (hadIssues) {
      const fixPrompt = `You are an expert software engineer.

ORIGINAL IMPLEMENTATION:
${coderOutput}

REVIEWER FEEDBACK (issues to fix):
${reviewerOutput}

Fix ALL issues identified by the reviewer.
Output ONLY the complete corrected code. No explanation, no preamble.
Use the same style and patterns as the original.`;

      finalOutput = await callGroq(prompts.coder, fixPrompt, 2500);
    }

    return res.status(200).json({
      architectPlan,
      coderOutput,
      reviewerOutput,
      finalOutput,
      hadIssues,
      taskType,
      repo
    });

  } catch (error) {
    console.error('Agent run error:', error);
    return res.status(500).json({ error: error.message });
  }
}
