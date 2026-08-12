# localStorage → Appwrite TablesDB 移行計画

最終更新: 2026-08-12
バックエンド: **Appwrite Cloud**（Auth + TablesDB）

**大原則: 移行完了が検証できるまで、既存 localStorage データを絶対に破壊しない。**

---

## 1. 現在の localStorage schema（移行前の実態）

### 1.1 移行対象（ユーザーの記録データ）

| キー | 型 | 内容 |
|---|---|---|
| `meals` | `Meal[]` | 食事記録 |
| `workouts` | `Workout[]` | 筋トレ記録 |
| `weight_history` | `WeightRecord[]` | 体重記録 |
| `user_goals` | `UserGoals` | 目標PFC・目標体重・トレーナースタイル |

### 1.2 移行対象（UI状態・ユーザー固有）

| キー | 移行先 |
|---|---|
| `hidden_workout_dates` | `profiles.hiddenWorkoutDates` |
| `custom_exercise_categories` | `profiles.customExerciseCategories`（JSON文字列） |
| `freeze_used_dates` | `profiles.freezeUsedDates` |
| `longest_streak` | `profiles.longestStreak` |

### 1.3 移行しない（端末ローカルのまま）

| キー | 理由 |
|---|---|
| `reminders_enabled` | 端末ごとの通知設定。Push subscription は端末に紐づく |
| `chat_messages` | AIチャットは非表示化済み。復活させない方針 |
| `estimatedMealCache:v2` | 単なるAPI応答キャッシュ。再取得可能 |
| `ai_usage_limits` | サーバー側の userId 単位 rate limit へ役割を移す |

### 1.4 既存の型定義（`src/types.ts`）

```ts
Meal          { id, date, name, calories, protein, fat, carbs,
                mealType?, servingLabel?, sourceType?, sourceLabel?, sourceUrl?, note? }
Workout       { id, date, exercises: Exercise[] }
Exercise      { id, name, sets: Set[] }
Set           { id, reps, weight }
WeightRecord  { id, date, weight }
UserGoals     { calories, protein, fat, carbs, targetWeight, trainerStyle? }
```

**既知の後方互換上の注意:**
- `Meal.date` を持たない古いレコードが存在しうる（`App.tsx` が `m.date || today` でフォールバック）
- `id` は `crypto.randomUUID()` または `Math.random()+Date.now()` のフォールバック
  → **UUID形式とは限らない**。Appwrite の rowId 制約（36文字以内・限定文字種）を満たさない
  可能性があるため、**そのまま rowId にはしない**（§3.2）

---

## 2. 新スキーマ（Appwrite TablesDB）

Appwrite Cloud Free は **1プロジェクトにつきデータベース1個**。
`liftandlean` データベース1つに、以下のテーブルを作る。

| テーブル | 用途 | Row Security | table-level権限 |
|---|---|---|---|
| `profiles` | ユーザー設定・UI状態 | **有効** | **なし** |
| `goals` | 目標PFC・目標体重 | **有効** | **なし** |
| `meals` | 食事記録 | **有効** | **なし** |
| `weights` | 体重記録 | **有効** | **なし** |
| `workouts` | 日単位のワークアウト | **有効** | **なし** |
| `workout_exercises` | 種目 | **有効** | **なし** |
| `workout_sets` | セット | **有効** | **なし** |
| `audit_log` | 監査ログ | **有効** | **なし**（行権限も付与しない＝サーバー専用） |
| `rate_limits` | レート制限カウンタ | **有効** | **なし**（同上） |

**table-level 権限を一切与えないのが要点。**
table-level を与えると「そのテーブルの全行」にアクセスできてしまう。
行ごとの権限だけで制御し、クライアントから Appwrite への直接アクセス経路を残さない。

各行は作成時にサーバーが以下の権限を付与する:

```
Permission.read(Role.user(ownerId))
Permission.update(Role.user(ownerId))
Permission.delete(Role.user(ownerId))
```

