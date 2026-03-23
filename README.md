# PostgreSQL View

Tool web local để đọc schema PostgreSQL và hiển thị bảng, cột, quan hệ foreign key theo kiểu ERD.

## Yêu cầu

- Node.js
- `psql` client nằm trong `PATH`
- Có thể truy cập PostgreSQL bằng host/port/user/password phù hợp

## Chạy local

```bash
npm start
```

Mặc định app chạy tại:

```text
http://127.0.0.1:3210
```

## Cách dùng

1. Mở web local.
2. Nhập `host`, `port`, `database`, `user`, `password`.
3. Bấm `Đọc schema`.
4. Dùng ô tìm kiếm và bộ lọc schema để thu gọn sơ đồ.
5. Click vào bảng trong sidebar hoặc trên canvas để xem chi tiết.

## Tính năng hiện có

- Đọc danh sách bảng người dùng trong PostgreSQL
- Hiển thị cột, kiểu dữ liệu, PK, FK
- Vẽ quan hệ foreign key giữa các bảng
- Tìm kiếm theo tên schema, bảng, cột
- Pan / zoom / fit trong sơ đồ

## Ghi chú

- Password không được lưu trong local storage.
- App hiện dùng `psql` để query metadata từ PostgreSQL, nên không cần cài thêm package Node.
