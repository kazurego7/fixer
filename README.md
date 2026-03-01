# Codex Mobile UI (MVP)

Codex App Server と通信するスマホ向けWeb UIです。

## 起動

```bash
npm run build
npm start
```

開発時（サーバー自動再起動 + フロント再ビルド監視）:

```bash
npm run dev
```

フロント開発:

```bash
npm run web:dev
```

バックエンド:
- APIサーバー: **Fastify v5**
- 静的配信: **@fastify/static**
- ログ: Fastify標準ロガー（固定 `info`）

環境変数:

- `PORT` (default: `3000`)

前提:
- `gh` CLI がインストール済みであること
- `gh auth login` が完了していること

## UI

- UI: **React + Framework7**（Vite事前ビルド）
- モバイル優先で、アクセス時に `gh auth` 接続状態を自動確認
- 接続失敗時はメインUIではなく、原因表示専用画面を表示
- リポジトリ選択後は下部固定CTAで作業開始

### 画面構成

1. 起動時の接続自動確認（成功時は一覧へ、失敗時はエラー画面へ）
2. リポジトリ選択（検索 / 一覧 / 選択）
3. 作業開始（クローン + Thread作成を自動実行）
4. チャット出力（準備完了後に表示）
5. 画面下固定コンポーザー（準備完了後に表示）

## 機能

- GitHubリポジトリ一覧の取得・検索
- 選択リポジトリのローカルクローン + 状態表示
- Thread新規作成（リポジトリ選択後に自動）
- Turn送信 + ストリーミング表示
- Markdown表示、diff検出時の等幅表示
- 画像添付（data URLとして送信）
- Turnキャンセル、承認API呼び出しエンドポイント

## 注意

Codex App Server 側のエンドポイント仕様に差異がある場合は `server.js` の `/api/threads`, `/api/turns/stream`, `/api/turns/cancel`, `/api/approvals/respond` を調整してください。

デバッグ用に `GET /api/logs?limit=200&level=error` でサーバーログ（メモリ保持分）を取得できます。クローン追跡は `event=clone_started|clone_succeeded|clone_failed` を確認してください。
