# NotifyBox

管理者承認型の内部通知アプリです。外部メール・SMSは使わず、利用者は受信箱で通知を確認します。外部サービスの認証コードを受け取ったり、他社の認証を代替・回避する用途ではありません。

データベースは **Supabase (PostgreSQL)** を使います。

## セットアップ

### 1. Supabase プロジェクトを作る
1. https://supabase.com でプロジェクトを作成
2. **SQL Editor** を開き、`schema.sql` の内容を貼り付けて実行（テーブルと RLS が作られます）
3. **Project Settings > API** から以下を控える
   - Project URL → `SUPABASE_URL`
   - `service_role` キー → `SUPABASE_SERVICE_ROLE_KEY`

### 2. アプリを起動する
```bash
npm install
cp .env.example .env   # 値を編集（下記参照）
npm start              # http://localhost:3000
```

`.env` で次を設定します。
- `SESSION_SECRET`: `openssl rand -hex 32` などで生成した長い文字列
- `ADMIN_PASSWORD`: 12文字以上。初回起動時に管理者アカウントを作成します
- `SUPABASE_SERVICE_ROLE_KEY`: サーバー専用。フロントエンドやGitに含めないでください

管理者パスワードは初回作成後は変更されません。変更する場合は、Supabase の Table Editor で `users` の `password_hash` を削除してから再起動すると、新しい値で作り直されます（その管理者の既存データは残りません）。

## 機能
- **利用登録**: ユーザー名・パスワード・申請理由を入力。承認まで利用不可
- **審査**: 管理画面で申請理由を確認し、承認・拒否
- **状態管理**: 有効 / 停止 / 再開。停止すると即座にログインできなくなります
- **受信箱**: 未読は `NEW` 表示、ナビの未読件数バッジ
- **通知送信**: 個別または有効な利用者全員へ送信（お知らせ / 内部コード）
- **ユーザー一覧**: ページ送り付き
- **監査ログ**: 承認・拒否・停止・再開・通知送信を記録し、管理画面で閲覧可能
- **セッション**: Supabase の `sessions` テーブルに保存（再起動してもログイン維持、8時間で失効）
- **セキュリティ**: bcrypt ハッシュ、CSRF トークン、HttpOnly / SameSite Cookie、レート制限、helmet、RLS

## 構成
| ファイル | 役割 |
|---|---|
| `server.js` | ルーティング、認可、レート制限、起動処理 |
| `db.js` | Supabase への問い合わせ |
| `sessionStore.js` | express-session の Supabase 実装 |
| `views.js` | HTML 描画（ユーザー入力はすべてエスケープ） |
| `schema.sql` | テーブル定義と RLS 設定 |

## 本番公開前の確認事項
- HTTPS 環境で `NODE_ENV=production` にする（Secure Cookie が有効になります）
- Supabase の `service_role` キーは環境変数でのみ管理し、ログに出さない
- 管理者アカウントの多要素認証（現状は未実装）
- Supabase のバックアップ設定（プランによりPITR/日次バックアップの有無が異なります）
- アカウント削除・パスワードリセットの運用手順
- プライバシーポリシーと関連法規への対応
- IP ベースの登録制限は簡易的です。共有ネットワークでは正当な申請者も制限され得ます

## 旧版（SQLite）からの移行
旧版の `app.db` は自動では移行されません。必要な場合は既存ユーザーを Supabase の Table Editor から手動で登録してください（パスワードハッシュは bcrypt 形式のまま流用できます）。