`audit_log` / `rate_limits` は**行権限も付与しない**（サーバーのAPI key経由でしか触れない）。
なお本番のAPI keyは `rows.write` のみを持つため、**サーバー自身もこの2つを読み出せない**。
監査ログは書くだけ、レート制限は増分操作だけで成立させている（§10）。

---

## 3. 移行対応表

| localStorage | Appwrite | 変換 |
|---|---|---|
| `Meal.id` | `meals.clientRequestId` | 文字列としてそのまま保持（**冪等キー**） |
| `Meal.date` | `meals.date` (string `YYYY-MM-DD`) | 欠損時は移行実行日（JST）で補完 |
| `Meal.name` | `meals.name` | 100文字で切り詰め |
| `Meal.calories/protein/fat/carbs` | 同名 (double) | 数値化。NaN は 0 |
| `Meal.mealType` | `meals.mealType` | |
| `Meal.servingLabel` | `meals.servingLabel` | |
| `Meal.sourceType` | `meals.sourceType` (enum) | official/web/ai_estimate 以外は未設定 |
| `Meal.sourceLabel/sourceUrl/note` | 同名 | |
| — | `meals.origin` | `'migration'` |
| — | `meals.needsReview` | 異常値を丸めた場合のみ `true` |
| `Workout.id` | `workouts.clientRequestId` | |
| `Workout.date` | `workouts.date` | |
| `Exercise.id` | `workout_exercises.clientRequestId` | |
| `Exercise.name` | `workout_exercises.name` | |
| `Set.id` | `workout_sets.clientRequestId` | |
| `Set.reps/weight` | `workout_sets.reps` / `weight` | |
| `WeightRecord.id` | `weights.clientRequestId` | |
| `WeightRecord.date/weight` | `weights.date` / `weight` | |
| `UserGoals.*` | `goals.*` | そのまま |
| `hidden_workout_dates` | `profiles.hiddenWorkoutDates` (string[]) | |
| `custom_exercise_categories` | `profiles.customExerciseCategories` (string) | JSON.stringify |
| `freeze_used_dates` | `profiles.freezeUsedDates` (string[]) | |
| `longest_streak` | `profiles.longestStreak` (integer) | |

### 3.1 冪等性の仕組み（Appwrite に適した方法）

Appwrite の unique index は**作成が非同期**で、直後は効かないことがある。
そのため index に依存せず、**rowId を決定的に導出する**。

```
rowId = 'r' + base36(sha256(userId + ':' + kind + ':' + naturalKey)).slice(0, 32)
```

| テーブル | naturalKey | 効果 |
|---|---|---|
| `meals` | `clientRequestId` | 二重POST防止 / 再実行安全 |
| `weights` | `date` | **1日1件**（同日は更新）＝既存アプリの挙動と一致 |
| `workouts` | `date` | **1日1件**＝既存アプリの挙動と一致 |
| `workout_exercises` | `clientRequestId + '#e' + i` | 追記の重複防止 |
| `workout_sets` | `clientRequestId + '#e' + i + 's' + j` | 同上 |

再実行すると同じ rowId になり、Appwrite が **409 Conflict** を返す。
サービス層はこれを「既に保存済み」として扱い、既存行を返す（**エラーにしない**）。

→ **同じデータを2回importしても重複しない。** ChatGPT の二重POST防止と同じ機構。

補助として複合 unique index（`userId` + `clientRequestId`）も作成する（多層防御）。

### 3.2 localStorage の id を rowId に使わない理由

Appwrite の rowId は「36文字以内・先頭は英数字・使用可能文字が限定」という制約がある。
既存の `safeUUID()` はフォールバック時に `Math.random().toString(36) + Date.now().toString(36)`
を返すため、制約を満たす保証がない。
そこで **id は `clientRequestId` 列に保存し、rowId は §3.1 のハッシュで導出**する。

### 3.3 既存データの異常値への対応

