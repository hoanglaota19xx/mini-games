/*
 * logic.js — luật chơi thuần (không đụng DOM / WebGL).
 * Chạy được cả trong trình duyệt (window.SRLogic) lẫn Node (require) để test.
 *
 * Mọi hàm thay đổi trạng thái đều trả về MẢNG SỰ KIỆN; phần hiển thị chỉ việc
 * phát lại các sự kiện này theo thứ tự. Logic không biết gì về hoạt ảnh.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SRLogic = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MAX_SLOTS = 8;
  const WINS_NEEDED = 2;
  const MAX_ROUNDS = 3;

  const ITEMS = {
    magnifier:  { name: 'Kính lúp',      desc: 'Xem viên đạn đang nằm trong nòng. Chỉ người dùng được thấy.' },
    cigarette:  { name: 'Thuốc lá',      desc: 'Hồi 1 máu (không vượt quá máu tối đa).' },
    beer:       { name: 'Lon bia',       desc: 'Nhả viên đạn hiện tại ra ngoài. Cả hai đều thấy đó là đạn gì.' },
    cuffs:      { name: 'Còng tay',      desc: 'Đối thủ mất lượt kế tiếp. Không dùng được nếu họ đang bị còng.' },
    saw:        { name: 'Cưa nòng',      desc: 'Phát bắn kế tiếp gây gấp đôi sát thương (nếu là đạn thật).' },
    phone:      { name: 'Điện thoại cũ', desc: 'Cho biết một viên ngẫu nhiên phía sau viên hiện tại là thật hay lép.' },
    inverter:   { name: 'Bộ đảo cực',    desc: 'Đảo viên hiện tại: thật thành lép, lép thành thật.' },
    adrenaline: { name: 'Adrenaline',    desc: 'Lấy một vật phẩm của đối thủ (trừ Adrenaline) và dùng ngay.' },
    medicine:   { name: 'Thuốc quá hạn', desc: '50% hồi 2 máu, 50% mất 1 máu.' },
  };
  const ITEM_IDS = Object.keys(ITEMS);

  // Số vật phẩm mỗi người nhận ở mỗi lần nạp đạn, theo hiệp.
  function itemsPerLoad(round) { return round <= 1 ? 0 : round === 2 ? 2 : 4; }
  // Máu mỗi hiệp: khoảng [min, max] (cả hai người cùng một mức).
  function hpRange(round) { return round <= 1 ? [2, 4] : round === 2 ? [3, 5] : [4, 6]; }

  // ---------- RNG ----------
  function makeRng(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function randInt(rng, lo, hi) { return lo + Math.floor(rng() * (hi - lo + 1)); } // [lo, hi]

  // ---------- Trạng thái ----------
  function createGame(opts) {
    opts = opts || {};
    const rng = opts.rng || Math.random;
    return {
      rng,
      names: opts.names || ['Người chơi 1', 'Người chơi 2'],
      firstStarter: opts.firstStarter != null ? opts.firstStarter : (rng() < 0.5 ? 0 : 1),
      round: 0,
      wins: [0, 0],
      hp: [0, 0],
      maxHp: 0,
      items: [new Array(MAX_SLOTS).fill(null), new Array(MAX_SLOTS).fill(null)],
      cuffed: [false, false],
      sawed: false,
      chamber: [],          // chamber[0] là viên sẽ nổ tiếp theo
      loaded: { live: 0, blank: 0 },
      turn: 0,
      roundOver: true,      // chưa bắt đầu hiệp nào
      matchOver: false,
      matchWinner: null,
    };
  }

  const other = (p) => 1 - p;

  function remaining(g) {
    let live = 0, blank = 0;
    for (const s of g.chamber) (s === 'live' ? live++ : blank++);
    return { live, blank };
  }

  // ---------- Bắt đầu hiệp / nạp đạn ----------
  function startRound(g) {
    if (g.matchOver) throw new Error('Trận đã kết thúc');
    if (!g.roundOver) throw new Error('Hiệp trước chưa kết thúc');
    g.round += 1;
    const [lo, hi] = hpRange(g.round);
    g.maxHp = randInt(g.rng, lo, hi);
    g.hp = [g.maxHp, g.maxHp];
    g.items = [new Array(MAX_SLOTS).fill(null), new Array(MAX_SLOTS).fill(null)];
    g.cuffed = [false, false];
    g.sawed = false;
    g.chamber = [];
    g.roundOver = false;
    g.turn = (g.firstStarter + g.round - 1) % 2;
    const events = [{ type: 'roundStart', round: g.round, maxHp: g.maxHp, starter: g.turn, wins: g.wins.slice() }];
    return events.concat(reload(g));
  }

  function shuffle(rng, arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }

  function reload(g) {
    const n = randInt(g.rng, 2, MAX_SLOTS);          // tổng số viên 2..8
    const live = randInt(g.rng, 1, n - 1);           // ít nhất 1 thật và 1 lép
    const blank = n - live;
    const chamber = [];
    for (let i = 0; i < live; i++) chamber.push('live');
    for (let i = 0; i < blank; i++) chamber.push('blank');
    g.chamber = shuffle(g.rng, chamber);
    g.loaded = { live, blank };
    const events = [{ type: 'load', live, blank }];
    // chia vật phẩm
    const count = itemsPerLoad(g.round);
    for (let p = 0; p < 2; p++) {
      for (let k = 0; k < count; k++) {
        const empties = [];
        g.items[p].forEach((it, i) => { if (!it) empties.push(i); });
        if (!empties.length) break;
        const slot = empties[Math.floor(g.rng() * empties.length)];
        const item = ITEM_IDS[Math.floor(g.rng() * ITEM_IDS.length)];
        g.items[p][slot] = item;
        events.push({ type: 'deal', player: p, slot, item });
      }
    }
    return events;
  }

  // ---------- Điều kiện dùng vật phẩm ----------
  function canApply(g, item, player) {
    if (item === 'cuffs') return !g.cuffed[other(player)];
    if (item === 'saw') return !g.sawed;
    return true;
  }
  function stealable(g, player) {            // các ô của đối thủ có thể bị Adrenaline lấy
    const opp = other(player);
    const out = [];
    g.items[opp].forEach((it, i) => {
      if (it && it !== 'adrenaline' && canApply(g, it, player)) out.push(i);
    });
    return out;
  }
  function canUseSlot(g, slot) {
    if (g.roundOver || g.matchOver) return false;
    const it = g.items[g.turn][slot];
    if (!it) return false;
    if (it === 'adrenaline') return stealable(g, g.turn).length > 0;
    return canApply(g, it, g.turn);
  }

  function legalActions(g) {
    if (g.roundOver || g.matchOver) return [];
    const acts = [{ type: 'shoot', target: 'self' }, { type: 'shoot', target: 'opp' }];
    g.items[g.turn].forEach((it, slot) => {
      if (!it) return;
      if (it === 'adrenaline') {
        for (const steal of stealable(g, g.turn)) acts.push({ type: 'use', slot, steal });
      } else if (canApply(g, it, g.turn)) {
        acts.push({ type: 'use', slot });
      }
    });
    return acts;
  }

  // ---------- Kết thúc hiệp ----------
  function endRound(g, loser) {
    const winner = other(loser);
    g.roundOver = true;
    g.wins[winner] += 1;
    const matchOver = g.wins[winner] >= WINS_NEEDED;
    if (matchOver) { g.matchOver = true; g.matchWinner = winner; }
    return { type: 'roundEnd', winner, loser, wins: g.wins.slice(), matchOver, round: g.round };
  }

  function damage(g, player, amount) {
    g.hp[player] = Math.max(0, g.hp[player] - amount);
  }
  function heal(g, player, amount) {
    const before = g.hp[player];
    g.hp[player] = Math.min(g.maxHp, g.hp[player] + amount);
    return g.hp[player] - before;
  }

  // ---------- Hiệu ứng vật phẩm ----------
  // Trả về { events, ended } — ended = true nếu hiệp kết thúc do vật phẩm.
  function applyItem(g, item, player) {
    const events = [];
    const opp = other(player);
    switch (item) {
      case 'magnifier':
        events.push({ type: 'peek', player, index: 0, shell: g.chamber[0] });
        break;
      case 'cigarette': {
        const amount = heal(g, player, 1);
        events.push({ type: 'heal', player, amount, hp: g.hp.slice() });
        break;
      }
      case 'beer': {
        const shell = g.chamber.shift();
        events.push({ type: 'eject', shell });
        break;
      }
      case 'cuffs':
        g.cuffed[opp] = true;
        events.push({ type: 'cuff', target: opp });
        break;
      case 'saw':
        g.sawed = true;
        events.push({ type: 'saw' });
        break;
      case 'phone': {
        if (g.chamber.length <= 1) {
          events.push({ type: 'phone', player, index: null, shell: null });
        } else {
          const idx = 1 + Math.floor(g.rng() * (g.chamber.length - 1));
          events.push({ type: 'phone', player, index: idx, shell: g.chamber[idx] });
        }
        break;
      }
      case 'inverter':
        g.chamber[0] = g.chamber[0] === 'live' ? 'blank' : 'live';
        events.push({ type: 'invert', player });     // không tiết lộ kết quả
        break;
      case 'medicine': {
        if (g.rng() < 0.5) {
          const amount = heal(g, player, 2);
          events.push({ type: 'medicine', player, outcome: 'heal', amount, hp: g.hp.slice() });
        } else {
          damage(g, player, 1);
          events.push({ type: 'medicine', player, outcome: 'hurt', amount: 1, hp: g.hp.slice() });
          if (g.hp[player] <= 0) {
            events.push(endRound(g, player));
            return { events, ended: true };
          }
        }
        break;
      }
      default:
        throw new Error('Vật phẩm lạ: ' + item);
    }
    return { events, ended: false };
  }

  // ---------- Hành động chính ----------
  function apply(g, action) {
    if (g.roundOver || g.matchOver) throw new Error('Hiệp không còn diễn ra');
    const events = [];
    const me = g.turn;
    const opp = other(me);

    if (action.type === 'use') {
      const slot = action.slot;
      const item = g.items[me][slot];
      if (!item) throw new Error('Ô trống');
      if (item === 'adrenaline') {
        const steal = action.steal;
        const target = g.items[opp][steal];
        if (!target) throw new Error('Ô đối thủ trống');
        if (target === 'adrenaline') throw new Error('Không thể lấy Adrenaline');
        if (!canApply(g, target, me)) throw new Error('Vật phẩm đó chưa dùng được');
        g.items[me][slot] = null;
        g.items[opp][steal] = null;
        events.push({ type: 'use', player: me, slot, item: 'adrenaline' });
        events.push({ type: 'steal', player: me, from: opp, slot: steal, item: target });
        const r = applyItem(g, target, me);
        events.push(...r.events);
        if (r.ended) return events;
      } else {
        if (!canApply(g, item, me)) throw new Error('Vật phẩm chưa dùng được');
        g.items[me][slot] = null;
        events.push({ type: 'use', player: me, slot, item });
        const r = applyItem(g, item, me);
        events.push(...r.events);
        if (r.ended) return events;
      }
      if (g.chamber.length === 0) events.push(...reload(g)); // bia nhả viên cuối
      return events;
    }

    if (action.type === 'shoot') {
      const target = action.target === 'self' ? me : opp;
      const shell = g.chamber.shift();
      const sawed = g.sawed;
      const dmg = shell === 'live' ? (sawed ? 2 : 1) : 0;
      g.sawed = false;
      if (dmg) damage(g, target, dmg);
      events.push({ type: 'shoot', shooter: me, target, shell, damage: dmg, sawed, hp: g.hp.slice() });
      if (g.hp[target] <= 0) {
        events.push(endRound(g, target));
        return events;
      }
      if (target === me && shell === 'blank') {
        events.push({ type: 'turn', player: me, reason: 'extra' });
      } else if (g.cuffed[opp]) {
        g.cuffed[opp] = false;
        events.push({ type: 'skip', player: opp });
        events.push({ type: 'turn', player: me, reason: 'skip' });
      } else {
        g.turn = opp;
        events.push({ type: 'turn', player: opp, reason: 'pass' });
      }
      if (g.chamber.length === 0) events.push(...reload(g));
      return events;
    }

    throw new Error('Hành động lạ: ' + action.type);
  }

  return {
    MAX_SLOTS, WINS_NEEDED, MAX_ROUNDS, ITEMS, ITEM_IDS,
    itemsPerLoad, hpRange, makeRng, createGame, startRound, apply, legalActions,
    canApply, canUseSlot, stealable, remaining, other,
  };
});
