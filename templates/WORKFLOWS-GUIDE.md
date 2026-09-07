# Cẩm Nang 21 Luồng Quy Trình SDLC (SDLC Workflows Guide)

Agent SDLC Harness hỗ trợ 21 base workflows chuẩn hóa nhằm bao quát toàn bộ các tình huống phát triển phần mềm trong thực tế.

---

## 1. Bảng Tra Cứu Toàn Bộ 21 Workflows

| Tên Workflow | Profile | Mục Đích Sử Dụng | Các Giai Đoạn Trải Qua |
| :--- | :---: | :--- | :--- |
| `new-feature` | STANDARD | Xây dựng tính năng hoàn toàn mới | INTAKE -> REQ -> DESIGN -> PLAN -> IMPL -> VERIFY -> REVIEW -> RELEASE -> DEPLOY -> OBSERVE -> CLOSE |
| `continue-feature` | STANDARD | Tiếp tục phát triển tính năng đang dang dở | INTAKE -> REQ -> DESIGN -> PLAN -> IMPL -> VERIFY -> REVIEW -> RELEASE -> CLOSE |
| `bug-fix` | STANDARD | Sửa các lỗi logic, bug đã phát hiện trong code | INTAKE -> REQ -> PLAN -> IMPL -> VERIFY -> REVIEW -> RELEASE -> CLOSE |
| `hotfix` | **STRICT** | Vá lỗi khẩn cấp trực tiếp trên môi trường live | INTAKE -> REQ -> PLAN -> IMPL -> VERIFY -> REVIEW -> RELEASE -> DEPLOY -> OBSERVE -> CLOSE |
| `refactor` | STANDARD | Tái cấu trúc code mà không đổi hành vi nghiệp vụ | INTAKE -> REQ -> DESIGN -> PLAN -> IMPL -> VERIFY -> REVIEW -> RELEASE -> CLOSE |
| `performance` | STANDARD | Tối ưu hóa hiệu năng, giảm thời gian xử lý | INTAKE -> REQ -> DESIGN -> PLAN -> IMPL -> VERIFY -> REVIEW -> RELEASE -> OBSERVE -> CLOSE |
| `dependency-upgrade` | STANDARD | Nâng cấp thư viện, package phụ thuộc | INTAKE -> REQ -> PLAN -> IMPL -> VERIFY -> REVIEW -> RELEASE -> CLOSE |
| `database-migration` | **STRICT** | Thay đổi cấu trúc bảng, schema database | INTAKE -> REQ -> DESIGN -> PLAN -> IMPL -> VERIFY -> REVIEW -> RELEASE -> DEPLOY -> OBSERVE -> CLOSE |
| `api-breaking-change` | **STRICT** | Thay đổi API làm phá vỡ tương thích ngược | INTAKE -> REQ -> DESIGN -> PLAN -> IMPL -> VERIFY -> REVIEW -> RELEASE -> DEPLOY -> OBSERVE -> CLOSE |
| `security-remediation` | **STRICT** | Khắc phục lỗ hổng bảo mật, CVE, rò rỉ dữ liệu | INTAKE -> REQ -> DESIGN -> PLAN -> IMPL -> VERIFY -> REVIEW -> RELEASE -> CLOSE |
| `ci-cd-change` | STANDARD | Chỉnh sửa pipeline GitHub Actions, Dockerfile, CI | INTAKE -> REQ -> PLAN -> IMPL -> VERIFY -> REVIEW -> RELEASE -> CLOSE |
| `infrastructure-change`| **STRICT** | Thay đổi hạ tầng đám mây, Terraform, k8s | INTAKE -> REQ -> DESIGN -> PLAN -> IMPL -> VERIFY -> REVIEW -> RELEASE -> DEPLOY -> OBSERVE -> CLOSE |
| `observability-change` | STANDARD | Bổ sung logging, metrics, tracing, alerts | INTAKE -> REQ -> PLAN -> IMPL -> VERIFY -> REVIEW -> RELEASE -> OBSERVE -> CLOSE |
| `incident-response` | **STRICT** | Ứng cứu sự cố kỹ thuật, xử lý downtime | INTAKE -> REQ -> PLAN -> IMPL -> VERIFY -> REVIEW -> RELEASE -> DEPLOY -> OBSERVE -> CLOSE |
| `maintenance` | **FAST** | Dọn dẹp code rác, update cấu hình nhẹ nhàng | INTAKE -> REQ -> PLAN -> IMPL -> VERIFY -> CLOSE |
| `modernization` | **STRICT** | Hiện đại hóa toàn bộ hệ thống hoặc framework cũ | INTAKE -> REQ -> DESIGN -> PLAN -> IMPL -> VERIFY -> REVIEW -> RELEASE -> DEPLOY -> OBSERVE -> CLOSE |
| `compliance-change` | **STRICT** | Thay đổi phục vụ tuân thủ chính sách, luật | INTAKE -> REQ -> DESIGN -> PLAN -> IMPL -> VERIFY -> REVIEW -> RELEASE -> CLOSE |
| `documentation` | **FAST** | Viết hoặc cập nhật tài liệu, hướng dẫn | INTAKE -> REQ -> PLAN -> IMPL -> VERIFY -> CLOSE |
| `technical-spike` | **FAST** | Nghiên cứu, đánh giá tính khả thi kỹ thuật | INTAKE -> REQ -> PLAN -> IMPL -> VERIFY -> CLOSE |
| `test-only` | **FAST** | Bổ sung unit test, integration test | INTAKE -> REQ -> PLAN -> IMPL -> VERIFY -> CLOSE |
| `deprecation-removal` | **STRICT** | Gỡ bỏ vĩnh viễn các API / tính năng đã deprecated | INTAKE -> REQ -> DESIGN -> PLAN -> IMPL -> VERIFY -> REVIEW -> RELEASE -> CLOSE |

---

## 2. Cách Sử Dụng Workflows Trong Thực Tế

### 1. Để Hệ Thống Tự Động Phân Loại (Recommended)
Hệ thống sử dụng bộ định tuyến ngữ nghĩa và từ khóa (`sdlc-router`). Bạn chỉ cần cung cấp mục tiêu rõ ràng:
```bash
# Ví dụ: Hệ thống sẽ tự nhận diện là bug-fix
node runtime/cli.mjs auto --objective "Sửa lỗi null pointer khi đăng nhập không có email"

# Ví dụ: Hệ thống sẽ tự nhận diện là hotfix (STRICT)
node runtime/cli.mjs auto --objective "Khắc phục lỗi thanh toán bị kẹt tiền khẩn cấp"
```

### 2. Chỉ Định Thủ Công Khi Bắt Đầu
Nếu bạn muốn cố định một workflow cụ thể:
```bash
node runtime/cli.mjs start --objective "Viết tài liệu hướng dẫn REST API" --workflow documentation
```
