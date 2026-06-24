import "dotenv/config";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import bcrypt from "bcryptjs";
import cookieParser from "cookie-parser";
import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import jwt from "jsonwebtoken";
import multer from "multer";
import { createWorker } from "tesseract.js";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import * as XLSX from "xlsx";
import { z } from "zod";
import {
  DEFAULT_GRADES,
  DEFAULT_SUBJECTS,
  classSchema,
  homeworkTaskSchema,
  importCommitSchema,
  loginSchema,
  matchStudentName,
  namedEntitySchema,
  studentSchema,
  submissionStatusSchema,
  teacherRegisterSchema,
  voiceMatchSchema,
  type ApiEnvelope,
  type AsrProvider,
  type AsrServerEvent,
  type StudentLite,
  type TaskStats
} from "@workbook/shared";
import { createId, db, nowIso, parseJsonList, withTransaction } from "./db";

type Row = Record<string, unknown>;

interface AuthRequest extends Request {
  teacherId?: string;
}

interface AsrUpgradeRequest extends http.IncomingMessage {
  asrContext?: {
    teacherId: string;
    taskId: string;
  };
}

const app = express();
const server = http.createServer(app);
const asrWss = new WebSocketServer({ noServer: true });
const port = Number(process.env.PORT ?? 4100);
const webOrigin = process.env.WEB_ORIGIN ?? "http://localhost:5173";
const sessionSecret = process.env.SESSION_SECRET ?? "dev-only-change-me";
const uploadDir = path.resolve(process.env.UPLOAD_DIR ?? "uploads");
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const secureCookies = process.env.COOKIE_SECURE
  ? process.env.COOKIE_SECURE === "true"
  : webOrigin.startsWith("https://");
const asrProvider = (process.env.ASR_PROVIDER ?? "disabled") as AsrProvider;
const asrMockText = process.env.ASR_MOCK_TEXT ?? "张三";

fs.mkdirSync(uploadDir, { recursive: true });

const upload = multer({
  dest: uploadDir,
  limits: { fileSize: 8 * 1024 * 1024 }
});

function ok<T>(res: Response<ApiEnvelope<T>>, data: T) {
  return res.json({ data, error: null });
}

function fail(res: Response<ApiEnvelope<never>>, status: number, error: string) {
  return res.status(status).json({ data: null, error });
}

function teacherId(req: AuthRequest) {
  if (!req.teacherId) {
    throw new Error("Missing authenticated teacher id");
  }
  return req.teacherId;
}

function routeParam(req: Request, name: string) {
  return String(req.params[name] ?? "");
}

function signSession(id: string) {
  return jwt.sign({ teacherId: id }, sessionSecret, { expiresIn: "14d" });
}

function setSessionCookie(res: Response, token: string) {
  res.cookie("workbook_session", token, {
    httpOnly: true,
    sameSite: "lax",
    secure: secureCookies,
    maxAge: 14 * 24 * 60 * 60 * 1000
  });
}

function requireAuth(req: AuthRequest, res: Response, next: NextFunction) {
  const token = req.cookies?.workbook_session;
  if (!token) {
    return fail(res, 401, "请先登录");
  }
  try {
    const payload = jwt.verify(token, sessionSecret) as { teacherId?: string };
    if (!payload.teacherId) {
      return fail(res, 401, "Session expired");
    }
    req.teacherId = payload.teacherId;
    return next();
  } catch {
    return fail(res, 401, "Session expired");
  }
}

function one<T extends Row>(sql: string, ...params: unknown[]) {
  return db.prepare(sql).get(...(params as never[])) as T | undefined;
}

function all<T extends Row>(sql: string, ...params: unknown[]) {
  return db.prepare(sql).all(...(params as never[])) as T[];
}

function run(sql: string, ...params: unknown[]) {
  return db.prepare(sql).run(...(params as never[]));
}

function parseDate(input: string) {
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) {
    throw new Error("Invalid date");
  }
  return date.toISOString();
}

function taskStats(submissions: Array<{ status: string }>): TaskStats {
  let submitted = 0;
  let pending = 0;
  for (const submission of submissions) {
    if (submission.status === "submitted") submitted += 1;
    if (submission.status === "pending_confirm") pending += 1;
  }
  return {
    submitted,
    pending,
    missing: submissions.length - submitted - pending,
    total: submissions.length
  };
}

function camelTeacher(row: Row) {
  return { id: String(row.id), username: String(row.username), name: String(row.name) };
}

function camelGrade(row: Row) {
  return { id: String(row.id), name: String(row.name), teacherId: String(row.teacher_id) };
}

