# ChatGPT連携アーキテクチャ（確定版）

最終更新: 2026-08-11

## 0. 最上位目的

Lift & Lean を「アプリ内にAIチャットを持つサービス」ではなく、
**ユーザーが普段使っている ChatGPT を会話型の入力・参照UIとして利用し、
Lift & Lean は正しいデータ・状態・分析・実行を持つサービス**に進化させる。

最終UX（書き込み）:

```
ChatGPT「今日ベンチ60kgを10回3セットやった。Lift & Leanに記録して」
  → ChatGPTが構造化 → 必要なら確認 → Lift & Lean → DBへ正式保存
  → アプリを開くと既に反映済み
```

最終UX（読み取り）:

```
ChatGPT「前回の胸トレ何kgだった？」「今日タンパク質あと何g？」「今週何回トレした？」
  → Lift & Leanのデータを取得 → ChatGPTが回答
```

---

## 1. プラットフォーム仕様の確認結果（2026-08-11時点）

### 1.1 Custom GPTs の廃止について — **確認できなかった**

以前の設計案に「2026年4月22日に Custom GPTs 廃止が発表された」「メンテナンスモード」
「GPT Store が機能していない」と記載したが、**OpenAI公式情報では確認できなかった**。
これらは第三者ブログを出典としていたため、**設計判断の根拠から除外する**。

公式に確認できたのは以下の「モデル退役」のみであり、Custom GPTs 機能自体の廃止ではない:

- GPT-4o は 2026-02-13 に ChatGPT で非推奨化。Business/Enterprise/Edu は Custom GPTs 内で
  2026-04-03 まで利用可、以降は全プランで退役
- GPT-4.5 は 2026-06-26 に ChatGPT（Custom GPTs 含む）で利用終了
- 退役モデルを使う GPT は自動的に GPT-5.3 Instant / GPT-5.4 Thinking 相当へ移行

→ **結論に影響なし**。後述の通り Apps SDK / MCP を本命にする判断は、
プラットフォーム寿命の予測ではなく「交換可能性」と「マルチユーザー認証の標準性」に基づく。

### 1.2 Developer Mode と write 対応 — **個人プランで write まで可能**

OpenAI公式 (developers.openai.com/api/docs/guides/developer-mode) より:

- 対象プラン: **Pro, Plus, Business, Enterprise, Education**（web版）
- 機能: **"full Model Context Protocol (MCP) client support for all tools, both read and write"**
- write アクションは**デフォルトで確認を要求**する
- 公式ドキュメント上、プラン間の機能差は記載されていない

→ **ゆま個人のアカウントで write 込みのエンドツーエンド検証が可能**。
（第三者情報には「Proはread/fetchのみ」とする記述もあったが、これは developer mode ではなく
通常のコネクタの話と混同している可能性が高い。公式記述を優先する）

⚠️ ワークスペース管理者ポリシーで developer mode が無効化される事例が
コミュニティで報告されている。**個人アカウントでの利用可否は実機で確認すること**（人間作業）。

### 1.3 認証 — Supabase の OAuth 2.1 Server が MCP 準拠

**自前で OAuth 認可サーバーを書く必要はない。**

Supabase Auth は OAuth 2.1 Server 機能を持ち、公式に
"fully complies with the Model Context Protocol's OAuth 2.1 authentication spec" と記載:

| 機能 | 提供状況 |
|---|---|
| OAuth 2.1 + PKCE 必須 | ✅ Supabase 提供 |
| Dynamic Client Registration (MCPクライアント自動登録) | ✅ Supabase 提供 |
| JWKS エンドポイント | ✅ `/auth/v1/.well-known/jwks.json` |
| Authorization Server Metadata | ✅ `/.well-known/oauth-authorization-server/auth/v1` |
| OIDC (ID token / UserInfo) | ✅ ただし **RS256/ES256 が必須**（HS256では失敗） |
| 同意画面 | ⚠️ **自前で実装**（`/oauth/consent`。`getAuthorizationDetails()` を使う） |
| Protected Resource Metadata | ⚠️ **自前で実装**（MCPサーバー側の責務） |

制約:
- ベータ機能（2025-11-26 public beta）。全プランで無料
- redirect URI は**完全一致**のみ（ワイルドカード不可）
- 環境ごとに別の OAuth クライアントを作ることが推奨

