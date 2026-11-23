# NotifyBox 認証コード API

自分が運用するアプリから、NotifyBox に登録済みの利用者の受信箱へ6桁の認証コードを送り、入力されたコードを検証するための API です。

## 準備

1. 管理者でログインし、「外部アプリ」画面でアプリ名を入力して追加します。
2. 表示された API キー（`nbk_` + 48文字）を保存します。**この画面でしか表示されません。**
3. キーはサーバー側の環境変数で管理し、フロントエンド（ブラウザ・スマホアプリ）には絶対に入れないでください。

## 共通

- ベースURL: `https://mail-production-b951d236.up.railway.app/api/v1`
- 認証ヘッダー: `Authorization: Bearer nbk_xxxxxxxx...`
- 形式: `Content-Type: application/json`（リクエスト・レスポンスとも JSON）
- 制限: 1キーあたり毎分60リクエストまで

## 1. コード送信

`POST /codes/send`

```json
{ "username": "alice" }
```

成功（200）:

```json
{ "id": "3f2b8c1e-....", "expires_in": 600 }
```

- 利用者の受信箱に「【アプリ名】認証コード」が届きます。
- コードの有効期限は10分（`expires_in` は秒）です。
- `id` は検証時に必要なので、アプリ側で保持してください。
- 同じアプリ・同じ利用者への送信は10分に5回までです。

## 2. コード検証

`POST /codes/verify`

```json
{ "id": "3f2b8c1e-....", "code": "123456" }
```

成功（200）:

```json
{ "valid": true, "username": "alice" }
```

失敗（200）:

```json
{ "valid": false, "reason": "mismatch" }
```

| reason | 意味 |
|---|---|
| `mismatch` | コードが違う（1回につき試行回数を1消費） |
| `expired` | 有効期限切れ |
| `already_used` | 使用済み（コードは1回のみ有効） |
| `too_many_attempts` | 試行5回を超えた（再送信が必要） |
| `not_found` | id が存在しない、または他アプリのコード |
| `bad_request` | id またはコードの形式が不正（コードは数字6桁） |

## エラー（HTTPステータス）

| status | error | 意味 |
|---|---|---|
| 401 | `invalid_api_key` | キーが無い・違う・アプリが無効化されている |
| 404 | `user_not_found` | ユーザーが存在しない、または有効な利用者ではない |
| 429 | `too_many_codes` | 同じ利用者への送信が10分に5回を超えた |
| 429 | `rate_limited` | 毎分60リクエストを超えた |
| 400 | `invalid_json` | JSON が不正 |
| 500 | `server_error` | サーバーエラー |

## 使用例

### curl

```bash
# 送信
curl -X POST https://YOUR-DOMAIN/api/v1/codes/send \
  -H "Authorization: Bearer $NOTIFYBOX_KEY" \
  -H "Content-Type: application/json" \
  -d '{"username":"alice"}'

# 検証
curl -X POST https://YOUR-DOMAIN/api/v1/codes/verify \
  -H "Authorization: Bearer $NOTIFYBOX_KEY" \
  -H "Content-Type: application/json" \
  -d '{"id":"3f2b8c1e-....","code":"123456"}'
```

### Node.js (18+)

```js
const BASE = 'https://YOUR-DOMAIN/api/v1';
const headers = {
  'Authorization': `Bearer ${process.env.NOTIFYBOX_KEY}`,
  'Content-Type': 'application/json',
};

async function sendCode(username) {
  const res = await fetch(`${BASE}/codes/send`, {
    method: 'POST', headers, body: JSON.stringify({ username }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error);
  return data.id; // 検証用に保持する
}

async function verifyCode(id, code) {
  const res = await fetch(`${BASE}/codes/verify`, {
    method: 'POST', headers, body: JSON.stringify({ id, code }),
  });
  return res.json(); // { valid: true, username } など
}
```

### Python

```python
import os, requests

BASE = "https://YOUR-DOMAIN/api/v1"
H = {"Authorization": f"Bearer {os.environ['NOTIFYBOX_KEY']}"}

def send_code(username):
    r = requests.post(f"{BASE}/codes/send", json={"username": username}, headers=H, timeout=10)
    r.raise_for_status()
    return r.json()["id"]

def verify_code(code_id, code):
    r = requests.post(f"{BASE}/codes/verify", json={"id": code_id, "code": code}, headers=H, timeout=10)
    return r.json()
```

## 典型的なログインフロー

1. 利用者がユーザー名を入力する。
2. アプリのサーバーが `/codes/send` を呼び、返ってきた `id` をセッションなどに保存する。
3. 利用者が NotifyBox の受信箱でコードを確認し、アプリに入力する。
4. アプリのサーバーが `/codes/verify` を呼ぶ。
5. `valid: true` ならログイン成功。**必ずサーバー側で判定してください。**

## セキュリティ上の注意

- API キーを漏らした場合は、管理画面でそのアプリを削除し、新しく作り直してください。
- コードは受信箱の本人にだけ表示され、管理画面の送信履歴にも保存されません。
- 利用者を特定できる情報（ユーザー名の存在有無）を、そのまま画面に出さない設計にしてください。