function camelSubject(row: Row) {
  return { id: String(row.id), name: String(row.name), teacherId: String(row.teacher_id) };
}

function camelClass(row: Row) {
  const grade = row.grade_name ? { id: String(row.grade_id), name: String(row.grade_name) } : undefined;
  return {
    id: String(row.id),
    name: String(row.name),
    teacherId: String(row.teacher_id),
    gradeId: String(row.grade_id),
    grade
  };
}

function camelStudent(row: Row) {
  return {
    id: String(row.id),
    name: String(row.name),
    studentNo: row.student_no ? String(row.student_no) : null,
    aliases: parseJsonList(row.aliases),
    teacherId: String(row.teacher_id),
    gradeId: String(row.grade_id),
    classId: String(row.class_id),
    grade: row.grade_name ? { id: String(row.grade_id), name: String(row.grade_name) } : undefined,
    classroom: row.class_name ? { id: String(row.class_id), name: String(row.class_name), gradeId: String(row.grade_id) } : undefined
  };
}

function getGrades(currentTeacherId: string) {
  return all("SELECT * FROM grades WHERE teacher_id = ? ORDER BY name", currentTeacherId).map(camelGrade);
}

function getSubjects(currentTeacherId: string) {
  return all("SELECT * FROM subjects WHERE teacher_id = ? ORDER BY name", currentTeacherId).map(camelSubject);
}

function getClasses(currentTeacherId: string) {
  return all(
    `SELECT c.*, g.name AS grade_name
     FROM classrooms c
     JOIN grades g ON g.id = c.grade_id
     WHERE c.teacher_id = ?
     ORDER BY g.name, c.name`,
    currentTeacherId
  ).map(camelClass);
}

function getStudents(currentTeacherId: string, classId?: string) {
  return all(
    `SELECT s.*, g.name AS grade_name, c.name AS class_name
     FROM students s
     JOIN grades g ON g.id = s.grade_id
     JOIN classrooms c ON c.id = s.class_id
     WHERE s.teacher_id = ? ${classId ? "AND s.class_id = ?" : ""}
     ORDER BY c.name, s.name`,
    ...(classId ? [currentTeacherId, classId] : [currentTeacherId])
  ).map(camelStudent);
}

function getTaskRows(currentTeacherId: string) {
  return all(
    `SELECT t.*, s.name AS subject_name, g.name AS grade_name, c.name AS class_name
     FROM homework_tasks t
     JOIN subjects s ON s.id = t.subject_id
     JOIN grades g ON g.id = t.grade_id
     JOIN classrooms c ON c.id = t.class_id
     WHERE t.teacher_id = ?
     ORDER BY t.created_at DESC`,
    currentTeacherId
  );
}

function getSubmissions(taskId: string) {
  return all(
    `SELECT hs.*, st.name AS student_name, st.student_no, st.aliases, st.grade_id, st.class_id
     FROM homework_submissions hs
     JOIN students st ON st.id = hs.student_id
     WHERE hs.task_id = ?
     ORDER BY st.name`,
    taskId
  ).map((row) => ({
    id: String(row.id),
    taskId: String(row.task_id),
    studentId: String(row.student_id),
    status: String(row.status),
    source: String(row.source),
    rawText: row.raw_text ? String(row.raw_text) : null,
    student: {
      id: String(row.student_id),
      name: String(row.student_name),
      studentNo: row.student_no ? String(row.student_no) : null,
      aliases: parseJsonList(row.aliases),
      gradeId: String(row.grade_id),
      classId: String(row.class_id)
    }
  }));
}

function camelTask(row: Row) {
  const submissions = getSubmissions(String(row.id));
  return {
    id: String(row.id),
    title: String(row.title),
    dueDate: String(row.due_date),
    status: String(row.status),
    teacherId: String(row.teacher_id),
    subjectId: String(row.subject_id),
    gradeId: String(row.grade_id),
    classId: String(row.class_id),
    subject: { id: String(row.subject_id), name: String(row.subject_name) },
    grade: { id: String(row.grade_id), name: String(row.grade_name) },
    classroom: { id: String(row.class_id), name: String(row.class_name), gradeId: String(row.grade_id) },
    submissions,
    stats: taskStats(submissions)
  };
}

function getTaskForTeacher(taskId: string, currentTeacherId: string) {
  const row = one(
    `SELECT t.*, s.name AS subject_name, g.name AS grade_name, c.name AS class_name
     FROM homework_tasks t
     JOIN subjects s ON s.id = t.subject_id
     JOIN grades g ON g.id = t.grade_id
     JOIN classrooms c ON c.id = t.class_id
     WHERE t.id = ? AND t.teacher_id = ?`,
    taskId,
    currentTeacherId
  );
  if (!row) {
    throw new Error("作业任务不存在或无权访问");
  }
  return camelTask(row);
}