→ **独自暗号・独自認証は一切書かない。** 我々が書くのは
「同意画面UI」と「リソースサーバー側のトークン検証」だけ。

---

## 2. 推奨アーキテクチャ

```
┌─────────────────────────────────────────────┐
│ ChatGPT （ユーザー自身の契約がコストを負担）        │
│  自然文理解 / 画像理解 / 構造化 / 曖昧解消 / 保存前確認 │
└────────────────────┬────────────────────────┘
                     │ OAuth 2.1 + PKCE(S256) / Bearer JWT
                     ↓
        ┌────────────────────────┐   ┌────────────────────┐
        │  MCP adapter           │   │  REST adapter      │
        │  /api/mcp              │   │  /api/v1/*         │
        └───────────┬────────────┘   └─────────┬──────────┘
                    │                          │
                    └──────────┬───────────────┘
                               ↓
         ┌──────────────────────────────────────┐
         │        【共通サービス層】               │
         │  authentication / authorization       │
         │  Zod validation / user isolation      │
         │  JST date normalization               │
         │  idempotency / rate limit / audit     │
         └──────────────────┬───────────────────┘
                            ↓
         ┌──────────────────────────────────────┐
         │  Supabase: Auth + Postgres + RLS      │
         └──────────────────────────────────────┘
                            ↑
                    ┌───────┴────────┐
                    │  PWA (React)   │
                    │  確認/編集/分析  │
                    └────────────────┘
```

**設計の核心: 入口は複数、ビジネスロジックは1つ。**

ChatGPT側の仕様（Actions / Apps SDK / MCP / 将来の別方式）が変わっても、
**交換するのは adapter だけ**。サービス層・DB・RLS・専門ロジックは無傷。

これが「特定のChatGPT接続方式に事業ロジックを密結合しない」という要件の実装形。

### 2.1 なぜ MCP / Apps SDK を本命にするか

プラットフォームの寿命予測ではなく、以下の構造的理由による:

1. **マルチユーザー認証が標準仕様**。1つの公開アプリ + ユーザーごとOAuthが正規の形
2. **developer mode で申請前に自分・友達とテストできる**（同じサーバーがそのまま公開に進む）
3. **read/write 両方が1つのプロトコルで扱える**（読み取りUXが要件に含まれる）
4. **adapter層に閉じ込められる**ので、外れても損失が adapter 分だけ

なお Custom GPT + Actions (OAuth) でも技術的にはマルチユーザー化が可能。
**両方を同時に生やすことも可能**（サービス層が共通のため、OpenAPI schema を1枚足すだけ）。
これはプラットフォームリスクのヘッジとして安価に確保できる。

---

## 3. 責務分担

| 処理 | 担当 | コスト負担 |
|---|---|---|
| 意図判定（記録か質問か） | ChatGPT | ユーザー |
| 自然文 → 構造化JSON | ChatGPT | ユーザー |
| 画像理解（料理・成分表） | ChatGPT | ユーザー |
| 曖昧解消の質問 | ChatGPT | ユーザー |
| 保存前の確認 | ChatGPT | ユーザー |
| 相対日付の解決 | ChatGPT（**サーバーで再検証**） | ユーザー |
| 認証・認可 | **Lift & Lean** | 自社 |
| schema validation | **Lift & Lean** | 自社 |
| JST正規化・範囲チェック | **Lift & Lean** | 自社 |
| 冪等性・保存 | **Lift & Lean** | 自社 |
| 集計・グラフ・分析 | **Lift & Lean** | 自社 |
| 栄養情報検索（食事のみ・任意） | Lift & Lean | **自社（唯一のAI従量）** |

**原則: Lift & Lean 側で同じ入力を再度LLM解析しない（二重課金の禁止）。**
筋トレ・体重は LLM 利用ゼロ。食事のみ例外を1つ設ける（§4）。

**Lift & Lean 内に汎用AIチャットを復活させない。**

---

## 4. 食事写真の処理方法

写真バイナリは **Lift & Lean に送らない・保存しない**。
ChatGPT が理解し、構造化データだけを送る。
サーバーコスト・ストレージ・プライバシーすべてで有利。

