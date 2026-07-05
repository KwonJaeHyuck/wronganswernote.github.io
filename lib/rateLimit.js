/**
 * 일일 호출 한도 (남용/비용 폭주 방지) — 보고서 §9.2 "페어유즈 한도" 원칙을
 * 사진 파싱 외 기능(AI 코칭, 해설 생성)에도 동일하게 적용.
 * users/{uid}.dailyLimits.{key} = { date: "YYYY-MM-DD", count } 로 추적.
 */
import { firestoreAdmin } from './verifyPro.js';

function todayKey() { return new Date().toISOString().slice(0, 10); } // "YYYY-MM-DD"

/**
 * limit 이하면 카운트 증가 후 true, 초과면 증가 없이 false.
 * 트랜잭션으로 처리해 동시 요청에서도 한도가 새지 않게 한다.
 */
export async function checkAndConsumeDailyLimit(uid, key, limit) {
  const db = firestoreAdmin();
  const ref = db.doc(`users/${uid}`);
  const today = todayKey();

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const existing = snap.exists ? (snap.data().dailyLimits || {})[key] : null;
    const count = (existing && existing.date === today) ? existing.count : 0;

    if (count >= limit) return { allowed: false, remaining: 0, limit };

    tx.set(ref, { dailyLimits: { [key]: { date: today, count: count + 1 } } }, { merge: true });
    return { allowed: true, remaining: limit - (count + 1), limit };
  });
}
