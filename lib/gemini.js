/**
 * Gemini API 호출 공용 헬퍼 — 503(과부하)/429(레이트리밋)는 잠깐 쉬었다 1회 재시도.
 * Vercel 함수 타임아웃(Hobby 기본 10s)을 넘지 않도록 재시도는 짧고 1번만 한다.
 */
const RETRYABLE_STATUS = new Set([429, 503]);

export async function callGemini(model, body, { retries = 1, delayMs = 600 } = {}) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`;
  let lastErr;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (r.ok) return r;

    const errBody = await r.text().catch(() => '');
    lastErr = new Error(`Gemini API ${r.status}: ${errBody.slice(0, 300)}`);
    if (!RETRYABLE_STATUS.has(r.status) || attempt === retries) throw lastErr;

    console.warn(`Gemini ${r.status} — ${delayMs}ms 후 재시도 (${attempt + 1}/${retries})`);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw lastErr;
}