| ルート | 条件 | 数値の出どころ | 自社AIコスト | needs_review |
|---|---|---|---|---|
| **A. 成分表が写っている** | コンビニ商品など | ChatGPTが読んだ値をそのまま採用 | **0** | false |
| **B. チェーン店名が特定できる** | 松屋・マクドナルド等 | `resolve_nutrition` → 既存 estimate-meal（公式栄養成分をWeb検索） | **従量** | false |
| **C. 家庭料理・不明** | それ以外 | ChatGPTの推定を採用 | **0** | **true** |

- デフォルトは A / C（コスト0）
- B は「チェーン店名を検出」または「ユーザーが正確に調べてと明示」した時のみ
- B には **ユーザーあたり 1日10回** の上限（既存 `aiUsage.ts` の思想をサーバー側へ移設）
- C は `needs_review = true` を立て、アプリ側で目視確認を促す

B を残す理由: 既存の松屋対応・公式栄養成分検索・sourceType検証(official/web/ai_estimate)
という資産が既にあり、ChatGPTの素の推定より明確に正確なため。

---

## 5. Inbox は作らない

ChatGPT 上で保存確認が完了したものは、**そのまま正式DBへ保存**する。
アプリを開いて再度「取り込む」操作は不要。

代わりに保存済みレコードに `needs_review boolean` を持たせる。
これは Inbox ではなく**レコードの属性**なので、一般公開後もそのまま使える（捨てコードにならない）。

---

## 6. source of truth は DB

- 最終的な source of truth は **Postgres**
- localStorage は「起動時キャッシュ / オフライン対応 / 一時同期キュー」としてのみ利用
- **DB と localStorage の二重 source of truth は作らない**

詳細な移行手順は `.design/db-migration-plan.md` を参照。

---

## 7. MCP tools（最小構成）

| tool | 種別 | readOnlyHint | destructiveHint | openWorldHint |
|---|---|---|---|---|
| `log_meal` | 書き込み | false | **false**（追記のみ） | false |
| `log_weight` | 書き込み | false | **false**（同日は更新＝冪等） | false |
| `log_workout` | 書き込み | false | **false**（追記のみ） | false |
| `get_today_summary` | 読み取り | **true** | false | false |
| `get_recent_workouts` | 読み取り | **true** | false | false |
| `get_progress` | 読み取り | **true** | false | false |
| `resolve_nutrition` | 参照 | **true** | false | **true**（Web検索する） |

MCP仕様のデフォルトは `destructiveHint: true` / `openWorldHint: true` なので、
**追記系には明示的に false を設定する**（未設定だと ChatGPT が過剰に警告する）。

### 公開しない tool（最小権限）

- 削除（meal/workout/weight の delete）
- 目標の変更
- アカウント削除・メールアドレス変更
- 課金・支払い情報

→ これらに対応する **scope も tool も存在させない**。
トークンが漏洩しても構造的に実行できない。編集・削除はアプリ側で行う。

---

## 8. セキュリティ設計

| 要件 | 実装 |
|---|---|
| request body の user_id を信用しない | **アクセストークンの `sub` からのみ決定**。body の user_id は存在しても無視 |
| 他ユーザーのデータを絶対に読めない | **全個人テーブルで RLS 有効化**（`auth.uid() = user_id`）。DBはユーザーのJWTで叩くのでRLSが必ず効く（二重防御） |
| service_role をブラウザに出さない | service_role は audit_log / rate_limits 専用。フロントには anon key のみ |
| API secret を commit しない | `.gitignore` に `.env*` を追加済み。`.env.example` のみ commit |
| idempotency | `(user_id, client_request_id)` に **DB UNIQUE 制約**。アプリ層チェックより堅い |
| 二重POST防止 | 同上。競合時は既存レコードを返す（エラーにしない） |
| rate limit | user_id 単位。書き込み100/日、`resolve_nutrition` 10/日 |
| strict validation | Zod。重量0〜500kg、回数1〜100、カロリー0〜5000 等の範囲チェック |
| JST日付処理 | サーバーで `Asia/Tokyo` 固定。未来日は拒否、31日以上前は拒否 |
| audit log | `audit_log` テーブル: user_id / action / source(`app`\|`chatgpt`) / 結果 / 日時 |
| token revoke | Supabase の refresh token revoke。アプリの「連携を解除」で全トークン失効 |
| 最小scope | `log:write` `data:read` のみ。account系スコープを作らない |
| aud / iss / exp 検証 | JWKS で署名検証 + audience/issuer/expiry を毎回検証 |
| 本番ログに機密を出さない | トークン・メールアドレス・PFC実数値をログに出さない |
| privacy policy | 既存 `/privacy` に追記（OpenAIへの送信範囲・写真は保存しないこと・削除方法） |
| data deletion | アプリに「全データを削除」。DBカスケード削除 + トークン失効 |

