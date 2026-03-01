# AGENTS

## ログ取得方法

### サーバーログ（推奨）
- エンドポイント: `GET /api/logs`
- 例:
  - `curl -sS 'http://localhost:3000/api/logs?limit=50'`
  - `curl -sS 'http://localhost:3000/api/logs?limit=200&level=error'`

### 動作確認用
- ヘルスチェック:
  - `curl -sS 'http://localhost:3000/api/health'`
- スレッド一覧確認:
  - `curl -sS 'http://localhost:3000/api/threads?repoFullName=OWNER%2FREPO'`

### トラブルシュート時の確認順
1. `GET /api/health` でサーバー稼働確認
2. `GET /api/logs?limit=100` で直近ログ確認
3. 必要に応じて `level=error` で絞り込み
4. 送信不具合時は、送信直後のログを時刻付きで確認
