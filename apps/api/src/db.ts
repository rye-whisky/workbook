import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

const rawUrl = process.env.DATABASE_URL ?? "file:./dev.db";
const dbPath = rawUrl.startsWith("file:") ? rawUrl.slice(5) : rawUrl;
const resolvedDbPath = path.resolve(dbPath);

fs.mkdirSync(path.dirname(resolvedDbPath), { recursive: true });

export const db = new DatabaseSync(resolvedDbPath);
db.exec("PRAGMA foreign_keys = ON");
db.exec("PRAGMA journal_mode = WAL");

function hasColumn(table: string, column: string) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((row) => {
    const item = row as { name?: unknown };
    return item.name === column;
  });
}

function ensureColumn(table: string, column: string, definition: string) {
  if (!hasColumn(table, column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

export function createId() {
  return randomUUID();
}

export function nowIso() {
  return new Date().toISOString();
}

export function migrate() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS teachers (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS grades (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      teacher_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      UNIQUE (teacher_id, name),
      FOREIGN KEY (teacher_id) REFERENCES teachers(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS classrooms (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      teacher_id TEXT NOT NULL,
      grade_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      UNIQUE (teacher_id, grade_id, name),
      FOREIGN KEY (teacher_id) REFERENCES teachers(id) ON DELETE CASCADE,
      FOREIGN KEY (grade_id) REFERENCES grades(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS students (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      student_no TEXT,
      aliases TEXT NOT NULL DEFAULT '[]',
      teacher_id TEXT NOT NULL,
      grade_id TEXT NOT NULL,
      class_id TEXT NOT NULL,
      display_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      UNIQUE (teacher_id, class_id, name),
      FOREIGN KEY (teacher_id) REFERENCES teachers(id) ON DELETE CASCADE,
      FOREIGN KEY (grade_id) REFERENCES grades(id) ON DELETE CASCADE,
      FOREIGN KEY (class_id) REFERENCES classrooms(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS subjects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      teacher_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (teacher_id, name),
      FOREIGN KEY (teacher_id) REFERENCES teachers(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS homework_tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      due_date TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      teacher_id TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      grade_id TEXT NOT NULL,
      class_id TEXT NOT NULL,
      grade_name_snapshot TEXT,
      class_name_snapshot TEXT,
      subject_name_snapshot TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (teacher_id) REFERENCES teachers(id) ON DELETE CASCADE,
      FOREIGN KEY (subject_id) REFERENCES subjects(id) ON DELETE RESTRICT,
      FOREIGN KEY (grade_id) REFERENCES grades(id) ON DELETE RESTRICT,
      FOREIGN KEY (class_id) REFERENCES classrooms(id) ON DELETE RESTRICT
    );

    CREATE TABLE IF NOT EXISTS homework_submissions (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      student_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'missing',
      source TEXT NOT NULL DEFAULT 'system',
      raw_text TEXT,
      student_name_snapshot TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (task_id, student_id),
      FOREIGN KEY (task_id) REFERENCES homework_tasks(id) ON DELETE CASCADE,
      FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS import_batches (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      original_name TEXT,
      raw_text TEXT,
      parsed_rows TEXT NOT NULL DEFAULT '[]',
      teacher_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (teacher_id) REFERENCES teachers(id) ON DELETE CASCADE
    );
  `);

  ensureColumn("grades", "deleted_at", "TEXT");
  ensureColumn("classrooms", "deleted_at", "TEXT");
  ensureColumn("students", "display_order", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn("students", "deleted_at", "TEXT");
  ensureColumn("homework_tasks", "grade_name_snapshot", "TEXT");
  ensureColumn("homework_tasks", "class_name_snapshot", "TEXT");
  ensureColumn("homework_tasks", "subject_name_snapshot", "TEXT");
  ensureColumn("homework_submissions", "student_name_snapshot", "TEXT");

  db.exec(`
    UPDATE homework_tasks
    SET grade_name_snapshot = COALESCE(grade_name_snapshot, (SELECT name FROM grades WHERE grades.id = homework_tasks.grade_id)),
        class_name_snapshot = COALESCE(class_name_snapshot, (SELECT name FROM classrooms WHERE classrooms.id = homework_tasks.class_id)),
        subject_name_snapshot = COALESCE(subject_name_snapshot, (SELECT name FROM subjects WHERE subjects.id = homework_tasks.subject_id))
    WHERE grade_name_snapshot IS NULL
       OR class_name_snapshot IS NULL
       OR subject_name_snapshot IS NULL;

    UPDATE homework_submissions
    SET student_name_snapshot = COALESCE(student_name_snapshot, (SELECT name FROM students WHERE students.id = homework_submissions.student_id))
    WHERE student_name_snapshot IS NULL;
  `);
}

export function withTransaction<T>(fn: () => T): T {
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function parseJsonList(value: unknown): string[] {
  if (typeof value !== "string") {
    return [];
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

migrate();
