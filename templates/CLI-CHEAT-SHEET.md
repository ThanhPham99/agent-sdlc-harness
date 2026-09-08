# Bảng Tra Cứu Lệnh CLI (Agent SDLC CLI Cheat Sheet)

Dưới đây là danh sách đầy đủ các lệnh dòng lệnh thường dùng nhất của Agent SDLC Harness.

---

## 1. Lệnh Điều Phối Tự Động (Autonomous Execution)

```bash
# Chạy pipeline tự động từ đầu đến cuối cho một mục tiêu:
node runtime/cli.mjs auto --objective "<mục_tiêu_công_việc>"

# Tiếp tục một lượt chạy đang tạm dừng (ở cổng phê duyệt):
node runtime/cli.mjs resume --run-id <run_id>

# Khởi tạo thư mục .agent-sdlc cho dự án mới:
node runtime/cli.mjs init
```

---

## 2. Quản Lý Run & Trạng Thái Pipeline

```bash
# Xem trạng thái của lượt chạy hiện tại hoặc theo mã:
node runtime/cli.mjs status [--run-id <run_id>]

# Xem danh sách toàn bộ các runs đã từng chạy:
node runtime/cli.mjs run-list

# Bắt đầu một run mới thủ công:
node runtime/cli.mjs start --objective "<mục_tiêu>" --workflow <workflow_name>

# Chuyển giai đoạn thủ công (chỉ dùng khi tự điều phối):
node runtime/cli.mjs transition --to <STAGE_NAME> --evidence <claim_1>,<claim_2>

# Kiểm tra điều kiện của Gate tại giai đoạn hiện tại:
node runtime/cli.mjs gate status
```

---

## 3. Quản Lý Tài Liệu, Báo Cáo & Dashboard (Human-Readable)

```bash
# Tạo / làm mới giao diện trực quan HTML (.agent-sdlc/cache/dashboard.html):
node runtime/cli.mjs dashboard

# Tạo hoặc xuất tóm tắt báo cáo Markdown cho run hiện tại:
node runtime/cli.mjs report [--run-id <run_id>]

# Xem danh sách các artifact có trong hệ thống:
node runtime/cli.mjs artifact-list

# Đọc nội dung văn bản rõ ràng của một artifact theo mã băm:
node runtime/cli.mjs artifact-get --ref <artifact_id>
```

---

## 4. Quản Lý Tasks (Nhiệm Vụ Triển Khai)

```bash
# Liệt kê danh sách các tasks của một run:
node runtime/cli.mjs task-list [--run-id <run_id>]

# Xem chi tiết một task:
node runtime/cli.mjs task-show --task <task_id>

# Khởi động thực thi một task trong workspace cô lập:
node runtime/cli.mjs task-start --task <task_id>

# Xác minh và đánh dấu task hoàn thành:
node runtime/cli.mjs task-advance --task <task_id>
```

---

## 5. Quản Lý Cổng Phê Duyệt Của Con Người (Human Gates)

```bash
# Xem danh sách các phiếu phê duyệt (approval tickets) đang chờ:
node runtime/cli.mjs approval tickets

# Cấp quyền phê duyệt cho một ticket đang chờ (Gate 1, 4, 5...):
node runtime/cli.mjs approval grant-ticket --ticket <ticket_id> --reason "Đã kiểm tra và đồng ý"
```