function applyVoiceMatch(taskId: string, currentTeacherId: string, text: string, source = "voice") {
  const task = getTaskForTeacher(taskId, currentTeacherId);
  const students: StudentLite[] = task.submissions.map((submission) => ({
    id: submission.student.id,
    name: submission.student.name,
    studentNo: submission.student.studentNo,
    aliases: submission.student.aliases
  }));
  const match = matchStudentName(text, students);
  if (match.matchedStudentId) {
    run(
      "UPDATE homework_submissions SET status = 'submitted', source = ?, raw_text = ?, updated_at = ? WHERE task_id = ? AND student_id = ?",
      source,
      text,
      nowIso(),
      taskId,
      match.matchedStudentId
    );
  }
  return { match, task: getTaskForTeacher(taskId, currentTeacherId) };
}

function sendAsr(ws: WebSocket, event: AsrServerEvent) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(event));
  }
}

function parseCookieHeader(header: string | undefined) {
  const result = new Map<string, string>();
  for (const item of (header ?? "").split(";")) {
    const [rawKey, ...rawValue] = item.trim().split("=");
    if (rawKey) {
      result.set(rawKey, decodeURIComponent(rawValue.join("=")));
    }
  }
  return result;
}

function teacherIdFromUpgrade(req: http.IncomingMessage) {
  const token = parseCookieHeader(req.headers.cookie).get("workbook_session");
  if (!token) {
    return null;
  }
  try {
    const payload = jwt.verify(token, sessionSecret) as { teacherId?: string };
    return payload.teacherId ?? null;
  } catch {
    return null;
  }
}

function ensureClass(currentTeacherId: string, gradeId: string, classId: string) {
  const classroom = one("SELECT id FROM classrooms WHERE id = ? AND grade_id = ? AND teacher_id = ?", classId, gradeId, currentTeacherId);
  if (!classroom) {
    throw new Error("班级不存在或无权访问");
  }
}

function normalizeRosterRow(row: Record<string, unknown>) {
  const name = String(row["姓名"] ?? row["学生姓名"] ?? row.name ?? row.Name ?? "").trim();
  const studentNo = String(row["学号"] ?? row["序号"] ?? row.studentNo ?? row.no ?? "").trim() || null;
  const aliasesText = String(row["别名"] ?? row.aliases ?? "").trim();
  const aliases = aliasesText
    ? aliasesText.split(/[、,，/]/).map((item) => item.trim()).filter(Boolean)
    : [];
  return name ? { name, studentNo, aliases } : null;
}

function parseRosterBuffer(buffer: Buffer) {
  const workbook = XLSX.read(buffer, { type: "buffer", raw: false });
  const firstSheetName = workbook.SheetNames[0];
  if (!firstSheetName) return [];
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets[firstSheetName], { defval: "" });
  return rows.flatMap((row) => {
    const normalized = normalizeRosterRow(row);
    return normalized ? [normalized] : [];
  });
}

app.use(express.json({ limit: "2mb" }));
app.use(cookieParser());
app.use(cors({ origin: webOrigin, credentials: true }));

app.get("/api/health", (_req, res) => ok(res, { status: "ok" }));

app.post("/api/auth/register", async (req, res, next) => {
  try {
    const input = teacherRegisterSchema.parse(req.body);
    const timestamp = nowIso();
    const passwordHash = await bcrypt.hash(input.password, 12);
    const created = withTransaction(() => {
      const id = createId();
      run("INSERT INTO teachers (id, username, name, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)", id, input.username, input.name, passwordHash, timestamp, timestamp);
      for (const name of new Set([...DEFAULT_GRADES, input.gradeName])) {
        run("INSERT OR IGNORE INTO grades (id, name, teacher_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)", createId(), name, id, timestamp, timestamp);
      }
      const grade = one("SELECT id FROM grades WHERE teacher_id = ? AND name = ?", id, input.gradeName);
      if (!grade) throw new Error("默认年级创建失败");
      run("INSERT INTO classrooms (id, name, teacher_id, grade_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)", createId(), input.className, id, String(grade.id), timestamp, timestamp);
      for (const name of new Set([...DEFAULT_SUBJECTS, input.subjectName])) {
        run("INSERT OR IGNORE INTO subjects (id, name, teacher_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)", createId(), name, id, timestamp, timestamp);
      }
      return one("SELECT id, username, name FROM teachers WHERE id = ?", id);
    });
    if (!created) throw new Error("账号创建失败");
    setSessionCookie(res, signSession(String(created.id)));
    return ok(res, camelTeacher(created));
  } catch (error) {
    return next(error);
  }
});