---

## 9. コスト構造

### 従量課金になるもの（本構成）

| 項目 | 従量の軸 | 誰が払う |
|---|---|---|
| 会話・自然文理解・画像理解 | — | **ユーザーのChatGPT契約** |
| Supabase DB容量 | レコード数 | 自社 |
| Supabase MAU | 月間ログインユーザー数 | 自社 |
| Supabase egress | API通信量 | 自社 |
| Vercel Function実行 | リクエスト数・実行時間 | 自社 |
| `resolve_nutrition` (OpenAI) | **食事推定の呼び出し回数のみ** | 自社 |

### 規模別の見立て

概算: 1レコード約200バイト、1ユーザー1日5レコード → **年間約365KB/ユーザー**

| ユーザー数 | 年間データ量 | 想定 |
|---|---|---|
| 1 | 0.4MB | 全て無料枠内 |
| 100 | 36MB | 無料枠内 |
| 1,000 | 365MB | Supabase無料枠500MBを1年で圧迫 → Pro検討。Vercelも商用ならPro |
| 10,000 | 3.6GB | Pro + 容量課金 |

Supabase 無料枠: 500MB DB / 50,000 MAU / 5GB egress / 2プロジェクト
（1週間非アクティブで自動停止）。**MAUは当面問題にならず、効くのは容量とegress。**

**アプリ内にLLMチャットを持つ構成とは「桁」が違う。**
本構成の自社コストは**ユーザー数ではなくレコード数に比例**するため予測可能で安い。

⚠️ Vercel Hobby プランは商用利用不可。一般公開時は Pro が必要になる想定。

---

## 10. 段階的展開

| | Phase 1: 自分だけ | Phase 2: 友達2人 | Phase 3: 一般公開 |
|---|---|---|---|
| 認証 | Supabase Auth | 同じ | 同じ |
| データ | Postgres + RLS | 同じ | 同じ |
| アプリ | PWAをDB化 | 同じ | 同じ |
| ChatGPT | MCP + OAuth / developer mode | 同じ（各自のアカウントで接続） | directory申請 |
| 追加作業 | — | （コード追加なし） | 規約・削除UI・申請 |

**Phase 1→3 で捨てるコードがほぼゼロ。**
OAuth を最初から入れるため、Phase 2 のユーザー分離は初日から本物。

---

## 11. 一般公開時にも残るもの / MVP限定で捨てるもの

### ✅ そのまま残る
- Supabase スキーマ + RLSポリシー
- Supabase Auth（メール/Googleログイン）
- 共通サービス層（validation / 認可 / JST / 冪等性 / rate limit / audit）
- REST API `/api/v1/*`
- MCP サーバー + tool定義
- OAuth リソースサーバー実装 + 同意画面
- 既存 `estimate-meal`（`resolve_nutrition` として再利用）
- 既存の表示コンポーネント全部（SectionDiet / Analysis / Dashboard / Workout / Settings）

### 🗑 後から捨てる（意図的に小さくした）
- `src/utils/aiUsage.ts` のlocalStorage版（サーバー側へ移設後に削除）— 81行
- localStorage 移行ユーティリティ（全ユーザー移行完了後に削除）— 移行専用コード
- developer mode の接続設定（申請通過後は不要）— コードではなく設定

---

## 12. 既存機能で触らない・壊さないもの

ChatGPT連携に無関係な挙動変更は禁止。特に:

- 通知 / cron / KV / CRON_SECRET / Push subscription
- AIチャットの非表示状態（復活させない）
- AI目標提案の数値ロジック（クランプ・中間目標の計算）
- 食事の日付切替UX / 食事編集UX / 既存PFC表示
- Dashboard の既存計算（ストリーク・達成率）
- 既存の estimate-meal / analyze-meal のプロンプトと精度

DB移行のために内部実装が変わっても、**ユーザーから見た挙動は維持する**。
