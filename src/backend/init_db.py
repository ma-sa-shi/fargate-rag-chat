import os
import sys
import time
import pymysql

MYSQL_HOST = os.environ.get("MYSQL_HOST")
MYSQL_PORT = os.environ.get("MYSQL_PORT")
MYSQL_ROOT_PASSWORD = os.environ.get("MYSQL_ROOT_PASSWORD")
MYSQL_DATABASE = os.environ.get("MYSQL_DATABASE")
MYSQL_USER = os.environ.get("MYSQL_USER")
MYSQL_PASSWORD = os.environ.get("MYSQL_PASSWORD")

db_env = {
    "MYSQL_HOST": MYSQL_HOST,
    "MYSQL_PORT": MYSQL_PORT,
    "MYSQL_ROOT_PASSWORD": MYSQL_ROOT_PASSWORD,
    "MYSQL_DATABASE": MYSQL_DATABASE,
    "MYSQL_USER": MYSQL_USER,
    "MYSQL_PASSWORD": MYSQL_PASSWORD,
}
missing_vars = [k for k, v in db_env.items() if not v]

if missing_vars:
    print(
        f"Error: The following required env vars are missing: {', '.join(missing_vars)}"
    )
    sys.exit(1)

if not MYSQL_PORT.isdigit():
    print(f"Error: MYSQL_PORT must be an integer, got: {MYSQL_PORT!r}")
    sys.exit(1)

MYSQL_PORT = int(MYSQL_PORT)


def quote_identifier(name: str) -> str:
    """識別子をバッククォートで囲む。名前に含まれるバッククォートは二重化する"""
    escaped = name.replace("`", "``")
    return f"`{escaped}`"


APP_DB = MYSQL_DATABASE
TEST_DB = f"{MYSQL_DATABASE}_test"
APP_DB_ID = quote_identifier(APP_DB)
TEST_DB_ID = quote_identifier(TEST_DB)
# params を渡す文は pymysql の書式化を通るため、識別子側の '%' も二重化しておく
APP_DB_ID_FMT = APP_DB_ID.replace("%", "%%")
TEST_DB_ID_FMT = TEST_DB_ID.replace("%", "%%")

CHARSET_CLAUSE = "CHARACTER SET utf8mb4 COLLATE utf8mb4_ja_0900_as_cs_ks"
GRANTED_PRIVILEGES = "SELECT, INSERT, UPDATE, DELETE, CREATE, DROP, INDEX, ALTER"

# 値はすべてプレースホルダで渡す。識別子はプレースホルダにできないため
# quote_identifier でエスケープしたうえで埋め込む。
# ホストの '%' は params を渡す文でだけ pymysql の書式化を通るため '%%' と書く。
# params が None の文は書式化されないので、識別子に '%' が含まれても壊れない
SETUP_STATEMENTS = [
    (
        "create_database",
        f"CREATE DATABASE IF NOT EXISTS {APP_DB_ID} {CHARSET_CLAUSE}",
        None,
    ),
    (
        "create_test_database",
        f"CREATE DATABASE IF NOT EXISTS {TEST_DB_ID} {CHARSET_CLAUSE}",
        None,
    ),
    (
        "create_user",
        "CREATE USER IF NOT EXISTS %s@'%%' IDENTIFIED BY %s",
        (MYSQL_USER, MYSQL_PASSWORD),
    ),
    # CREATE USER IF NOT EXISTS は既存ユーザーのパスワードを変えない。
    # ALTER USER を続けて実行し、MYSQL_PASSWORD の変更を必ず反映させる
    (
        "alter_user_password",
        "ALTER USER %s@'%%' IDENTIFIED BY %s",
        (MYSQL_USER, MYSQL_PASSWORD),
    ),
    (
        "grant_database",
        f"GRANT {GRANTED_PRIVILEGES} ON {APP_DB_ID_FMT}.* TO %s@'%%'",
        (MYSQL_USER,),
    ),
    (
        "grant_test_database",
        f"GRANT {GRANTED_PRIVILEGES} ON {TEST_DB_ID_FMT}.* TO %s@'%%'",
        (MYSQL_USER,),
    ),
    ("flush_privileges", "FLUSH PRIVILEGES", None),
]

