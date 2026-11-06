# Mash ∞ Loop

Bài hay thường hết quá sớm. Cái này sửa lỗi đó.

**Nghe thử:** https://mashloop.truclv.com

- [x] **15/10** Bản đầu: lặp vô hạn, nối bài khớp nhịp, màu theo mood, bản web cho nhiều người.
- [x] **16/10** Key lock, tách giọng, 9 kho có sẵn, thêm các kiểu chuyển bài (mashup, double drop, build-up…), bấm vòng để tua.
- [x] **17/10** Chế độ "Như một set DJ", vòng ∞ mới lúc chờ.
- [x] **18/10** Tab Tạo mashup (2–5 bài thành một bài mới, nền lấy từ đoạn thuần nhạc, ba tốc độ), rồi tạm ẩn vì chất lượng chưa đạt; tách giọng bằng BS-RoFormer.
- [x] **21/10** Hàng chờ tải cho cả app (từng bài một, nghỉ 5–10 giây, tối đa 480p), ai cũng thấy, huỷ được bài của mình; tải YouTube bằng cookies; thư viện lưu trong trình duyệt, lần sau mở lại vẫn còn, đếm ngược 12 giờ giữ nhạc; trang quản trị /admin.
- [x] **22/10–04/11** Chống lạm dụng: phải mở trang mới mở được phiên nghe, tự chặn 24 giờ ở app lẫn HAProxy, chặn nhúng trang và trình duyệt tự động, nhật ký truy cập; chuẩn bị để Google tìm thấy; dời sang server mới.
- [x] **07/11** Banner quảng cáo và mã QR mời cà phê.

Mash ∞ Loop nghe kỹ từng beat của bài hát rồi phát mãi không dứt. Trong một bài, nó
nhảy qua lại giữa những đoạn giống nhau đến mức bạn không biết mình đang ở lần lặp
thứ mấy. Phần ăn tiền là ở **giữa các bài**: khi đã ở đủ lâu, nó tìm chỗ nối sang bài
khác, khớp nhịp, nắn tempo, giữ mood, rồi mix sang như một DJ không biết mỏi tay.

![Hai vòng của dấu ∞: bài đang phát bên trái, bài kế tiếp bên phải, chạm nhau ở điểm mix](web/img/og.png)

Mỗi bài là một vòng của dấu ∞, mang màu của mood bài đó. Chỗ hai vòng chạm nhau là
chỗ mix, và ánh sáng đi qua điểm giao để chạy sang vòng của bài sau. Tên app, logo
và màn hình chính là cùng một hình vẽ, chuyện này có chủ ý.

## Nó làm gì