app.post("/api/auth/login", async (req, res, next) => {
  try {
    const input = loginSchema.parse(req.body);
    const teacher = one("SELECT * FROM teachers WHERE username = ?", input.username);
    if (!teacher) return fail(res, 401, "Invalid username or password");
    const passwordOk = await bcrypt.compare(input.password, String(teacher.password_hash));
    if (!passwordOk) return fail(res, 401, "Invalid username or password");
    setSessionCookie(res, signSession(String(teacher.id)));
    return ok(res, camelTeacher(teacher));
  } catch (error) {
    return next(error);
  }
});

app.post("/api/auth/logout", (_req, res) => {
  res.clearCookie("workbook_session");
  return ok(res, { success: true });
});

app.get("/api/auth/me", requireAuth, (req: AuthRequest, res, next) => {
  try {
    const teacher = one("SELECT id, username, name FROM teachers WHERE id = ?", teacherId(req));
    if (!teacher) return fail(res, 401, "Session expired");
    return ok(res, camelTeacher(teacher));
  } catch (error) {
    return next(error);
  }
});

app.get("/api/bootstrap", requireAuth, (req: AuthRequest, res, next) => {
  try {
    const currentTeacherId = teacherId(req);
    return ok(res, {
      grades: getGrades(currentTeacherId),
      classrooms: getClasses(currentTeacherId),
      subjects: getSubjects(currentTeacherId),
      students: getStudents(currentTeacherId),
      tasks: getTaskRows(currentTeacherId).slice(0, 30).map(camelTask)
    });
  } catch (error) {
    return next(error);
  }
});

app.get("/api/grades", requireAuth, (req: AuthRequest, res) => ok(res, getGrades(teacherId(req))));
app.post("/api/grades", requireAuth, (req: AuthRequest, res, next) => {
  try {
    const input = namedEntitySchema.parse(req.body);
    const id = createId();
    const timestamp = nowIso();
    run("INSERT INTO grades (id, name, teacher_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)", id, input.name, teacherId(req), timestamp, timestamp);
    return ok(res, camelGrade(one("SELECT * FROM grades WHERE id = ?", id)!));
  } catch (error) {
    return next(error);
  }
});
app.patch("/api/grades/:id", requireAuth, (req: AuthRequest, res, next) => {
  try {
    const input = namedEntitySchema.parse(req.body);
    run("UPDATE grades SET name = ?, updated_at = ? WHERE id = ? AND teacher_id = ?", input.name, nowIso(), routeParam(req, "id"), teacherId(req));
    return ok(res, camelGrade(one("SELECT * FROM grades WHERE id = ? AND teacher_id = ?", routeParam(req, "id"), teacherId(req))!));
  } catch (error) {
    return next(error);
  }
});
app.delete("/api/grades/:id", requireAuth, (req: AuthRequest, res) => {
  run("DELETE FROM grades WHERE id = ? AND teacher_id = ?", routeParam(req, "id"), teacherId(req));
  return ok(res, { success: true });
});

app.get("/api/classes", requireAuth, (req: AuthRequest, res) => ok(res, getClasses(teacherId(req))));
app.post("/api/classes", requireAuth, (req: AuthRequest, res, next) => {
  try {
    const input = classSchema.parse(req.body);
    const currentTeacherId = teacherId(req);
    if (!one("SELECT id FROM grades WHERE id = ? AND teacher_id = ?", input.gradeId, currentTeacherId)) {
      throw new Error("年级不存在或无权访问");
    }
    const id = createId();
    const timestamp = nowIso();
    run("INSERT INTO classrooms (id, name, teacher_id, grade_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)", id, input.name, currentTeacherId, input.gradeId, timestamp, timestamp);
    return ok(res, getClasses(currentTeacherId).find((item) => item.id === id));
  } catch (error) {
    return next(error);
  }
});
app.patch("/api/classes/:id", requireAuth, (req: AuthRequest, res, next) => {
  try {
    const input = classSchema.parse(req.body);
    const currentTeacherId = teacherId(req);
    run("UPDATE classrooms SET name = ?, grade_id = ?, updated_at = ? WHERE id = ? AND teacher_id = ?", input.name, input.gradeId, nowIso(), routeParam(req, "id"), currentTeacherId);
    return ok(res, getClasses(currentTeacherId).find((item) => item.id === routeParam(req, "id")));
  } catch (error) {
    return next(error);
  }
});
app.delete("/api/classes/:id", requireAuth, (req: AuthRequest, res) => {
  run("DELETE FROM classrooms WHERE id = ? AND teacher_id = ?", routeParam(req, "id"), teacherId(req));
  return ok(res, { success: true });
});

