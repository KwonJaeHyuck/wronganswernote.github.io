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

  try {
    const decoded = await admin.auth().verifyIdToken(token);
    const snap = await admin.firestore().doc(`users/${decoded.uid}`).get();
    const plan = snap.exists ? snap.data().plan : null;
    return { isPro: plan === 'pro', uid: decoded.uid };
  } catch (e) {
    console.error('verifyPro 실패:', e.message);
    return { isPro: false, uid: null };
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