| 状況 | 対応 |
|---|---|
| 同一日に複数の `Workout` | 種目数が最も多いものを採用し、残りの exercises をマージ |
| 同一日に複数の `WeightRecord` | 配列内で**最後**のものを採用（既存 `addWeight` の挙動と一致） |
| `exercises` が空の `Workout` | skip（既存UIも `exercises.length > 0` でフィルタ） |
| `date` 欠損 | 移行実行日（JST）で補完 |
| 数値が NaN / 範囲外 | 範囲内へ丸め、`needsReview = true` を立てる |

---

## 4. データ消失防止

移行実行の**前**に必ず以下を行う。

1. **エクスポート経路を先に作る**
   設定画面に「データをJSONでバックアップ」を実装し、全 localStorage キーを
   1つの JSON にまとめてダウンロードする。**移行が何を壊してもここから復元できる**状態を先に作る
2. **移行はコピーであって移動ではない** — import 中も後も localStorage に書き込まない・削除しない
3. **検証が通るまで source of truth を切り替えない**（§5）
4. **失敗時に localStorage を削除しない** — 例外で落ちても localStorage は無傷。再実行は冪等

---

## 5. source of truth 切替手順

```
[1] バックアップDL機能を実装し、自分で1回ダウンロードして中身を確認
      ↓
[2] Appwrite へコピー（localStorage は読むだけ）
      ↓
[3] 件数・内容の検証
     - meals / workouts / weights の件数一致
     - 合計カロリー・合計セット数・体重の最新値が一致
     - 不一致なら中断（localStorage は無傷）
      ↓
[4] 検証OK → アプリの読み込み元を Appwrite に切替
      ↓
[5] 1週間の並行稼働（localStorage のデータはまだ残す）
      ↓
[6] 問題なければ移行用コードと旧キーを削除
```

**[4] より前は、アプリは今まで通り localStorage を source of truth として動く。**
つまり移行作業中もアプリは壊れない。

---

## 6. rollback 方針

| 段階 | rollback 方法 |
|---|---|
| [2] コピー中に失敗 | 何もしなくてよい。localStorage は無傷。Appwrite 側は `origin='migration'` で識別でき削除可能 |
| [3] 検証で不一致 | 同上。切替を行わない |
| [4] 切替後に不具合 | 環境変数 `VITE_DATA_SOURCE=local` で localStorage 読み込みへ戻す |
| [5] 並行稼働中 | 同上。完全復旧できる |
| [6] 削除後 | バックアップJSONから再import（冪等なので安全） |

`origin` 列を持たせているため、**移行由来の行だけを後から特定・削除できる**。

---

## 7. localStorage の cache 化方針

| 用途 | キー | 挙動 |
|---|---|---|
| 起動時キャッシュ | `cache:meals` 等 | 起動時に即描画 → Appwrite から取得して差し替え |
| オフライン同期キュー | `sync:queue` | オフライン時の書き込みを溜め、復帰後に送信（決定的rowIdなので冪等） |
| 端末設定 | `reminders_enabled` | 移行対象外 |

**旧キー（`meals`/`workouts`/`weight_history`/`user_goals`）には切替後は読み書きしない。**

---

## 8. 実施単位

リスクを下げるためテーブル単位で分けて適用する。

| 順 | 対象 | 理由 |
|---|---|---|
| 1 | `weights` | 最も単純。ここで権限と冪等性の挙動を確認する |
| 2 | `meals` | フラットだが列が多い |
| 3 | `workouts` → `workout_exercises` → `workout_sets` | 唯一のネスト構造 |
| 4 | `goals` + `profiles` | 1行だけなので最後 |

各段階で「件数一致」を確認してから次へ進む。

---

## 9. 実装状況（2026-08-12時点）

### 完了済み

