# ChatGPT連携アーキテクチャ（確定版 / Appwrite）

最終更新: 2026-08-11
バックエンド: **Appwrite Cloud**（Auth + TablesDB）

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

以前の設計案に「2026年4月22日に Custom GPTs 廃止が発表された」と記載したが、
**OpenAI公式情報では確認できなかった**（出典は第三者ブログ）。
**設計判断の根拠から除外する。**

公式に確認できたのは「モデルの退役」のみで、Custom GPTs 機能自体の廃止ではない:
GPT-4o は 2026-02-13 に ChatGPT で非推奨化（Business/Enterprise/Edu の Custom GPTs 内では
2026-04-03 まで）、GPT-4.5 は 2026-06-26 に利用終了。退役モデルを使う GPT は
GPT-5.3 Instant / GPT-5.4 Thinking 相当へ自動移行。

→ Apps SDK / MCP を本命にする判断は、プラットフォーム寿命の予測ではなく
**「入口を交換可能にする」構造と、マルチユーザー認証の標準性**に基づく（§2.1）。

### 1.2 Developer Mode と write 対応 — **個人プランで write まで可能**

OpenAI公式 (developers.openai.com/api/docs/guides/developer-mode):

- 対象プラン: **Pro, Plus, Business, Enterprise, Education**（web版）
- **"full Model Context Protocol (MCP) client support for all tools, both read and write"**
- write アクションは**デフォルトで確認を要求**する
- 公式ドキュメント上、プラン間の機能差の記載はない

→ ゆま個人のアカウントで write 込みのエンドツーエンド検証ができる見込み。

⚠️ ワークスペースのポリシーで無効化される事例がコミュニティで報告されている。
**実機での可否確認は人間作業**として残る。

### 1.3 Appwrite の認証・権限モデル

| 項目 | 内容 |
|---|---|
| データ構造 | TablesDB: database > **tables** > **rows** / **columns** |
| 権限の考え方 | **grant-based**（既定はアクセス不可。付与して初めてアクセスできる） |
| 権限レベル | **table-level**（全行に適用）と **row-level**（行ごと） |
| Row Security | テーブル設定で**明示的に有効化**しないと row-level 権限が効かない |
| ロール | `Role.any()` / `Role.guests()` / `Role.users()` / `Role.user(ID)` / `Role.team(ID[,role])` / `Role.member(ID)` / `Role.label(NAME)` |
| 権限種別 | `Permission.read` / `create` / `update` / `delete` |
| API key | **admin権限。権限チェックを完全にバイパスする**（サーバー専用） |
| JWT (client) | `account.createJWT()`。**15分**または セッション削除で失効 |
| JWT (server) | `users.createJWT({userId, sessionId, duration})`（API key必要） |
| JWT利用時 | サーバーSDKが**そのユーザーの権限に従う**（＝権限が強制される） |
| 一意制約 | `tablesDB.createIndex({type:'unique', attributes:[...]})`（複合可・**作成は非同期**） |

### 1.4 Appwrite は OAuth 2.1 認可サーバーではない ⚠️ 未決事項

Appwrite の OAuth2 は「Googleでログイン」のような**consumer側**の機能であり、
**第三者クライアント（ChatGPT）にトークンを発行する authorization server ではない。**

MCP は OAuth 2.1 + PKCE + DCR/CIMD を要求するため、**認可サーバーを別途用意する必要がある**。
選択肢は §12 に整理する。**MCPサーバーを公開する段階までこの決定に依存しないため、先行して実装を進める。**

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
         │   repository層（Appwrite依存はここだけ） │
         └──────────────────┬───────────────────┘
                            ↓
         ┌──────────────────────────────────────┐
         │  Appwrite Cloud: Auth + TablesDB      │
         └──────────────────────────────────────┘
                            ↑
                    ┌───────┴────────┐
                    │  PWA (React)   │
                    │  確認/編集/分析  │
                    └────────────────┘
