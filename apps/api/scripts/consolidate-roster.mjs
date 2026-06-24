// One-time, idempotent roster consolidation for the shared (school-wide) model.
// Run once during deploy BEFORE restarting the API:
//   node apps/api/scripts/consolidate-roster.mjs            # real DB (../dev.db)
//   node apps/api/scripts/consolidate-roster.mjs /tmp/x.db  # dry-run on a copy
//
// Two phases, each its own transaction (rolls back on any error):
//   A. (foreign_keys ON) delete obvious test teacher accounts (username debug_* / fix_*) —
//      cascades their subjects/grades/classes/students, removing roster junk.
//   B. (foreign_keys OFF) hard-delete soft-deleted tombstones (so the table-level
//      UNIQUE(teacher_id,grade_id,name) etc. stop colliding), then merge duplicate
//      active grades/classes by name, re-link students + homework_tasks, dedup students,
//      and add partial UNIQUE indexes so duplicates cannot recur.
//
// Idempotent: a second run is a no-op. Back up apps/api/dev.db first.

import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(__dirname, "../dev.db");
const db = new DatabaseSync(dbPath);

const iso = () => new Date().toISOString();
const stats = {
  teachersDeleted: 0,
  tombstonedStudents: 0,
  tombstonedClasses: 0,
  tombstonedGrades: 0,
  gradesMerged: 0,
  classesMerged: 0,
  studentsRelinked: 0,
  tasksRelinked: 0,
  studentsDeduped: 0,
  indexesCreated: 0
};

const studentsInClass = db.prepare("SELECT COUNT(*) AS c FROM students WHERE class_id = ? AND deleted_at IS NULL");
const studentsInGrade = db.prepare("SELECT COUNT(*) AS c FROM students WHERE grade_id = ? AND deleted_at IS NULL");
const pickCanonical = (rows, countStmt) =>
  rows
    .map((r) => ({ r, n: countStmt.get(r.id).c }))
    .sort((a, b) => b.n - a.n || (a.r.created_at < b.r.created_at ? -1 : 1) || (a.r.id < b.r.id ? -1 : 1));

// ---------------- Phase A: remove test accounts (FK ON -> cascade) ----------------
db.exec("PRAGMA foreign_keys = ON");
try {
  db.exec("BEGIN");
  const testTeachers = db
    .prepare("SELECT id, username FROM teachers WHERE username LIKE 'debug\\_%' ESCAPE '\\' OR username LIKE 'fix\\_%' ESCAPE '\\'")
    .all();
  for (const t of testTeachers) {
    db.prepare("DELETE FROM teachers WHERE id = ?").run(t.id);
    stats.teachersDeleted += 1;
    console.log(`  removed test teacher: ${t.username}`);
  }
  db.exec("COMMIT");
} catch (error) {
  db.exec("ROLLBACK");
  console.error("Phase A FAILED — rolled back.\n", error);
  process.exit(1);
}