CREATE_TABLE_STATEMENTS = [
    (
        "users",
        """
        CREATE TABLE IF NOT EXISTS users (
            user_id INT PRIMARY KEY AUTO_INCREMENT,
            username VARCHAR(50) NOT NULL UNIQUE,
            hashed_password VARCHAR(255) NOT NULL,
            is_admin BOOLEAN DEFAULT FALSE,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            delete_flg BOOLEAN DEFAULT FALSE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_ja_0900_as_cs_ks
        """,
    ),
    (
        "docs",
        """
        CREATE TABLE IF NOT EXISTS docs (
            doc_id INT PRIMARY KEY AUTO_INCREMENT,
            user_id INT NOT NULL,
            dir_path VARCHAR(255),
            filename VARCHAR(100) NOT NULL,
            status ENUM('uploaded', 'processing', 'ingested', 'failed') DEFAULT 'uploaded',
            extracted_text MEDIUMTEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            delete_flg BOOLEAN DEFAULT FALSE,
            FOREIGN KEY (user_id) REFERENCES users(user_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_ja_0900_as_cs_ks
        """,
    ),
    (
        "chat_histories",
        """
        CREATE TABLE IF NOT EXISTS chat_histories (
            chat_id INT PRIMARY KEY AUTO_INCREMENT,
            request_id VARCHAR(255) NOT NULL UNIQUE,
            user_id INT NOT NULL,
            question TEXT NOT NULL,
            final_answer TEXT,
            final_grade ENUM('useful', 'useless', 'hallucination'),
            retry_count INT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            delete_flg BOOLEAN DEFAULT FALSE,
            FOREIGN KEY (user_id) REFERENCES users(user_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_ja_0900_as_cs_ks
        """,
    ),
    (
        "chat_details",
        """
        CREATE TABLE IF NOT EXISTS chat_details (
            detail_id INT PRIMARY KEY AUTO_INCREMENT,
            chat_id INT NOT NULL,
            request_id VARCHAR(255) NOT NULL,
            retry_count INT,
            generate_queries JSON,
            retrieved_documents JSON,
            generate_answer TEXT,
            node_grade ENUM('useful', 'useless', 'hallucination'),
            node_feedback TEXT,
            failure_analysis TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            delete_flg BOOLEAN DEFAULT FALSE,
            FOREIGN KEY (chat_id) REFERENCES chat_histories(chat_id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_ja_0900_as_cs_ks
        """,
    ),
]


def fail(stage: str, error: pymysql.MySQLError) -> None:
    """SQL の断片やパスワードがログに残らないよう、errno だけを出して終了する"""
    errno = error.args[0] if error.args else "unknown"
    print(f"Migration failed at {stage}: MySQL error {errno}")
    sys.exit(1)


def main():
    print(f"Connecting to MySQL at {MYSQL_HOST}:{MYSQL_PORT}...")
    connection = None

    for i in range(10):
        try:
            connection = pymysql.connect(
                host=MYSQL_HOST,
                port=MYSQL_PORT,
                user="root",
                password=MYSQL_ROOT_PASSWORD,
                charset="utf8mb4",
                cursorclass=pymysql.cursors.DictCursor,
            )
            print("Connected to MySQL.")
            break
        except pymysql.MySQLError as e:
            print(f"Connection attempt {i + 1} failed: {e}")
            time.sleep(5)

    if not connection:
        print("Error: Couldn't connect to MySQL server.")
        sys.exit(1)

    print("connected. Running init SQL")

    try:
        with connection.cursor() as cursor:
            for stage, sql, params in SETUP_STATEMENTS:
                try:
                    cursor.execute(sql, params)
                except pymysql.MySQLError as e:
                    fail(stage, e)

            for target_db in [APP_DB, TEST_DB]:
                print(f"Creating tables in database: {target_db}")
                try:
                    cursor.execute(f"USE {quote_identifier(target_db)}")
                except pymysql.MySQLError as e:
                    fail(f"use_database:{target_db}", e)

                for table, sql in CREATE_TABLE_STATEMENTS:
                    try:
                        cursor.execute(sql)
                    except pymysql.MySQLError as e:
                        fail(f"create_table:{target_db}.{table}", e)

        print("Migration successfully completed.")
    finally:
        connection.close()


if __name__ == "__main__":
    main()
