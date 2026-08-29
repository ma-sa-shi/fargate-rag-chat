import os
import sys
import time
import pymysql
from pymysql.constants import CLIENT

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

MYSQL_PORT = int(MYSQL_PORT)

APP_DB = MYSQL_DATABASE
TEST_DB = f"{MYSQL_DATABASE}_test"

SETUP_SQL = f"""
CREATE DATABASE IF NOT EXISTS `{APP_DB}` CHARACTER SET utf8mb4 COLLATE utf8mb4_ja_0900_as_cs_ks;
CREATE DATABASE IF NOT EXISTS `{TEST_DB}` CHARACTER SET utf8mb4 COLLATE utf8mb4_ja_0900_as_cs_ks;

CREATE USER IF NOT EXISTS '{MYSQL_USER}'@'%' IDENTIFIED BY '{MYSQL_PASSWORD}';

GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, DROP, INDEX, ALTER ON `{APP_DB}`.* TO '{MYSQL_USER}'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, DROP, INDEX, ALTER ON `{TEST_DB}`.* TO '{MYSQL_USER}'@'%';
FLUSH PRIVILEGES;
"""
CREATE_TABLES_SQL = """
CREATE TABLE IF NOT EXISTS users (
    user_id INT PRIMARY KEY AUTO_INCREMENT,
    username VARCHAR(50) NOT NULL UNIQUE,
    hashed_password VARCHAR(255) NOT NULL,
    is_admin BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    delete_flg BOOLEAN DEFAULT FALSE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_ja_0900_as_cs_ks;

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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_ja_0900_as_cs_ks;

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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_ja_0900_as_cs_ks;

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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_ja_0900_as_cs_ks;
"""


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
                client_flag=CLIENT.MULTI_STATEMENTS,
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
            cursor.execute(SETUP_SQL)
            target_dbs = [APP_DB, TEST_DB]

            for target_db in target_dbs:
                print(f"Creating database: {target_db}")
                cursor.execute(f"USE `{target_db}`;")
                cursor.execute(CREATE_TABLES_SQL)

        print("Migration successfully completed.")
    except pymysql.MySQLError as e:
        print(f"Migration failed with error: {e}")
        sys.exit(1)
    finally:
        connection.close()


if __name__ == "__main__":
    main()
