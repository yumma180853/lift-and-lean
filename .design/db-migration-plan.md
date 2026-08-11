# localStorage → Supabase Postgres 移行計画

最終更新: 2026-08-11

**大原則: 移行完了が検証できるまで、既存 localStorage データを絶対に破壊しない。**

---

## 1. 現在の localStorage schema（移行前の実態）

`src/App.tsx` および各コンポーネントで使用中のキー一覧。

### 1.1 移行対象（ユーザーの記録データ）

| キー | 型 | 内容 |
|---|---|---|
| `meals` | `Meal[]` | 食事記録 |
| `workouts` | `Workout[]` | 筋トレ記録 |
| `weight_history` | `WeightRecord[]` | 体重記録 |
| `user_goals` | `UserGoals` | 目標PFC・目標体重・トレーナースタイル |

### 1.2 移行対象（UI状態・ユーザー固有だが軽量）

| キー | 型 | 内容 | 扱い |
|---|---|---|---|
| `hidden_workout_dates` | `string[]` | 履歴一覧から非表示にした日付 | DBへ（`profiles.hidden_workout_dates`） |
| `custom_exercise_categories` | `Record<string,string>` | ユーザー定義の種目→部位 | DBへ（`profiles.custom_exercise_categories`） |
| `freeze_used_dates` | `string[]` | ストリークのフリーズ使用日 | DBへ（`profiles.freeze_used_dates`） |
| `longest_streak` | `number` | 最長ストリーク | DBへ（`profiles.longest_streak`） |

### 1.3 移行しない（端末ローカルのままでよい）

| キー | 理由 |
|---|---|
| `reminders_enabled` | 端末ごとの通知設定。Push subscription は端末に紐づくため移行しない |
| `chat_messages` | AIチャットは非表示化済み。復活させない方針のため移行しない |
| `estimatedMealCache:v2` | 単なる API 応答キャッシュ。再取得可能 |
| `ai_usage_limits` | サーバー側の user 単位 rate limit へ役割を移す（§7） |

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
- `Meal.date` を持たない古いレコードが存在しうる（`App.tsx` で `m.date || today` とフォールバックしている）
  → 移行時も同じフォールバックを適用する
- `id` は `crypto.randomUUID()` または `Math.random()+Date.now()` のフォールバック
  → **UUID形式とは限らない**。DB の主キーには使わず `client_request_id`（text）に入れる

---

## 2. 新 DB schema

| テーブル | 主キー | ユニーク制約 | 備考 |
|---|---|---|---|
| `profiles` | `id` (= auth.users.id) | — | UI状態もここに集約 |
| `goals` | `user_id` | — | 1ユーザー1行 |
| `meals` | `id` (uuid) | `(user_id, client_request_id)` | 冪等性 |
| `weights` | `id` (uuid) | `(user_id, date)` / `(user_id, client_request_id)` | 1日1件（既存挙動と一致） |
| `workouts` | `id` (uuid) | `(user_id, date)` / `(user_id, client_request_id)` | 1日1件（既存挙動と一致） |
| `workout_exercises` | `id` (uuid) | `(user_id, client_request_id)` | `workout_id` に FK |
| `workout_sets` | `id` (uuid) | `(user_id, client_request_id)` | `exercise_id` に FK |
| `audit_log` | `id` (bigint) | — | service_role のみ |
| `rate_limits` | `(user_id, bucket, window_start)` | 同左 | service_role のみ |

全ユーザーテーブルに `user_id uuid not null references auth.users(id) on delete cascade` を持たせ、
`workout_exercises` / `workout_sets` にも **user_id を非正規化して保持**する
（RLSポリシーを単純かつ高速にするため）。

---

## 3. 移行対応表

| localStorage | DB | 変換 |
|---|---|---|
| `Meal.id` | `meals.client_request_id` | そのまま文字列として保存（**冪等キーになる**） |
| `Meal.date` | `meals.date` (date) | 欠損時は移行実行日（JST）で補完 |
| `Meal.name` | `meals.name` | 50文字で切り詰め |
| `Meal.calories/protein/fat/carbs` | 同名 (numeric) | 数値化。NaN は 0 |
| `Meal.mealType` | `meals.meal_type` | |
| `Meal.servingLabel` | `meals.serving_label` | |
| `Meal.sourceType` | `meals.source_type` | enum 検証（official/web/ai_estimate）。不正値は null |
| `Meal.sourceLabel/sourceUrl/note` | `source_label`/`source_url`/`note` | |
| — | `meals.origin` | `'migration'` を設定 |
| — | `meals.needs_review` | `false` |
| `Workout.id` | `workouts.client_request_id` | |
| `Workout.date` | `workouts.date` | |
| `Exercise.id` | `workout_exercises.client_request_id` | |
| `Exercise.name` | `workout_exercises.name` | |
| `Set.id` | `workout_sets.client_request_id` | |
| `Set.reps/weight` | `workout_sets.reps` / `weight` | |
| `WeightRecord.id` | `weights.client_request_id` | |
| `WeightRecord.date/weight` | `weights.date` / `weight` | |
| `UserGoals.*` | `goals.*` | camelCase → snake_case |
| `hidden_workout_dates` | `profiles.hidden_workout_dates` (date[]) | |
| `custom_exercise_categories` | `profiles.custom_exercise_categories` (jsonb) | |
| `freeze_used_dates` | `profiles.freeze_used_dates` (date[]) | |
| `longest_streak` | `profiles.longest_streak` (int) | |

