/**
 * /api/parse — 사진 → 오답카드 구조화 (Vercel 서버리스 함수)
 * ─────────────────────────────────────────────────────────────────────────
 * 입력:  { image: base64(JPEG), tags: ["기존 태그 목록"] }
 * 출력:  { q, c[4], a, tag, concept, expl, has_figure, figure_box }
 *
 * 설계 원칙:
 *  - API 키는 여기(서버)에만. 게이트는 PRO 전용이 아니라 "무료 월 30장,
 *    PRO 무제한" (보고서 §9.1) — checkPhotoQuota/incrementPhotoQuota로 처리.
 *  - 환각 통제: "사진에 보이는 것만" 전사. 해설이 사진에 없으면 빈 문자열 —
 *    해설을 지어내지 않는다. 정답 표시가 없으면 a=null.
 *  - tag/concept: CLAUDE.md 원칙 4 — 기존 목록(certTagList) 매칭 우선, 새 태그는
 *    간결하게. 최종 정규화(registerTag/registerConcept)는 클라이언트에서 한 번 더 함.
 *  - 그림 문제: 그림 영역 좌표(0~1 비율)를 반환 → 클라이언트가 잘라 보존.
 */
import { verifyPro } from '../lib/verifyPro.js';
import { checkPhotoQuota, incrementPhotoQuota } from '../lib/quota.js';

const MODEL = 'gemini-2.5-flash-lite'; // 전사 작업 — 창의성 불필요, 저비용 모델

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { isPro, uid } = await verifyPro(req);
  if (!uid) return res.status(403).json({ error: '로그인이 필요합니다.' });

  const quota = await checkPhotoQuota(uid, isPro);
  if (!quota.allowed) {
    return res.status(403).json({ error: '이번 달 무료 사진 파싱 30장을 모두 사용했습니다. PRO는 무제한입니다.', quota });
  }

  const { image, tags } = req.body || {};
  if (!image) return res.status(400).json({ error: '이미지가 없습니다.' });

  const prompt = `한국 국가기술자격 시험 문제 사진입니다. 아래 JSON 스키마로만 응답하세요.
마크다운 백틱, 설명문 등 JSON 외 텍스트를 절대 포함하지 마세요.

{
 "q": "문제 지문 (사진의 문구 그대로, 위첨자는 m³·m² 형태로)",
 "c": ["보기1","보기2","보기3","보기4"],
 "a": 정답 번호(1~4) 또는 null,
 "tag": "개념 태그",
 "concept": "이 문제의 핵심개념 한 줄",
 "expl": "사진에 해설이 있으면 그대로 전사, 없으면 빈 문자열",
 "has_figure": true/false,
 "figure_box": [x0, y0, x1, y1] 또는 null
}

[엄격한 규칙]
1. 사진에 보이는 내용만 전사하세요. 해설·정답을 추론하거나 지어내지 마세요.
2. 정답 표시(체크, 형광펜, "정답:" 문구 등)가 사진에 없으면 a는 null.
3. 그림(도면·회로·기호·그래프·사진)이 사진 어디에든 있으면 무조건 has_figure를
   true로, figure_box에 그 그림 영역을 담으세요. 두 경우 모두 포함합니다:
   (a) 보기 중 하나가 그림인 경우 — 해당 보기 문자열은 "" 빈 값으로 둡니다.
   (b) 문제 지문 자체에 딸린 그림인 경우("다음 그림과 같은...", "그림에서 A는?" 등)
       — 이때는 보기가 전부 텍스트여도 has_figure를 true로 표시해야 합니다.
4. figure_box는 이미지 좌상단 기준 0.0~1.0 사이의 소수 비율 좌표 [x0,y0,x1,y1]
   입니다 (예: [0.12, 0.34, 0.78, 0.91]). 0~1000 정수 스케일이 아니라 반드시
   0~1 소수로 주세요. 그림이 여러 개면 전체를 포함하는 하나의 사각형으로 담으세요.
5. tag는 다음 기존 태그 중 가장 맞는 것을 우선 사용하고, 전부 안 맞으면
   새 태그를 간결하게 만드세요: ${JSON.stringify(tags || [])}`;

  try {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              { inline_data: { mime_type: 'image/jpeg', data: image } },
              { text: prompt },
            ],
          }],
          generationConfig: {
            temperature: 0,
            maxOutputTokens: 2000,
            responseMimeType: 'application/json',
          },
        }),
      }
    );
    if (!r.ok) {
      const errBody = await r.text().catch(() => '');
      throw new Error(`Gemini API ${r.status}: ${errBody.slice(0, 300)}`);
    }
    const data = await r.json();
    const finishReason = data.candidates?.[0]?.finishReason;
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '{}';

    let parsed;
    try {
      parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
    } catch (parseErr) {
      console.error('JSON 파싱 실패, finishReason:', finishReason, '원문:', text.slice(0, 500));
      const reasonNote = finishReason === 'MAX_TOKENS' ? ' (응답이 잘림 — 사진을 더 단순하게 찍어보세요)' : '';
      throw new Error(`Gemini 응답이 JSON이 아님${reasonNote}`);
    }

    // 실제로 파싱이 성공한 뒤에만 한도를 깎는다 — Gemini 오류로 실패한 호출은 무료
    if (!isPro) { try { await incrementPhotoQuota(uid); } catch (e) { console.error('한도 갱신 실패:', e.message); } }

    return res.status(200).json({ ...parsed, quota: isPro ? null : { remaining: Math.max(0, quota.remaining - 1), limit: quota.limit } });
  } catch (e) {
    console.error(e);
    return res.status(502).json({ error: `사진 분석 실패: ${e.message}` });
  }
}
