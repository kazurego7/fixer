# Codex Mobile UI (MVP)

Codex App Server と通信するスマホ向けWeb UIです。

## 起動

```bash
npm start
```

環境変数:

- `PORT` (default: `3000`)
- `WORKSPACE_ROOT` (default: `<project>/workspace`)
- `CODEX_BASE_URL` (default: `http://127.0.0.1:8080`)

## UI

- CSSフレームワーク: **Pico.css v2**（CDN読み込み）
- モバイル優先の1カラム表示 + チャット操作ボタンの押しやすさを重視

## 機能

- GitHubリポジトリ一覧の取得・検索
- 選択リポジトリのローカルクローン + 状態表示
- Thread一覧取得 / 新規作成 / 再開
- Turn送信 + ストリーミング表示
- Markdown表示、diff検出時の等幅表示
- 画像添付（data URLとして送信）
- Turnキャンセル、承認API呼び出しエンドポイント

## 注意

Codex App Server 側のエンドポイント仕様に差異がある場合は `server.js` の `/api/threads`, `/api/turns/stream`, `/api/turns/cancel`, `/api/approvals/respond` を調整してください。
