"""
Kiểm thử đầu-cuối: điều khiển giao diện thật (bấm nút, chạm vật phẩm) qua nhiều trận liên tiếp
và đối chiếu HUD / cảnh 3D với trạng thái logic sau MỖI hành động.

Chạy:  pip install playwright && playwright install chromium
       python tests/e2e_playwright.py [số_trận=4] [rộng=640] [cao=360] [seed=1]
"""
import os, random, sys, time
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
URL = "file://" + os.path.join(ROOT, "index.html")
ARGS = ["--use-angle=swiftshader", "--use-gl=angle", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"]

MATCHES = int(sys.argv[1]) if len(sys.argv) > 1 else 4
W = int(sys.argv[2]) if len(sys.argv) > 2 else 640
H = int(sys.argv[3]) if len(sys.argv) > 3 else 360
SEED = int(sys.argv[4]) if len(sys.argv) > 4 else 1
rnd = random.Random(SEED)

problems, stats = [], {"actions": 0, "matches": 0, "rounds": 0, "peeks": 0, "steals": 0, "items": {}}


def visible(pg, sel):
    return pg.evaluate("(s)=>{const e=document.querySelector(s);return !!e && !e.classList.contains('hidden')}", sel)


def state(pg):
    return pg.evaluate("window.__SR.state()")


def check_consistency(pg, where):
    """HUD và cảnh 3D phải khớp trạng thái logic khi game đang chờ thao tác."""
    r = pg.evaluate("""()=>{
      const st = __SR.state(), g = __SR.game(), S = __SR.scene, out = [];
      for (let p = 0; p < 2; p++) {
        const on = document.querySelectorAll('#pl' + p + ' .cell.on').length;
        const tot = document.querySelectorAll('#pl' + p + ' .cell').length;
        if (on !== g.hp[p]) out.push('HUD hp P' + p + ': hiện ' + on + ' nhưng logic ' + g.hp[p]);
        if (tot !== g.maxHp) out.push('HUD số ô máu P' + p + ': ' + tot + ' vs ' + g.maxHp);
        for (let s = 0; s < 8; s++) {
          const want = g.items[p][s] || null, have = S.itemAt(p, s);
          if (want !== have) out.push('3D item P' + p + ' ô ' + s + ': logic=' + want + ' cảnh=' + have);
        }
      }
      const tags = [...document.querySelectorAll('.tag')].filter(t => t.textContent === 'BỊ CÒNG').length;
      const cuffedCount = g.cuffed.filter(Boolean).length;
      if (tags !== cuffedCount) out.push('HUD thẻ BỊ CÒNG: ' + tags + ' vs logic ' + cuffedCount);
      return out;
    }""")
    for m in r:
        problems.append(f"[{where}] {m}")


def do_peek(pg):
    """Màn hình xem riêng: nhấn giữ -> kết quả hiện, thả -> ẩn, bấm XONG."""
    box = pg.locator("#peek-box")
    bb = box.bounding_box()
    pg.mouse.move(bb["x"] + bb["width"] / 2, bb["y"] + bb["height"] / 2)
    pg.mouse.down()
    revealed = pg.evaluate("document.getElementById('peek-box').classList.contains('reveal')")
    pg.mouse.up()
    hidden = not pg.evaluate("document.getElementById('peek-box').classList.contains('reveal')")
    if not revealed:
        problems.append("peek: giữ chuột mà không hiện kết quả")
    if not hidden:
        problems.append("peek: thả chuột mà kết quả vẫn hiện")
    pg.click("#btn-peek-done")
    stats["peeks"] += 1


def wait_ready(pg, timeout=90000):
    """Chờ tới khi: sẵn sàng thao tác, hoặc có màn hình peek / hết hiệp."""
    pg.wait_for_function(
        """()=>{
          const st = __SR.state();
          const vis = (id)=>{const e=document.getElementById(id);return e && !e.classList.contains('hidden')};
          return (st.mode==='idle' && !st.busy) || vis('screen-peek') || vis('screen-round');
        }""", timeout=timeout)


def take_turn(pg):
    st = state(pg)
    turn = st["turn"]
    items = st["items"][turn]
    usable = [i for i, it in enumerate(items) if it]
    if usable and rnd.random() < 0.55:
        slot = rnd.choice(usable)
        item = items[slot]
        pg.evaluate("(a)=>__SR.pick({kind:'item',player:a[0],slot:a[1]})", [turn, slot])
        pg.wait_for_selector("#actions .panel")
        dis = pg.evaluate("document.getElementById('btn-use').disabled")
        can = pg.evaluate("(s)=>SRLogic.canUseSlot(__SR.game(), s)", slot)
        if dis == can:
            problems.append(f"nút DÙNG không khớp canUseSlot cho {item} (disabled={dis}, can={can})")
        if dis:
            pg.click("#btn-cancel")
            return
        stats["items"][item] = stats["items"].get(item, 0) + 1
        pg.click("#btn-use")
        if item == "adrenaline":
            pg.wait_for_function("__SR.state().mode==='steal'")
            targets = pg.evaluate("SRLogic.stealable(__SR.game(), __SR.game().turn)")
            if not targets:
                problems.append("adrenaline vào chế độ steal nhưng không có mục tiêu")
                pg.click("#btn-cancel")
                return
            # chạm vào ô KHÔNG hợp lệ trước: không được thực hiện hành động nào
            bad = pg.evaluate("(t)=>{const g=__SR.game();const o=1-g.turn;return g.items[o].map((it,i)=>i).filter(i=>!t.includes(i))}", targets)
            if bad:
                pg.evaluate("(a)=>__SR.pick({kind:'item',player:a[0],slot:a[1]})", [1 - turn, rnd.choice(bad)])
                pg.wait_for_timeout(150)
                if state(pg)["mode"] != "steal":
                    problems.append("chạm ô không hợp lệ khi steal lại làm đổi chế độ")
            pg.evaluate("(a)=>__SR.pick({kind:'item',player:a[0],slot:a[1]})", [1 - turn, rnd.choice(targets)])
            stats["steals"] += 1
        return
    # lấy súng
    pg.click("#btn-gun")
    pg.wait_for_function("__SR.state().mode==='gun' && !__SR.state().busy")
    which = rnd.choice(["opp", "self"])
    pg.click("#btn-aim-opp" if which == "opp" else "#btn-aim-self")
    pg.wait_for_function("(w)=>__SR.state().aim===w && !__SR.state().busy", arg=which)
    if rnd.random() < 0.2:  # đổi ý rồi đặt súng xuống
        pg.click("#btn-putdown")
        pg.wait_for_function("__SR.state().mode==='idle' && !__SR.state().busy")
        return
    pg.click("#btn-fire")


def main():
    t0 = time.time()
    with sync_playwright() as p:
        b = p.chromium.launch(args=ARGS)
        pg = b.new_page(viewport={"width": W, "height": H})
        pg.on("console", lambda m: problems.append("console." + m.type + ": " + m.text) if m.type in ("error", "warning") else None)
        pg.on("pageerror", lambda e: problems.append("PAGEERROR: " + str(e)))
        pg.goto(URL)
        pg.wait_for_function("window.__SR && __SR.state().started")
        pg.evaluate("__SR.scene.setSpeed(80)")
        pg.fill("#in-name0", "An")
        pg.fill("#in-name1", "Bình")
        pg.click("#btn-start")
        guard = 0
        while stats["matches"] < MATCHES:
            guard += 1
            if guard > 4000:
                problems.append("vòng lặp kiểm thử quá dài (có thể bị kẹt)")
                break
            try:
                wait_ready(pg)
            except Exception as e:  # noqa: BLE001
                problems.append("KẸT: không sẵn sàng sau 90s. state=" + str(state(pg)))
                pg.screenshot(path="/tmp/e2e_stuck.png")
                break
            if visible(pg, "#screen-peek"):
                do_peek(pg)
                continue
            if visible(pg, "#screen-round"):
                st = state(pg)
                stats["rounds"] += 1
                if st["matchOver"]:
                    stats["matches"] += 1
                    if stats["matches"] >= MATCHES:
                        break
                    pg.click("#btn-round-next")      # CHƠI LẠI
                else:
                    pg.click("#btn-round-next")      # hiệp tiếp theo
                continue
            check_consistency(pg, f"trước hành động #{stats['actions']}")
            take_turn(pg)
            stats["actions"] += 1
            if len(problems) > 30:
                break
        b.close()
    dt = time.time() - t0
    print(f"Trận: {stats['matches']} | hiệp: {stats['rounds']} | hành động: {stats['actions']} | peek: {stats['peeks']} | adrenaline: {stats['steals']} | {dt:.0f}s")
    print("Vật phẩm đã dùng:", dict(sorted(stats["items"].items())))
    if problems:
        print("PHÁT HIỆN %d VẤN ĐỀ:" % len(problems))
        for x in problems[:30]:
            print(" -", x)
        sys.exit(1)
    print("KHÔNG CÓ VẤN ĐỀ")


if __name__ == "__main__":
    main()
