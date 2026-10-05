// online.js — catan の通信対戦（「みんなのスマホで」）。
// 部屋のしくみ（作る・入る・顔ぶれ・状態の送受信）は room.js（正本は本部の online-kit）。
// ここは catan の待合の形（settings・seats）を組み立てるだけ。画面は main.js が持つ。
import { createRoom, joinRoom, isValidCode, sanitizeName as roomSanitizeName, roomLinkFor, roomCodeFromHash } from './room.js';
import qrcode from './qr.js';

const GAME = 'catan-3d';

// 待合の座席。空いている人の席は uid: null。
// [{ type: 'human', uid: string|null, name: string }, { type: 'cpu', level: 'weak'|'normal'|'strong' }, ...]
function emptySeats(count) {
  return Array.from({ length: count }, () => ({ type: 'human', uid: null, name: '' }));
}

function parseSeats(json, count) {
  try {
    const arr = JSON.parse(json || '[]');
    if (Array.isArray(arr) && arr.length) return arr;
  } catch { /* 壊れていたら空の席として扱う */ }
  return emptySeats(count);
}

function parseSettings(json) {
  try { return JSON.parse(json || '{}') || {}; } catch { return {}; }
}

// 通信対戦で選べる拡張（段階9）。1つずつ ready: true にして開ける。表に足すだけで済むようにしてある
const ONLINE_EXPANSIONS = [
  { id: 'none', name: 'なし', ready: true },
  { id: 'seafarers', name: '航海者版', ready: true },
  { id: 'cities-knights', name: '都市と騎士', ready: true },
  { id: 'traders-barbarians', name: '交易と略奪', ready: true },
  { id: 'soccer', name: 'サッカー熱', ready: true },
  { id: 'explorers-pirates', name: '探検家と海賊', ready: true },
];

// members（全員）のうち座っていない人を、空いている人の席に座らせる（ホストだけが呼ぶ）
function seatMembers(seats, members) {
  const next = seats.map((s) => ({ ...s }));
  const seated = new Set(next.filter((s) => s.type === 'human' && s.uid).map((s) => s.uid));
  Object.keys(members || {}).forEach((uid) => {
    if (seated.has(uid)) return;
    const open = next.find((s) => s.type === 'human' && !s.uid);
    if (!open) return;
    open.uid = uid;
    open.name = roomSanitizeName((members[uid] && members[uid].name) || '');
    seated.add(uid);
  });
  return next;
}

// 全席が人（座った）かCPUで、人が2人以上なら始められる
function canStart(seats) {
  const humanCount = seats.filter((s) => s.type === 'human').length;
  return humanCount >= 2 && seats.every((s) => s.type === 'cpu' || (s.type === 'human' && s.uid));
}

// 席 i を「CPUに代わってもらう」。持ち主(uid)は覚えておき、本人が戻ったら revertSubbedSeats で人に戻す
function subSeat(seats, i) {
  const seat = seats[i];
  if (!seat || seat.type !== 'human' || !seat.uid) return seats;
  const next = seats.map((s) => ({ ...s }));
  next[i] = { type: 'cpu', level: 'normal', subbed: true, uid: seat.uid, name: seat.name || '' };
  return next;
}

// 待合で席を空ける（対局中はsubSeatを使う。自分から抜けたときなど）
function freeSeat(seats, i) {
  const seat = seats[i];
  if (!seat || seat.type !== 'human') return seats;
  const next = seats.map((s) => ({ ...s }));
  next[i] = { type: 'human', uid: null, name: '' };
  return next;
}

// CPUに代わってもらっていた席の持ち主がつながり直していたら、人の席に戻す
function revertSubbedSeats(seats, members) {
  return seats.map((s) => (s.type === 'cpu' && s.subbed && s.uid && members[s.uid] && members[s.uid].online
    ? { type: 'human', uid: s.uid, name: s.name || members[s.uid].name || '' }
    : s));
}

// 部屋のリンクをQRにしたSVG文字列（待合の「QRコードで招待する」）
function roomQrSvg(code) {
  const qr = qrcode(0, 'M'); // typeNumber 0 = 文字数に合わせて自動で選ぶ
  qr.addData(roomLinkFor(code));
  qr.make();
  return qr.createSvgTag(4, 8);
}

export {
  createRoom, joinRoom, isValidCode, roomSanitizeName, roomLinkFor, roomCodeFromHash, roomQrSvg,
  GAME, emptySeats, parseSeats, parseSettings, seatMembers, canStart, subSeat, freeSeat, revertSubbedSeats,
  ONLINE_EXPANSIONS,
};
