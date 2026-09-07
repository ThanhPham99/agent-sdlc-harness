# Bảng Tóm Tắt Trạng Thái & Trung Tâm Tài Liệu SDLC (.agent-sdlc)

> **Lưu ý:** Thư mục `.agent-sdlc/` được cấu hình để lưu trữ toàn bộ trạng thái thực thi, bằng chứng kiểm định (evidence), và các tài liệu con người có thể đọc trực tiếp (human-readable docs).

---

## 1. Tài Liệu Hướng Dẫn & Kiến Trúc (Dành Cho Người Dùng Đọc)

| Tài liệu | Mô tả | Liên kết |
| :--- | :--- | :--- |
| **Hướng Dẫn Cấu Trúc & Tra Cứu** | Hướng dẫn cấu trúc thư mục `.agent-sdlc`, cách đọc artifact băm SHA-256 | [guides/README.md](./guides/README.md) |
| **Kiến Trúc & 5 Human Gates** | Chi tiết 10 giai đoạn SDLC, 5 cổng phê duyệt của con người và 3 risk profiles | [ARCHITECTURE-AND-STATE.md](./guides/ARCHITECTURE-AND-STATE.md) |
| **Cẩm Nang 21 Workflows** | Bảng đối chiếu 21 workflows (STRICT / STANDARD / FAST) và cách chọn luồng | [WORKFLOWS-GUIDE.md](./guides/WORKFLOWS-GUIDE.md) |
| **Bảng Tra Cứu Lệnh CLI** | Tra cứu nhanh các lệnh: `auto`, `status`, `task`, `gate`, `approval`, `report` | [CLI-CHEAT-SHEET.md](./guides/CLI-CHEAT-SHEET.md) |
| **Chính Sách Review Code** | Quy chuẩn 3 vòng review (Bugs, Security, Compliance) và Nit Capping | [REVIEW.md](../REVIEW.md) |
| **Dashboard Trực Quan** | Giao diện HTML xem trạng thái pipeline, tasks và runs trực quan trên trình duyệt | [dashboard.html](../cache/dashboard.html) |

---

## 2. Các Báo Cáo Nghiệm Thu & Tóm Tắt Công Việc

| Báo cáo | Nội dung chính | Liên kết |
| :--- | :--- | :--- |
| **Báo Cáo Sửa Lỗi & Cập Nhật Mới Nhất** | 3 lỗi blocking trong runner đã xử lý, 45/45 test checks PASS | [LATEST-WORK-SUMMARY.md](./reports/LATEST-WORK-SUMMARY.md) |
| **Báo Cáo Nghiệm Thu 22/22 Workflows E2E** | Kết quả chạy kiểm định E2E tự động toàn bộ 21 workflows + delta update | [WORKFLOWS-E2E-REPORT.md](./reports/WORKFLOWS-E2E-REPORT.md) |

---

## 3. Trạng Thái Tổng Thể Codebase & Kiểm Thử

Đây là tệp mẫu được sao chép vào mỗi dự án, nên nó **không khẳng định** số liệu kiểm thử của dự án bạn — hãy tự chạy và đọc kết quả:

| Kiểm tra | Lệnh |
|---|---|
| Cổng kiểm định đầy đủ (local gate) | `npm run check` |
| Bộ kiểm thử tất định | `npm test` |
| Kiểm tra tính toàn vẹn | `npm run test:integrity` |
| E2E 21 SDLC workflows | `npm run test:workflows-e2e` |
| Autonomous runner | `npm run test:autonomous-runner` |

---

## 4. Các Lệnh Tra Cứu Nhanh Cho Người Dùng

```bash
# 1. Cập nhật / tạo file Dashboard giao diện HTML trực quan:
node runtime/cli.mjs dashboard

# 2. Xem danh sách tất cả các Artifacts đã được tạo:
node runtime/cli.mjs artifact-list

# 3. Xem nội dung văn bản/markdown rõ ràng của một Artifact theo mã ID:
node runtime/cli.mjs artifact-get --ref <artifact_id>

# 4. Xem danh sách các đợt chạy (runs):
node runtime/cli.mjs run-list

# 5. Xem chi tiết trạng thái bàn giao giữa các giai đoạn (handoffs):
node runtime/cli.mjs handoff-list
```
