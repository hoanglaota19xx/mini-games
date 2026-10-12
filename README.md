# SHELL ROULETTE

Trò chơi sinh tồn 2 người chơi, **cùng nhìn một màn hình** (điện thoại hoặc máy tính).
Một khẩu shotgun, đạn thật và đạn lép trộn ngẫu nhiên, và một bàn đầy vật phẩm.

- Cơ chế lấy cảm hứng từ dòng game "roulette shotgun". Chỉ tham khảo **cách chơi**.
- **Toàn bộ mô hình 3D, texture, nhân vật và âm thanh đều do code tạo ra** (Three.js + WebGL + WebAudio).
  Không có file ảnh hay âm thanh nào trong repo, nên không dính tài nguyên có bản quyền của game khác.
- Không cần build, không cần server riêng.

## Chạy thử

Mở thẳng `index.html` bằng trình duyệt, hoặc chạy server tĩnh:

```bash
python3 -m http.server 8080      # rồi mở http://localhost:8080
```

## Đưa lên GitHub Pages

1. Tạo repo mới, đẩy toàn bộ thư mục này lên nhánh `main`.
2. Vào **Settings → Pages → Build and deployment → Source: Deploy from a branch**.
3. Chọn nhánh `main`, thư mục `/ (root)`, bấm Save.
4. Sau 1–2 phút, game chạy tại `https://<tên-bạn>.github.io/<tên-repo>/`.

Mọi đường dẫn đều là đường dẫn tương đối nên chạy được cả khi repo nằm trong thư mục con.
Three.js đã được đóng gói trong `vendor/` nên game không phụ thuộc CDN và vẫn chạy khi mạng yếu.

## Cách chơi (tóm tắt)

- Thắng **2 trong 3 hiệp**. Hiệp kết thúc khi một người hết máu.
- Mỗi lần nạp có 2–8 viên (ít nhất 1 thật, 1 lép). Số lượng được công bố, thứ tự thì không.
- Bắn đối thủ: lượt luôn chuyển. Tự bắn đạn lép: được đi tiếp. Tự bắn đạn thật: mất máu và mất lượt.
- Hiệp 1 không có vật phẩm. Hiệp 2 mỗi lần nạp chia 2 vật phẩm, hiệp 3 chia 4 (mỗi người tối đa 8).
- Kính lúp và Điện thoại cũ hiện thông tin trên màn hình riêng: người dùng nhấn giữ để xem,
  **người còn lại nhắm mắt**.
- Phím tắt (máy tính): `G`/`Space` lấy súng · `1` nhắm đối thủ · `2` nhắm bản thân · `Enter` bắn ·
  `Esc` hủy · `M` tắt/bật âm · `H` hướng dẫn.

Chi tiết từng vật phẩm có trong nút **CÁCH CHƠI** của game.

## Cấu trúc

```
index.html          khung trang, HUD, các màn hình phủ
css/style.css       giao diện (HUD, nút, responsive điện thoại / máy tính)
js/logic.js         luật chơi thuần, không đụng DOM. Chạy được cả trong Node để test
js/scene.js         cảnh 3D, hoạt ảnh, bộ lọc low-res + dither + CRT, chọn đối tượng
js/audio.js         âm thanh tổng hợp bằng WebAudio
js/ui.js            điều khiển ván chơi: nối logic với hoạt ảnh, HUD, màn hình phủ
vendor/             three.min.js r128 (MIT)
tests/              kiểm thử (xem bên dưới)
```

Luồng dữ liệu: `logic.js` thực hiện hành động và trả về **danh sách sự kiện**; `ui.js` phát lại các sự kiện
đó thành hoạt ảnh. Vì vậy luật chơi và đồ họa tách bạch, thêm vật phẩm mới chỉ cần sửa `logic.js` (luật),
`scene.js` (mô hình) và một dòng trong bảng hiệu ứng của `ui.js`.

## Kiểm thử

```bash
node --test tests/logic.test.js        # 27 test luật chơi, gồm mô phỏng 3000 trận ngẫu nhiên
pip install playwright && playwright install chromium
python3 tests/e2e_playwright.py 4      # chơi 4 trận bằng thao tác thật trên giao diện
```

Bài e2e đối chiếu HUD và cảnh 3D với trạng thái logic sau mỗi hành động, kiểm tra không bị kẹt
và không có lỗi console.

## Giới hạn đã biết

- Cần trình duyệt có WebGL. Nếu không có, game báo lỗi thay vì chạy sai.
- Chỉ chơi chung một thiết bị (hotseat). Chơi online cần thêm đồng bộ qua mạng (chưa có).
- Chưa chọn license cho mã nguồn. Hãy thêm file `LICENSE` theo ý bạn. Three.js giữ nguyên giấy phép MIT riêng.
