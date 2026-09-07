# Hướng Dẫn Cấu Trúc & Tra Cứu Dữ Liệu `.agent-sdlc`

Thư mục `.agent-sdlc/` là trung tâm lưu trữ toàn bộ trạng thái thực thi, bằng chứng xác thực và tài liệu của Agent SDLC Harness.

Cấu trúc này là **layout v2**. Phiên bản được ghi trong `LAYOUT.json`; nếu bạn mở một dự án cũ, harness sẽ tự phát hiện và yêu cầu chạy `migrate` (xem mục 5).

---

## 1. Bốn Vòng Đời Dữ Liệu

Đây là điều quan trọng nhất cần nắm, và là lý do v2 sắp xếp lại cây thư mục: **mỗi phần dữ liệu có một vòng đời khác nhau**, và trước đây không thể nhìn vào cây thư mục mà biết được phần nào an toàn để xoá, phần nào phải commit, phần nào phải sao lưu.

| Vòng đời | Ở đâu | Ý nghĩa |
|---|---|---|
| **CONFIG** | `project.json`, `workflows/` | Cấu hình dự án. **Nên commit vào git.** |
| **DURABLE** | `runs/`, `store/`, `shared/`, `state.json`, `LAYOUT.json` | Bằng chứng và lịch sử mà các gate phụ thuộc vào. **Cần sao lưu, không sửa tay.** |
| **CACHE** | `cache/` | Dữ liệu dẫn xuất, tái tạo được. **Xoá lúc nào cũng được**, nên đưa vào `.gitignore`. |
| **DOCS** | `docs/` | Tài liệu do harness sinh ra cho con người đọc. Tái tạo bằng `report`. |

> Quy tắc thực dụng: `rm -rf .agent-sdlc/cache` là an toàn tuyệt đối (có test chứng minh điều này: `npm run test:cache-regeneration`). Mọi thư mục khác thì không.

### Nếu muốn commit `project.json`

Mặc định `.gitignore` bỏ qua **toàn bộ** `.agent-sdlc/`. Một quy tắc bỏ qua cả thư mục sẽ thắng mọi đường dẫn con, nên chỉ thêm `project.json` vào git là **không đủ** — cần một quy tắc phủ định cho cả thư mục cha:

```gitignore
.agent-sdlc/*
!.agent-sdlc/project.json
!.agent-sdlc/workflows/
```

Hoặc, nếu không muốn sửa `.gitignore`: `git add -f .agent-sdlc/project.json`.

Đây là lựa chọn của bạn, không phải mặc định của harness: bỏ qua toàn bộ `.agent-sdlc/` là một mặc định hợp lý, vì phần lớn nội dung trong đó là DURABLE hoặc CACHE.

---

## 2. Cấu Trúc Chi Tiết

```
.agent-sdlc/
├── LAYOUT.json               # Phiên bản cấu trúc cây (layout_version)   [DURABLE]
├── project.json              # Cấu hình dự án — nên commit               [CONFIG]
├── state.json                # Con trỏ run đang hoạt động, sổ migration  [DURABLE]
├── workflows/                # Workflow ghi đè riêng của dự án           [CONFIG]
│
├── runs/<run_id>/            # TẤT CẢ dữ liệu của một run, trong MỘT thư mục  [DURABLE]
│   ├── run.json              #   tài liệu run
│   ├── events.jsonl          #   luồng sự kiện (hash-chained)
│   ├── cost.jsonl            #   token & chi phí
│   ├── evidence.jsonl        #   bằng chứng gate
│   ├── ci-evidence.json/.jsonl
│   ├── delivery.json  requirement-update.json
│   ├── tasks/                #   task records + graph.json
│   ├── task-events.jsonl
│   ├── task-context/         #   ngữ cảnh thu gọn cho worker subagent
│   ├── task-evidence/
│   └── traceability/         #   graph.json + invalidations.jsonl
│
├── store/<aa>/<phần còn lại>         # Object store băm SHA-256, chia shard  [DURABLE]
│         <aa>/<...>.meta.json        # Metadata nằm CẠNH object của nó
│
├── shared/                   # Trạng thái dùng chung, sống lâu hơn một run  [DURABLE]
│   ├── handoffs/  features/  memory/  webhooks/  intent/  backups/
│   ├── quarantine.json       #   test bị cách ly vì flaky
│   └── activation.jsonl      #   nhật ký auto-activation
│
├── cache/                    # Tái tạo được — xoá thoải mái               [CACHE]
│   ├── index/                #   chỉ mục symbol của repo
│   ├── workspaces/<run_id>/  #   git worktree cô lập cho từng task
│   └── dashboard.html        #   dashboard đã render
│
└── docs/                     # Con người đọc                              [DOCS]
    ├── SUMMARY.md  REVIEW.md
    ├── guides/               #   4 tài liệu hướng dẫn được sinh ra
    └── reports/<run_id>.md   #   báo cáo từng run
```

Ba đường dẫn thuộc về một run nhưng **không** nằm dưới `runs/<run_id>/`, vì vòng đời và vị trí tự nhiên của chúng khác nhau: worktree thì tái tạo được (`cache/`), báo cáo là văn bản cho người đọc (`docs/`), và bản sao lưu trước migration nằm cùng chỗ với các backup khác (`shared/`). Bảng `RUN_SCOPED` trong `runtime/layout.mjs` vẫn ghi nhận cả ba, nên `gc` xoá chúng cùng với run — đây chính là lỗi rò rỉ mà v2 sinh ra để sửa.

