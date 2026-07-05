/**
 * verifyPro — 구독 상태 검증 (서버 전용)
 * ─────────────────────────────────────────────────────────────────────────
 * CLAUDE.md 원칙 2: "구독 게이트·API 키는 서버리스 함수 안에만" — 이 파일이
 * 그 게이트 본체. 클라이언트는 Firebase ID 토큰을 Authorization 헤더로
 * 보내고, 여기서 검증 후 Firestore users/{uid}.plan 필드를 확인한다.
 *
 * 필요 환경변수 (Vercel 프로젝트 설정 → Environment Variables):
 *   FIREBASE_PROJECT_ID
 *   FIREBASE_CLIENT_EMAIL
 *   FIREBASE_PRIVATE_KEY   (Firebase 콘솔 → 프로젝트 설정 → 서비스 계정 → 새 비공개 키 생성)
 *
 * 결제 웹훅(토스페이먼츠/포트원)이 users/{uid}.plan 을 'pro'로 갱신하면
 * 이 함수가 그 값을 그대로 읽는다 — 이 파일은 plan 을 쓰지 않고 읽기만 한다.
 */
import admin from 'firebase-admin';

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    }),
  });
}

/**
 * @param {import('http').IncomingMessage} req
 * @returns {Promise<{ isPro: boolean, uid: string|null }>}
 */
export async function verifyPro(req) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return { isPro: false, uid: null };

  // 토큰 검증과 plan 조회를 분리한다 — Firestore 쪽이 일시적으로 실패해도
  // (네트워크 블립 등) 토큰 자체는 유효했으므로 uid는 살려서 반환한다.
  // 그래야 /api/parse처럼 "로그인만 하면 되는(PRO는 한도만 다름)" 호출부가
  // 진짜 로그인 안 한 사람과 "Firestore 잠깐 삐끗"을 구분해 잘못된
  // "로그인이 필요합니다" 오류를 보여주지 않는다.
  let uid;
  try {
    uid = (await admin.auth().verifyIdToken(token)).uid;
  } catch (e) {
    console.error('verifyPro 토큰 검증 실패:', e.message);
    return { isPro: false, uid: null };
  }

  try {
    const snap = await admin.firestore().doc(`users/${uid}`).get();
    const plan = snap.exists ? snap.data().plan : null;
    return { isPro: plan === 'pro', uid };
  } catch (e) {
    console.error('verifyPro plan 조회 실패(토큰은 유효):', e.message);
    return { isPro: false, uid }; // PRO는 안전하게 거부, 로그인 자체는 유효하니 uid는 반환
  }
}

/**
 * 로그인만 확인 (PRO 여부 무관) — 무료로 열어둔 기능(예: 캐시 해설 조회/생성)에 사용.
 * @param {import('http').IncomingMessage} req
 * @returns {Promise<string|null>} uid 또는 null
 */
export async function verifyLogin(req) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return null;
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    return decoded.uid;
  } catch (e) {
    console.error('verifyLogin 실패:', e.message);
    return null;
  }
}

export function firestoreAdmin() { return admin.firestore(); }
