// Chạy: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../js/logic.js');

// Dựng một ván có trạng thái cố định để test từng luật.
function setup(opts) {
  opts = opts || {};
  const g = L.createGame({ rng: L.makeRng(opts.seed || 1), firstStarter: 0 });
  L.startRound(g);
  g.round = opts.round || g.round;
  g.maxHp = opts.maxHp || 4;
  g.hp = opts.hp ? opts.hp.slice() : [g.maxHp, g.maxHp];
  g.chamber = (opts.chamber || ['live', 'blank', 'blank']).slice();
  g.items = [new Array(8).fill(null), new Array(8).fill(null)];
  (opts.items0 || []).forEach(([s, it]) => (g.items[0][s] = it));
  (opts.items1 || []).forEach(([s, it]) => (g.items[1][s] = it));
  g.turn = opts.turn || 0;
  g.cuffed = [false, false];
  g.sawed = false;
  return g;
}
const types = (ev) => ev.map((e) => e.type);

test('startRound: máu, đạn, lượt hợp lệ', () => {
  for (let seed = 1; seed < 200; seed++) {
    const g = L.createGame({ rng: L.makeRng(seed) });
    const ev = L.startRound(g);
    const [lo, hi] = L.hpRange(1);
    assert.ok(g.maxHp >= lo && g.maxHp <= hi);
    assert.deepEqual(g.hp, [g.maxHp, g.maxHp]);
    const n = g.chamber.length;
    assert.ok(n >= 2 && n <= 8);
    assert.ok(g.loaded.live >= 1 && g.loaded.blank >= 1);
    assert.equal(g.loaded.live + g.loaded.blank, n);
    assert.equal(ev[0].type, 'roundStart');
    assert.equal(ev[1].type, 'load');
    assert.ok(!ev.some((e) => e.type === 'deal'), 'hiệp 1 không có vật phẩm');
  }
});

test('hiệp 2 chia 2 vật phẩm, hiệp 3 chia 4 vật phẩm cho mỗi người', () => {
  for (const [round, expected] of [[2, 2], [3, 4]]) {
    const g = L.createGame({ rng: L.makeRng(round), firstStarter: 0 });
    g.round = round - 1; // startRound sẽ tăng lên `round`
    const ev = L.startRound(g);
    assert.equal(ev.filter((e) => e.type === 'deal' && e.player === 0).length, expected);
    assert.equal(ev.filter((e) => e.type === 'deal' && e.player === 1).length, expected);
  }
});

test('người bắt đầu đổi luân phiên theo hiệp', () => {
  const g = L.createGame({ rng: L.makeRng(5), firstStarter: 0 });
  L.startRound(g);
  assert.equal(g.turn, 0);
  g.hp[1] = 0; g.roundOver = true; // ép sang hiệp sau
  L.startRound(g);
  assert.equal(g.turn, 1);
});

test('bắn đối thủ bằng đạn thật: trừ 1 máu, chuyển lượt', () => {
  const g = setup({ chamber: ['live', 'blank'] });
  const ev = L.apply(g, { type: 'shoot', target: 'opp' });
  assert.equal(g.hp[1], 3);
  assert.equal(g.turn, 1);
  assert.deepEqual(g.chamber, ['blank']);
  assert.equal(ev[0].damage, 1);
});

test('bắn đối thủ bằng đạn lép: không mất máu, vẫn chuyển lượt', () => {
  const g = setup({ chamber: ['blank', 'live'] });
  L.apply(g, { type: 'shoot', target: 'opp' });
  assert.equal(g.hp[1], 4);
  assert.equal(g.turn, 1);
});

test('tự bắn đạn lép: được thêm lượt', () => {
  const g = setup({ chamber: ['blank', 'live'] });
  const ev = L.apply(g, { type: 'shoot', target: 'self' });
  assert.equal(g.hp[0], 4);
  assert.equal(g.turn, 0);
  assert.equal(ev.find((e) => e.type === 'turn').reason, 'extra');
});

test('tự bắn đạn thật: mất máu và mất lượt', () => {
  const g = setup({ chamber: ['live', 'blank'] });
  L.apply(g, { type: 'shoot', target: 'self' });
  assert.equal(g.hp[0], 3);
  assert.equal(g.turn, 1);
});

test('cưa nòng: gấp đôi sát thương một lần rồi tự reset; đạn lép làm mất tác dụng', () => {
  const g = setup({ chamber: ['live', 'live', 'blank'], items0: [[0, 'saw']] });
  L.apply(g, { type: 'use', slot: 0 });
  assert.equal(g.sawed, true);
  L.apply(g, { type: 'shoot', target: 'opp' });
  assert.equal(g.hp[1], 2);
  assert.equal(g.sawed, false);
  const g2 = setup({ chamber: ['blank', 'live'], items0: [[0, 'saw']] });
  L.apply(g2, { type: 'use', slot: 0 });
  L.apply(g2, { type: 'shoot', target: 'opp' });
  assert.equal(g2.hp[1], 4);
  assert.equal(g2.sawed, false);
});

