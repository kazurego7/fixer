# Codex Mobile UI (MVP)

Codex App Server と通信する、モバイル向け Web UI です。

## クイックスタート

```bash
npm run build
npm start
```

起動後の確認:

```bash
curl -sS 'http://localhost:3000/api/health'
```

## 開発コマンド

- `npm run dev`: サーバー自動再起動 + フロント再ビルド監視
- `npm run web:dev`: フロントエンドのみ開発起動（Vite）
- `npm test`: ユニットテスト
- `npm run test:smoke`: Playwright スモークテスト
- `npm run test:all`: ユニット + スモーク

## 前提条件

- `gh` CLI がインストール済み
- `gh auth login` が完了済み
- Push 通知を使う場合は HTTPS でアクセス（Tailscale `serve` 推奨）

## 環境変数

- `PORT`（デフォルト: `3000`）

## 技術構成

- バックエンド: **Fastify v5**
- 静的配信: **@fastify/static**
- ログ: Fastify 標準ロガー（固定 `info`）
- フロントエンド: **React + Framework7**（Vite 事前ビルド）

## 画面フロー

1. 起動時に `gh auth` 接続状態を自動確認（成功時は一覧、失敗時はエラー画面）
2. リポジトリ選択（検索 / 一覧 / 選択）
3. 作業開始（クローン + Thread 作成を自動実行）
4. チャット出力を表示
5. 画面下固定コンポーザーを表示

## 主な機能

- GitHub リポジトリ一覧の取得・検索
- 選択リポジトリのローカルクローン + 状態表示
- Thread 新規作成（リポジトリ選択後に自動）
- Turn 送信 + ストリーミング表示
- Markdown 表示、diff 検出時の等幅表示
- 画像添付（data URL として送信）
- Turn キャンセル、承認 API 呼び出し

## ログ取得と動作確認

- ヘルスチェック:

```bash
curl -sS 'http://localhost:3000/api/health'
```

- サーバーログ（推奨）:

```bash
curl -sS 'http://localhost:3000/api/logs?limit=50'
curl -sS 'http://localhost:3000/api/logs?limit=200&level=error'
```

- スレッド一覧確認:

```bash
curl -sS 'http://localhost:3000/api/threads?repoFullName=OWNER%2FREPO'
```

トラブルシュート時の確認順:

1. `GET /api/health` でサーバー稼働確認
2. `GET /api/logs?limit=100` で直近ログ確認
3. 必要に応じて `level=error` で絞り込み
4. 送信不具合時は、送信直後のログを時刻付きで確認

## API 仕様差異がある場合

Codex App Server 側のエンドポイント仕様に差異がある場合は、`server.js` の以下を調整してください。

- `/api/threads`
- `/api/turns/stream`
- `/api/turns/steer`
- `/api/turns/cancel`
- `/api/approvals/respond`

クローン追跡は `event=clone_started|clone_succeeded|clone_failed` を確認できます。

## iOS Push 通知の設定

1. サーバーを起動（初回起動時に VAPID 鍵を自動生成）

```bash
npm run dev
```

2. Tailscale HTTPS で公開

```bash
tailscale serve https / http://127.0.0.1:3000
```

3. iPhone で `https://<マシン名>.<tailnet>.ts.net` にアクセスしてホーム画面に追加
4. チャット画面の通知ボタン（ベル）で通知を有効化
