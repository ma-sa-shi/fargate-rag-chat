# 社内ナレッジ検索RAGアプリ

社内ドキュメントを検索し、その記載根拠に基づいて回答を生成する RAG チャットアプリです。ECS Fargate Spot とスケジュール停止（夜間・休日）を組み合わせることで、常駐構成ながら運用コストを大幅に削減しています。

## デモ

https://github.com/user-attachments/assets/5617046a-c229-4914-a120-0a7c6836cfe1

## 背景と目的

手順書や過去の案件資料といった社内ドキュメントは、蓄積が進むにつれて保管場所が分散し、「どこに何があるかわからない」状態に陥りがちです。また、保管場所が分かっていても、ドキュメントの量が多いと必要な情報に辿り着くまでに時間がかかります。

本アプリは、アップロードされたドキュメントを対象に RAG チャットを提供し、必要な情報へ素早くアクセスできるようにすることを目的としています。
特徴として、生成された回答は LLM 自身が自動評価（Self-RAG）し、根拠が不足している場合は検索クエリを自動修正して再試行します。また、チャット履歴を全ユーザーに公開することで、得られた回答を組織のナレッジとして共有・活用できます。

## アーキテクチャ

![アプリ設計](./docs/diagrams/アプリ設計.svg)

フロントエンドには Next.js（App Router）を採用しています。認証やファイルアップロードは Server Actions から MySQL / S3 を直接操作し、チャット通信のみ Route Handler（`/api/chat-stream`）を経由して SSE をストリーミング配信します。一部 FastAPI を経由しない経路があるため、完全な BFF 構成ではありません。

認証フローでは、Server Actions が MySQL の認証情報を argon2 で検証し、`session_token`（httpOnly クッキー）として JWT を発行します。認証が必要な各ページでは、`getUserIdFromToken()` を使用してこのクッキーを検証します。

| サービス | 責務 | 実行構成 |
|---|---|---|
| rag-app-nextjs | 画面、認証、ファイルアップロード、SSEプロキシ | Fargate Spot / port 3000 / cloudflaredサイドカー |
| rag-app-fastapi | Embedding生成・Chroma登録、LangGraphによるSelf-RAG実行・SSE配信 | Fargate Spot / port 8000 / EFSマウント |

パブリックアクセスには ALB を使用せず、Next.js タスク内の `cloudflared` サイドカーからアウトバウンドのトンネルを確立しています。これにより、インバウンドポートを開放することなく安全に公開でき、ALB の固定費も削減できます。また、2つのサービスは平日 9:00〜19:00（JST）のみ起動し、時間外はタスク数を 0 にスケールダウンします。

### ドキュメント取込

![取込パイプライン](./docs/diagrams/取込パイプライン.svg)

ファイルアップロードと取込処理は分離されています。アップロード時点ではファイル本体と抽出テキストの保存のみを行い、Embedding の生成はユーザーが「取込」を実行したタイミングで開始されます。これに伴い、ステータスは `uploaded → processing → ingested | failed` と遷移します。
取込処理では、抽出済みテキストを 500 文字単位（オーバーラップ 50 文字）で分割し、OpenAI で Embedding を生成して Chroma へ登録します。

### 回答生成

![RAGパイプライン](./docs/diagrams/RAGパイプライン.svg)

回答生成には Self-RAG アーキテクチャを採用しています。Multi Query 生成、ベクトル検索、RRF（Reciprocal Rank Fusion）による統合、Cohere Rerank、回答生成、自己評価、最大1回のリトライという一連の流れを LangGraphで構築しています。

自己評価で `useless` または `hallucination` と判定された場合は、フィードバックを伴ってクエリ再生成へと戻ります。リトライ後も改善しない場合は、失敗原因の分析結果を出力して終了します。なお、試行ごとのクエリ・検索結果・回答・評価結果は `chat_details` に1行ずつ記録され、後から失敗要因を追跡できる設計にしています。

### CI/CD

![CICD](./docs/diagrams/CICD.svg)

GitHub Actions と AWS 間の認証には OIDC を使用し、長期アクセスキーを持たせない設計としています。プルリクエスト時には、変更のあったパスに対してのみ lint とテストを実行します。デプロイ処理は、インフラ・バックエンド・フロントエンドともに `workflow_dispatch` による手動実行としています。

インフラ構成の詳細は[cdk/README.md](./cdk/README.md)に記載しました。

## 技術スタック

