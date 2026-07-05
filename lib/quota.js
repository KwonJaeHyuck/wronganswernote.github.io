/**
 * 사진 파싱 무료 월 한도 (보고서 §9.1: "사진 파싱만 월 30장 한도")
 * ─────────────────────────────────────────────────────────────────────────
 * PRO는 무제한. 무료는 월 30장 — users/{uid}.photoQuota = { month, count } 로 추적.
 * Firestore 트랜잭션으로 증가시켜 동시 요청에서도 카운트가 씹히지 않게 한다.
 */
import { firestoreAdmin } from './verifyPro.js';

const FREE_MONTHLY_LIMIT = 30;
function currentMonthKey() { return new Date().toISOString().slice(0, 7); } // "YYYY-MM"

/** 한도 초과 여부만 확인 (증가시키지 않음) — 실제 호출 전에 먼저 체크 */
export async function checkPhotoQuota(uid, isPro) {
  if (isPro) return { allowed: true, remaining: null, limit: null };
  const db = firestoreAdmin();
  const snap = await db.doc(`users/${uid}`).get();
  const month = currentMonthKey();
  const existing = snap.exists ? snap.data().photoQuota : null;
  const count = (existing && existing.month === month) ? existing.count : 0;
  return { allowed: count < FREE_MONTHLY_LIMIT, remaining: Math.max(0, FREE_MONTHLY_LIMIT - count), limit: FREE_MONTHLY_LIMIT };
}

/** 실제 파싱 성공 후에만 호출 — 실패한 호출까지 한도를 깎지 않기 위해 분리 */
export async function incrementPhotoQuota(uid) {
  const db = firestoreAdmin();
  const ref = db.doc(`users/${uid}`);
  const month = currentMonthKey();
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const existing = snap.exists ? snap.data().photoQuota : null;
    const count = (existing && existing.month === month) ? existing.count : 0;
    tx.set(ref, { photoQuota: { month, count: count + 1 } }, { merge: true });
  });
}