| 対象 | 実体 | 検証 |
|---|---|---|
| バックアップDL（§4-1） | `src/utils/backup.ts` + 設定画面 | `tests/backup.test.ts` |
| 変換・正規化・冪等rowId（§3） | `api/migration-helpers.ts` | `tests/migration-helpers.test.ts` |
| 件数検証（§5-[3]） | `expectedCounts` / `planCounts` / `diffCounts` | 同上 |
| スキーマ as code（§2） | `scripts/appwrite-setup.ts` | **実Appwriteへ反映済み（88件）** |
| Appwrite Cloud プロジェクト | Singapore / `liftandlean` DB・9テーブル | `npm run db:verify` = 定義どおり |
| 認証（メール+パスワード） | `api/appwrite/auth.ts` + `/api/v1/auth/*` | `tests/v1-router.test.ts` |
| repository層 | `api/core/ports.ts` / `api/appwrite/repository.ts` | `tests/appwrite-repository.test.ts` |
| サービス層 | `api/core/service.ts` | `tests/service.test.ts` |
| REST（PWA用・MCPと共通のサービス層） | `api/v1/router.ts` | `tests/v1-router.test.ts` |
| 移行API（preview / 実行 / 検証） | `LiftAndLeanService.migrateFromBackup` ほか | `tests/migration-service.test.ts` |
| 移行UI | `src/components/CloudSync.tsx`（設定画面） | 実機確認は未 |
| デプロイ規約の固定 | `tests/build-conventions.test.ts` | §11の2件の障害を再発検出 |

**クラウドへ送るのは移行対象のキーだけ**（`buildMigrationPayload`）。
AIチャット履歴（`chat_messages`）と端末の通知設定は**送信もしない**。
バックアップDLは全キーを含む（復元のため）が、送信対象とは別に管理する。

### 層の構成

```
入口:  /api/v1/*（PWA）        将来: MCP tools（ChatGPT）
          └──────────┬──────────┘
サービス層（api/core/service.ts）… 検証・認可・JST・冪等性・rate limit・audit
          ↓
repository契約（api/core/ports.ts）… DB非依存。ここまではAppwriteを知らない
          ↓
Appwrite実装（api/appwrite/repository.ts）
```

**認証情報の使い分け**（`tests/appwrite-repository.test.ts` で強制）:
- 書き込み = API key（userIdと行権限をサーバーが権威的に決める）
- 読み取り = ユーザーのセッション（Appwriteが行権限を強制する）
- セッションが無いときは読み取りを**拒否する**。API keyでの代替はしない

---

## 10. 本番APIキーの最小権限（2026-08-12 監査）

**確定: 本番稼働用API keyに必要なscopeは `rows.write` のみ。**

| scope | 必要か | 根拠 |
|---|---|---|
| `rows.write` | **必要** | `AppwriteRepository` の createRow / upsertRow / updateRow / deleteRow / incrementRowColumn。行の所有者と権限をサーバーが権威的に決めるため、書き込みだけはAPIキーで行う |
| `rows.read` | **不要** | 読み取りは全てユーザーのセッション経由（`sessionTables`）。唯一APIキーで読んでいたレート制限カウンタを、増分操作（`incrementRowColumn`）へ置き換えて解消した。監査ログは書くだけで読まない |
| `users.read` / `users.write` | **不要** | Users API（管理者向け）を本番コードで一度も呼ばない。ユーザー作成は Account API（`account.create`）で行う |
| `sessions.write` | **不要** | セッションは `account.createEmailPasswordSession`（本人の資格情報で作る）。`users.createSession`（管理者が代理で作る）は使わない |
| `databases.*` / `tables.*` / `columns.*` / `indexes.*` | **不要（本番では）** | スキーマ操作は `scripts/appwrite-setup.ts` だけが行う。変更時に一時キーを発行する |

**この最小化で得られる性質: 本番APIキーが漏れても、利用者のデータは1行も読み出せない。**
書き換え・削除は可能なので無害ではないが、**情報漏洩と改ざんを切り離せている**。
（読み取り権限を1つ足すだけでこの性質は失われるので、安易に足さないこと）

実測での裏づけは `tests/integration/appwrite.test.ts` の
「本番APIキーは rows.write だけで全ての書き込み経路が動く」で行う。

---

## 11. デプロイ前チェック（2026-08-12 実施）

