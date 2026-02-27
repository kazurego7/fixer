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
- モバイル優先の画面構成（上: リポジトリ/Thread管理、下: 固定コンポーザー）
- 送信エリアを画面下に固定し、スマホ片手操作で「追指示→送信」を行いやすく調整

### 画面構成

1. リポジトリ選択（GitHub Token / 検索 / 一覧）
2. クローン状態（状態表示とクローン実行）
3. セッション一覧（一覧更新 / 新規Thread開始 / 再開）
4. チャット出力（ストリーミング表示）
5. 画面下固定コンポーザー（指示入力 / 送信 / 停止）

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
