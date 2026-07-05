/**
 * /api/analyze — AI 취약점 코칭 (Vercel 서버리스 함수)
 * ─────────────────────────────────────────────────────────────────────────
 * 이 파일이 아키텍처의 급소 두 개를 동시에 해결한다:
 *  1) API 키 은닉  : GEMINI_API_KEY는 Vercel 환경변수에만 존재.
 *  2) 구독 게이트  : PRO 여부 검증을 "여기서" 한다.
 *
 * CLAUDE.md 원칙 1 (AI는 판단하지 않고 데이터가 판단한다):
 *  - 통계(정답률 등)는 클라이언트가 이미 계산해서 보낸다. AI에게 숫자를
 *    만들게 하지 않는다.
 *  - 프롬프트에 "전달된 데이터에 없는 개념·공식·수치를 언급하지 말 것"을
 *    명시하고, 오답 문제의 concept(핵심개념) 필드만 근거로 제공한다.
 */
import { verifyPro } from '../lib/verifyPro.js';
import { callGemini } from '../lib/gemini.js';
import { checkAndConsumeDailyLimit } from '../lib/rateLimit.js';

const MODEL = 'gemini-2.5-flash'; // 런타임 코칭 — 품질·비용 균형
const DAILY_LIMIT = 10; // 페어유즈 한도 (보고서 §9.2) — 코칭은 반복 호출할 이유가 적은 기능

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST only' });
  }

  const { isPro, uid } = await verifyPro(req);
  if (!isPro) {
    return res.status(403).json({ error: 'PRO 구독이 필요한 기능입니다.' });
  }

  const limitCheck = await checkAndConsumeDailyLimit(uid, 'analyze', DAILY_LIMIT);
  if (!limitCheck.allowed) {
    return res.status(429).json({ error: `오늘의 AI 코칭 한도(${DAILY_LIMIT}회)를 모두 사용했습니다. 내일 다시 시도해주세요.` });
  }

  const { stats, wrongQuestions } = req.body || {};
  if (!Array.isArray(stats) || !stats.length) {
    return res.status(400).json({ error: '통계 데이터가 없습니다.' });
  }

  const statsText = stats
    .map((t) => `- ${t.tag}: 정답률 ${t.rate}% (${t.correct}/${t.total}문항)`)
    .join('\n');
  const wrongText = (wrongQuestions || [])
    .map((w) => `- [${w.tag}] ${w.q} → 핵심개념: ${w.concept}`)
    .join('\n');

  const prompt = `당신은 국가기술자격 학습 코치입니다.
아래 [데이터]만을 근거로 학습 코칭을 작성하세요.

[엄격한 규칙]
1. 데이터에 없는 개념, 공식, 수치를 절대 언급하지 마세요.
2. 정답률 숫자는 데이터에 있는 값을 그대로 인용하고, 새로 계산하지 마세요.
3. 문제 해설을 새로 지어내지 마세요. 핵심개념 필드의 표현을 그대로 사용하세요.
4. 출력: 우선 복습할 태그 최대 3개를 순서대로, 태그마다 다시 볼 핵심개념을
   나열하고, 마지막에 한 문장으로 다음 행동을 제안하세요. 8줄 이내.

[데이터]
태그별 정답률:
${statsText}

오답 문제와 핵심개념:
${wrongText || '(오답노트에 남은 문제 없음)'}`;

  try {
    const r = await callGemini(MODEL, {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.2, // 코칭은 창의성보다 재현성 — 낮게 고정
        maxOutputTokens: 500,
      },
    });
    const data = await r.json();
    const text =
      data.candidates?.[0]?.content?.parts?.[0]?.text ??
      '분석 결과를 생성하지 못했습니다. 잠시 후 다시 시도해주세요.';
    return res.status(200).json({ text });
  } catch (e) {
    console.error(e);
    return res.status(502).json({ error: `AI 분석 서버 오류: ${e.message}` });
  }
}