app.get("/api/subjects", requireAuth, (req: AuthRequest, res) => ok(res, getSubjects(teacherId(req))));
app.post("/api/subjects", requireAuth, (req: AuthRequest, res, next) => {
  try {
    const input = namedEntitySchema.parse(req.body);
    const id = createId();
    const timestamp = nowIso();
    run("INSERT INTO subjects (id, name, teacher_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)", id, input.name, teacherId(req), timestamp, timestamp);
    return ok(res, camelSubject(one("SELECT * FROM subjects WHERE id = ?", id)!));
  } catch (error) {
    return next(error);
  }
});
app.patch("/api/subjects/:id", requireAuth, (req: AuthRequest, res, next) => {
  try {
    const input = namedEntitySchema.parse(req.body);
    run("UPDATE subjects SET name = ?, updated_at = ? WHERE id = ? AND teacher_id = ?", input.name, nowIso(), routeParam(req, "id"), teacherId(req));
    return ok(res, camelSubject(one("SELECT * FROM subjects WHERE id = ? AND teacher_id = ?", routeParam(req, "id"), teacherId(req))!));
  } catch (error) {
    return next(error);
  }
});
app.delete("/api/subjects/:id", requireAuth, (req: AuthRequest, res) => {
  run("DELETE FROM subjects WHERE id = ? AND teacher_id = ?", routeParam(req, "id"), teacherId(req));
  return ok(res, { success: true });
});

app.get("/api/students", requireAuth, (req: AuthRequest, res) => {
  const classId = typeof req.query.classId === "string" ? req.query.classId : undefined;
  return ok(res, getStudents(teacherId(req), classId));
});
app.post("/api/students", requireAuth, (req: AuthRequest, res, next) => {
  try {
    const input = studentSchema.parse(req.body);
    const currentTeacherId = teacherId(req);
    ensureClass(currentTeacherId, input.gradeId, input.classId);
    const id = createId();
    const timestamp = nowIso();
    run("INSERT INTO students (id, name, student_no, aliases, teacher_id, grade_id, class_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", id, input.name, input.studentNo ?? null, JSON.stringify(input.aliases), currentTeacherId, input.gradeId, input.classId, timestamp, timestamp);
    return ok(res, getStudents(currentTeacherId).find((item) => item.id === id));
  } catch (error) {
    return next(error);
  }
});
app.patch("/api/students/:id", requireAuth, (req: AuthRequest, res, next) => {
  try {
    const input = studentSchema.parse(req.body);
    const currentTeacherId = teacherId(req);
    ensureClass(currentTeacherId, input.gradeId, input.classId);
    run("UPDATE students SET name = ?, student_no = ?, aliases = ?, grade_id = ?, class_id = ?, updated_at = ? WHERE id = ? AND teacher_id = ?", input.name, input.studentNo ?? null, JSON.stringify(input.aliases), input.gradeId, input.classId, nowIso(), routeParam(req, "id"), currentTeacherId);
    return ok(res, getStudents(currentTeacherId).find((item) => item.id === routeParam(req, "id")));
  } catch (error) {
    return next(error);
  }
});
app.delete("/api/students/:id", requireAuth, (req: AuthRequest, res) => {
  run("DELETE FROM students WHERE id = ? AND teacher_id = ?", routeParam(req, "id"), teacherId(req));
  return ok(res, { success: true });
});

