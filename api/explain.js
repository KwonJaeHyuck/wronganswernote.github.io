/**
 * /api/explain — 해설 생성·전역 캐시 (Vercel 서버리스 함수)
 * ─────────────────────────────────────────────────────────────────────────
 * CLAUDE.md 원칙 3: 해설은 전역 캐시(문제 지문 해시 기준) — 같은 문제는
 * 두 번째 유저부터 생성이 아니라 조회(원가 0).
 *
 * 입력:  { question, choices[4], correctAnswer(1~4), concept? }
 * 출력:  { text, cached: boolean }
 *
 * 환각 통제 (CLAUDE.md 원칙 1 / 보고서 §5):
 *  - 정답은 클라이언트가 이미 확정해서 보낸 값(correctAnswer)을 그대로 사용.
 *    AI는 "왜 그 번호가 정답인지"를 서술만 한다 — 정답을 판단하지 않는다.
 *  - correctAnswer가 없으면(미채점 문제) 해설 생성을 아예 차단한다.
 *  - 프롬프트에 "주어진 보기·핵심개념 밖의 사실을 지어내지 말 것"을 명시.
 *
 * 무료/PRO: 캐시 히트는 항상 무료(로그인만 하면 됨). 캐시 미스(신규 생성)도
 * 현재는 무료 기간 정책상 열어둔다 — 추후 PRO 우선순위 큐로 바꿀 때 이 함수의
 * verifyLogin()을 verifyPro()로만 바꾸면 된다 (구조는 이미 그렇게 짜여 있음).
 */
import crypto from 'crypto';
import { verifyLogin, firestoreAdmin } from '../lib/verifyPro.js';
import { callGemini } from '../lib/gemini.js';
import { checkAndConsumeDailyLimit } from '../lib/rateLimit.js';

const MODEL = 'gemini-2.5-flash'; // 런타임 해설 — 품질·비용 균형
const DAILY_GEN_LIMIT = 20; // 캐시 미스(신규 생성)만 세는 페어유즈 한도 — 캐시 히트는 무제한 무료

function hashQuestion(question, choices) {
  const normalized = String(question).trim() + '|' + (choices || []).map(c => String(c).trim()).join('|');
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const uid = await verifyLogin(req);
  if (!uid) return res.status(403).json({ error: '로그인이 필요합니다.' });

  const { question, choices, correctAnswer, concept } = req.body || {};
  if (!question || !Array.isArray(choices) || choices.length < 2) {
    return res.status(400).json({ error: '문제 데이터가 올바르지 않습니다.' });
  }
  // 정답 없는 카드는 해설 생성 차단 — 원칙 1 (AI는 정답을 판단하지 않는다)
  if (!correctAnswer || correctAnswer < 1 || correctAnswer > choices.length) {
    return res.status(400).json({ error: '정답이 확정되지 않은 문제는 해설을 생성할 수 없습니다.' });
  }

  const qHash = hashQuestion(question, choices);
  const db = firestoreAdmin();
  const ref = db.doc(`explanations/${qHash}`);

  try {
    const snap = await ref.get();
    if (snap.exists) {
      return res.status(200).json({ text: snap.data().text, cached: true });
    }
  } catch (e) {
    console.error('캐시 조회 실패:', e.message);
    // 캐시 조회 실패해도 생성은 시도 — 원가만 조금 더 들 뿐 기능은 살아있어야 함
  }

  // 캐시 미스(신규 생성)만 한도 대상 — 캐시 히트는 위에서 이미 반환됨
  const limitCheck = await checkAndConsumeDailyLimit(uid, 'explain', DAILY_GEN_LIMIT);
  if (!limitCheck.allowed) {
    return res.status(429).json({ error: `오늘의 신규 해설 생성 한도(${DAILY_GEN_LIMIT}회)를 모두 사용했습니다. 캐시된 해설은 계속 볼 수 있습니다.` });
  }

  const choiceText = choices.map((c, i) => `${i + 1}) ${c}`).join('\n');
  const prompt = `한국 국가기술자격 시험 문제의 해설을 작성하세요.

[문제]
${question}

[보기]
${choiceText}

[확정 정답] ${correctAnswer}번
${concept ? `[핵심개념] ${concept}` : ''}

[엄격한 규칙]
1. 정답은 이미 ${correctAnswer}번으로 확정되어 있습니다 — 정답을 다시 판단하거나 의심하지 마세요.
2. 왜 ${correctAnswer}번이 정답인지, 나머지 보기가 왜 틀렸는지 위 정보만 근거로 서술하세요.
3. 위에 주어지지 않은 공식·수치·개념을 지어내지 마세요.
4. 간결하게 5~8줄 이내로 작성하세요.`;

  try {
    const r = await callGemini(MODEL, {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 600 },
    });
    const data = await r.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    if (!text) throw new Error('빈 응답');

    try {
      await ref.set({
        question, choices, correctAnswer, concept: concept || '',
        text, model: MODEL, verified: false,
        createdAt: new Date().toISOString(),
      });
    } catch (e) {
      console.error('캐시 저장 실패(응답은 정상 반환):', e.message);
    }

    return res.status(200).json({ text, cached: false });
  } catch (e) {
    console.error(e);
    return res.status(502).json({ error: `해설 생성 실패: ${e.message}` });
  }
}
