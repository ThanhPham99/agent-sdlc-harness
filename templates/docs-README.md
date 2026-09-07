# Hướng Dẫn Cấu Trúc & Tra Cứu Dữ Liệu `.agent-sdlc`

Thư mục `.agent-sdlc/` là trung tâm lưu trữ toàn bộ trạng thái thực thi, bằng chứng xác thực và tài liệu của Agent SDLC Harness.

---

## 1. Cấu Trúc Chi Tiết Các Thư Mục & Tệp Tin

```
.agent-sdlc/
├── SUMMARY.md                # Bảng tóm tắt tổng quan mức cao dành cho người dùng
├── REVIEW.md                 # Quy tắc và hướng dẫn thực hiện Code Review
├── dashboard.html            # Dashboard giao diện trực quan (mở bằng trình duyệt)
│
├── docs/                     # Tài liệu hướng dẫn, kiến trúc (người đọc được)
│   ├── README.md             # Tệp tài liệu hướng dẫn này
│   ├── ARCHITECTURE-AND-STATE.md # Chi tiết 10 Stages, 5 Human Gates, 3 Risk Profiles
│   ├── WORKFLOWS-GUIDE.md    # Cẩm nang 21 Workflows và cách chọn luồng
│   └── CLI-CHEAT-SHEET.md    # Bảng tra cứu các lệnh CLI thường dùng
│
├── reports/                  # Các báo cáo tóm tắt công việc, biên bản kiểm thử
│   ├── LATEST-WORK-SUMMARY.md   # Tóm tắt các lỗi đã fix & test mới nhất
│   └── WORKFLOWS-E2E-REPORT.md  # Báo cáo nghiệm thu 22/22 workflows E2E
│
├── intent/                   # Nơi tiếp nhận yêu cầu / proto-spec dạng Markdown
├── artifacts/                # Content-Addressed Object Store (dành cho máy & CLI)
│   ├── meta/                 # Metadata JSON của từng artifact (kind, run_id, filename...)
│   └── objects/              # Dữ liệu nội dung thô được băm theo mã SHA-256
│
├── runs/                     # Lịch sử các đợt chạy pipeline (dạng run_<uuid>.json)
├── handoffs/                 # Bản ghi chuyển giao trạng thái giữa các Stage
├── evidence/                 # Bằng chứng gate verification đạt chuẩn
├── ci-evidence/              # Bằng chứng tích hợp CI / test suites
├── tasks/                    # Danh sách các task và đồ thị phụ thuộc (task graph)
├── task-context/             # Ngữ cảnh thu gọn phục vụ worker subagent
└── state.json                # Trạng thái hiện tại của phiên làm việc đang chạy
```

---

## 2. Vì Sao Có Các File Băm Trong `artifacts/objects/`?

Các file không có đuôi mở rộng trong `artifacts/objects/<sha256>` là thiết kế **Content-Addressed Storage** (tương tự cơ chế `objects` của Git):
- Giúp dữ liệu không bị sửa đổi ngoài ý muốn (tamper-proof).
- Cho phép xác minh bằng chứng kiểm thử một cách toán học thông qua mã băm SHA-256.

### Cách đọc nội dung thật của các Artifacts:
Không nên mở trực tiếp file hash trong `objects/`. Hãy dùng công cụ CLI để đọc:

1. **Xem danh sách toàn bộ Artifacts:**
   ```bash
   node runtime/cli.mjs artifact-list
   ```
2. **Đọc nội dung định dạng rõ ràng của một Artifact:**
   ```bash
   node runtime/cli.mjs artifact-get --ref <artifact_id>
   ```
3. **Xuất artifact ra file markdown để đọc:**
   ```bash
   node runtime/cli.mjs artifact-get --ref <artifact_id> > .agent-sdlc/docs/exported-doc.md
   ```

---

## 3. Quy Ước Lưu Thêm Tài Liệu Mới Vào `.agent-sdlc`

Nếu bạn hoặc Agent muốn ghi lại tài liệu mới:
1. **Tài liệu hướng dẫn / ghi chú kỹ thuật:** Lưu vào `.agent-sdlc/docs/<ten-tai-lieu>.md`
2. **Báo cáo tiến độ / tóm tắt công việc:** Lưu vào `.agent-sdlc/reports/<YYYY-MM-DD-ten-bao-cao>.md`
3. **Ý tưởng tính năng / yêu cầu mới:** Lưu vào `.agent-sdlc/intent/<ten-tinh-nang>.md` (Harness sẽ tự động nhận diện khi chạy intake).

> **Lưu ý:** Thư mục `.agent-sdlc/` mặc định nằm trong `.gitignore` nên các tài liệu lưu tại đây sẽ nằm cục bộ trên máy của bạn. Nếu cần chia sẻ tài liệu chung cho toàn team lên GitHub, hãy lưu vào thư mục `docs/` ở gốc repository.