app.get("/api/homework-tasks", requireAuth, (req: AuthRequest, res) => ok(res, getTaskRows(teacherId(req)).map(camelTask)));
app.post("/api/homework-tasks", requireAuth, (req: AuthRequest, res, next) => {
  try {
    const input = homeworkTaskSchema.parse(req.body);
    const currentTeacherId = teacherId(req);
    ensureClass(currentTeacherId, input.gradeId, input.classId);
    if (!one("SELECT id FROM subjects WHERE id = ? AND teacher_id = ?", input.subjectId, currentTeacherId)) {
      throw new Error("学科不存在或无权访问");
    }
    const taskId = withTransaction(() => {
      const id = createId();
      const timestamp = nowIso();
      run("INSERT INTO homework_tasks (id, title, due_date, status, teacher_id, subject_id, grade_id, class_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", id, input.title, parseDate(input.dueDate), input.status, currentTeacherId, input.subjectId, input.gradeId, input.classId, timestamp, timestamp);
      const students = all("SELECT id FROM students WHERE teacher_id = ? AND class_id = ?", currentTeacherId, input.classId);
      for (const student of students) {
        run("INSERT INTO homework_submissions (id, task_id, student_id, status, source, created_at, updated_at) VALUES (?, ?, ?, 'missing', 'system', ?, ?)", createId(), id, String(student.id), timestamp, timestamp);
      }
      return id;
    });
    return ok(res, getTaskForTeacher(taskId, currentTeacherId));
  } catch (error) {
    return next(error);
  }
});
app.get("/api/homework-tasks/:id", requireAuth, (req: AuthRequest, res, next) => {
  try {
    return ok(res, getTaskForTeacher(routeParam(req, "id"), teacherId(req)));
  } catch (error) {
    return next(error);
  }
});
app.patch("/api/homework-tasks/:id", requireAuth, (req: AuthRequest, res, next) => {
  try {
    const input = homeworkTaskSchema.parse(req.body);
    const currentTeacherId = teacherId(req);
    ensureClass(currentTeacherId, input.gradeId, input.classId);
    run("UPDATE homework_tasks SET title = ?, due_date = ?, status = ?, subject_id = ?, grade_id = ?, class_id = ?, updated_at = ? WHERE id = ? AND teacher_id = ?", input.title, parseDate(input.dueDate), input.status, input.subjectId, input.gradeId, input.classId, nowIso(), routeParam(req, "id"), currentTeacherId);
    return ok(res, getTaskForTeacher(routeParam(req, "id"), currentTeacherId));
  } catch (error) {
    return next(error);
  }
});
app.delete("/api/homework-tasks/:id", requireAuth, (req: AuthRequest, res) => {
  run("DELETE FROM homework_tasks WHERE id = ? AND teacher_id = ?", routeParam(req, "id"), teacherId(req));
  return ok(res, { success: true });
});
app.get("/api/homework-tasks/:id/submissions", requireAuth, (req: AuthRequest, res, next) => {
  try {
    const task = getTaskForTeacher(routeParam(req, "id"), teacherId(req));
    return ok(res, { submissions: task.submissions, stats: task.stats });
  } catch (error) {
    return next(error);
  }
});
app.patch("/api/homework-tasks/:id/submissions/:studentId", requireAuth, (req: AuthRequest, res, next) => {
  try {
    const input = submissionStatusSchema.parse(req.body);
    const task = getTaskForTeacher(routeParam(req, "id"), teacherId(req));
    const student = task.submissions.find((submission) => submission.student.id === routeParam(req, "studentId"));
    if (!student) throw new Error("学生不在该作业任务中");
    run("UPDATE homework_submissions SET status = ?, source = ?, updated_at = ? WHERE task_id = ? AND student_id = ?", input.status, input.source, nowIso(), routeParam(req, "id"), routeParam(req, "studentId"));
    return ok(res, getSubmissions(routeParam(req, "id")).find((submission) => submission.student.id === routeParam(req, "studentId")));
  } catch (error) {
    return next(error);
  }
});
app.post("/api/homework-tasks/:id/voice-matches", requireAuth, (req: AuthRequest, res, next) => {
  try {
    const input = voiceMatchSchema.parse(req.body);
    const currentTeacherId = teacherId(req);
    return ok(res, applyVoiceMatch(routeParam(req, "id"), currentTeacherId, input.text, "voice"));
  } catch (error) {
    return next(error);
  }
});

app.post("/api/imports/roster-file", requireAuth, upload.single("file"), async (req: AuthRequest, res, next) => {
  try {
    if (!req.file) return fail(res, 400, "请上传花名册文件");
    const buffer = await fs.promises.readFile(req.file.path);
    const rows = parseRosterBuffer(buffer);
    await fs.promises.unlink(req.file.path).catch(() => undefined);
    const id = createId();
    const timestamp = nowIso();
    run("INSERT INTO import_batches (id, source, original_name, parsed_rows, teacher_id, created_at, updated_at) VALUES (?, 'file', ?, ?, ?, ?, ?)", id, req.file.originalname, JSON.stringify(rows), teacherId(req), timestamp, timestamp);
    return ok(res, { batchId: id, rows });
  } catch (error) {
    return next(error);
  }
});