// ---------------- Phase B: tombstone cleanup + merge (FK OFF) ----------------
db.exec("PRAGMA foreign_keys = OFF");
try {
  db.exec("BEGIN");

  // 0pre. rebuild classrooms WITHOUT the table-level UNIQUE(teacher_id,grade_id,name) so that
  //       re-pointing grade_id during the merge can't collide (the UNIQUE includes soft-deleted
  //       rows and spans teachers, which is what kept failing). FK is OFF here. Final active-row
  //       uniqueness is re-enforced by the partial index added at the end.
  db.exec(
    "CREATE TABLE classrooms_new (id TEXT PRIMARY KEY, name TEXT NOT NULL, teacher_id TEXT NOT NULL, grade_id TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT, FOREIGN KEY (teacher_id) REFERENCES teachers(id) ON DELETE CASCADE, FOREIGN KEY (grade_id) REFERENCES grades(id) ON DELETE CASCADE)"
  );
  db.exec(
    "INSERT INTO classrooms_new (id, name, teacher_id, grade_id, created_at, updated_at, deleted_at) SELECT id, name, teacher_id, grade_id, created_at, updated_at, deleted_at FROM classrooms"
  );
  db.exec("DROP TABLE classrooms");
  db.exec("ALTER TABLE classrooms_new RENAME TO classrooms");
  db.exec("CREATE INDEX IF NOT EXISTS idx_classrooms_grade ON classrooms(grade_id)");

  // 0a. re-link tasks/students that reference a TOMBSTONE classroom/grade to the active
  //     same-named equivalent, BEFORE we hard-delete the tombstones — otherwise the INNER
  //     JOINs in getTaskRows/getStudents would orphan them.
  for (const tc of db.prepare("SELECT id, name, grade_id FROM classrooms WHERE deleted_at IS NOT NULL").all()) {
    const act = db
      .prepare("SELECT id FROM classrooms WHERE name = ? AND deleted_at IS NULL ORDER BY (grade_id = ?) DESC LIMIT 1")
      .get(tc.name, tc.grade_id);
    if (act) {
      db.prepare("UPDATE homework_tasks SET class_id = ? WHERE class_id = ?").run(act.id, tc.id);
      for (const s of db
        .prepare("SELECT id, name, teacher_id FROM students WHERE class_id = ? AND deleted_at IS NULL")
        .all(tc.id)) {
        const clash = db
          .prepare("SELECT id FROM students WHERE class_id = ? AND name = ? AND teacher_id = ? AND id != ?")
          .get(act.id, s.name, s.teacher_id, s.id);
        if (clash) {
          db.prepare("UPDATE students SET deleted_at = ?, updated_at = ? WHERE id = ?").run(iso(), iso(), s.id);
        } else {
          db.prepare("UPDATE students SET class_id = ?, updated_at = ? WHERE id = ?").run(act.id, iso(), s.id);
        }
      }
    }
  }
  for (const tg of db.prepare("SELECT id, name FROM grades WHERE deleted_at IS NOT NULL").all()) {
    const act = db.prepare("SELECT id FROM grades WHERE name = ? AND deleted_at IS NULL").get(tg.name);
    if (act) {
      db.prepare("UPDATE homework_tasks SET grade_id = ? WHERE grade_id = ?").run(act.id, tg.id);
      db.prepare("UPDATE students SET grade_id = ? WHERE grade_id = ?").run(act.id, tg.id);
      db.prepare("UPDATE classrooms SET grade_id = ? WHERE grade_id = ?").run(act.id, tg.id);
    }
  }

  // 0. drop tombstones so table-level UNIQUEs (which include soft-deleted rows) don't collide
  stats.tombstonedStudents = db.prepare("DELETE FROM students WHERE deleted_at IS NOT NULL").run().changes;
  stats.tombstonedClasses = db.prepare("DELETE FROM classrooms WHERE deleted_at IS NOT NULL").run().changes;
  stats.tombstonedGrades = db.prepare("DELETE FROM grades WHERE deleted_at IS NOT NULL").run().changes;

  // 1. grades: canonical per name
  const grades = db.prepare("SELECT id, name, created_at FROM grades WHERE deleted_at IS NULL").all();
  const byName = new Map();
  for (const g of grades) (byName.get(g.name) ?? byName.set(g.name, []).get(g.name)).push(g);
  const gradeRewrite = new Map();
  for (const group of byName.values()) {
    if (group.length <= 1) continue;
    const ranked = pickCanonical(group, studentsInGrade);
    for (const { r } of ranked.slice(1)) gradeRewrite.set(r.id, ranked[0].r.id);
  }
  stats.gradesMerged = gradeRewrite.size;

  // 2. classes: canonical per (canonical-grade, name)
  const classrooms = db
    .prepare("SELECT id, name, grade_id, created_at FROM classrooms WHERE deleted_at IS NULL")
    .all();
  const classGroups = new Map();
  for (const c of classrooms) {
    const tg = gradeRewrite.get(c.grade_id) ?? c.grade_id;
    const key = `${tg} ${c.name}`;
    (classGroups.get(key) ?? classGroups.set(key, []).get(key)).push({ c, tg });
  }
  const classRewrite = new Map();
  const classGradeFix = [];
  for (const group of classGroups.values()) {
    const ranked = pickCanonical(group.map((x) => x.c), studentsInClass);
    const canon = ranked[0].r;
    const canonTarget = group.find((x) => x.c.id === canon.id).tg;
    if (canonTarget !== canon.grade_id) classGradeFix.push({ id: canon.id, gradeId: canonTarget });
    for (const { r } of ranked.slice(1)) classRewrite.set(r.id, canon.id);
  }
  stats.classesMerged = classRewrite.size;

  // 3. re-link homework_tasks (no UNIQUE on grade/class -> bulk)
  for (const [dup, canon] of gradeRewrite)
    stats.tasksRelinked += db.prepare("UPDATE homework_tasks SET grade_id = ? WHERE grade_id = ?").run(canon, dup).changes;
  for (const [dup, canon] of classRewrite)
    stats.tasksRelinked += db.prepare("UPDATE homework_tasks SET class_id = ? WHERE class_id = ?").run(canon, dup).changes;

  // 4. re-link students: grade_id bulk; class_id per-row (collision-safe)
  for (const [dup, canon] of gradeRewrite)
    stats.studentsRelinked += db.prepare("UPDATE students SET grade_id = ? WHERE grade_id = ?").run(canon, dup).changes;
  for (const [dup, canon] of classRewrite) {
    for (const s of db
      .prepare("SELECT id, name, teacher_id FROM students WHERE class_id = ? AND deleted_at IS NULL")
      .all(dup)) {
      const clash = db
        .prepare("SELECT id FROM students WHERE class_id = ? AND name = ? AND teacher_id = ? AND deleted_at IS NULL AND id != ?")
        .get(canon, s.name, s.teacher_id, s.id);
      if (clash) {
        db.prepare("UPDATE students SET deleted_at = ?, updated_at = ? WHERE id = ?").run(iso(), iso(), s.id);
        stats.studentsDeduped += 1;
      } else {
        db.prepare("UPDATE students SET class_id = ?, updated_at = ? WHERE id = ?").run(canon, iso(), s.id);
        stats.studentsRelinked += 1;
      }
    }
  }

  // 5. delete dup classes, fix canonical class grades, delete dup grades
  for (const dup of classRewrite.keys()) db.prepare("DELETE FROM classrooms WHERE id = ?").run(dup);
  for (const { id, gradeId } of classGradeFix)
    db.prepare("UPDATE classrooms SET grade_id = ?, updated_at = ? WHERE id = ?").run(gradeId, iso(), id);
  for (const dup of gradeRewrite.keys()) db.prepare("DELETE FROM grades WHERE id = ?").run(dup);

  // 6. dedup students now sharing (teacher_id, class_id, name) after re-linking
  const dupes = db
    .prepare(
      "SELECT MIN(id) keep_id, teacher_id, class_id, name FROM students WHERE deleted_at IS NULL GROUP BY teacher_id, class_id, name HAVING COUNT(*) > 1"
    )
    .all();
  for (const d of dupes) {
    const r = db
      .prepare("UPDATE students SET deleted_at = ?, updated_at = ? WHERE teacher_id = ? AND class_id = ? AND name = ? AND id != ?")
      .run(iso(), iso(), d.teacher_id, d.class_id, d.name, d.keep_id);
    stats.studentsDeduped += r.changes;
  }

  // 7. partial UNIQUE indexes so duplicates cannot recur among active rows
  for (const ddl of [
    "CREATE UNIQUE INDEX IF NOT EXISTS ux_grades_name ON grades(name) WHERE deleted_at IS NULL",
    "CREATE UNIQUE INDEX IF NOT EXISTS ux_classrooms_grade_name ON classrooms(grade_id, name) WHERE deleted_at IS NULL"
  ]) {
    db.exec(ddl);
    stats.indexesCreated += 1;
  }

  db.exec("COMMIT");
} catch (error) {
  db.exec("ROLLBACK");
  db.exec("PRAGMA foreign_keys = ON");
  console.error("Phase B FAILED — rolled back. No changes applied.\n", error);
  process.exit(1);
}

db.exec("PRAGMA foreign_keys = ON");
console.log("\nRoster consolidation complete:");
console.log(JSON.stringify(stats, null, 2));
console.log(`DB: ${dbPath}`);
db.close();