test('cưa nòng không dùng chồng được', () => {
  const g = setup({ items0: [[0, 'saw'], [1, 'saw']] });
  L.apply(g, { type: 'use', slot: 0 });
  assert.equal(L.canUseSlot(g, 1), false);
  assert.throws(() => L.apply(g, { type: 'use', slot: 1 }));
});

test('hiệp kết thúc khi hết máu, tính thắng và hết trận khi đủ 2 hiệp', () => {
  const g = setup({ hp: [4, 1], chamber: ['live', 'blank'] });
  const ev = L.apply(g, { type: 'shoot', target: 'opp' });
  assert.equal(g.roundOver, true);
  assert.deepEqual(g.wins, [1, 0]);
  assert.equal(ev[ev.length - 1].type, 'roundEnd');
  assert.equal(g.matchOver, false);
  assert.throws(() => L.apply(g, { type: 'shoot', target: 'opp' }));
  // thắng 1 hiệp thì trận chưa kết thúc, hiệp sau bắt đầu lại từ đầu
  L.startRound(g);
  assert.equal(g.round, 2);
  assert.equal(g.roundOver, false);
  assert.deepEqual(g.hp, [g.maxHp, g.maxHp]);
});

test('thắng 2 hiệp thì kết thúc trận', () => {
  const g = setup({ hp: [4, 1], chamber: ['live', 'blank'] });
  L.apply(g, { type: 'shoot', target: 'opp' });
  L.startRound(g);
  g.hp = [4, 1]; g.turn = 0; g.chamber = ['live', 'blank'];
  const ev = L.apply(g, { type: 'shoot', target: 'opp' });
  assert.equal(g.matchOver, true);
  assert.equal(g.matchWinner, 0);
  assert.equal(ev[ev.length - 1].matchOver, true);
  assert.throws(() => L.startRound(g));
});

test('còng tay: đối thủ mất đúng một lượt rồi hết còng', () => {
  const g = setup({ chamber: ['blank', 'blank', 'blank', 'blank'], items0: [[0, 'cuffs']] });
  L.apply(g, { type: 'use', slot: 0 });
  assert.equal(g.cuffed[1], true);
  const ev = L.apply(g, { type: 'shoot', target: 'opp' });
  assert.ok(types(ev).includes('skip'));
  assert.equal(g.turn, 0);
  assert.equal(g.cuffed[1], false);
  L.apply(g, { type: 'shoot', target: 'opp' });
  assert.equal(g.turn, 1);
});

test('còng tay: không còng được người đang bị còng', () => {
  const g = setup({ items0: [[0, 'cuffs'], [1, 'cuffs']] });
  L.apply(g, { type: 'use', slot: 0 });
  assert.equal(L.canUseSlot(g, 1), false);
});

test('còng tay không bị tiêu hao khi tự bắn đạn lép (vẫn là lượt của mình)', () => {
  const g = setup({ chamber: ['blank', 'blank', 'live'], items0: [[0, 'cuffs']] });
  L.apply(g, { type: 'use', slot: 0 });
  L.apply(g, { type: 'shoot', target: 'self' });
  assert.equal(g.cuffed[1], true);
  assert.equal(g.turn, 0);
});

test('kính lúp: lộ đúng viên hiện tại, không đổi buồng đạn', () => {
  const g = setup({ chamber: ['live', 'blank'], items0: [[0, 'magnifier']] });
  const ev = L.apply(g, { type: 'use', slot: 0 });
  const peek = ev.find((e) => e.type === 'peek');
  assert.equal(peek.shell, 'live');
  assert.deepEqual(g.chamber, ['live', 'blank']);
  assert.equal(g.items[0][0], null);
});

test('thuốc lá: hồi 1 máu, không vượt mức tối đa', () => {
  const g = setup({ hp: [2, 4], items0: [[0, 'cigarette'], [1, 'cigarette']] });
  L.apply(g, { type: 'use', slot: 0 });
  assert.equal(g.hp[0], 3);
  g.hp[0] = 4;
  const ev = L.apply(g, { type: 'use', slot: 1 });
  assert.equal(g.hp[0], 4);
  assert.equal(ev.find((e) => e.type === 'heal').amount, 0);
});