app.post("/api/imports/roster-ocr", requireAuth, upload.single("file"), async (req: AuthRequest, res, next) => {
  try {
    if (!req.file) return fail(res, 400, "请上传花名册图片");
    const worker = await createWorker("chi_sim+eng");
    const result = await worker.recognize(req.file.path);
    await worker.terminate();
    const rawText = result.data.text;
    const rows = rawText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .flatMap((line) => {
        const [studentNoOrName, maybeName] = line.split(/\s+/);
        const name = maybeName ?? studentNoOrName;
        return name && name.length >= 2 ? [{ name, studentNo: maybeName ? studentNoOrName : null, aliases: [] }] : [];
      });
    await fs.promises.unlink(req.file.path).catch(() => undefined);
    const id = createId();
    const timestamp = nowIso();
    run("INSERT INTO import_batches (id, source, original_name, raw_text, parsed_rows, teacher_id, created_at, updated_at) VALUES (?, 'ocr', ?, ?, ?, ?, ?, ?)", id, req.file.originalname, rawText, JSON.stringify(rows), teacherId(req), timestamp, timestamp);
    return ok(res, { batchId: id, rawText, rows });
  } catch (error) {
    return next(error);
  }
});

app.post("/api/imports/:id/commit", requireAuth, (req: AuthRequest, res, next) => {
  try {
    const input = importCommitSchema.parse(req.body);
    const currentTeacherId = teacherId(req);
    ensureClass(currentTeacherId, input.gradeId, input.classId);
    if (!one("SELECT id FROM import_batches WHERE id = ? AND teacher_id = ?", routeParam(req, "id"), currentTeacherId)) {
      throw new Error("导入批次不存在或无权访问");
    }
    let created = 0;
    let skipped = 0;
    let overwritten = 0;
    const timestamp = nowIso();
    withTransaction(() => {
      for (const row of input.rows) {
        const existing = one("SELECT id FROM students WHERE teacher_id = ? AND class_id = ? AND name = ?", currentTeacherId, input.classId, row.name);
        if (existing && input.duplicateStrategy === "skip") {
          skipped += 1;
          continue;
        }
        if (existing) {
          overwritten += 1;
          run("UPDATE students SET student_no = ?, aliases = ?, grade_id = ?, class_id = ?, updated_at = ? WHERE id = ?", row.studentNo ?? null, JSON.stringify(row.aliases), input.gradeId, input.classId, timestamp, String(existing.id));
          continue;
        }
        created += 1;
        run("INSERT INTO students (id, name, student_no, aliases, teacher_id, grade_id, class_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", createId(), row.name, row.studentNo ?? null, JSON.stringify(row.aliases), currentTeacherId, input.gradeId, input.classId, timestamp, timestamp);
      }
    });
    return ok(res, { created, skipped, overwritten, students: getStudents(currentTeacherId, input.classId) });
  } catch (error) {
    return next(error);
  }
});

