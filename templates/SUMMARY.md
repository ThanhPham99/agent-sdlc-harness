# Bảng Tóm Tắt Trạng Thái & Trung Tâm Tài Liệu SDLC (.agent-sdlc)

> **Lưu ý:** Thư mục `.agent-sdlc/` được cấu hình để lưu trữ toàn bộ trạng thái thực thi, bằng chứng kiểm định (evidence), và các tài liệu con người có thể đọc trực tiếp (human-readable docs).

---

## 1. Tài Liệu Hướng Dẫn & Kiến Trúc (Dành Cho Người Dùng Đọc)

| Tài liệu | Mô tả | Liên kết |
| :--- | :--- | :--- |
| **Hướng Dẫn Cấu Trúc & Tra Cứu** | Hướng dẫn cấu trúc thư mục `.agent-sdlc`, cách đọc artifact băm SHA-256 | [docs/README.md](file:///media/moe_mint/D/Moevuive/agent-sdlc-harness/.agent-sdlc/docs/README.md) |
| **Kiến Trúc & 5 Human Gates** | Chi tiết 10 giai đoạn SDLC, 5 cổng phê duyệt của con người và 3 risk profiles | [ARCHITECTURE-AND-STATE.md](file:///media/moe_mint/D/Moevuive/agent-sdlc-harness/.agent-sdlc/docs/ARCHITECTURE-AND-STATE.md) |
| **Cẩm Nang 21 Workflows** | Bảng đối chiếu 21 workflows (STRICT / STANDARD / FAST) và cách chọn luồng | [WORKFLOWS-GUIDE.md](file:///media/moe_mint/D/Moevuive/agent-sdlc-harness/.agent-sdlc/docs/WORKFLOWS-GUIDE.md) |
| **Bảng Tra Cứu Lệnh CLI** | Tra cứu nhanh các lệnh: `auto`, `status`, `task`, `gate`, `approval`, `report` | [CLI-CHEAT-SHEET.md](file:///media/moe_mint/D/Moevuive/agent-sdlc-harness/.agent-sdlc/docs/CLI-CHEAT-SHEET.md) |
| **Chính Sách Review Code** | Quy chuẩn 3 vòng review (Bugs, Security, Compliance) và Nit Capping | [REVIEW.md](file:///media/moe_mint/D/Moevuive/agent-sdlc-harness/.agent-sdlc/REVIEW.md) |
| **Dashboard Trực Quan** | Giao diện HTML xem trạng thái pipeline, tasks và runs trực quan trên trình duyệt | [dashboard.html](file:///media/moe_mint/D/Moevuive/agent-sdlc-harness/.agent-sdlc/dashboard.html) |

---

## 2. Các Báo Cáo Nghiệm Thu & Tóm Tắt Công Việc

| Báo cáo | Nội dung chính | Liên kết |
| :--- | :--- | :--- |
| **Báo Cáo Sửa Lỗi & Cập Nhật Mới Nhất** | 3 lỗi blocking trong runner đã xử lý, 45/45 test checks PASS | [LATEST-WORK-SUMMARY.md](file:///media/moe_mint/D/Moevuive/agent-sdlc-harness/.agent-sdlc/reports/LATEST-WORK-SUMMARY.md) |
| **Báo Cáo Nghiệm Thu 22/22 Workflows E2E** | Kết quả chạy kiểm định E2E tự động toàn bộ 21 workflows + delta update | [WORKFLOWS-E2E-REPORT.md](file:///media/moe_mint/D/Moevuive/agent-sdlc-harness/.agent-sdlc/reports/WORKFLOWS-E2E-REPORT.md) |

---

## 3. Trạng Thái Tổng Thể Codebase & Kiểm Thử

- **Phiên bản Harness:** `v3.0.0-rc2`
- **Bộ kiểm thử toàn diện (Local Gate):** `47/47 test suites PASS (100%)`
- **Kiểm thử E2E 21 SDLC Workflows:** `22/22 checks PASS` ([scripts/test-all-workflows-e2e.mjs](file:///media/moe_mint/D/Moevuive/agent-sdlc-harness/scripts/test-all-workflows-e2e.mjs))
- **Autonomous Runner:** `45/45 checks PASS` ([scripts/test-autonomous-runner.mjs](file:///media/moe_mint/D/Moevuive/agent-sdlc-harness/scripts/test-autonomous-runner.mjs))

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