test('bia: nhả viên hiện tại và lộ ra; nhả viên cuối thì nạp lại', () => {
  const g = setup({ chamber: ['blank', 'live'], items0: [[0, 'beer'], [1, 'beer']] });
  const ev = L.apply(g, { type: 'use', slot: 0 });
  assert.equal(ev.find((e) => e.type === 'eject').shell, 'blank');
  assert.deepEqual(g.chamber, ['live']);
  const ev2 = L.apply(g, { type: 'use', slot: 1 });
  assert.equal(ev2.find((e) => e.type === 'eject').shell, 'live');
  assert.ok(types(ev2).includes('load'));
  assert.ok(g.chamber.length >= 2);
  assert.equal(g.turn, 0);
});

test('bộ đảo cực: đảo viên hiện tại, sự kiện không lộ kết quả', () => {
  const g = setup({ chamber: ['live', 'blank'], items0: [[0, 'inverter']] });
  const ev = L.apply(g, { type: 'use', slot: 0 });
  assert.equal(g.chamber[0], 'blank');
  assert.ok(!('shell' in ev.find((e) => e.type === 'invert')));
});

test('điện thoại: chỉ lộ viên phía sau, không bao giờ là viên hiện tại', () => {
  for (let seed = 1; seed < 100; seed++) {
    const g = setup({ seed, chamber: ['live', 'blank', 'live', 'blank'], items0: [[0, 'phone']] });
    const ev = L.apply(g, { type: 'use', slot: 0 });
    const p = ev.find((e) => e.type === 'phone');
    assert.ok(p.index >= 1 && p.index <= 3);
    assert.equal(p.shell, g.chamber[p.index]);
  }
  const g = setup({ chamber: ['live'], items0: [[0, 'phone']] });
  const p = L.apply(g, { type: 'use', slot: 0 }).find((e) => e.type === 'phone');
  assert.equal(p.index, null);
});

test('thuốc quá hạn: hoặc +2 (có giới hạn) hoặc -1; có thể tự giết mình', () => {
  const seen = new Set();
  for (let seed = 1; seed < 80; seed++) {
    const g = setup({ seed, hp: [3, 4], items0: [[0, 'medicine']] });
    const ev = L.apply(g, { type: 'use', slot: 0 });
    const m = ev.find((e) => e.type === 'medicine');
    seen.add(m.outcome);
    if (m.outcome === 'heal') assert.equal(g.hp[0], 4);
    else assert.equal(g.hp[0], 2);
  }
  assert.deepEqual([...seen].sort(), ['heal', 'hurt']);
  for (let seed = 1; seed < 80; seed++) {
    const g = setup({ seed, hp: [1, 4], items0: [[0, 'medicine']] });
    const ev = L.apply(g, { type: 'use', slot: 0 });
    if (g.hp[0] === 0) {
      assert.equal(g.roundOver, true);
      assert.equal(g.wins[1], 1);
      assert.equal(ev[ev.length - 1].type, 'roundEnd');
      return;
    }
  }
  assert.fail('không thấy trường hợp thuốc gây chết');
});

test('adrenaline: lấy và dùng ngay vật phẩm của đối thủ; không lấy được Adrenaline', () => {
  const g = setup({ hp: [2, 4], items0: [[0, 'adrenaline']], items1: [[3, 'cigarette'], [5, 'adrenaline']] });
  assert.equal(L.canUseSlot(g, 0), true);
  assert.deepEqual(L.stealable(g, 0), [3]);
  assert.throws(() => L.apply(g, { type: 'use', slot: 0, steal: 5 }));
  const ev = L.apply(g, { type: 'use', slot: 0, steal: 3 });
  assert.equal(g.hp[0], 3);
  assert.equal(g.items[0][0], null);
  assert.equal(g.items[1][3], null);
  assert.deepEqual(types(ev).slice(0, 3), ['use', 'steal', 'heal']);
});

test('adrenaline: không dùng được khi đối thủ không có gì lấy được', () => {
  const g = setup({ items0: [[0, 'adrenaline']], items1: [[2, 'adrenaline']] });
  assert.equal(L.canUseSlot(g, 0), false);
  const g2 = setup({ items0: [[0, 'adrenaline']] });
  assert.equal(L.canUseSlot(g2, 0), false);
});

test('adrenaline: không lấy được còng khi đối thủ đã bị còng', () => {
  const g = setup({ items0: [[0, 'adrenaline'], [1, 'cuffs']], items1: [[2, 'cuffs']] });
  L.apply(g, { type: 'use', slot: 1 });
  assert.deepEqual(L.stealable(g, 0), []);
});