asrWss.on("connection", (ws: WebSocket, req: AsrUpgradeRequest) => {
  const context = req.asrContext;
  if (!context) {
    sendAsr(ws, { type: "error", message: "ASR session missing context" });
    ws.close();
    return;
  }
  const asrContext = context;

  let upstream: WebSocket | null = null;
  let started = false;

  function closeUpstream() {
    if (upstream && upstream.readyState === WebSocket.OPEN) {
      upstream.close();
    }
    upstream = null;
  }

  function handleFinalText(text: string) {
    const normalized = text.trim();
    if (!normalized) {
      return;
    }
    try {
      const result = applyVoiceMatch(asrContext.taskId, asrContext.teacherId, normalized, "asr");
      const payload = {
        text: normalized,
        match: result.match,
        stats: result.task.stats
      };
      sendAsr(ws, result.match.needsConfirmation ? { type: "pending", ...payload } : { type: "final", ...payload });
    } catch (error) {
      sendAsr(ws, { type: "error", message: error instanceof Error ? error.message : "语音匹配失败" });
    }
  }

  function connectVolcengine() {
    const endpoint = process.env.VOLCENGINE_ASR_ENDPOINT;
    const appId = process.env.VOLCENGINE_ASR_APP_ID;
    const token = process.env.VOLCENGINE_ASR_ACCESS_TOKEN;
    const cluster = process.env.VOLCENGINE_ASR_CLUSTER;
    if (!endpoint || !appId || !token || !cluster) {
      sendAsr(ws, { type: "error", message: "火山引擎 ASR 未配置完整，请检查服务器 .env" });
      return null;
    }

    const providerSocket = new WebSocket(endpoint, {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Api-App-Id": appId,
        "X-Api-Cluster": cluster
      }
    });

    providerSocket.on("open", () => {
      providerSocket.send(
        JSON.stringify({
          type: "start",
          app: { appid: appId, cluster },
          user: { uid: asrContext.teacherId },
          request: { reqid: createId(), workflow: "audio_in,resample,partition,vad,fe,decode,itn,nlu_punctuate" },
          audio: {
            format: process.env.VOLCENGINE_ASR_FORMAT ?? "pcm",
            sample_rate: Number(process.env.VOLCENGINE_ASR_SAMPLE_RATE ?? 16000),
            language: process.env.VOLCENGINE_ASR_LANGUAGE ?? "zh-CN",
            channel: 1
          }
        })
      );
      sendAsr(ws, { type: "ready", provider: "volcengine" });
    });

    providerSocket.on("message", (message) => {
      const raw = message.toString();
      try {
        const data = JSON.parse(raw) as Record<string, unknown>;
        const text =
          typeof data.text === "string"
            ? data.text
            : typeof data.result === "string"
              ? data.result
              : typeof (data.result as Record<string, unknown> | undefined)?.text === "string"
                ? String((data.result as Record<string, unknown>).text)
                : "";
        const isFinal = data.is_final === true || data.final === true || data.type === "final";
        if (text && isFinal) {
          handleFinalText(text);
        } else if (text) {
          sendAsr(ws, { type: "partial", text });
        }
      } catch {
        sendAsr(ws, { type: "status", message: "收到火山 ASR 非 JSON 响应" });
      }
    });

    providerSocket.on("error", () => {
      sendAsr(ws, { type: "error", message: "火山引擎 ASR 连接失败" });
    });

    providerSocket.on("close", () => {
      if (ws.readyState === WebSocket.OPEN) {
        sendAsr(ws, { type: "closed" });
      }
    });

    return providerSocket;
  }

  sendAsr(ws, { type: "ready", provider: asrProvider });

  ws.on("message", (message: RawData, isBinary) => {
    if (isBinary) {
      if (asrProvider === "volcengine" && upstream?.readyState === WebSocket.OPEN) {
        upstream.send(message);
      }
      return;
    }

    let event: { type?: string; text?: string };
    try {
      event = JSON.parse(message.toString()) as { type?: string; text?: string };
    } catch {
      sendAsr(ws, { type: "error", message: "ASR 控制消息格式错误" });
      return;
    }

    if (event.type === "start") {
      if (started) {
        return;
      }
      started = true;
      if (asrProvider === "disabled" || asrProvider === "browser") {
        sendAsr(ws, { type: "error", message: "云端 ASR 未启用，请配置 ASR_PROVIDER=mock 或 volcengine" });
        return;
      }
      if (asrProvider === "mock") {
        sendAsr(ws, { type: "status", message: "Mock ASR 已开始，结束录音后返回测试姓名" });
        return;
      }
      if (asrProvider === "volcengine") {
        upstream = connectVolcengine();
      }
      return;
    }

    if (event.type === "mock-final" && event.text) {
      handleFinalText(event.text);
      return;
    }

    if (event.type === "stop") {
      if (asrProvider === "mock") {
        handleFinalText(event.text || asrMockText);
      } else if (upstream?.readyState === WebSocket.OPEN) {
        upstream.send(JSON.stringify({ type: "stop" }));
      }
      sendAsr(ws, { type: "closed" });
      closeUpstream();
      return;
    }
  });

  ws.on("close", closeUpstream);
});

app.use((error: unknown, _req: Request, res: Response<ApiEnvelope<never>>, _next: NextFunction) => {
  if (error instanceof z.ZodError) {
    return fail(res, 400, error.issues[0]?.message ?? "Invalid request data");
  }
  if (error instanceof Error) {
    if (/UNIQUE constraint failed/.test(error.message)) {
      return fail(res, 409, "数据已存在，请检查账号、班级、学生或学科是否重复");
    }
    return fail(res, 500, error.message);
  }
  return fail(res, 500, "Server error");
});

const webDist = path.resolve(__dirname, "../../web/dist");
if (fs.existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get(/.*/, (_req, res) => {
    res.sendFile(path.join(webDist, "index.html"));
  });
}

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  if (url.pathname !== "/ws/asr") {
    socket.destroy();
    return;
  }

  const currentTeacherId = teacherIdFromUpgrade(req);
  const taskId = url.searchParams.get("taskId") ?? "";
  if (!currentTeacherId || !taskId) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }

  try {
    getTaskForTeacher(taskId, currentTeacherId);
  } catch {
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    socket.destroy();
    return;
  }

  (req as AsrUpgradeRequest).asrContext = { teacherId: currentTeacherId, taskId };
  asrWss.handleUpgrade(req, socket, head, (ws) => {
    asrWss.emit("connection", ws, req);
  });
});

server.listen(port, () => {
  console.log(`Workbook API listening on http://localhost:${port}`);
});

