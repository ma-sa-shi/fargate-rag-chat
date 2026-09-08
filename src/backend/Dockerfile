# 一般ユーザーが使える仮想環境/app/.venv/...にパッケージをインストールする

FROM python:3.13-slim AS base

WORKDIR /app

# 共通パッケージのインストール
RUN apt-get update && apt-get install -y \
    build-essential \
    default-libmysqlclient-dev \
    pkg-config \
    curl \
    && rm -rf /var/lib/apt/lists/*

ENV POETRY_HOME="/opt/poetry"

ENV POETRY_VIRTUALENVS_IN_PROJECT=true

RUN curl -sSL https://install.python-poetry.org | python3 -

ENV PATH="$POETRY_HOME/bin:$PATH"

# ローカル開発環境用
FROM base AS local

ARG USERNAME=vscode
ARG USER_UID=1000
ARG USER_GID=1000

RUN groupadd --gid $USER_GID $USERNAME \
    && useradd --uid $USER_UID --gid $USER_GID -m -s /bin/bash $USERNAME \
    && mkdir -p /etc/sudoers.d \
    && echo $USERNAME ALL=\(root\) NOPASSWD:ALL > /etc/sudoers.d/$USERNAME \
    && chmod 0440 /etc/sudoers.d/$USERNAME

RUN chown -R $USERNAME:$USER_GID $POETRY_HOME

# 定義ファイルをコピーして所有者を変更
COPY --chown=$USERNAME:$USER_GID src/backend/pyproject.toml src/backend/poetry.lock ./

# ローカル環境向けにインストール（開発用パッケージも含む）
RUN poetry install --no-interaction --no-ansi --no-root

USER $USERNAME

# デプロイ環境用
FROM base AS cloud

ARG USERNAME=appuser
ARG USER_UID=1000
ARG USER_GID=1000

RUN groupadd --gid $USER_GID $USERNAME \
    && useradd --uid $USER_UID --gid $USER_GID -m -s /bin/bash $USERNAME

RUN chown -R $USERNAME:$USER_GID $POETRY_HOME

# 定義ファイルをコピーして所有者を変更
COPY --chown=$USERNAME:$USER_GID src/backend/pyproject.toml src/backend/poetry.lock ./

# 本番環境向けインストール
RUN poetry install --only main --no-interaction --no-ansi --no-root

COPY --chown=$USERNAME:$USER_GID src/backend/ /app/

USER $USERNAME

# init_db.pyでDBとテーブルを用意してからuvicornを起動する
CMD ["sh", "-c", "poetry run python init_db.py && poetry run uvicorn main:app --host 0.0.0.0 --port 8000"]
