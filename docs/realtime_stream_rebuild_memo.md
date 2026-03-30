# リアルタイム出力 設計仕様

最終更新: 2026-03-30

## 目的

チャット欄のリアルタイム出力を、Codex App Server の仕様に合わせて安定動作させる。

満たすべき要件:

- ユーザー送信後、返答をリアルタイム表示する
- ブラウザを閉じて再度開いても、リアルタイム表示を再開できる
- 再開時は、即時に出せる内容は通常表示し、その後に増える差分だけをライブ表示する
- 返答途中でも追加送信できる
- 追加送信前の返答は同一カード内に維持し、追加送信が反映された後の返答は次カードで表示する
- ライブ出力中でも、入力・戻る・スレッド切替など必要な操作を継続できる

## 公式仕様の要点

確認元:

- OpenAI Developers: `https://developers.openai.com/codex/app-server`
- OpenAI: `https://openai.com/index/unlocking-the-codex-harness/`
- ローカル CLI: `codex-cli 0.117.0`
- ローカル生成スキーマ:
  - `/tmp/codex-app-schema/v2/ThreadReadResponse.json`
  - `/tmp/codex-app-schema/v2/TurnStartParams.json`
  - `/tmp/codex-app-schema/v2/TurnSteerParams.json`
  - `/tmp/codex-app-schema/v2/TurnStartedNotification.json`
  - `/tmp/codex-app-schema/v2/TurnCompletedNotification.json`
  - `/tmp/codex-app-schema/ToolRequestUserInputParams.json`

重要ポイント:

- `codex app-server` は JSON-RPC 2.0 ベース
- `thread/read` は履歴取得であり、ライブ購読開始ではない
- `turn/steer` は同じ turn に追加入力するための操作である
- turn の真実は `item/*` 通知にあり、特に `item/completed` が最終状態の権威になる
- `item/agentMessage/delta` は途中差分であり、最終表示そのものではない
- `item/plan/delta` は途中差分であり、最終 `plan` item と一致しない可能性がある
- `item/reasoning/summaryTextDelta` / `item/reasoning/textDelta` はライブ表示用の思考系差分である
- `item/tool/requestUserInput` は会話の見た目上も境界として扱う必要がある
- `turn/completed` は `completed` / `interrupted` / `failed` を取りうる

## 最終仕様の要約

最終的な責務分担は以下とする。

- App Server:
  - `item/*` と `turn/*` 通知を出す一次情報源
- このアプリのサーバー:
  - App Server 通知を turn 単位の live state に正規化する
  - クライアント再開用に snapshot と連番付きイベント列を持つ
- クライアント:
  - 履歴は `thread/read` を表示する
  - 進行中 turn だけは server 正規化済みの `live-state` / `turn_state` で上書きする
  - delta を自前で再構築しない

この設計で、履歴表示とライブ表示の責務を分離しつつ、表示内容の最終責任を server 側の正規化に集約する。

## サーバー側の最終仕様

### 1. live state を turn 単位で保持する

サーバーは thread ごとに「いま進行中の turn の表示状態」を保持する。

保持対象:

- `threadId`
- `turnId`
- 現在までに観測した item 群
- 正規化済みの current turn 表示 items
- `liveReasoningText`
- 再開用 `seq`
- `afterSeq` 用イベントバッファ
- running / done / error などの状態

理由:

- App Server の通知は差分中心で、そのままでは再接続後の表示再構築が不安定になる
- クライアントごとに再構築させると、同じ turn でも表示がずれやすい
- 途中送信時のカード境界を client 推測にすると壊れやすい

### 2. `turn_state` を server 正規化イベントとして出す

クライアントへは、App Server の raw delta ではなく、server が正規化した `turn_state` を流す。

`turn_state` が持つ意味:

- 「いまこの turn をどう描画すべきか」の現在値
- assistant だけでなく current turn 全体の表示単位
- steer 後のカード分割結果も含んだ描画用状態

理由:

- delta の連結だけでは最終表示を一意に決められない
- `plan` や `reasoning` は途中差分と最終 item が一致しないことがある
- UI の複雑な判断を client に持たせると、再開時・途中送信時の不整合が増える

### 3. `request_user_input` をカード境界として扱う

`item/tool/requestUserInput` を受けたら、その位置を assistant カード分割の境界として扱う。

理由:

- これは単なるツール通知ではなく、ユーザーへの応答フローが切り替わる点だから
- 見た目上ここを連結すると、「どこまでが元の返答か」が分かりにくくなる
- 途中送信や承認 UI を挟むケースで、履歴とライブの見た目を揃えやすい

### 4. 再開は snapshot + afterSeq で行う

サーバーは以下を提供する。

- `/api/turns/live-state`
  - 現時点の進行中 turn snapshot を返す
- `/api/turns/stream`
  - 新規 turn 開始と live stream
- `/api/turns/stream/resume?afterSeq=...`
  - 指定 seq より後の増分だけを再購読する

理由:

- `thread/read` とライブ購読開始の間には必ずレースがある
- snapshot がないと、再開時に「どこまで通常表示してよいか」が決まらない
- `afterSeq` がないと、再開時に重複表示か欠落のどちらかが起きやすい

