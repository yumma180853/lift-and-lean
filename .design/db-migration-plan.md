# localStorage → Appwrite TablesDB 移行計画

最終更新: 2026-08-11
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

`audit_log` / `rate_limits` は**行権限も付与しない**（API key を持つサーバーのみアクセス可能）。

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

## 9. 実装状況（2026-08-11時点）

### 実装済み（Appwriteアカウント無しで動くもの）

| 対象 | 実体 | 検証 |
|---|---|---|
| バックアップDL（§4-1） | `src/utils/backup.ts` + 設定画面のカード | `tests/backup.test.ts` |
| 変換・正規化・冪等rowId（§3） | `api/migration-helpers.ts` | `tests/migration-helpers.test.ts` |
| 件数検証（§5-[3]） | `expectedCounts` / `planCounts` / `diffCounts` | 同上 |
| スキーマ as code（§2） | `scripts/appwrite-setup.ts` | `npm run db:verify` |

`normalizeBackup()` は Appwrite に接続しないため、移行の正しさは全て
ローカルの単体テストで確認できる。DBに触るのは書き込み層だけ。

### 人間の作業（ここから先はゆまが手を動かす必要がある）

1. Appwrite Cloud でプロジェクトを作成
2. API key を発行（scope: databases / tables / rows / users の read+write）
3. `cp .env.example .env` して `APPWRITE_PROJECT_ID` と `APPWRITE_API_KEY` を記入
4. `npm run db:setup` → `npm run db:verify` が「定義どおりです」になるまで

### その後に実装するもの

| 順 | 対象 | 前提 |
|---|---|---|
| 1 | Appwrite Auth でのログイン（userId の確定） | 上記4まで完了 |
| 2 | `/api/migrate`（バックアップJSONを受け取り冪等に書き込む） | 1 |
| 3 | 件数検証UI → 読み込み元の切替（`VITE_DATA_SOURCE=db`） | 2 |
| 4 | MCPサーバー + OAuth リソースサーバー | 3 |