### 3.1 移行の冪等性

**localStorage の `id` を `client_request_id` に入れることで、
再実行しても UNIQUE 制約により重複しない。**

- 同じデータを2回 import → 2回目は `ON CONFLICT DO NOTHING` で skip
- 部分的に失敗して途中から再開しても安全
- ChatGPT からの二重POST防止と**同じ機構**を使う（専用コードを増やさない）

### 3.2 既存データの異常値への対応

| 状況 | 対応 |
|---|---|
| 同一日に複数の `Workout` | 最も種目数が多いものを採用し、残りの exercises をマージ |
| 同一日に複数の `WeightRecord` | 配列内で**最後**のものを採用（既存 `addWeight` の挙動と一致） |
| `exercises` が空の `Workout` | skip（既存UIも `exercises.length > 0` でフィルタしている） |
| `date` 欠損 | 移行実行日（JST）で補完 |
| 数値が NaN / 範囲外 | 0 にクランプし、`needs_review = true` を立てる |

---

## 4. データ消失防止

移行実行の**前**に必ず以下を行う。

1. **エクスポート経路を先に作る**
   設定画面に「データをJSONでバックアップ」を実装。
   全 localStorage キーを1つの JSON にまとめてダウンロードする。
   → 移行が何をどう壊しても、ここから復元できる状態を先に作る

2. **移行はコピーであって移動ではない**
   import 実行中も実行後も localStorage には一切書き込まない・削除しない

3. **検証が通るまで source of truth を切り替えない**（§5）

4. **失敗時に localStorage を削除しない**
   import が例外で落ちても localStorage は無傷。再実行すれば冪等に続きから進む

---

## 5. source of truth 切替手順

```
[1] バックアップDL機能を実装・自分で1回ダウンロードして中身を確認
        ↓
[2] DBへコピー（localStorage は読むだけ）
        ↓
[3] 件数・内容の検証
     - meals / workouts / weights の件数が一致するか
     - 合計カロリー・合計セット数・体重の最新値が一致するか
     - 不一致なら中断し、localStorage は無傷のまま
        ↓
[4] 検証OK → アプリの読み込み元を DB に切り替え
     （localStorage は読み込みキャッシュに格下げ）
        ↓
[5] 1週間並行稼働で様子を見る（localStorage のデータはまだ残す）
        ↓
[6] 問題なければ移行用コードと旧キーを削除
```

**[4] より前は、アプリは今まで通り localStorage を source of truth として動く。**
つまり移行作業中もアプリは壊れない。

---

## 6. rollback 方針

| 段階 | rollback 方法 |
|---|---|
| [2] コピー中に失敗 | 何もしなくてよい。localStorage は無傷。DBの行は `origin='migration'` で識別でき、削除可能 |
| [3] 検証で不一致 | 同上。切替を行わない |
| [4] 切替後に不具合 | フラグ1つで localStorage 読み込みへ戻す（`VITE_DATA_SOURCE=local`）。DBの書き込みは残るが読まれない |
| [5] 並行稼働中 | 同上。localStorage が残っているので完全復旧できる |
| [6] 削除後 | バックアップJSONから再import（冪等なので安全） |

`origin` カラムを持たせているため、**移行由来の行だけを後から特定・削除できる**。

---

## 7. localStorage の cache 化方針

切替後の localStorage の役割:

| 用途 | キー | 挙動 |
|---|---|---|
| 起動時キャッシュ | `cache:meals` 等 | 起動時に即描画 → DBから取得して差し替え。体感速度を落とさない |
| オフライン同期キュー | `sync:queue` | オフライン時の書き込みを溜め、復帰後に順次送信（client_request_id 付きなので冪等） |
| 端末設定 | `reminders_enabled` | 移行対象外。そのまま |

**旧キー（`meals` / `workouts` / `weight_history` / `user_goals`）には切替後は書き込まない。**
二重 source of truth を作らないため、読み込みも行わない（[6] で削除）。

`ai_usage_limits` はサーバー側の `rate_limits` テーブルへ役割を移す。
移行期間中は両方が動いても実害がない（サーバー側が真の上限、クライアント側は表示用の目安）。

---

## 8. migration の実施単位

リスクを下げるため、**テーブル単位で分けて適用する**。

| 順 | 対象 | 理由 |
|---|---|---|
| 1 | `weights` | 最も単純（フラットで1日1件）。ここでRLSと冪等性の挙動を確認する |
| 2 | `meals` | フラットだが列が多い |
| 3 | `workouts` → `workout_exercises` → `workout_sets` | 唯一のネスト構造。最後に回す |
| 4 | `goals` + `profiles` のUI状態 | 1行だけなので最後でよい |

各段階で「件数一致」を確認してから次へ進む。
