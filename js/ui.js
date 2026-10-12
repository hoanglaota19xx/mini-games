/*
 * ui.js — nối luật chơi (logic.js) với đồ họa (scene.js), HUD và các màn hình phủ.
 *
 * Nguyên tắc để không bị lỗi:
 *  1. Logic chạy xong NGAY, trả về mảng sự kiện; phần này chỉ phát lại sự kiện (hoạt ảnh + HUD).
 *  2. Trong lúc phát (busy = true) mọi thao tác của người chơi bị bỏ qua.
 *  3. Sau mỗi hành động luôn gọi syncItems()/syncView() để ép cảnh 3D và HUD khớp với trạng thái logic,
 *     kể cả khi một hoạt ảnh bị lỗi giữa chừng.
 */
(function () {
  'use strict';
  const L = window.SRLogic, S = window.SRScene, A = window.SRAudio;
  const $ = (id) => document.getElementById(id);
  const ITEMS = L.ITEMS;
  const COLORS = ['#ffb347', '#4ad8ff'];
  const DEFAULT_NAMES = ['Người chơi 1', 'Người chơi 2'];
  const SETTINGS_KEY = 'shellroulette.v1';

  // ---------- cài đặt ----------
  function loadSettings() {
    try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch (e) { return {}; }
  }
  function saveSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) { /* bỏ qua: chế độ riêng tư */ }
  }
  const settings = Object.assign({ names: DEFAULT_NAMES.slice(), counter: true, muted: false, music: true }, loadSettings());
  if (!Array.isArray(settings.names) || settings.names.length !== 2) settings.names = DEFAULT_NAMES.slice();

  // ---------- trạng thái ----------
  let g = null;
  let mode = 'menu';                 // menu | busy | idle | item | gun | steal
  let busy = false;
  let aim = null;                    // 'opp' | 'self' | null
  let sel = null;                    // { owner, slot }
  const view = { hp: [0, 0], turn: 0, cuffed: [false, false], sawed: false, maxHp: 0, round: 0, wins: [0, 0] };
  let track = { live: 0, blank: 0, uncertain: false };
  let logLines = [];
  let bannerSeq = 0;
  let started = false;               // đã khởi tạo 3D chưa

  const nm = (p) => g.names[p];

  // ---------- tiện ích DOM ----------
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function show(id) { $(id).classList.remove('hidden'); }
  function hide(id) { $(id).classList.add('hidden'); }

  async function banner(text, cls, sub, sec) {
    const b = $('banner'), my = ++bannerSeq;
    b.className = 'show ' + (cls || 'plain');
    b.textContent = text;
    if (sub) { b.appendChild(el('small', null, sub)); }
    await S.wait(sec || 1.0);
    if (my === bannerSeq) b.classList.remove('show');
  }
  function log(text) {
    logLines.push(text);
    if (logLines.length > 4) logLines.shift();
    const box = $('log');
    box.textContent = '';
    logLines.forEach((t) => box.appendChild(el('div', null, t)));
  }

  // ---------- HUD ----------
  function renderHud() {
    for (let p = 0; p < 2; p++) {
      const pl = $('pl' + p);
      pl.querySelector('.nm').textContent = g.names[p];
      const cells = pl.querySelector('.cells');
      while (cells.children.length < view.maxHp) cells.appendChild(el('i', 'cell'));
      while (cells.children.length > view.maxHp) cells.removeChild(cells.lastChild);
      Array.prototype.forEach.call(cells.children, (c, i) => c.classList.toggle('on', i < view.hp[p]));
      pl.classList.toggle('turn', view.turn === p);
      const tags = pl.querySelector('.tags');
      tags.textContent = '';
      if (view.cuffed[p]) tags.appendChild(el('span', 'tag', 'BỊ CÒNG'));
      if (view.sawed && view.turn === p) tags.appendChild(el('span', 'tag saw', 'CƯA NÒNG'));
    }
    $('roundtxt').textContent = view.round ? 'HIỆP ' + view.round + '/' + L.MAX_ROUNDS : '';
    const sc = $('score');
    sc.textContent = '';
    sc.appendChild(el('span', 's0', String(view.wins[0])));
    sc.appendChild(document.createTextNode(' - '));
    sc.appendChild(el('span', 's1', String(view.wins[1])));
    renderCounter();
  }
  function renderCounter() {
    const c = $('counter');
    c.classList.toggle('off', !settings.counter || !g || g.roundOver);
    c.textContent = '';
    const chip = (cls, label, n) => {
      const s = el('span', 'chip');
      s.appendChild(el('i', 'dot ' + cls));
      s.appendChild(document.createTextNode(label + ' ' + n));
      return s;
    };
    c.appendChild(chip('live', 'THẬT', track.live));
    c.appendChild(chip('blank', 'LÉP', track.blank));
    if (track.uncertain) c.appendChild(el('span', 'u', '≈ đã dùng bộ đảo'));
  }
  function setHp(hp) {
    for (let p = 0; p < 2; p++) {
      if (hp[p] < view.hp[p]) {
        const cells = $('pl' + p).querySelector('.cells').children;
        for (let i = hp[p]; i < view.hp[p]; i++) if (cells[i]) { cells[i].classList.remove('on'); cells[i].classList.add('flash'); }
      }
    }
    view.hp = hp.slice();
    renderHud();
  }
  function syncView() {
    view.hp = g.hp.slice(); view.turn = g.turn; view.cuffed = g.cuffed.slice(); view.sawed = g.sawed;
    view.maxHp = g.maxHp; view.round = g.round; view.wins = g.wins.slice();
    S.setFigureCuffed(0, g.cuffed[0]); S.setFigureCuffed(1, g.cuffed[1]);
    S.setGunSawed(g.sawed);
    renderHud();
  }
  function syncItems() {
    for (let p = 0; p < 2; p++) for (let s = 0; s < L.MAX_SLOTS; s++) {
      const want = g.items[p][s] || null;
      if (S.itemAt(p, s) !== want) S.placeItem(p, s, want, false);
    }
  }

  // ---------- bảng thao tác ----------
  function btn(label, cls, onClick, id, disabled) {
    const b = el('button', 'btn ' + (cls || ''), label);
    if (id) b.id = id;
    b.type = 'button';
    b.disabled = !!disabled;
    b.addEventListener('click', () => { A.unlock(); onClick(); });
    return b;
  }
  function whyCannot(id) {
    if (id === 'cuffs') return 'Đối thủ đang bị còng rồi.';
    if (id === 'saw') return 'Nòng súng đã được cưa rồi.';
    if (id === 'adrenaline') return 'Đối thủ không có vật phẩm nào lấy được.';
    return '';
  }
  function renderActions() {
    const box = $('actions');
    box.textContent = '';
    if (!g || busy || mode === 'menu' || mode === 'busy') return;
    box.style.setProperty('--accent', COLORS[g.turn]);
    const panel = el('div', 'panel');
    const btns = el('div', 'btns');
    let title = '', desc = '', why = '';
    if (mode === 'idle') {
      title = 'Lượt của ' + nm(g.turn);
      desc = 'Chạm vào súng để bắn, hoặc chạm vật phẩm của bạn để dùng.';
      btns.appendChild(btn('LẤY SÚNG', 'primary', takeGun, 'btn-gun'));
    } else if (mode === 'item' && sel) {
      const id = g.items[sel.owner][sel.slot];
      const info = ITEMS[id];
      title = info ? info.name : '';
      desc = info ? info.desc : '';
      if (sel.owner === g.turn) {
        const can = L.canUseSlot(g, sel.slot);
        if (!can) why = whyCannot(id);
        btns.appendChild(btn('DÙNG', 'primary', useSelected, 'btn-use', !can));
        btns.appendChild(btn('HỦY', '', cancelSelection, 'btn-cancel'));
      } else {
        title = 'Của đối thủ · ' + title;
        btns.appendChild(btn('ĐÓNG', '', cancelSelection, 'btn-cancel'));
      }
    } else if (mode === 'gun') {
      title = 'Đang cầm súng';
      if (!aim) {
        desc = 'Chọn hướng nhắm (có thể chạm vào nhân vật để nhắm).';
        btns.appendChild(btn('NHẮM ĐỐI THỦ', 'primary', () => setAim('opp'), 'btn-aim-opp'));
        btns.appendChild(btn('NHẮM BẢN THÂN', '', () => setAim('self'), 'btn-aim-self'));
        btns.appendChild(btn('ĐẶT XUỐNG', '', putDown, 'btn-putdown'));
      } else {
        desc = aim === 'opp' ? 'Bắn đối thủ: lượt luôn chuyển sang họ.' : 'Bắn bản thân: nếu là đạn lép, bạn được đi tiếp.';
        btns.appendChild(btn('BẮN!', 'danger', fire, 'btn-fire'));
        btns.appendChild(btn(aim === 'opp' ? 'NHẮM BẢN THÂN' : 'NHẮM ĐỐI THỦ', '', () => setAim(aim === 'opp' ? 'self' : 'opp'), 'btn-aim-other'));
        btns.appendChild(btn('ĐẶT XUỐNG', '', putDown, 'btn-putdown'));
      }
    } else if (mode === 'steal') {
      title = 'Adrenaline';
      desc = 'Chọn một vật phẩm đang nhấp nháy đỏ của đối thủ để lấy và dùng ngay.';
      btns.appendChild(btn('HỦY', '', cancelSelection, 'btn-cancel'));
    }
    panel.appendChild(el('div', 'title', title));
    panel.appendChild(el('div', 'desc', desc));
    if (why) panel.appendChild(el('div', 'why', why));
    panel.appendChild(btns);
    box.appendChild(panel);
  }

  // ---------- chuyển chế độ ----------
  function enterIdle() {
    busy = false; mode = 'idle'; aim = null; sel = null;
    S.clearSlotStates(); S.setGunPickable(true);
    renderActions();
  }
  function setBusy() { busy = true; $('actions').textContent = ''; }

  function selectItem(owner, slot) {
    if (busy) return;
    if (!g.items[owner][slot]) return;
    S.clearSlotStates();
    sel = { owner, slot }; mode = 'item';
    S.setSlotState(owner, slot, 'selected');
    A.play('select');
    renderActions();
  }
  function cancelSelection() {
    if (busy) return;
    sel = null; mode = 'idle'; S.clearSlotStates();
    A.play('cancel');
    renderActions();
  }
  function useSelected() {
    if (busy || !sel || sel.owner !== g.turn || !L.canUseSlot(g, sel.slot)) return;
    const id = g.items[sel.owner][sel.slot];
    if (id === 'adrenaline') {
      mode = 'steal';
      S.clearSlotStates();
      S.setSlotState(sel.owner, sel.slot, 'selected');
      L.stealable(g, g.turn).forEach((s) => S.setSlotState(L.other(g.turn), s, 'target'));
      renderActions();
      return;
    }
    perform({ type: 'use', slot: sel.slot });
  }
  async function takeGun() {
    if (busy || (mode !== 'idle' && mode !== 'item')) return;
    S.clearSlotStates(); sel = null;
    setBusy();
    A.play('select');
    try { await S.gunTake(g.turn); } finally { busy = false; mode = 'gun'; aim = null; renderActions(); }
  }
  async function setAim(which) {
    if (busy || mode !== 'gun') return;
    setBusy();
    try { await S.gunAim(g.turn, which); aim = which; } finally { busy = false; renderActions(); }
  }
  async function putDown() {
    if (busy || mode !== 'gun') return;
    setBusy();
    try { await S.gunRest(); } finally { enterIdle(); }
  }
  function fire() {
    if (busy || mode !== 'gun' || !aim) return;
    perform({ type: 'shoot', target: aim === 'self' ? 'self' : 'opp' });
  }

  function onPick(pk) {
    if (!g || busy) return;
    A.unlock();
    if (mode === 'idle') {
      if (!pk) return;
      if (pk.kind === 'gun') takeGun();
      else if (pk.kind === 'item') selectItem(pk.player, pk.slot);
    } else if (mode === 'item') {
      if (!pk) cancelSelection();
      else if (pk.kind === 'gun' && sel && sel.owner === g.turn) takeGun();
      else if (pk.kind === 'item') selectItem(pk.player, pk.slot);
      else cancelSelection();
    } else if (mode === 'gun') {
      if (pk && pk.kind === 'figure') setAim(pk.player === g.turn ? 'self' : 'opp');
    } else if (mode === 'steal') {
      if (pk && pk.kind === 'item' && pk.player !== g.turn) {
        if (L.stealable(g, g.turn).indexOf(pk.slot) >= 0) perform({ type: 'use', slot: sel.slot, steal: pk.slot });
        else banner('KHÔNG LẤY ĐƯỢC', 'warn', 'Vật phẩm này chưa dùng được lúc này', 0.9);
      }
    }
  }

  // ---------- màn hình riêng tư ----------
  function peekPrivate(player, title, text, cls) {
    return new Promise((resolve) => {
      $('peek-name').textContent = g.names[player].toUpperCase();
      $('peek-other').textContent = g.names[1 - player].toUpperCase();
      $('peek-title').textContent = title;
      const box = $('peek-box'), res = $('peek-result');
      res.textContent = text; res.className = cls || '';
      box.classList.remove('reveal');
      show('screen-peek');
      const on = () => box.classList.add('reveal'), off = () => box.classList.remove('reveal');
      box.onpointerdown = (ev) => { ev.preventDefault(); on(); };
      box.onpointerup = off; box.onpointerleave = off; box.onpointercancel = off;
      box.onkeydown = (ev) => { if (ev.key === ' ' || ev.key === 'Enter') { ev.preventDefault(); on(); } };
      box.onkeyup = off;
      $('btn-peek-done').onclick = () => {
        off(); hide('screen-peek');
        box.onpointerdown = box.onpointerup = box.onpointerleave = box.onpointercancel = box.onkeydown = box.onkeyup = null;
        resolve();
      };
    });
  }
  // ---------- phát sự kiện ----------
  const ITEM_SFX = { magnifier: 'peek', cigarette: 'cig', beer: 'beer', cuffs: 'cuff', saw: 'saw', phone: 'phone', inverter: 'invert', adrenaline: 'adren', medicine: 'pill' };
  const shellName = (s) => (s === 'live' ? 'THẬT' : 'LÉP');

  async function dealItems(batch) {
    banner('NHẬN VẬT PHẨM', 'plain', null, 1.2);
    await Promise.all(batch.map((d, i) => S.wait(i * 0.1).then(() => {
      A.play('deal');
      return S.placeItem(d.player, d.slot, d.item, true);
    })));
  }

  async function playEvents(events) {
    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      switch (e.type) {
        case 'roundStart':
          view.round = e.round; view.maxHp = e.maxHp; view.hp = [e.maxHp, e.maxHp]; view.turn = e.starter;
          view.wins = e.wins.slice(); view.cuffed = [false, false]; view.sawed = false;
          track = { live: 0, blank: 0, uncertain: false };
          renderHud();
          log('— Hiệp ' + e.round + ' —');
          await banner('HIỆP ' + e.round, 'plain', e.maxHp + ' máu mỗi người · ' + nm(e.starter) + ' đi trước', 1.8);
          break;
        case 'load':
          track = { live: e.live, blank: e.blank, uncertain: false };
          renderHud();
          log('Nạp ' + e.live + ' thật, ' + e.blank + ' lép');
          banner(e.live + ' THẬT · ' + e.blank + ' LÉP', 'plain', 'Thứ tự nạp là ngẫu nhiên', 2.6);
          await S.showLoad(e.live, e.blank);
          A.play('pump');
          break;
        case 'deal': {
          const batch = [e];
          while (events[i + 1] && events[i + 1].type === 'deal') batch.push(events[++i]);
          await dealItems(batch);
          break;
        }
        case 'shoot': {
          const selfShot = e.shooter === e.target;
          log(nm(e.shooter) + (selfShot ? ' tự bắn: ' : ' bắn ' + nm(e.target) + ': ') + (e.shell === 'live' ? 'ĐẠN THẬT' : 'đạn lép'));
          A.play(e.shell === 'live' ? 'live' : 'blank');
          const firing = S.gunFire(e.shell, selfShot);
          if (e.shell === 'live') S.hitFigure(e.target);
          track[e.shell] = Math.max(0, track[e.shell] - 1);
          view.sawed = false;
          setHp(e.hp);
          const b = e.shell === 'live'
            ? banner('ĐẠN THẬT', 'live', '-' + e.damage + ' máu' + (e.sawed ? ' (cưa nòng)' : ''), 1.3)
            : banner('ĐẠN LÉP', 'blank', 'Không có gì xảy ra', 1.1);
          await firing;
          await S.gunPump(e.shell);
          await S.gunRest();
          await b;
          break;
        }
        case 'use':
          log(nm(e.player) + ' dùng ' + ITEMS[e.item].name);
          A.play(ITEM_SFX[e.item]);
          banner(ITEMS[e.item].name, 'plain', null, 0.9);
          await S.useItem(e.player, e.slot, e.player);
          break;
        case 'steal':
          log(nm(e.player) + ' lấy ' + ITEMS[e.item].name + ' của ' + nm(e.from));
          A.play(ITEM_SFX[e.item]);
          banner('LẤY: ' + ITEMS[e.item].name, 'warn', 'từ ' + nm(e.from), 0.9);
          await S.useItem(e.from, e.slot, e.player);
          break;
        case 'peek':
          await peekPrivate(e.player, 'VIÊN TRONG NÒNG', shellName(e.shell), e.shell);
          log(nm(e.player) + ' đã nhìn viên đạn');
          break;
        case 'phone':
          if (e.index == null) await peekPrivate(e.player, 'ĐIỆN THOẠI CŨ', 'KHÔNG CÓ\nTHÔNG TIN', 'none');
          else await peekPrivate(e.player, 'ĐIỆN THOẠI CŨ', 'VIÊN THỨ ' + (e.index + 1) + '\n' + shellName(e.shell), e.shell);
          log(nm(e.player) + ' đã gọi điện thoại');
          break;
        case 'heal':
          setHp(e.hp); A.play('heal');
          await banner(e.amount > 0 ? '+' + e.amount + ' MÁU' : 'MÁU ĐÃ ĐẦY', 'good', null, 0.9);
          break;
        case 'eject': {
          track[e.shell] = Math.max(0, track[e.shell] - 1);
          renderHud();
          log('Viên ' + shellName(e.shell) + ' bị nhả ra');
          const b = banner('VIÊN ' + shellName(e.shell), e.shell, 'bị nhả ra khỏi nòng', 1.3);
          await S.gunPump(e.shell);
          await b;
          break;
        }
        case 'cuff':
          view.cuffed[e.target] = true; S.setFigureCuffed(e.target, true); renderHud();
          await banner('CÒNG TAY', 'warn', nm(e.target) + ' sẽ mất lượt kế tiếp', 1.1);
          break;
        case 'saw':
          view.sawed = true; S.setGunSawed(true); renderHud();
          await banner('CƯA NÒNG', 'warn', 'Phát bắn kế tiếp gấp đôi sát thương', 1.1);
          break;
        case 'invert':
          track.uncertain = true; renderHud();
          await banner('ĐẢO CỰC', 'warn', 'Viên hiện tại đã bị đảo', 1.0);
          break;
        case 'medicine':
          setHp(e.hp);
          if (e.outcome === 'heal') { A.play('heal'); await banner('+' + e.amount + ' MÁU', 'good', 'Thuốc quá hạn', 1.1); }
          else { A.play('hurt'); S.flash(0xff2a1a, 0.5, 0.4); S.shake(0.1); await banner('-1 MÁU', 'live', 'Thuốc quá hạn', 1.1); }
          break;
        case 'skip':
          view.cuffed[e.player] = false; S.setFigureCuffed(e.player, false); renderHud();
          A.play('cuff');
          log(nm(e.player) + ' bị còng nên mất lượt');
          await banner('MẤT LƯỢT', 'warn', nm(e.player) + ' đang bị còng', 1.2);
          break;
        case 'turn':
          view.turn = e.player; renderHud();
          if (e.reason === 'extra') await banner('LƯỢT THÊM', 'good', nm(e.player) + ' đi tiếp', 1.0);
          break;
        case 'roundEnd':
          view.wins = e.wins.slice(); renderHud();
          log(nm(e.winner) + ' thắng hiệp ' + e.round);
          S.setFigureDown(e.loser, true);
          S.flash(0xff0000, 0.45, 0.8); S.shake(0.1);
          A.play(e.matchOver ? 'win' : 'lose');
          await banner(nm(e.winner) + ' THẮNG HIỆP', 'good', 'Tỉ số ' + e.wins[0] + ' - ' + e.wins[1], 1.8);
          break;
        default:
          break;
      }
    }
  }

  // ---------- luồng chính ----------
  async function perform(action) {
    if (busy) return;
    setBusy();
    S.clearSlotStates();
    let events = [];
    try {
      events = L.apply(g, action);
      await playEvents(events);
    } catch (err) {
      console.error(err);
    }
    syncItems(); syncView();
    const re = events.find((e) => e.type === 'roundEnd');
    if (g.roundOver) { await finishRound(re); return; }
    try { await handoff(); } catch (err) { console.error(err); }
    sel = null; aim = null;
    enterIdle();
  }

  // Cả hai cùng nhìn một màn hình nên chỉ cần đổi mũi tên báo lượt.
  async function handoff() {
    S.setTurn(g.turn);
    await banner('LƯỢT: ' + nm(g.turn).toUpperCase(), 'plain', null, 0.9);
  }

  async function beginRound() {
    busy = true; mode = 'busy'; $('actions').textContent = '';
    let events = [];
    try {
      events = L.startRound(g);
      await S.fade(1, 0.35);
      S.clearItems(); S.resetFigures(); S.setGunSawed(false);
      S.setTurn(g.turn);
      view.hp = [g.maxHp, g.maxHp]; view.maxHp = g.maxHp; view.round = g.round; view.turn = g.turn; view.wins = g.wins.slice();
      view.cuffed = [false, false]; view.sawed = false;
      renderHud();
      await S.fade(0, 0.5);
      await playEvents(events);
    } catch (err) {
      console.error(err);
    }
    syncItems(); syncView();
    enterIdle();
  }

  function waitClick(ids) {
    return new Promise((resolve) => {
      ids.forEach((id) => { $(id).onclick = () => { ids.forEach((j) => { $(j).onclick = null; }); resolve(id); }; });
    });
  }
  async function finishRound(re) {
    mode = 'busy';
    $('actions').textContent = '';
    await S.wait(0.3);
    $('round-title').textContent = re.matchOver ? nm(re.winner).toUpperCase() + ' CHIẾN THẮNG' : 'HIỆP ' + re.round + ': ' + nm(re.winner).toUpperCase() + ' THẮNG';
    $('round-title').style.color = COLORS[re.winner];
    $('round-sub').textContent = 'Tỉ số ' + re.wins[0] + ' - ' + re.wins[1] + (re.matchOver ? ' · Trận đấu kết thúc' : ' · Cần ' + L.WINS_NEEDED + ' hiệp thắng');
    $('btn-round-next').textContent = re.matchOver ? 'CHƠI LẠI' : 'HIỆP TIẾP THEO';
    show('screen-round');
    const which = await waitClick(['btn-round-next', 'btn-round-menu']);
    hide('screen-round');
    if (which === 'btn-round-menu') { showMenu(); return; }
    if (re.matchOver) startMatch(); else await beginRound();
  }

  function cleanNames(a, b) {
    const f = (s, d) => (String(s || '').replace(/\s+/g, ' ').trim().slice(0, 12) || d);
    let n0 = f(a, DEFAULT_NAMES[0]), n1 = f(b, DEFAULT_NAMES[1]);
    if (n0.toLowerCase() === n1.toLowerCase()) n1 = n1.slice(0, 10) + ' 2';
    return [n0, n1];
  }
  function startMatch() {
    settings.names = cleanNames($('in-name0').value, $('in-name1').value);
    settings.counter = $('in-counter').checked;
    saveSettings();
    A.unlock();
    hide('screen-start'); hide('screen-round'); show('hud');
    logLines = []; $('log').textContent = '';
    g = L.createGame({ names: settings.names });
    beginRound();
  }
  function showMenu() {
    busy = false; mode = 'menu';
    hide('hud'); hide('screen-round'); hide('screen-peek');
    $('in-name0').value = settings.names[0]; $('in-name1').value = settings.names[1];
    $('in-counter').checked = settings.counter;
    S.clearItems(); S.resetFigures(); S.gunRest();
    show('screen-start');
  }

  // ---------- cách chơi ----------
  function buildHelp() {
    const items = L.ITEM_IDS.map((id) => '<li><b>' + ITEMS[id].name + '</b> — ' + ITEMS[id].desc + '</li>').join('');
    $('help-body').innerHTML =
      '<h3>MỤC TIÊU</h3><p>Thắng <b>' + L.WINS_NEEDED + ' trong ' + L.MAX_ROUNDS + ' hiệp</b>. Một hiệp kết thúc khi một người hết máu.</p>' +
      '<h3>KHẨU SÚNG</h3><p>Mỗi lần nạp có từ 2 đến 8 viên, trộn ngẫu nhiên giữa <span class="live">đạn THẬT</span> và <span class="blank">đạn LÉP</span> (luôn có ít nhất một viên mỗi loại). Số lượng được công bố, thứ tự thì không.</p>' +
      '<ul><li>Lấy súng, chọn <b>nhắm đối thủ</b> hoặc <b>nhắm bản thân</b>, rồi bắn.</li>' +
      '<li>Bắn đối thủ: đạn thật làm họ mất 1 máu. Lượt luôn chuyển sang họ.</li>' +
      '<li>Bắn bản thân bằng <span class="blank">đạn lép</span>: bạn <b>được đi tiếp</b>. Bằng <span class="live">đạn thật</span>: mất 1 máu và mất lượt.</li>' +
      '<li>Hết đạn thì nạp lại, và (từ hiệp 2) mỗi người nhận thêm vật phẩm. Tối đa ' + L.MAX_SLOTS + ' vật phẩm.</li></ul>' +
      '<h3>HIỆP</h3><ul><li>Hiệp 1: 2–4 máu, không có vật phẩm.</li><li>Hiệp 2: 3–5 máu, 2 vật phẩm mỗi lần nạp.</li><li>Hiệp 3: 4–6 máu, 4 vật phẩm mỗi lần nạp.</li><li>Người đi trước đổi luân phiên theo hiệp.</li></ul>' +
      '<h3>VẬT PHẨM</h3><p>Chạm vào vật phẩm để xem mô tả, rồi bấm DÙNG. Có thể chạm cả vật phẩm của đối thủ để xem.</p><ul>' + items + '</ul>' +
      '<h3>THÔNG TIN RIÊNG</h3><p>Cả hai cùng nhìn một màn hình. Kính lúp và Điện thoại cũ hiện kết quả trên một màn hình riêng: người dùng <b>nhấn giữ</b> ô để xem, thả ra để ẩn. Người còn lại hãy <b>nhắm mắt</b> trong lúc đó.</p>' +
      '<h3>PHÍM TẮT (máy tính)</h3><ul><li><b>G</b>/<b>Space</b>: lấy súng · <b>1</b>: nhắm đối thủ · <b>2</b>: nhắm bản thân · <b>Enter</b>: bắn · <b>Esc</b>: hủy</li><li><b>M</b>: tắt/bật âm · <b>H</b>: mở/đóng hướng dẫn</li></ul>';
  }

  // ---------- công cụ HUD ----------
  function syncTools() {
    $('t-sound').classList.toggle('off', settings.muted);
    $('t-music').classList.toggle('off', !settings.music);
    $('t-counter').classList.toggle('off', !settings.counter);
  }
  function toggleHelp(force) {
    const open = force != null ? force : $('screen-help').classList.contains('hidden');
    if (open) show('screen-help'); else hide('screen-help');
  }

  // ---------- khởi động ----------
  function init() {
    buildHelp();
    $('in-name0').value = settings.names[0]; $('in-name1').value = settings.names[1];
    $('in-counter').checked = settings.counter;
    A.setMuted(settings.muted); A.setMusic(settings.music);
    syncTools();

    started = S.init($('stage'));
    if (!started) { hide('screen-start'); show('screen-nogl'); return; }
    S.onPick(onPick);

    $('btn-start').onclick = startMatch;
    $('btn-help0').onclick = () => toggleHelp(true);
    $('btn-help-close').onclick = () => toggleHelp(false);
    $('t-help').onclick = () => toggleHelp(true);
    $('t-sound').onclick = () => { settings.muted = !settings.muted; A.unlock(); A.setMuted(settings.muted); saveSettings(); syncTools(); };
    $('t-music').onclick = () => { settings.music = !settings.music; A.unlock(); A.setMusic(settings.music); saveSettings(); syncTools(); };
    $('t-counter').onclick = () => { settings.counter = !settings.counter; saveSettings(); syncTools(); if (g) renderCounter(); };

    window.addEventListener('keydown', (ev) => {
      if (ev.target && ev.target.tagName === 'INPUT' && ev.target.type === 'text') return;
      const k = ev.key.toLowerCase();
      if (k === 'm') { $('t-sound').click(); return; }
      if (k === 'h' || (k === 'escape' && !$('screen-help').classList.contains('hidden'))) { toggleHelp(); return; }
      if (!g || busy) return;
      if (mode === 'idle' && (k === 'g' || k === ' ')) { ev.preventDefault(); takeGun(); }
      else if (mode === 'gun') {
        if (k === '1') setAim('opp'); else if (k === '2') setAim('self');
        else if (k === 'enter' || k === ' ') { ev.preventDefault(); fire(); }
        else if (k === 'escape') putDown();
      } else if ((mode === 'item' || mode === 'steal') && k === 'escape') cancelSelection();
    });
    document.addEventListener('gesturestart', (e) => e.preventDefault());
    document.addEventListener('contextmenu', (e) => { if (e.target.id === 'stage') e.preventDefault(); });
    showMenu();
  }

  // Giao diện kiểm thử (dùng bởi tests/e2e): chỉ đọc trạng thái và mô phỏng thao tác chạm.
  window.__SR = {
    state: () => ({ mode, busy, aim, started, round: g && g.round, turn: g && g.turn, hp: g && g.hp.slice(), roundOver: g && g.roundOver, matchOver: g && g.matchOver, wins: g && g.wins.slice(), chamber: g && g.chamber.length, items: g && g.items.map((r) => r.slice()), cuffed: g && g.cuffed.slice() }),
    game: () => g,
    pick: onPick,
    perform,
    scene: S,
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