### 5. terminal state は server で確定させる

`turn/completed` と error 通知を受けたら、server 側で live state を `done` / `error` として確定し、クライアントへ流す。

理由:

- 中断、失敗、完了の判定は App Server 通知系列全体を見て決めるべきで、client の手元状態だけでは不十分
- 複数クライアントや再接続を考えると、終端判定は server 側に寄せた方が一貫する

## クライアント側の最終仕様

### 1. 履歴表示は `thread/read` を正とする

スレッドを開いたとき、まず `thread/read` 相当の履歴を表示する。

理由:

- 履歴はライブ差分ではなく、既に確定した表示を出すべきだから
- 画面再表示時にまず安定した内容を出せる

### 2. 進行中 turn だけを `live-state` で overlay する

進行中 turn がある場合だけ、`live-state` の current turn 表示を履歴に重ねる。

理由:

- 履歴全体をライブ状態で置き換える必要はない
- 問題になるのは「いま進行中の turn」だけである
- overlay に限定すると、履歴とライブの責務が明確になる

### 3. 再開時は「即時表示」と「増分ライブ」を分ける

ブラウザ再表示時の順序は以下とする。

1. `thread/read` で履歴を通常表示する
2. `live-state` があれば current turn を通常表示として overlay する
3. `afterSeq` 付き resume stream を開始する
4. それ以降に増えたものだけをライブ表示する

理由:

- 再開直後に snapshot 内容まで live 演出すると、既に確定済みの内容を再生したように見えて不自然
- ユーザーが必要なのは「いまから増えるもの」であって、「もう出ているものの再演」ではない

### 4. 途中送信は `turn/steer` を優先する

返答途中の追加送信では、進行中 turn が存在し、対応する `turnId` が確定していれば `turn/steer` を使う。

`turnId` が未確定、または steer 不可の状態なら:

- 現在の stream を静かに中断する
- 新しい turn を通常開始する

理由:

- 公式仕様上、途中送信はまず同一 turn への steer として扱うのが正しい
- ただし local UI 側で `turnId` を持てていない瞬間もあるため、その場合は安全側に倒す
- 「とにかく送れない」より、「静かに切り替えて送れる」方が UX 上まし

### 5. カード分割は「送信クリック時」ではなく「server 反映時」で決める

途中送信後の表示規則:

- 追加送信が server にまだ反映されていない区間は、元の assistant カードのまま表示する
- 追加送信が item 境界として反映された時点で、次のカードへ進める

理由:

- 送信クリック時点で split すると、実際の履歴とライブ表示がずれやすい
- steer は同一 turn 内の入力なので、「どこからが別カードか」は App Server 側の item 境界で決めるべき
- これにより、履歴再取得後の見た目とライブ中の見た目を揃えられる

### 6. ライブ出力中も操作は止めない

ライブ出力中でも以下は継続してできるようにする。

- 追加入力
- 戻る
- スレッド切替
- 停止

ただし、repo / thread の基準状態を切り替えている短い排他区間だけは `busy` として制御する。

理由:

- `streaming` は「返答が流れている」だけであり、UI 全体を止める理由にはならない
- 本当に止めるべきなのは、thread 切替や新規 thread 作成のように競合しうる短い区間だけである

### 7. 入力欄は live 中でも操作しやすく保つ

composer は以下を満たす。

- 内容量に応じて自動伸長する
- composer 高さに応じてチャット下部余白を追従させる
- `visualViewport` を見て、モバイル keyboard 表示時に下へ沈まない

理由:

- ライブ中の追加入力を許すなら、入力欄の操作性も維持しなければ要件を満たしたことにならない
- 固定 footer のままだと、keyboard 表示時に入力欄が隠れたり、複数行入力がしづらくなる

## 採用しない仕様

- 旧 delta ベース UI の後方互換は維持しない
- client 側で `answer_delta` / `reasoning_delta` / `plan_delta` を再構築しない
- 途中送信時に client 推測でカード split しない
- resume 直後に snapshot 内容をライブ演出しない

理由:

- 後方互換を残すほど、表示系の分岐と不整合が増える
- 今回必要なのは「正しく再開できること」であって、「過去の不安定な経路を残すこと」ではない

## この仕様で解決する問題

- 再開時の欠落
  - `live-state` + `afterSeq` により、履歴取得と再購読の間の穴を埋める
- 再開時の重複演出
  - snapshot は通常表示、以後の増分だけをライブ表示にする
- 途中送信時のカード不整合
  - split を server 反映済み境界に従わせる
- plan / reasoning の不安定な差分連結
  - raw delta ではなく server 正規化結果を描画する
- ライブ中の操作不能
  - `streaming` と `busy` を分離し、必要な操作だけを止めない

## 検証

確認済み:

- `npm test`
- `npm run build`
- `npm run test:e2e`

E2E では特に以下を確認済み:

- ブラウザ再表示後の live 再開
- 返答途中の追加入力
- steer 後の表示継続
- ライブ中の戻る
- ライブ中の入力欄再入力と自動伸長