Vercel本番でだけ壊れる不具合を、pushの前にローカルで捕まえるための手順。

```
npx vercel build --yes                 # 実際のVercelビルダーで組む
find .vercel/output/functions -name "*.func" -type d   # 関数の数を数える
cd .vercel/output/functions/api/server.func && node -e "...handler を実際に呼ぶ"
```

**この手順で実際に見つかって直した本番障害が2件ある。**

| 見つかった問題 | 症状になったはずの結果 | 対処 |
|---|---|---|
| `api/` 配下の相対importに `.ts` を書いていた | Vercelは中身を `.js` にコンパイルするが**import文の拡張子は書き換えない**。実行時に `ERR_MODULE_NOT_FOUND` → **全API 500** | 相対importは `.js` で書く（TSは`.ts`へ、実行時は`.js`へ解決する）。テスト実行は `tsx` に変更して同じ解決規則に揃えた |
| 共有モジュールが1ファイル1関数になっていた | Serverless Functionが13個に増殖。**Hobbyの上限12個を超えてデプロイ失敗** | `api/` 直下のディレクトリを `_core` / `_appwrite` / `_v1` にリネーム。`_` 始まりは関数化されない。結果2個（`server` と既存の `meal-estimate-helpers`）に戻した |

どちらも `tests/build-conventions.test.ts` で固定してあるので、`npm test` で再発を検出できる。

### Appwrite本番プロジェクトへの疎通（秘密値を使わない確認）

`endpoint` と `project ID` は公開してよい値なので、API keyなしで確認できる。

| 確認 | 結果 |
|---|---|
| `GET /account`（未認証） | `401 general_unauthorized_scope` → プロジェクトが存在し到達できる |
| `POST /account/sessions/email`（存在しない資格情報） | `401 user_invalid_credentials` → **Email/Password認証が有効**で、かつ**Originヘッダの無いサーバーからのAccount API呼び出しが許可されている** |

2つ目が重要で、これが通らないとVercelの関数からサインアップ・ログインができない。
Appwriteのバージョンは 1.9.6。

### 移行の実行時間

移行は数千行の書き込みになる。1行ずつ直列に書くとVercelの実行時間上限（60秒）を超えるため、
`putOwnedRows` は**上限8の並行書き込み**にしてある（`WRITE_CONCURRENCY`）。
決定的rowIdのおかげで途中で落ちても再実行が安全なので、タイムアウトしてもデータは壊れない。

---

## 12. 残っている人間の作業

| # | 作業 | 状態 |
|---|---|---|
| 1 | 本番稼働用API keyの発行（scope: `rows.write` のみ） | **完了**（2026-08-12） |
| 2 | Vercelの環境変数へ4つを登録（API keyはSensitive・Productionのみ） | **完了**（2026-08-12） |
| 3 | Appwrite Console でメール+パスワード認証が有効か確認 | **完了**（疎通確認で実証済み・§11） |
| 4 | `git push` して本番へ反映する | **残っている** |
| 5 | 本番で1回サインアップ→「クラウドへコピー」→検証OKまで実機確認 | 残っている（push後） |

**4と5だけが残り。** コード・テスト・ビルド・疎通確認はすべて済んでいる。
実データでの移行だけは本番でしか確かめられないため、pushのあとにゆまが1回実施する。

`.env` の `APPWRITE_PROJECT_ID` は個人アカウント側（Singapore）の値へ修正済み。
`APPWRITE_API_KEY` は**空のまま**にしてある。

### 人間の作業1〜2が済んだあとに実装するもの

| 順 | 対象 | 前提 |
|---|---|---|
| 1 | 実Appwriteでの疎通確認（`APPWRITE_ALLOW_INTEGRATION_TESTS=1 npm run test:integration`） | API key |
| 2 | 読み込み元の切替（`VITE_DATA_SOURCE=db`）とオフライン同期キュー | 1 |
| 3 | MCPサーバー + OAuth リソースサーバー | 2 |
