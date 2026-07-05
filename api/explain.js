/**
 * /api/explain — 해설 생성·전역 캐시 (Vercel 서버리스 함수)
 * ─────────────────────────────────────────────────────────────────────────
 * CLAUDE.md 원칙 3: 해설은 전역 캐시(문제 지문 해시 기준) — 같은 문제는
 * 두 번째 유저부터 생성이 아니라 조회(원가 0).
 *
 * 입력:  { question, choices[4], correctAnswer(1~4), concept?, img? }
 * 출력:  { text, cached: boolean } 또는 실패 시 { pending: true, error }
 *
 * 환각 통제 (CLAUDE.md 원칙 1 / 보고서 §5):
 *  - 정답은 클라이언트가 이미 확정해서 보낸 값(correctAnswer)을 그대로 사용.
 *    AI는 "왜 그 번호가 정답인지"를 서술만 한다 — 정답을 판단하지 않는다.
 *  - correctAnswer가 없으면(미채점 문제) 해설 생성을 아예 차단한다.
 *
 * 문항 유형별 라우팅 (그림 문제 순환논리 버그 수정):
 *  - 보기가 전부 빈 텍스트 + img 있음 → 그림을 inline_data로 첨부해 "그림 비교"
 *    프롬프트 사용. 텍스트만 주면 AI가 그림을 못 보고 "3번 정답 → 해설 참조"
 *    같은 순환논리를 만들어냈던 게 원인이었음.
 *  - 그 외 → 기존 텍스트 기반 "각 선지 분석" 프롬프트.
 *
 * 품질 게이트: 생성된 해설이 (1) 문제 지문과 과도하게 겹치거나 (2) 선지 판정만
 * 있고 근거 문장이 없거나 (3) MAX_TOKENS로 잘렸으면 불합격 → 1회 재생성 →
 * 그래도 불합격이면 캐시에 저장하지 않고 "해설 준비 중" 상태로 반환한다.
 * 검증되지 않은 순환논리 해설을 캐시에 박아버리면 그 다음부터 모든 유저가
 * 그 나쁜 해설을 그대로 받게 되므로(전역 캐시라서) 여기서 반드시 걸러야 한다.
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

async function fetchImageAsBase64(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`이미지 다운로드 실패: ${r.status}`);
  const buf = await r.arrayBuffer();
  return Buffer.from(buf).toString('base64');
}

function buildTextPrompt({ question, choices, correctAnswer, concept }) {
  const choiceText = choices.map((c, i) => `${i + 1}) ${c}`).join('\n');
  return `한국 국가기술자격 시험 문제의 해설을 작성하세요.

[문제]
${question}

[보기]
${choiceText}

[확정 정답] ${correctAnswer}번
${concept ? `[핵심개념] ${concept}` : ''}

[엄격한 규칙]
1. 정답은 이미 ${correctAnswer}번으로 확정되어 있습니다 — 정답을 다시 판단하거나 의심하지 마세요.
2. "각 선지 분석" 섹션: 보기마다 정답/오답 여부만 한 단어로 쓰지 말고, 왜 맞는지
   또는 왜 틀렸는지 근거 문장을 반드시 붙이세요. (나쁜 예: "1번) 오답" / 좋은 예:
   "1번) 오답 — OO 조건을 만족하지 않아 제외된다")
3. 위에 주어지지 않은 공식·수치·개념을 지어내지 마세요.
4. 문제 지문을 그대로 반복하지 말고, 반드시 새로운 설명을 더하세요.
5. 간결하게 5~8줄 이내로 작성하세요.`;
}

function buildImagePrompt({ question, correctAnswer, concept }) {
  return `한국 국가기술자격 시험 문제입니다. 보기 ①~④가 전부 첨부된 그림 안에
있습니다(텍스트 보기 없음). 아래 규칙에 따라 해설을 작성하세요.

[문제]
${question}

[확정 정답] ${correctAnswer}번
${concept ? `[핵심개념] ${concept}` : ''}

[엄격한 규칙]
1. 정답은 이미 ${correctAnswer}번으로 확정되어 있습니다 — 판단하거나 의심하지 마세요.
2. "그림 비교 해설" 섹션: 이미지 속 보기 ①~④를 실제로 보이는 모양·형태·구조로
   서로 비교해, 왜 ${correctAnswer}번이 정답인지 시각적 근거로 서술하세요.
   "각 선지 분석" 형식(텍스트 판정)은 쓰지 마세요 — 해당 없는 섹션을 억지로
   채우지 마세요.
3. 이미지에 실제로 보이는 내용만 근거로 삼으세요. 지어내지 마세요.
4. 문제 지문을 그대로 반복하지 마세요.
5. 간결하게 5~8줄 이내로 작성하세요.`;
}

// 품질 게이트 — 실패 사유 문자열 반환, 문제 없으면 null
function qualityIssue(text, question, finishReason, isImageMode) {
  if (finishReason === 'MAX_TOKENS') return 'MAX_TOKENS로 응답이 잘림';

  // 문제 지문과 과도하게 겹치는지 — 단어 단위 자카드 유사도로 대략 판정
  const qWords = new Set(String(question).split(/\s+/).filter(w => w.length > 1));
  const tWords = String(text).split(/\s+/).filter(w => w.length > 1);
  if (qWords.size > 0) {
    const overlap = tWords.filter(w => qWords.has(w)).length;
    const ratio = overlap / qWords.size;
    if (ratio >= 0.8) return `문제 지문과 겹침(${Math.round(ratio * 100)}%) — 순환논리 의심`;
  }

  // 텍스트형만: "1) 정답"/"2) 오답"처럼 근거 문장 없이 판정만 있는 줄이 있으면 불합격
  if (!isImageMode) {
    const bareJudgementLine = /^\s*[①-④1-4][).]?\s*(정답|오답)\.?\s*$/m;
    if (bareJudgementLine.test(text)) return '근거 문장 없이 정답/오답 판정만 있음';
  }

  return null;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const uid = await verifyLogin(req);
  if (!uid) return res.status(403).json({ error: '로그인이 필요합니다.' });

  const { question, choices, correctAnswer, concept, img } = req.body || {};
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

  const isImageMode = !!img && choices.every(c => !c || !String(c).trim());
  const payload = { question, choices, correctAnswer, concept };

  let imageBase64 = null;
  if (isImageMode) {
    try { imageBase64 = await fetchImageAsBase64(img); }
    catch (e) {
      console.error('그림 다운로드 실패, 텍스트 모드로 폴백:', e.message);
    }
  }
  const useImage = isImageMode && imageBase64;
  const prompt = useImage ? buildImagePrompt(payload) : buildTextPrompt(payload);

  async function generateOnce() {
    const contents = useImage
      ? [{ parts: [{ inline_data: { mime_type: 'image/jpeg', data: imageBase64 } }, { text: prompt }] }]
      : [{ parts: [{ text: prompt }] }];

    const r = await callGemini(MODEL, {
      contents,
      generationConfig: { temperature: 0.2, maxOutputTokens: 900 },
    });
    const data = await r.json();
    const finishReason = data.candidates?.[0]?.finishReason;
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    return { text, finishReason };
  }

  try {
    let { text, finishReason } = await generateOnce();
    if (!text) throw new Error('빈 응답');

    let issue = qualityIssue(text, question, finishReason, useImage);
    if (issue) {
      console.warn('해설 품질 게이트 실패, 재생성:', issue);
      const retry = await generateOnce();
      if (!retry.text) throw new Error('재생성 빈 응답');
      const retryIssue = qualityIssue(retry.text, question, retry.finishReason, useImage);
      if (retryIssue) {
        console.error('재생성도 품질 게이트 실패, 캐시 저장 안 함:', retryIssue);
        return res.status(200).json({ pending: true, error: `해설 품질 검증 실패(${retryIssue}) — 잠시 후 다시 시도해주세요.` });
      }
      text = retry.text;
    }

    try {
      await ref.set({
        question, choices, correctAnswer, concept: concept || '',
        text, model: MODEL, verified: false, imageMode: useImage,
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