```

**設計の核心: 入口は複数、ビジネスロジックは1つ、DB依存は repository 層だけ。**

- ChatGPT側の仕様が変わっても、交換するのは **adapter** だけ
- Appwrite から別のDBに移っても、交換するのは **repository** だけ
- サービス層（validation / 認可 / JST / 冪等性 / rate limit / audit）は**どちらの変更でも無傷**

### 2.1 なぜ MCP / Apps SDK を本命にするか

1. マルチユーザー認証が標準仕様（1つの公開アプリ + ユーザーごとOAuth）
2. developer mode で申請前に自分・友達とテストでき、同じサーバーがそのまま公開に進む
3. read/write 両方が1つのプロトコルで扱える
4. adapter層に閉じ込められるので、外れても損失が adapter 分だけ

Custom GPT + Actions (OAuth) も技術的には可能。サービス層が共通なので
**OpenAPI schema を1枚足すだけで併存できる**（プラットフォームリスクの安価なヘッジ）。

---

## 3. 責務分担

| 処理 | 担当 | コスト負担 |
|---|---|---|
| 意図判定 / 自然文→構造化 / 画像理解 / 曖昧解消 / 保存前確認 | ChatGPT | **ユーザー** |
| 相対日付の解決 | ChatGPT（**サーバーで再検証**） | ユーザー |
| 認証・認可 / validation / JST正規化 / 冪等性 / 保存 / 集計 | **Lift & Lean** | 自社 |
| 栄養情報検索（食事のみ・任意） | Lift & Lean | **自社（唯一のAI従量）** |

**原則: Lift & Lean 側で同じ入力を再度LLM解析しない（二重課金の禁止）。**
筋トレ・体重は LLM 利用ゼロ。食事のみ例外を1つ設ける（§4）。
**Lift & Lean 内に汎用AIチャットを復活させない。**

---

## 4. 食事写真の処理方法

写真バイナリは **Lift & Lean に送らない・保存しない**（Appwrite Storage も使わない）。

| ルート | 条件 | 数値の出どころ | 自社AIコスト | needs_review |
|---|---|---|---|---|
| **A. 成分表が写っている** | コンビニ商品など | ChatGPTが読んだ値をそのまま採用 | **0** | false |
| **B. チェーン店名が特定できる** | 松屋・マクドナルド等 | `resolve_nutrition` → 既存 estimate-meal | **従量** | false |
| **C. 家庭料理・不明** | それ以外 | ChatGPTの推定を採用 | **0** | **true** |

- デフォルトは A / C（コスト0）
- B は「チェーン店名を検出」or「ユーザーが明示」した時のみ。**1日10回**の上限
- 既存の松屋対応・公式栄養成分検索・sourceType検証の資産をそのまま活かす

---

## 5. Inbox は作らない

ChatGPT 上で保存確認が完了したものは**そのまま正式DBへ保存**。
アプリを開いて再度「取り込む」操作は不要。
代わりに `needsReview` 列を持たせる（Inboxではなく**レコードの属性**なので捨てコードにならない）。

---

## 6. source of truth は Appwrite

- 最終的な source of truth は **Appwrite TablesDB**
- localStorage は「起動時キャッシュ / オフライン対応 / 一時同期キュー」としてのみ利用
- **二重 source of truth は作らない**

詳細は `.design/db-migration-plan.md`。

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

MCP仕様の既定は `destructiveHint: true` / `openWorldHint: true` のため、
**追記系には明示的に false を設定する**（未設定だと ChatGPT が過剰に警告する）。

### 公開しない tool（最小権限）
削除 / 目標変更 / アカウント削除 / メール変更 / 課金。
→ **対応する scope も tool も存在させない。** 編集・削除はアプリ側で行う。

---

## 8. セキュリティ設計（Appwrite版）

### 8.1 権限モデル — RLSの名前替えではなく Appwrite ネイティブ設計

| 設定 | 値 | 理由 |
|---|---|---|
| **Row Security** | **全ユーザーテーブルで有効** | 行ごとの権限を効かせるために必須 |
| **table-level 権限** | **空（誰にも付与しない）** | table-level を付けると**全行にアクセスできてしまう**ため |
| **row-level 権限**（行作成時にサーバーが付与） | `read/update/delete` を `Role.user(ownerId)` のみ | 本人以外は物理的に到達できない |
| **クライアントからAppwriteへの直接アクセス** | **不可能**（table-level create を付与しない） | Appwrite の client SDK は project ID だけで到達できるため、直接書き込みの余地を残さない |

### 8.2 読み書きの経路を非対称にする（重要）

| 操作 | 使う資格情報 | 理由 |
|---|---|---|
| **書き込み** | **API key（admin）** | `userId` と行権限を**サーバーが権威的に決める**。クライアントの申告を一切信用しない |
| **読み取り** | **ユーザーのJWT**（`users.createJWT` で発行） | Appwriteが行権限を強制する。**アプリ層にバグがあっても他人の行は返らない**（二重防御） |

危険な方向（読み取り＝情報漏洩）に対してプラットフォーム側の強制を効かせ、
書き込みは権威的に制御する。API key を読み取りに使わないことが要。

### 8.3 その他の必須要件

| 要件 | 実装 |
|---|---|
| request body の user_id を信用しない | **アクセストークンから解決した userId のみ使用**。body の userId は無視 |
| API key をフロントへ出さない | API key はサーバー専用。フロントは project ID とユーザーセッションのみ |
| secret を commit しない | `.gitignore` に `.env*` を追加済み。`.env.example` のみ追跡 |
| 冪等性 | **決定的 rowId**（§8.4）。二重POSTは 409 になり、既存行を返す |
| rate limit | userId 単位。書き込み100/日、`resolve_nutrition` 10/日 |
| strict validation | Zod。重量0〜500kg、回数1〜1000、カロリー0〜20000 等 |
| JST日付処理 | サーバーで `Asia/Tokyo` 固定。未来日は拒否、31日以上前は拒否 |
| audit log | `audit_log` テーブル。**本人にも read 権限を与えない**（サーバー専用） |
| token revoke | 連携解除でセッション削除 → JWT も即失効（15分ではなく即時） |
| 最小scope | `log:write` `data:read` のみ |
| 本番ログに機密を出さない | トークン・メール・PFC実数値をログに出さない |
| privacy policy | 既存 `/privacy` に追記 |
| data deletion | アプリに「全データを削除」 |

### 8.4 冪等性 — Appwrite に適した方法（決定的 rowId）

Appwrite の unique index は**作成が非同期**で、作成直後は効かない可能性がある。
そのため index に依存せず、**rowId 自体を決定的に導出する**。

```
rowId = base36( sha256( userId + ':' + kind + ':' + naturalKey ) ) を36文字以内に切り詰め
```

| テーブル | naturalKey | 効果 |
|---|---|---|
| `meals` | `clientRequestId` | 二重POST防止 / 移行の再実行安全 |
| `weights` | `date` | **1日1件**（同日は更新）。既存アプリの挙動と一致 |
| `workouts` | `date` | **1日1件**。既存アプリの挙動と一致 |
| `workout_exercises` | `clientRequestId + '#e' + index` | 追記の重複防止 |
| `workout_sets` | `clientRequestId + '#e' + i + 's' + j` | 同上 |

- 同じ内容の再送 → 同じ rowId → **409 Conflict** → 既存行を取得して返す（エラーにしない）
- 移行時は `clientRequestId = localStorageのid` とするため、**再実行しても重複しない**
- rowId は推測可能になるが、行権限で保護されるため**アクセス制御上の問題はない**
- 補助として複合 unique index も作成する（多層防御。非同期構築が完了すれば効く）

---

## 9. コスト構造

### 従量課金になるもの

| 項目 | 従量の軸 | 誰が払う |
|---|---|---|
| 会話・自然文理解・画像理解 | — | **ユーザーのChatGPT契約** |
| Appwrite: 帯域 / ストレージ / DB読み書き / MAU | レコード数・アクセス数 | 自社 |
| Vercel Function実行 | リクエスト数・実行時間 | 自社 |
| `resolve_nutrition` (OpenAI) | **食事推定の呼び出し回数のみ** | 自社 |

### Appwrite Cloud の枠

| | Free ($0) | Pro (from $25/mo) |
|---|---|---|
| 帯域 | 5GB | 2TB |
| ストレージ | 2GB | 150GB |
| MAU | 75,000 | 200,000 |
| DB | **1 / project** | 無制限 |
| プロジェクト | 2 | — |
| DB読み | — | 1,750K/月（超過 $0.06/100k） |
| DB書き | — | 750K/月（超過 $0.10/100k） |
| **超過時** | **プロジェクトが凍結（コンソールは読み取り専用）** | 稼働継続・追加課金 |

⚠️ **Free は超過するとプロジェクトが凍結する。** 一般公開前に Pro へ上げるか、
上限アラートを設定すること。開発用と本番用でプロジェクトを分ける（Free枠は2プロジェクト）。

### 規模別の見立て

概算: 1行 約200バイト、1ユーザー1日5行 → **年間約365KB/ユーザー**

| ユーザー数 | 年間データ量 | 想定 |
|---|---|---|
| 1 | 0.4MB | Free枠内 |
| 100 | 36MB | Free枠内（帯域5GBに注意） |
| 1,000 | 365MB | 帯域・書き込み数で Pro が必要になる可能性 |
| 10,000 | 3.6GB | Pro + 従量 |

**アプリ内にLLMチャットを持つ構成とは「桁」が違う。**
自社コストは**ユーザー数ではなくレコード数・アクセス数に比例**するため予測可能。

⚠️ Vercel Hobby プランは商用利用不可。一般公開時は Pro が必要になる想定。

---

## 10. 段階的展開

| | Phase 1: 自分だけ | Phase 2: 友達2人 | Phase 3: 一般公開 |
|---|---|---|---|
| 認証 | Appwrite Auth | 同じ | 同じ |
| データ | Appwrite TablesDB + 行権限 | 同じ | 同じ |
| アプリ | PWAをDB化 | 同じ | 同じ |
| ChatGPT | MCP + OAuth / developer mode | 同じ（各自のアカウントで接続） | directory申請 |
| 追加作業 | — | （コード追加なし） | 規約・削除UI・申請 |

---

## 11. 一般公開時にも残るもの / MVP限定で捨てるもの

### ✅ そのまま残る
- Appwrite スキーマ定義（schema-as-code）と権限設計
- Appwrite Auth
- 共通サービス層（validation / 認可 / JST / 冪等性 / rate limit / audit）
- repository 層
- REST API `/api/v1/*`
- MCP サーバー + tool定義
- OAuth リソースサーバー実装 + 同意画面
- 既存 `estimate-meal`（`resolve_nutrition` として再利用）
- 既存の表示コンポーネント全部

### 🗑 後から捨てる（意図的に小さくした）
- `src/utils/aiUsage.ts` のlocalStorage版（サーバー側へ移設後に削除）— 81行
- localStorage 移行ユーティリティ（全ユーザー移行完了後に削除）
- developer mode の接続設定（申請通過後は不要）— コードではなく設定

---

## 12. OAuth 認可サーバー（決定済み: 案A / 2026-08-13 実装完了）

Appwrite は第三者向けの OAuth 2.1 認可サーバー機能を持たないため、別途必要だった。
検討した3案は下記。**採用したのは案A（Vercel上の最小認可サーバー）**で、
決め手は「IDをAppwriteに一本化したまま追加課金なしで済むこと」。
実装量の懸念は、MCP公式SDKの `mcpAuthRouter` が
discovery / PKCE照合 / エラー形式を持っているため、
自前で書くのは「本人確認して認可コードを出す」部分だけになり解消した。

| 案 | 内容 | 利点 | 欠点 |
|---|---|---|---|
| **A. 自前の最小AS** | Vercel上に authorize / token / jwks / DCR / discovery を実装。ユーザー認証は Appwrite Auth に委譲。code / refresh token は TablesDB に保存 | 追加課金ゼロ。ID体系が Appwrite に一本化される | 実装量が最大（600〜900行）。セキュリティ責任を負う |
| **B. 外部IdPをASにする** | Stytch / WorkOS / Auth0 / Logto 等。MCP向けOAuth（DCR対応）を提供する製品がある | 標準実装を再利用。実装量が小さい | ID体系が二重化（IdP と Appwrite Auth の紐付けが必要）。無料枠の制約 |
| **C. 外部IdPを唯一のIDにする** | 認証は全て IdP。Appwrite は純粋にDBとして使う（API key + 行権限） | ID体系は一本 | Appwrite Auth を使わなくなる。行権限の `Role.user()` 用に Appwrite ユーザーの作成/同期が必要 |

### 実際に作ったもの

ChatGPTへ渡すのは**Lift & Lean が `/api/mcp` 向けに発行した専用トークン**だけ。

> **2026-08-13 修正**: 当初はAppwriteのセッションをそのままアクセストークンとして
> 渡す設計だった。これは「Appwriteに対する利用者本人の資格情報」であって
> MCPの資源向けに発行されたものではなく、受け取った側がAppwriteのAPIを
> 直接叩けてしまう。MCP仕様が禁じる**トークンの素通し**にあたるため作り直した。
> 詳細は §15。

| 経路 | 実体 |
|---|---|
| `/.well-known/oauth-protected-resource[/api/mcp]` | 保護リソースの案内（RFC 9728） |
| `/.well-known/oauth-authorization-server` | 認可サーバーの案内（RFC 8414）。SDK提供 |
| `/authorize` → `/oauth/consent` | 同意画面。**パスワードを入力する唯一の場所** |
| `/token` | 認可コード → アクセストークン。PKCE(S256)必須 |
| `/register` | 動的クライアント登録（SDK提供） |
| `/revoke` | 連携解除 |
| `/api/mcp` | MCP本体（Streamable HTTP・セッションを持たない形） |

認可コードは Vercel KV に2分だけ置き、1回使ったら消す（本番で疎通確認済み）。
戻り先URLは許可リスト方式（ChatGPTのコネクタ受け口とローカル検証用のみ）。

---

## 13. 既存機能で触らない・壊さないもの

ChatGPT連携に無関係な挙動変更は禁止。特に:

- 通知 / cron / KV / CRON_SECRET / Push subscription
- AIチャットの非表示状態（復活させない）
- AI目標提案の数値ロジック（クランプ・中間目標の計算）
- 食事の日付切替UX / 食事編集UX / 既存PFC表示
- Dashboard の既存計算（ストリーク・達成率）
- 既存の estimate-meal / analyze-meal のプロンプトと精度

DB移行のために内部実装が変わっても、**ユーザーから見た挙動は維持する**。

---

## 14. 実装状況（2026-08-13）

### 公開した道具（6つ）

| 道具 | 種別 | 内容 |
|---|---|---|
| `log_meal` | 書き | 食事を記録。栄養値は必須（ChatGPT側で確定させてから渡す） |
| `log_weight` | 書き | 体重を記録 |
| `log_workout` | 書き | 筋トレ1種目分（セット配列）を記録 |
| `get_today_summary` | 読み | 今日の合計・目標・残り |
| `get_recent_workouts` | 読み | 直近の筋トレ |
| `get_progress` | 読み | 体重推移・記録の継続状況 |

削除・目標変更・アカウント操作・支払い・自由なDB問い合わせ・鍵の操作は**出していない**。

### 守っていること

- **本人の特定はトークンだけで行う**。道具の引数に `userId` を渡されても無視する
  （プロトコルE2Eで、他人のIDを差し込んでも自分のデータしか動かないことを確認済み）
- **道具の中に業務ロジックを置かない**。日付の解釈もPFCの計算も既存の `LiftAndLeanService` 側にある
- **再送で二重登録しない**。`利用者ID + 道具名 + 引数 + 5分の枠` から決まる鍵で行IDを決める
- **ChatGPTが出した栄養値は正本として確定させない**。`origin: chatgpt` / `sourceType: ai_estimate` /
  `needsReview` を立てて保存する
- 日付の扱いはアプリ経由より厳しい側（31日制限あり）に寄せる

### 確認できたこと / まだ確認できていないこと

**確認できた（本番）**: メタデータ2種の整合、`/authorize` `/token` `/register` `/revoke` が
SPAに飲まれず届くこと、KVへの読み書き、トークン無しの `/api/mcp` が
`WWW-Authenticate` 付き401を返すこと、既存PWA・REST APIが無傷であること。

**確認できた（ローカルのプロトコルE2E・23件）**: initialize / tools/list の注釈 /
無効・失効・メール未確認トークンの拒否 / 書き3種 / 再送の重複排除 / 読み3種 /
他人のデータ分離 / userId差し込みの無効化 / 壊れた入力 / 同意→コード→トークン→MCP接続の一連 /
PKCE不一致・コード使い回し・パスワード誤り・許可外の戻り先の拒否。

**確認できた（2026-08-13 の認証境界の修正後）**: テスト243件。
素通しの拒否・別の相手向けトークンの拒否・期限切れ・取り消し・
更新トークンの入れ替えと使い回しの検出・応答/戻り先URL/ログへの漏れが無いこと。
本番では `/register` に秘密が付かないこと、`/token` の2つの grant_type が
正しいエラー形式を返すこと、`/api/mcp` の401を実測。

**まだ**: ChatGPT実機からの接続（開発者モードの有効化が要るため人手）。

---

## 15. アクセストークンの作り（2026-08-13 修正）

### 構造

```
ChatGPT
  │  Bearer <Lift & Lean が /api/mcp 向けに発行した不透明トークン>
  ▼
/api/mcp  ──▶ サーバー側で本人とAppwriteセッションへ解決
                     │
                     ▼
             LiftAndLeanService ──▶ Appwrite
```

**Appwriteのセッションはサーバー側から出ない。** ChatGPTはその値を知らない。

### トークンの性質

| 条件 | どう満たすか |
|---|---|
| 推測できない | `randomBytes(32)` の不透明な値。中身に意味を持たせない |
| 相手を固定 | 発行時に `resource` を記録に焼き付け、**使うたびに `/api/mcp` と一致するか確かめる** |
| 短命 | アクセストークン1時間 |
| 平文で保存しない | 保管庫の鍵は `sha256(トークン)`。生の値はどこにも残らない |
| 期限の検証 | 記録の期限を毎回確認。切れていれば401 |
| 取り消せる | 連携1件ぶん（grant）をまとめて無効化 |
| Appwriteとは別物 | 別々に生成し、対応表はサーバー側だけが持つ |

### Appwriteセッションの置き方

保管庫（Vercel KV）には、**提示されたトークンから導いた鍵で封をして**置く
（HKDF-SHA256 で鍵を導き、AES-256-GCM で封をする。どちらも標準の道具で、暗号は自作しない）。
保管庫ごと抜かれても、トークンを持っていない限り開けられない。

### 更新トークン

公開クライアントなので**毎回入れ替える**（OAuth 2.1 の必須事項）。
使い終わった更新トークンは消さずに「使用済み」として残し、
再び出てきたら盗まれたとみなして**その連携ごと無効にする**。
正規の利用者はつなぎ直すことになるが、盗んだ側だけが使い続けられる状態よりましだと判断した。

### 相手が食い違うときの扱い

| 場面 | 挙動 |
|---|---|
| 認可時に別の `resource` を要求 | コードを発行しない |
| 交換時に認可時と違う `resource` を要求 | `invalid_target` |
| 別の相手向けトークンで `/api/mcp` | 401 |
| Appwriteセッションを直接持ち込む | 401（記録が無い） |

### 解除したときに何が起きるか

トークン一式と連携の記録を消し、**この連携用に作ったAppwriteセッションだけ**を削除する。
本人がアプリで使っているログインには触れない。