- **Mash cả thư viện thành một chuỗi.** Không chỉ lặp trong một bài như
  [Infinite Jukebox](https://musicmachinery.com/2012/11/12/the-infinite-jukebox/) ngày
  xưa: ở mỗi bài một lúc, rồi đi tới điểm nối tốt gần nhất sang bài khác.
- **Mười ba kiểu nối bài và mười cách blend**, từ nối thẳng không lộ tới mashup
  kiểu DJ (bảng bên dưới). Bật tắt từng kiểu trong *Tinh chỉnh*.
- **Nắn tempo mà giữ tông (key lock).** Lệch tới 8 % vẫn blend được, kể cả nhịp đôi
  70 ↔ 140, và giọng ca sĩ không bị bổng hay trầm đi. Lệch xa hơn (tới 18 %) thì bài
  trước kéo tempo dần về phía bài sau. Hai bài lệch tông thì bài sau được dịch tới hai
  nửa cung cho hợp, rồi trượt dần về tông gốc.
- **Nối vào đúng đoạn:** ra ở cuối câu nhạc, vào đầu điệp khúc hay chỗ drop của bài
  sau, không chỉ vào đầu bài.
- **Chọn tiêu chí cho bài kế tiếp:** cân bằng, cùng mood, cùng nhịp, hợp tông (vòng
  Camelot của DJ), như một set DJ (khởi động, lên dần tới đỉnh, cứ vài bài lại có
  một khoảng nghỉ rồi lên lại), hoặc tự do. Tiêu chí nào cũng nhìn trước một bước:
  không chọn bài mà từ đó chỉ còn cách crossfade đi tiếp.
- **Biết ai đang hát:** không nhảy từ giọng nam sang giọng nữ giữa câu, không cắt
  ngang một câu hát, không để hai giọng hát chồng nhau. Có stem giọng hát riêng nên
  blend được chỉ phần nhạc, hoặc để giọng bài sau hát trên nền bài trước.
- **Mỗi bài một màu theo mood**, cả căn phòng đổi màu theo bài đang phát và chuyển
  dần sang màu bài sau trong lúc mix. Có quầng phổ âm thanh quanh vòng đang phát.
  Thích yên tĩnh thì chọn Neon hoặc Hổ phách trong *Tinh chỉnh*.
- **Nhiều nguồn:** link YouTube (cả playlist), SoundCloud, Bandcamp, Zing MP3,
  Mixcloud; gõ tên bài để tìm trên YouTube; hoặc thả file nhạc, cả nguyên file zip.
- **Hàng chờ tải:** server tải từng bài một cho cả app, nghỉ ngẫu nhiên 5–10 giây
  giữa hai bài để các trang nhạc không chặn, chỉ lấy âm thanh (không có thì video tối
  đa 480p). Ai mở trang cũng thấy hàng chờ: bài của mình có tên, thứ tự, thời gian
  chờ và nút *Huỷ*; bài của người khác chỉ hiện là đang chờ.
- **Tạo mashup** (tab riêng, đang tắt trên web, xem *Dựng cho nhiều người*): chọn 2–5
  bài, server kéo tất cả về một tempo, một tông
  (Rubber Band, giữ âm sắc giọng; độ nắn và độ dịch được chia đều cho các bài), rồi tự
  sắp xếp như một người làm mashup: ai hát trên nhạc ai (đo nốt giọng hát với hợp âm
  của nền, và groove giọng vốn hát với groove của nền), thứ tự lên dần, giọng vào đúng
  đầu câu và ra đúng cuối câu. Nhạc nền lấy từ những đoạn thuần nhạc của bài gốc (vòng
  4 hoặc 8 ô nhịp không có giọng, chọn chỗ nối vòng liền và chừa chỗ cho giọng), không
  tách từ chỗ có giọng; bài hát kín từ đầu đến cuối thì nền dựng lại từ trống và bass
  tách riêng, phần còn lại lọc mạnh chỗ giọng. Giữa hai giọng luôn có vài giây chỉ
  có nhạc (giọng trước vọng lại rồi tắt, hai nền đan nhau), không đổi giọng gấp. Một
  bài có intro hé lộ hook, các màn đảo vai, drop, breakdown a cappella, cao trào hai
  giọng, outro; giữa các màn là các kiểu chuyển của DJ (blend đổi bass, mash, build-up,
  echo, reverb wash, cuộn nhịp, gate…). Ba tốc độ: Tự nhiên, Nhanh (mặc định: tempo đẩy
  lên, vào điệp khúc sớm, kết gọn), Rất nhanh (điệp khúc nối điệp khúc). Mỗi lần có
  nhiều phương án, nút "Phương án khác" để nghe cách ghép khác. Bảy không khí (club,
  chill, slowed + reverb, speed up, mộc…). Giọng được tách bằng BS-RoFormer. Bài giữ 48
  giờ, chỉ nghe trên trang (không cho tải), nghe thẳng hoặc phát lặp mãi kiểu Mash ∞ Loop.

## Các kiểu nối bài

| Kiểu | Khi nào | Nghe ra sao |
|---|---|---|
| Nối thẳng | Hai đoạn nghe gần như y hệt nhau | Không nhận ra là đã đổi bài |
| Drop | Cùng groove, cùng cường độ, cùng mood | Bài mới vào đúng phách đầu câu nhạc |
| Blend | Nhịp khớp được (lệch tới 8 %, kể cả nhịp đôi 70 ↔ 140) | Mix kiểu DJ, khóa nhịp từng beat, 2 đến 32 ô nhịp |
| Crossfade dài | Hai bài khác mood | 5 đến 11 giây, lọc âm: bài cũ tối dần, bài mới sáng dần |
| Echo | Cuối một câu hát | Bài cũ tan thành tiếng vọng của chính nó |
| Wash | Cuối một đoạn | Bài cũ chìm vào reverb, bài mới bước ra từ đó |
| Build-up | Vào một đoạn drop hay điệp khúc | Bài cũ mỏng dần dưới tiếng gió dâng lên, bài mới nổ vào cùng một cú impact |
| Flanger | Cuối một câu | Bài cũ quét tiếng phản lực rồi đi |
| Ngắt lặng | Bài cũ đang to, bài mới vào mạnh | Im đúng một nhịp, rồi bài mới vào trên phách mạnh |
| Phanh đĩa, cuộn nhịp, spinback, gate | Khi bạn muốn | Đột ngột. Tắt sẵn, bật trong *Tinh chỉnh* nếu thích kịch tính |

Mười cách blend: dài, đổi EQ (bass, mid, treble lần lượt), ngắn, quét filter, đổi chỗ
ở drop, trao giọng (tách giọng), acapella (giọng bài sau hát trên nền bài trước, nhạc
bài sau lên dần bên dưới), mashup (như acapella nhưng trọn 16–32 ô nhịp), double drop
(hai đoạn drop nổ cùng lúc),
và vòng lặp (lặp vài ô nhịp bài trước làm outro cho những bài không có outro).

Khi hai bài lệch tempo, bài sau vào đúng tốc độ bài trước rồi trượt dần về tốc độ
gốc, giữ nguyên tông nhờ time-stretch. Hai bài lệch tông hẳn thì không blend, hai bộ
trống chưa khớp nhịp thì không crossfade chồng lên nhau.

## Dùng bản trên web

Mở https://mashloop.truclv.com. Lần đầu là một thư viện trống của riêng bạn. Thư viện
được lưu trong trình duyệt (server không có tài khoản hay hồ sơ nào của bạn), nên lần sau mở lại vẫn còn;
bỏ chọn *Lưu thư viện trên máy này* nếu không muốn. Nhạc trên server giữ 12 giờ sau
lần cuối có người nghe, trang đếm ngược thời gian đó. Quá hạn thì bài từ link tự tải
lại khi bạn mở lại (phần phân tích vẫn còn nên nhanh), bài tải lên thì phải tải file
lên lại. Chưa biết thêm gì thì mở một trong 9 kho có sẵn: Pass The Aux (làm
bằng Suno), Pop, Rock, Hip-hop, Electro & Dance, Chill & Lofi, Acoustic, Remix
ccMixter, Kevin MacLeod. Tám kho sau là nhạc Creative Commons từ Jamendo, ccMixter và
Incompetech, có ghi tên tác giả. Nghe hết một kho thì nó tự nối sang kho kế, hoặc
bấm *Kho khác*.

- Mỗi thư viện tối đa 10 bài tự thêm. Bài người khác đã thêm trước đó thì vào ngay,
  không phải chờ phân tích; bài mới mất chừng 20 giây.
- File âm thanh không ai nghe trong 12 giờ thì tự xoá. Trang không lưu dữ liệu cá
  nhân nào ngoài nhật ký truy cập để chống lạm dụng (IP, trình duyệt; giữ 7 ngày). Đây
  là dự án vui; một banner quảng cáo và mã QR mời cà phê dưới bộ nút phát giúp trả tiền server.
- Bấm lên vòng để phát từ đoạn đó (vào ngay ở nhịp kế tiếp, không lệch nhịp). Rê
  chuột lên một chấm bên ngoài vòng để xem nó dẫn tới bài nào, bấm để tự chọn điểm
  chuyển. `Space` phát / dừng, `J` nhảy ngay, `N` sang bài khác.

## Chạy trên máy mình

Đã chạy trên Windows 11 với Python 3.13 và một card NVIDIA. Không có GPU vẫn chạy
được, chỉ là mỗi bài phân tích lâu hơn.

Cần sẵn: Python 3.11 trở lên, [ffmpeg](https://ffmpeg.org/) trong `PATH`, và
[Node.js](https://nodejs.org/) 20+ (yt-dlp dùng nó để giải mã trình phát của YouTube).

```powershell
python -m venv .venv
.venv\Scripts\pip install torch==2.6.0 torchaudio==2.6.0 --index-url https://download.pytorch.org/whl/cu124
.venv\Scripts\pip install --no-deps beat-this demucs
.venv\Scripts\pip install -r requirements.txt
.\run.ps1          # mở http://127.0.0.1:8765, tự tắt server cũ nếu còn chạy
```

Lần phân tích đầu tiên sẽ tải model Beat This! và Demucs (khoảng 160 MB). Chạy trên
máy mình thì là bản cá nhân: một thư viện, giữ lại giữa các lần mở, không giới hạn
số bài. Chưa thử trên macOS hay Linux; lệnh tương đương là
`python -m loopbox.server --open`.

Dòng lệnh, nếu bạn thích:

```powershell
.venv\Scripts\python -m loopbox.cli add "Daft Punk Get Lucky audio" "https://www.youtube.com/playlist?list=..."
.venv\Scripts\python -m loopbox.cli list
.venv\Scripts\python -m loopbox.cli rejump     # tính lại điểm nhảy từ dữ liệu đã lưu
.venv\Scripts\python -m loopbox.cli relink     # tính lại điểm nối giữa các bài
```

## Dựng cho nhiều người

Đặt `MASHLOOP_MULTIUSER=1` là thành bản cho nhiều người: mỗi lượt truy cập một thư
viện riêng, bài hát và điểm nối giữa từng cặp bài là kho chung trên server.
`deploy/` có đủ thứ để dựng trên một máy Ubuntu có GPU:

- `pack.py` đóng gói code, `setup.sh` cài venv, deno và service systemd (app chỉ
  nghe trên `127.0.0.1`).
- `haproxy.cfg` và `haproxy-setup.sh`: HAProxy đứng trước, TLS bằng Let's Encrypt tự
  gia hạn.
- `seed_samples.py`: biến một file zip nhạc thành thư viện mẫu. `seed_cc.py`: dựng
  các kho nhạc Creative Commons từ Jamendo, ccMixter và Incompetech.
- `mashloop.service`: số bài phân tích song song, giới hạn mỗi thư viện, dung lượng
  kho nhạc, tất cả là biến môi trường.

YouTube hay chặn IP của server ("Sign in to confirm you're not a bot"). Đặt cookies
của một trình duyệt đã đăng nhập (định dạng Netscape, nên dùng tài khoản phụ) ở
`secrets/youtube-cookies.txt` cạnh code, hoặc chỉ đường bằng `MASHLOOP_COOKIES`.
`setup.sh` giữ thư mục `secrets/` qua mỗi lần cập nhật, git và `pack.py` bỏ qua nó.
Mỗi lần gọi yt-dlp làm việc trên một bản sao. Sau một lượt tải xong, bản yt-dlp gia
hạn được ghi lại, nhưng chỉ khi vẫn còn đủ các cookies đăng nhập; bản đầu tiên được
giữ ở `youtube-cookies.txt.orig`. Nhịp tải và chất lượng chỉnh bằng
`MASHLOOP_DOWNLOAD_PAUSE_S` (mặc định `5,10`) và `MASHLOOP_MAX_VIDEO_HEIGHT` (`480`).

**Trang quản trị** ở `/admin` (không có link nào dẫn tới). Trang hiện:
- người đang mở trang và đang nghe, theo thời gian thực;
- lượt vào và số khách theo ngày, phân bố theo giờ, thời lượng mỗi lượt vào, thời gian nghe;
- kho nhạc của mọi người (lọc, sắp xếp, thử lại bài lỗi, xoá bài không ai giữ);
- các thư viện đang mở, bài nghe nhiều nhất;
- hàng chờ tải, tình trạng YouTube và cookies (kèm ô dán cookies mới);
- quảng cáo: thêm banner, tạm dừng, đổi độ ưu tiên, sửa link, xoá, xem lượt thấy và click;
- GPU, ổ đĩa và các hàng việc.

**Quảng cáo và mời cà phê** (chỉ bản trên web). Dưới bộ nút phát có một banner tỉ lệ 6:1 và nút *Mời cà phê* mở mã QR chuyển khoản (VietQR), kèm số tài khoản để sao chép trên điện thoại. Banner do admin thêm ở `/admin`; nhiều banner thì mỗi cái 8 giây, độ ưu tiên càng cao càng hay hiện. Banner đứng yên khi rê chuột hay focus vào, khi nằm ngoài màn hình, khi tab bị ẩn, và với người chọn giảm chuyển động. Chỗ của dải này được giữ từ lần vẽ đầu tiên, nên bộ nút phát không bị xô khi banner tải xong.
- Lưu trong `data/ads/` (`ads.json` và một ảnh mỗi banner). Ảnh không bao giờ đổi, nên được phục vụ kèm cache vĩnh viễn, `nosniff`, và không cho trang khác nhúng.
- Trình duyệt của admin thu ảnh về rộng tối đa 1600 px và nén sang WebP trước khi gửi (server không có thư viện ảnh). Server chỉ đọc loại và kích thước ảnh từ phần đầu file, và chỉ nhận PNG, JPEG, WebP nguyên vẹn, tỉ lệ từ 4,5:1 tới 8:1, link `https`.
- Chỉ đếm hai thứ: lượt thấy (nửa banner nằm trên màn hình một giây, mỗi client một lần một giờ) và click qua `/go/<id>` (mỗi client một lần trong 10 phút). Chỉ đếm khi chính trang gửi (Fetch Metadata, hoặc Origin/Referer với Safari cũ), không đếm bot tìm kiếm. `/go/` có `noindex` và bị chặn trong `robots.txt`.
- Banner mẫu nằm ở `deploy/ads/` (`ads.json` cùng ảnh). `setup.sh` thêm mỗi banner một lần (`python -m loopbox.ads seed deploy/ads`). Banner đã bị admin xoá thì không bị thêm lại.

Tài khoản đặt trên server bằng `python -m loopbox.adminauth`. Lệnh hỏi tên và mật khẩu, rồi chỉ lưu mã băm scrypt vào `secrets/admin.json`. Chưa có file này thì `/admin` là 404. Đổi mật khẩu thì mọi phiên đăng nhập cũ hết hiệu lực ngay.

Đăng nhập được bảo vệ như sau:
- cookie `HttpOnly`/`Secure`/`SameSite=Strict`, chỉ gửi cho `/api/admin`;
- mỗi lần sai trả lời chậm 1 giây, 5 lần sai thì địa chỉ đó phải chờ 15 phút, sai quá nhiều từ mọi nơi thì khoá chung 30 phút;
- trang không bị cache, không bị index, không nhúng được vào iframe, có CSP chặt.

Số liệu của app không giữ gì nhận ra người nghe. Khách mỗi ngày được đếm bằng mã băm địa chỉ với một muối chỉ sống trong ngày; sang ngày mới, muối và mã băm bị bỏ, chỉ còn con số (`data/stats/`).

Từ 24/10/2026, HAProxy ghi nhật ký truy cập của Mash ∞ Loop để chống lạm dụng; request của các site khác trên box không bị ghi. Mỗi dòng gồm IP, giờ, request, mã trả về, số byte, user-agent và `Sec-Fetch-Site`; từ 29/10 có thêm `Sec-Fetch-Dest` và `Referer` (bỏ phần query, vì đó là mã theo dõi lượt bấm như `fbclid`), để thấy ai nhúng trang và link của site nào dẫn người tới. Log nằm ở `/var/log/haproxy.log` (`syslog:adm`, `0640`), xoay vòng hằng ngày và giữ 7 ngày. Trang web và hộp xác nhận nói rõ điều này với người dùng. Phân tích log: `python3 deploy/access_report.py /var/log/haproxy.log`.

Mục **Nghi vấn** trên trang admin tìm những client hành xử như chương trình, theo các dấu hiệu sau:
- mở phiên rồi bỏ ngay;
- chạm giới hạn tần suất liên tục (ghi rõ giới hạn nào: thêm bài, mở trang, tìm kiếm);
- dồn quá 120 request một phút mà không phải từ trang web;
- user-agent của bot hay script;
- dò đường dẫn lạ;
- đăng nhập admin sai;
- lấy âm thanh của từ 15 bài khách thêm (không tính kho mẫu) mà mỗi bài phát chưa tới 30 giây, tức là lấy nhạc chứ không nghe;
- phát liền từ 6 giờ trở lên (có thể là phát lại cho một kênh khác, cũng có thể là người để nhạc chạy cả ngày).

Hai dấu hiệu cuối chỉ để admin xem, không bao giờ tự chặn. Mục **Tất cả khách** liệt kê mọi client trong 24 giờ: số request, số request do trang web gửi, đỉnh request trong một phút, số phiên, số bài thêm, số bài đã lấy âm thanh, thời gian phát và đoạn phát liền dài nhất. Mục này chỉ hiện IP với client nghi vấn.

Mọi client chỉ được đếm theo mã băm có khoá (`secrets/guard.key`), trong bộ nhớ, trong 24 giờ. Chỉ client bị nghi mới được giữ IP, và chỉ trong bộ nhớ. Từ đó admin có thể:
- **chặn** theo client (lưu mã băm), theo user-agent (một đoạn chữ) hoặc theo IP và dải IP (lưu đúng như admin nhập), lưu ở `data/blocklist.json`. Request bị chặn nhận 403;
- đánh dấu **tin cậy** một IP hay một dải IP: địa chỉ đó không bao giờ bị nghi hay bị chặn.

Chính server (loopback) và IP đang đăng nhập admin (trong 24 giờ) luôn được tin cậy. Trang `/admin` không bao giờ bị chặn.

Muốn mở phiên phải tải trang trước. Mỗi lần tải trang, server cấp một cookie có chữ ký (`ml_pass`, chỉ gửi kèm `/api/session`), dùng được 6 giờ và tối đa 10 phiên. Yêu cầu mở phiên không có cookie hợp lệ nhận 428 và server không tạo gì. Tab mở quá lâu thì trang tự xin cookie mới rồi mở lại. Công cụ chạy trên chính server (`deploy/seed_*.py`) không cần cookie này.

Riêng request gửi từ chính trang web trong trình duyệt (`Sec-Fetch-Site: same-origin`, hoặc `Origin` là chính web) thì vẫn mở được phiên khi thiếu cookie. Đó là bản trang cũ trình duyệt còn giữ (tab khôi phục khi mở lại trình duyệt, nút back/forward không hỏi lại server), chạy JS từ trước khi có cookie. Trả lời kèm `Clear-Site-Data: "cache"` để trình duyệt bỏ bản cũ, bỏ luôn cái 410 có thể còn kẹt trong cache.

App tự chặn một IP trong 24 giờ, cả ở app lẫn ở HAProxy, khi IP đó làm một trong các việc sau, dù là ai gửi:
- quá 240 request trong một phút mà không phải do trang gửi, hoặc quá 1.200 tính cả của trang (trang hỏi thư viện mỗi 1,2–20 giây; lúc tải hoặc đổi kho mẫu thì thêm vài chục tới khoảng 90 request);
- dò từ 10 đường dẫn lạ trở lên (`.env`, `.php`, `wp-`...);
- dùng user-agent của script (hoặc không gửi user-agent) mà gọi API từ 10 lần;
- bị từ chối mở phiên từ 60 lần.

Thêm hai trường hợp, chỉ áp dụng khi request không phải do trang web gửi:
- mở từ 15 phiên trở lên mà số lần hỏi thư viện chưa bằng nửa số phiên;
- mở phiên không có cookie 20 lần mà chưa từng tải trang.

Luật tự chặn hiện trong danh sách chặn, có ghi lý do và giờ tự gỡ; admin có thể bỏ chặn sớm. Không bị tự chặn vì mở phiên, để admin tự xem:
- trang web trong trình duyệt, được gắn nhãn *trình duyệt* trong mục Nghi vấn: một tab mở phiên liên tục là lỗi của web, không phải bot;
- crawler tìm kiếm và bot xem trước link (theo user-agent).

Một tab nghe lâu không phải là bất thường. Từ 31/10 trang hỏi thư viện:
- mỗi 20 giây lúc đang nghe hoặc không làm gì, khoảng 180 lần một giờ (trước đó là mỗi 5 giây, 720 lần một giờ);
- mỗi 1,2 giây khi bài của mình đang được tải hoặc phân tích;
- mỗi 2,5 giây khi bài của mình đang chờ trong hàng đợi tải.

Thao tác nào của người nghe cũng hỏi lại ngay. Trang giữ lại âm thanh đã tải trong bộ nhớ (64 MB, hoặc 192 MB trên máy có từ 8 GB RAM), bỏ bài lâu không dùng nhất trước, nên khi vòng phát quay lại một bài thì không phải tải lại. Trước đó, một thư viện 17 bài nghe cả ngày từng kéo 1,6 GB.

Chống nhúng và chống trình duyệt bị điều khiển:
- Không trang nào của web nằm được trong iframe của site khác (`X-Frame-Options: DENY`, CSP `frame-ancestors 'none'`). Trả lời của API kèm `Cross-Origin-Resource-Policy: same-origin`, nên trang khác không lấy được âm thanh hay dữ liệu bằng `<audio>`, `<img>` hay `fetch` không CORS. API không trả header CORS nào.
- Request tới `/api/` do trang của site khác gửi (`Sec-Fetch-Site: cross-site` hoặc `same-site`, hoặc `Origin` không phải web này, kể cả `null`) nhận 403. Mục Nghi vấn ghi lại, nhưng không tự chặn, vì IP đó là của người đang xem trang kia.
- Trang báo cho server biết trình duyệt có đang bị một chương trình điều khiển không (`navigator.webdriver`, gửi qua header `X-Env` khi mở phiên). Puppeteer, Playwright và Selenium đều bật cờ này, nên trình duyệt như vậy không mở được phiên; thử 3 lần thì IP bị tự chặn 24 giờ.
- Client hints (`Sec-CH-UA`) báo `HeadlessChrome` thì bị xử như script: gọi API từ 10 lần là bị tự chặn.
- User-agent tự xưng Chrome 90 trở lên mà không gửi client hints (Chrome thật luôn gửi trên https) thì hiện ở Nghi vấn để admin xem, không tự chặn. Không tính Chrome trên iOS, web view Android và app Electron, vì những loại này có thể không gửi.

- Request dò đường dẫn kiểu máy quét (`/.env`, `/wp-login.php`, `/.git/config`, `phpmyadmin`…) vẫn nhận 404, nhưng kèm lời nhắn bằng tiếng Anh: đừng tốn thời gian (và token), mã nguồn công khai ở https://github.com/lvt1693/mashloop, cứ lấy về mà dùng. Trình duyệt nhận trang HTML, curl và agent nhận text thường. Bot của công cụ tìm kiếm vẫn nhận 404 trơn. `sitemap.xml`, `robots.txt`, `favicon.ico`, `apple-touch-icon*.png` và `ads.txt` không bị tính là dò.

Những lớp này chặn được công cụ tự động thông thường. Bot cố tình giả trình duyệt (stealth) thì lách được; muốn chặn tới mức đó phải dùng thử thách từ bên ngoài như Cloudflare Turnstile.

Mọi trả lời của `/api/` đều kèm `Cache-Control: no-store`, và trang luôn gọi API với `cache: "no-store"`. Trước đây Chrome giữ vĩnh viễn cái 410 (phiên mất) mà một tab nhận lúc server khởi động lại, vì nó không có Cache-Control. Sau đó mọi lần hỏi thư viện đều lấy lại cái 410 đó từ cache, kể cả sau khi tải lại trang, nên tab cứ vài giây lại mở một phiên mới mà server không hề thấy nó hỏi thư viện.

Tab *Tạo mashup* đang tắt (chất lượng ghép chưa đạt): trang không hiện nó và server
không dựng mashup mới. Đặt `MASHLOOP_MASHUPS=1` để bật lại.

Giới hạn cho mỗi địa chỉ:
- mở trang 20 lần mỗi giờ;
- 20 bài mới mỗi ngày (bài server phải tải về; bài đã có sẵn thì không tính), thêm vào đó giới hạn 20 bài mỗi giờ.

Người dùng thấy số bài mới còn lại hôm nay ngay dưới ô thêm bài. Khi vượt giới hạn, trang báo phải chờ bao lâu.

Server giữ tối đa 5000 phiên. Phiên rỗng bị bỏ quá 15 phút thì bị xoá. Khi chạm trần, phiên rỗng lâu nhất bị xoá trước, còn đầy thì báo quá tải.

IP chặn trên trang admin bị HAProxy từ chối luôn, trước khi tới app. App tự giữ hai file `/etc/haproxy/mashloop-block.lst` và `mashloop-trust.lst`, đồng thời cập nhật danh sách đang chạy của HAProxy qua socket quản trị, không cần nạp lại. App cũng từ chối quy tắc chặn nào trùng với IP tin cậy.

Bản trên web có vài lớp chống lạm dụng, để nó không thành một dịch vụ tải nhạc miễn
phí: giới hạn số bài mỗi thư viện, giới hạn theo IP cho tìm kiếm, bài mới, file tải
lên và lượt tải audio, link chỉ nhận từ các trang kể trên, và audio chỉ gửi cho đúng
thư viện đang giữ bài, đã xáo trộn bằng khoá của lượt truy cập đó.

Cho công cụ tìm kiếm:
- Trang có title, description, canonical và các thẻ Open Graph / Twitter.
- Có structured data `WebSite` (tên site hiện trên kết quả Google) và `WebApplication`.
- Có `robots.txt` (chặn `/admin` và `/go/`, trỏ tới sitemap) và `sitemap.xml`.
- Icon: `favicon.ico` 16/32/48, SVG, PNG 192/512, `apple-touch-icon` và icon maskable cho manifest. Icon nền tràn ô vẽ từ `web/img/icon-full.svg`.
- Trả lời của `/api/` kèm `X-Robots-Tag: noindex`. Google vẫn gọi được API để render trang, nhưng không đưa JSON vào kết quả.
- Bot tìm kiếm (theo user-agent) được miễn kiểm tra `navigator.webdriver` và luật Chrome headless, để Google index đúng trang chứ không phải câu báo lỗi.
- Xác minh Google Search Console theo kiểu Domain property: bản ghi TXT `google-site-verification=…` ở DNS của `truclv.com` (Namecheap). Thẻ meta cùng mã cũng đã gắn trong trang.

## Bên trong

Mỗi bài đi qua một dây chuyền nhỏ (`loopbox/analysis/`):

1. **Beat This!** dò beat và downbeat. Model trả về theo lưới 20 ms; một bước tinh
   chỉnh kéo từng beat về đúng đỉnh onset, còn lệch khoảng 0.7 ms.
2. **Demucs** tách trống, bass, giọng hát và phần còn lại cho phần phân tích. Stem
   giọng hát dùng để trao giọng và để làm mashup thì được tách lại bằng
   **BS-RoFormer** (checkpoint ViperX, SDR giọng khoảng 12.9 dB so với 8.5 của Demucs)
   trong một tiến trình riêng trên GPU.
3. Mỗi beat được mô tả bằng hòa âm (lấy từ phần không có trống), âm sắc, độ lớn,
   nhịp điệu bên trong beat, mức của từng stem, và giọng hát: cao độ cùng âm sắc của
   riêng stem vocal. Mood của cả bài (năng lượng, độ tươi) suy ra từ trống, tempo,
   độ sáng và trưởng/thứ.
4. Key đoán bằng profile Albrecht-Shanahan trên stem hòa âm và bass. Đoạn và câu nhạc
   tìm từ ma trận tự tương đồng.
5. Điểm nhảy là cặp beat mà cả cửa sổ 8 beat quanh chúng khớp nhau, cùng vị trí
   trong câu nhạc 4 ô nhịp, có crossfade riêng cho từng chỗ (12 ms nếu trống chắc,
   tới 60 ms nếu là nốt ngân). Đoạn cuối bài được nối cầu để không thành cái bẫy.
6. Điểm nối giữa hai bài được tìm và lưu cho từng cặp, nên một cặp chỉ tính một lần
   cho tất cả mọi người. Phân tích chạy song song ở nhiều tiến trình dùng chung GPU.

Phần phát (`web/js/`) là Web Audio API thuần, lên lịch trước 0.6 giây và chính xác
tới từng mẫu. Đường tới điểm chuyển bài được tìm bằng Dijkstra trên đồ thị nhảy.
Không framework, không build step.

## Kiểm tra

Vì không ai ngồi nghe 3 tiếng liền để test được, nên có mấy công cụ làm việc đó:

```powershell
node tools\sim_player.mjs 180 chain                 # mô phỏng 3 giờ phát trong vài giây
$env:CRITERION="tempo"; node tools\sim_player.mjs 360 chain   # ... với một tiêu chí chọn bài
.venv\Scripts\python tools\e2e_test.py 240          # chạy UI thật trong Chrome, ghi âm output ra WAV
.venv\Scripts\python tools\eval_splices.py          # điểm nhảy khác bản gốc bao nhiêu
.venv\Scripts\python tools\eval_voice.py            # nhảy đổi ca sĩ, cắt giữa câu, giữ câu nhạc
.venv\Scripts\python tools\link_report.py           # thư viện được nối với nhau tốt cỡ nào
```

Trên thư viện thử 14 bài, mô phỏng 6 giờ cho mỗi tiêu chí: *cùng mood* làm độ lệch
mood mỗi lần đổi bài giảm từ 0.49 xuống 0.31 (chọn bừa là 0.76), *cùng nhịp* giữ beat
liền ở 68 % số lần đổi bài với độ lệch tempo trung bình 4.5 %, *hợp tông* cho 85 %
cặp tông hợp nhau. Phát thật 4 phút trong Chrome không rớt tiếng nào.

## Nói thật

- Các con số ở trên là đo bằng máy. Tai người vẫn là trọng tài cuối cùng.
- Key lock chạy [signalsmith-stretch](https://github.com/Signalsmith-Audio/signalsmith-stretch)
  trong trình duyệt, trễ chừng 0.12 giây, nên máy yếu có thể thấy nặng trong lúc blend.
- Zing MP3 chập chờn: nhiều bài chỉ dành cho tài khoản VIP. SoundCloud có bài chỉ cho
  nghe thử 30 giây, những bài đó bị từ chối.
- Không có Suno: audio của Suno được mã hóa, và app không phá lớp bảo vệ đó. Có file
  nhạc của mình thì cứ thả vào.
- Lớp xáo trộn audio chặn được công cụ tải và việc lưu file vu vơ, không phải DRM:
  trình duyệt bắt buộc phải nhận được âm thanh thì mới phát được.
- Chọn bản "audio" trên YouTube sẽ tốt hơn bản MV có đoạn mở đầu dài.

## Bản quyền

Repo này không chứa bất kỳ file nhạc nào. Nhạc bạn tải về nằm trong `data/` và không
đi đâu cả. Dùng cho mục đích cá nhân, tôn trọng điều khoản của các trang nhạc và
quyền của nghệ sĩ.

## Cảm ơn

[The Infinite Jukebox](https://musicmachinery.com/2012/11/12/the-infinite-jukebox/) của
Paul Lamere và [Eternal Jukebox](https://github.com/EternalBox/EternalJukebox) đã nghĩ ra
trò này trước. Phần nặng nhất là của [Beat This!](https://github.com/CPJKU/beat_this),
[Demucs](https://github.com/facebookresearch/demucs), BS-RoFormer (mã của
[ZFTurbo](https://github.com/ZFTurbo/Music-Source-Separation-Training), MIT),
[Rubber Band](https://breakfastquay.com/rubberband/), [librosa](https://librosa.org/) và
[yt-dlp](https://github.com/yt-dlp/yt-dlp).

## License

[MIT](LICENSE). Áp dụng cho code trong repo này; nhạc bạn tải về vẫn thuộc về người
làm ra nó.

## English, briefly

An endless jukebox that mashes songs together. It analyses beats, stems, singers and
mood, loops each song through its own seamless jump points, and mixes a library into
one continuous set: beat-matched, key-locked blends (ten styles, stem-aware, with key
shifts and tempo ramps), mashups and double drops, long filtered crossfades between
moods, DJ accents (build-ups, flangers, drop-outs), and a chain that can follow mood,
tempo, key, or nothing at all. Try it
at https://mashloop.truclv.com (a fresh private library per visit, songs from YouTube,
SoundCloud, Bandcamp, Zing MP3, Mixcloud or your own files), or run it on your own
machine. The UI is in Vietnamese; the code and its comments are in English.