---

## 3. Vì Sao Object Store Được Chia Shard?

Trong `store/`, một object có địa chỉ là mã băm SHA-256 của chính nội dung nó, và được chia thư mục theo **2 ký tự đầu** — đúng cơ chế `objects` của Git:

```
store/ab/cdef0123...        # nội dung thô
store/ab/cdef0123....meta.json   # metadata: kind, run_id, stage, bindings
```

- **Chia shard** vì một thư mục phẳng chứa toàn bộ object của dự án sẽ chậm dần: mọi thao tác `readdir`, `stat` hay backup đều phải duyệt hết. 2 ký tự cho 256 nhánh, đủ cho quy mô hàng chục nghìn object.
- **Metadata nằm cạnh object** vì hai file được ghi cùng nhau, đọc cùng nhau, xoá cùng nhau. Một thư mục shard là câu chuyện đầy đủ về các object của nó.
- **Content-addressed** nên dữ liệu không thể bị sửa lén (tamper-proof), và hai run tạo ra nội dung giống hệt nhau sẽ dùng chung một object (mỗi run có một `binding` riêng trong metadata).

### Cách đọc nội dung thật của Artifacts

Đừng mở trực tiếp file băm trong `store/`. Dùng CLI:

```bash
node runtime/cli.mjs artifact-list                    # liệt kê toàn bộ
node runtime/cli.mjs artifact-get --ref <artifact_id> # đọc một artifact
```

---

## 4. Một Quy Tắc Duy Nhất Về Đường Dẫn

Mọi đường dẫn dưới `.agent-sdlc/` đều do **`runtime/layout.mjs`** sinh ra — không module nào tự ghép chuỗi. Quy tắc này được kiểm tra tự động bằng `npm run test:layout-boundary`, và test đó sẽ **fail** nếu có file nào ghép đường dẫn bằng tay.

Lý do: trước v2, 24 namespace được tạo rải rác bởi hơn 20 module, mỗi chỗ tự viết `path.join(stateDir(root),'...')`. Không gì liệt kê được cây thư mục, nên không gì migrate, tài liệu hoá hay dọn dẹp được nó — `retention.mjs` giữ danh sách đường dẫn riêng và đã lạc hậu mất 6 mục, khiến mỗi run bị "dọn" vẫn để lại evidence, ci-evidence, delivery, traceability, requirement-update và workspace trên đĩa vĩnh viễn.

Muốn thêm một namespace mới? Thêm một dòng vào bảng trong `layout.mjs`. `gc`, tài liệu và migration sẽ tự nhìn thấy nó.

---

## 5. Nâng Cấp Từ Cấu Trúc Cũ (v1 → v2)

Nếu `.agent-sdlc/` của bạn còn ở dạng cũ (có `artifacts/`, `events/`, `tasks/` ở cấp cao nhất, hoặc `runs/<id>.json` là file phẳng), harness sẽ phát hiện và **không** tự ý đọc nhầm:

```bash
node runtime/cli.mjs compat-check    # báo LAYOUT_MIGRATION_REQUIRED
node runtime/cli.mjs migrate         # chuyển đổi
```

Quá trình migration:
- **Sao lưu trước tiên** toàn bộ cây cũ vào `.agent-sdlc/.backup-v1-<timestamp>/`.
- **Di chuyển (move), không sao chép** — nếu chỉ sao chép, các thư mục cũ còn lại sẽ khiến dự án báo `compatible: false` mãi mãi.
- **Không ghi đè** bất kỳ đường dẫn v2 nào đã tồn tại.
- **Idempotent**: chạy lần hai là no-op, không tạo thêm backup.
- **Không viết lại nội dung** file nào. Trên cùng một ổ đĩa, mọi thao tác là `rename`, nên gián đoạn giữa chừng để lại file ở vị trí cũ hoặc mới, không bao giờ bị cắt cụt. Nếu `.agent-sdlc/` nằm trên một filesystem khác với đích đến (`EXDEV`), thao tác lùi về copy-rồi-xoá; khi đó một gián đoạn có thể để lại bản sao dở dang ở đích, và bản gốc vẫn còn nguyên trong backup.
- Báo **`INCOMPLETE`** thay vì báo thành công nếu còn sót thứ gì: thư mục cũ chưa rỗng, tên file mà v2 không địa chỉ hoá được (hãy đổi tên rồi chạy lại), hoặc thao tác di chuyển thất bại.

### Sau khi migration xong: xử lý thư mục backup

`.backup-v1-<timestamp>/` là **bản sao đầy đủ** của cây cũ — thường là thứ chiếm nhiều dung lượng nhất trong `.agent-sdlc/`. Nó **không** nằm trong bảng layout, nên `gc` sẽ không bao giờ tự dọn nó.

Sau khi bạn đã xác nhận dự án chạy bình thường trên v2 (`compat-check` báo `compatible: true`, `runs` và `artifact-list` hiển thị đúng lịch sử), có thể xoá:

```bash
rm -rf .agent-sdlc/.backup-v1-*
```

Giữ lại nếu bạn chưa kiểm tra xong — đây là đường lui duy nhất về v1.

Kiểm chứng: `npm run test:layout-migration`.