| 領域 | 採用技術 |
|---|---|
| フロントエンド | Next.js 16(App Router) / React 19 / TypeScript / Tailwind CSS 4 / jose / argon2 |
| バックエンド | Python 3.13 / FastAPI / LangGraph / LangChain / aiomysql / Poetry |
| データストア | MySQL 8.4 / Chroma(EFS永続化) / S3 |
| インフラ | AWS CDK(TypeScript) / ECS Fargate Spot / RDS / EFS / S3 / VPC / Cloudflare Tunnel / SSM Parameter Store / Secrets Manager / ECR |
| モデル | OpenAI gpt-5-nano / OpenAI text-embedding-3-small / Cohere rerank-v3.5 |
| CI/CD | GitHub Actions(OIDC) |
| テスト・静的解析 | pytest / Ruff / ESLint / Prettier |

## 設計上の判断(ADR)

| ADR | 判断と理由 |
|---|---|
| [001 コンピュート構成の選定](./docs/adr/001-compute-architecture.md) | ECS Fargate Spot の常駐構成を採用。平日 9:00〜19:00 のスケジュール運用によりコストを最適化。 |

検討にあたっては、ECS Fargate Spot（A案）、コンテナイメージ版 Lambda への移植（B案）、VPC 外 Lambda + DynamoDB + S3 Vectors への再設計（C案）の 3 案を比較しました。

B 案は、Chroma（SQLite バックエンド）の同時実行数制限と、egress 用 NAT インスタンスの自前運用による SPOF（単一障害点）化のリスクから採用を見送りました。
C 案は、月間約 14,400 チャット未満の利用規模であれば A 案より低コストになりますが、データ層の移行コストを総合的に考慮し、現時点では A 案を採用しています。

## ローカル実行

```bash
cp .env.example .env   # OpenAI / Cohere のAPIキーなどを設定する
docker compose up --build
```

`backend`・`frontend`・`rdb` の 3 サービスが起動します。`backend` は起動時に `init_db.py` を実行し、アプリケーション用およびテスト用のデータベース／テーブルを自動作成します。

- フロントエンド: `http://localhost:3000`
- バックエンドAPI: `http://localhost:8000`
- Swagger UI: `http://localhost:8000/docs`

起動確認は `/api/system/health`、`/api/system/db-test`、`/api/system/chroma-test` で行えます。すべて `{"status":"success"}` が返れば正常に起動しています。なお、`chroma-test` は検索クエリの Embedding 生成を行うため OpenAI API キーの検証を兼ねています（Cohere の API キーはチャット実行時まで検証されません）。

静的解析はホストで実行します。

```bash
(cd src/backend && poetry run ruff check . && poetry run ruff format --check .)
(cd src/frontend && npm run lint && npm run format:check)
```

テストは `backend` コンテナ内で実行してください。ホスト側からは `src/backend` が `sys.path` に含まれず、`MYSQL_HOST=rdb` の名前解決も行えないためです。

```bash
docker compose exec -e PYTHONPATH=. backend poetry run pytest
```

`tests/test_documents.py` と `tests/test_chats.py` で、取込からチャット処理までの一連の流れを検証します。モックを使用しないため、有効な OpenAI / Cohere の API キーと `<MYSQL_DATABASE>_test` データベースが必要です。なお、フロントエンド側のテストフレームワークは導入していません。

CDK の操作は、`cd cdk && npm ci` を事前に実行してから `npm run diff` / `npm run deploy` を使用します。CDK の自動テストは未実装のため、変更内容は `npm run diff` で事前に確認してください。

## リポジトリ構成

```text
src/
  frontend/           Next.js（画面、認証、アップロード、SSE プロキシ）
  backend/            FastAPI（取込 API、Self-RAG の LangGraph ワークフロー）
cdk/                  CDK（VpcStack / EfsStack / RdsStack / S3Stack / EcsStack / IamStack）
docs/
  adr/                アーキテクチャ決定記録（ADR）
  diagrams/           構成図（architecture.drawio が原本、各ページを SVG 変換）
.github/workflows/    PR 検証・デプロイ用ワークフロー
```

## 今後の課題

**1. サーバーレス構成への段階的移行**

現在の常駐構成では、夜間や休日にコンテナを停止しても RDS や EFS の固定費が発生します。そのため、「ベクトル層」「ドキュメント取込の非同期化」「データ層」「コンピュート・Ingress」の 4 段階に分け、各段階で個別にデプロイ・切り戻しが可能な形でサーバーレス化を進めます（詳細は [ADR 001](./docs/adr/001-compute-architecture.md) を参照）。

**2. マルチターン対話（継続的な対話）への対応**

現状は 1 問 1 答形式で各質問を独立して処理しています。生成された回答に対してさらに深掘りした質問ができるよう、過去のチャット履歴をコンテキストとして保持・活用する仕組みを追加します。

**3. Text-to-SQL によるデータ活用機能の追加**

SQL の知識がないユーザーでも社内データにアクセスできるよう、自然言語から SQL を生成・実行し、リレーショナルデータベースの情報から回答を組み立てる機能の追加を検討しています。