test('hết đạn thì nạp lại và chia thêm vật phẩm, giữ nguyên máu và lượt', () => {
  const g = setup({ round: 2, chamber: ['blank'], hp: [3, 3] });
  g.round = 2;
  const ev = L.apply(g, { type: 'shoot', target: 'self' });
  assert.ok(types(ev).includes('load'));
  assert.equal(g.turn, 0);
  assert.ok(g.chamber.length >= 2);
  assert.equal(ev.filter((e) => e.type === 'deal').length, 4);
});

test('mỗi người tối đa 8 vật phẩm, không ghi đè ô có sẵn', () => {
  const g = setup({ round: 3 });
  g.round = 3;
  g.items[0] = ['saw', 'saw', 'saw', 'saw', 'saw', 'saw', 'saw', null];
  const ev = L.apply(Object.assign(g, { chamber: ['blank'] }), { type: 'shoot', target: 'self' });
  assert.equal(ev.filter((e) => e.type === 'deal' && e.player === 0).length, 1);
  assert.ok(g.items[0].every(Boolean));
  assert.equal(g.items[0].filter((x) => x === 'saw').length, 7);
});

test('legalActions khớp với apply (mọi hành động liệt kê đều chạy được)', () => {
  for (let seed = 1; seed < 150; seed++) {
    const g = L.createGame({ rng: L.makeRng(seed) });
    L.startRound(g);
    g.round = 3;
    for (let p = 0; p < 2; p++) for (let s = 0; s < 8; s++) g.items[p][s] = L.ITEM_IDS[(s + p + seed) % L.ITEM_IDS.length];
    for (const act of L.legalActions(g)) {
      const copy = JSON.parse(JSON.stringify({ ...g, rng: undefined }));
      copy.rng = L.makeRng(seed + 1);
      assert.doesNotThrow(() => L.apply(copy, act));
    }
  }
});

// ---------- Fuzz: chơi trọn nhiều trận với hành động ngẫu nhiên hợp lệ ----------
test('fuzz 3000 trận: bất biến luôn đúng, trận luôn kết thúc', () => {
  let totalActions = 0;
  const itemUse = {};
  for (let seed = 1; seed <= 3000; seed++) {
    const rng = L.makeRng(seed * 7919);
    const g = L.createGame({ rng });
    let guard = 0;
    while (!g.matchOver) {
      L.startRound(g);
      assert.ok(g.round >= 1 && g.round <= 3, 'số hiệp hợp lệ');
      while (!g.roundOver) {
        if (++guard > 20000) assert.fail('vòng lặp vô hạn, seed ' + seed);
        const acts = L.legalActions(g);
        assert.ok(acts.length >= 2);
        // thiên về dùng vật phẩm để phủ nhiều nhánh
        const useActs = acts.filter((a) => a.type === 'use');
        const act = useActs.length && rng() < 0.6 ? useActs[Math.floor(rng() * useActs.length)] : acts[Math.floor(rng() * acts.length)];
        if (act.type === 'use') { const it = g.items[g.turn][act.slot]; itemUse[it] = (itemUse[it] || 0) + 1; }
        const before = g.turn;
        const ev = L.apply(g, act);
        totalActions++;
        // bất biến
        assert.ok(g.hp[0] >= 0 && g.hp[0] <= g.maxHp && g.hp[1] >= 0 && g.hp[1] <= g.maxHp);
        assert.ok(g.turn === 0 || g.turn === 1);
        for (const row of g.items) assert.equal(row.length, 8);
        if (!g.roundOver) {
          assert.ok(g.chamber.length >= 1, 'buồng đạn không được rỗng khi đang chơi');
          assert.ok(g.chamber.every((s) => s === 'live' || s === 'blank'));
          const r = L.remaining(g);
          assert.ok(r.live + r.blank === g.chamber.length);
        } else {
          assert.ok(g.hp[0] === 0 || g.hp[1] === 0);
          assert.equal(ev[ev.length - 1].type, 'roundEnd');
        }
        if (act.type === 'shoot' && !g.roundOver) {
          // lượt chỉ đổi khi không phải 'extra' hoặc 'skip'
          const t = ev.filter((e) => e.type === 'turn').pop();
          assert.equal(g.turn, t.player);
          if (t.reason === 'pass') assert.notEqual(g.turn, before);
          else assert.equal(g.turn, before);
        }
      }
      assert.ok(g.wins[0] <= 2 && g.wins[1] <= 2);
    }
    assert.ok(g.wins[g.matchWinner] === 2);
    assert.ok(g.round >= 2 && g.round <= 3);
  }
  // mọi vật phẩm đều đã được dùng trong fuzz
  for (const id of L.ITEM_IDS) assert.ok(itemUse[id] > 50, 'fuzz chưa phủ vật phẩm ' + id);
  assert.ok(totalActions > 10000);
});
