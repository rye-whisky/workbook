import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";
import bcrypt from "bcryptjs";
import cookieParser from "cookie-parser";
import cors from "cors";
import dotenv from "dotenv";
import express, { type NextFunction, type Request, type Response } from "express";
import ExcelJS from "exceljs";
import jwt from "jsonwebtoken";
import multer from "multer";
import rateLimit from "express-rate-limit";
import { createWorker } from "tesseract.js";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import * as XLSX from "xlsx";
import { z } from "zod";
import {
  DEFAULT_SUBJECTS,
  classSchema,
  homeworkTaskSchema,
  importCommitSchema,
  loginSchema,
  matchStudentNameSequence,
  namedEntitySchema,
  shouldLearnVoiceAlias,
  studentSchema,
  studentOrderSchema,
  submissionStatusSchema,
  teacherRegisterSchema,
  voiceMatchSchema,
  type ApiEnvelope,
  type AsrProvider,
  type AsrServerEvent,
  type HomeworkRegister,
  type HomeworkRegisterCell,
  type StudentLite,
  type TaskStats,
  type VoiceBatchMatchResult
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
app.set("trust proxy", 1);
const httpsCertFile = process.env.HTTPS_CERT_FILE;
const httpsKeyFile = process.env.HTTPS_KEY_FILE;
const server =
  httpsCertFile && httpsKeyFile
    ? https.createServer(
        {
          cert: fs.readFileSync(httpsCertFile),
          key: fs.readFileSync(httpsKeyFile)
        },
        app
      )
    : http.createServer(app);
const asrWss = new WebSocketServer({ noServer: true });
const activeAsrClients = new Set<WebSocket>();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });
dotenv.config({ path: path.resolve(process.cwd(), ".env"), override: false });
const port = Number(process.env.PORT ?? 4100);
const webOrigin = process.env.WEB_ORIGIN ?? "http://localhost:5173";
function resolveSessionSecret(): string {
  const secret = process.env.SESSION_SECRET;
  const isDev = process.env.NODE_ENV === "development";
  const weakValues = ["", "dev-only-change-me", "replace-with-a-long-random-secret"];
  if (!secret || secret.length < 32 || weakValues.includes(secret)) {
    if (isDev) {
      return "dev-only-change-me";
    }
    throw new Error(
      "SESSION_SECRET 未配置或强度不足（需至少 32 位随机字符）。请在 .env 中设置一个强随机值后重启服务。"
    );
  }
  return secret;
}

const sessionSecret = resolveSessionSecret();
const uploadDir = path.resolve(process.env.UPLOAD_DIR ?? "uploads");
const secureCookies = process.env.COOKIE_SECURE
  ? process.env.COOKIE_SECURE === "true"
  : webOrigin.startsWith("https://");
const asrProvider = (process.env.ASR_PROVIDER ?? "disabled") as AsrProvider;
const asrMockText = process.env.ASR_MOCK_TEXT ?? "张三";
const maxAsrConcurrency = envPositiveInt("ASR_MAX_CONCURRENCY", 1);
const maxOcrConcurrency = envPositiveInt("OCR_MAX_CONCURRENCY", 1);
let activeOcrJobs = 0;
const ocrWaiters: Array<() => void> = [];

function envPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return parsed;
}

// Bounds concurrent OCR jobs (each spawns a heavy tesseract worker + language data)
// so parallel image uploads cannot exhaust memory/CPU.
async function withOcrSlot<T>(task: () => Promise<T>): Promise<T> {
  if (activeOcrJobs >= maxOcrConcurrency) {
    await new Promise<void>((resolve) => ocrWaiters.push(resolve));
  }
  activeOcrJobs += 1;
  try {
    return await task();
  } finally {
    activeOcrJobs -= 1;
    const next = ocrWaiters.shift();
    if (next) next();
  }
}
const defaultVolcengineAsrEndpoint = "wss://openspeech.bytedance.com/api/v2/asr";

const volcengineProtocolVersion = 0x1;
const volcengineHeaderSize = 0x1;
const volcengineSerializationJson = 0x1;
const volcengineCompressionGzip = 0x1;
const volcengineMessageType = {
  fullClientRequest: 0x1,
  audioOnlyRequest: 0x2,
  fullServerResponse: 0x9,
  serverAck: 0xb,
  serverError: 0xf
} as const;
const volcengineMessageFlags = {
  noSequence: 0x0,
  positiveSequence: 0x1,
  negativeSequence: 0x2
} as const;

fs.mkdirSync(uploadDir, { recursive: true });

const upload = multer({
  dest: uploadDir,
  limits: { fileSize: 8 * 1024 * 1024 }
});

// Precomputed hash so that a login attempt for a non-existent username still pays
// the full bcrypt cost, removing a username-enumeration timing oracle.
const DUMMY_PASSWORD_HASH = bcrypt.hashSync("workbook-timing-dummy", 12);

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).json({ data: null, error: "登录尝试过于频繁，请 15 分钟后再试" });
  }
});

function ok<T>(res: Response<ApiEnvelope<T>>, data: T) {
  return res.json({ data, error: null });
}

function fail(res: Response<ApiEnvelope<never>>, status: number, error: string) {
  return res.status(status).json({ data: null, error });
}

class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

function notFound(message: string) {
  return new ApiError(404, message);
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
  let lateSubmitted = 0;
  let leave = 0;
  for (const submission of submissions) {
    if (submission.status === "submitted") submitted += 1;
    if (submission.status === "pending_confirm") pending += 1;
    if (submission.status === "late_submitted") lateSubmitted += 1;
    if (submission.status === "leave") leave += 1;
  }
  return {
    submitted,
    pending,
    lateSubmitted,
    leave,
    missing: submissions.length - submitted - pending - lateSubmitted - leave,
    total: submissions.length
  };
}

function submissionCell(status: string): Pick<HomeworkRegisterCell, "symbol" | "color"> {
  if (status === "submitted") return { symbol: "√", color: "normal" };
  if (status === "late_submitted") return { symbol: "√", color: "red" };
  if (status === "leave") return { symbol: "O", color: "normal" };
  if (status === "pending_confirm") return { symbol: "?", color: "warning" };
  return { symbol: "×", color: "normal" };
}

function camelTeacher(row: Row) {
  return { id: String(row.id), username: String(row.username), name: String(row.name) };
}

function camelGrade(row: Row) {
  return { id: String(row.id), name: String(row.name), teacherId: String(row.teacher_id), deletedAt: row.deleted_at ? String(row.deleted_at) : null };
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
    deletedAt: row.deleted_at ? String(row.deleted_at) : null,
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
    displayOrder: Number(row.display_order ?? 0),
    deletedAt: row.deleted_at ? String(row.deleted_at) : null,
    grade: row.grade_name ? { id: String(row.grade_id), name: String(row.grade_name) } : undefined,
    classroom: row.class_name ? { id: String(row.class_id), name: String(row.class_name), gradeId: String(row.grade_id) } : undefined
  };
}

function getGrades() {
  return all("SELECT * FROM grades WHERE deleted_at IS NULL ORDER BY name").map(camelGrade);
}

function getSubjects(currentTeacherId: string) {
  return all("SELECT * FROM subjects WHERE teacher_id = ? ORDER BY name", currentTeacherId).map(camelSubject);
}

function getClasses() {
  return all(
    `SELECT c.*, g.name AS grade_name
     FROM classrooms c
     JOIN grades g ON g.id = c.grade_id
     WHERE c.deleted_at IS NULL AND g.deleted_at IS NULL
     ORDER BY g.name, c.name`
  ).map(camelClass);
}

function getStudents(classId?: string) {
  return all(
    `SELECT s.*, g.name AS grade_name, c.name AS class_name
     FROM students s
     JOIN grades g ON g.id = s.grade_id
     JOIN classrooms c ON c.id = s.class_id
     WHERE s.deleted_at IS NULL AND c.deleted_at IS NULL AND g.deleted_at IS NULL ${classId ? "AND s.class_id = ?" : ""}
     ORDER BY g.name, c.name, s.display_order, s.created_at`,
    ...(classId ? [classId] : [])
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
    `SELECT hs.*, st.name AS student_name, st.student_no, st.aliases, st.grade_id, st.class_id, st.display_order
     FROM homework_submissions hs
     JOIN students st ON st.id = hs.student_id
     WHERE hs.task_id = ?
     ORDER BY st.display_order, hs.created_at`,
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
      name: row.student_name_snapshot ? String(row.student_name_snapshot) : String(row.student_name),
      studentNo: row.student_no ? String(row.student_no) : null,
      aliases: parseJsonList(row.aliases),
      gradeId: String(row.grade_id),
      classId: String(row.class_id),
      displayOrder: Number(row.display_order ?? 0)
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
    subject: { id: String(row.subject_id), name: row.subject_name_snapshot ? String(row.subject_name_snapshot) : String(row.subject_name) },
    grade: { id: String(row.grade_id), name: row.grade_name_snapshot ? String(row.grade_name_snapshot) : String(row.grade_name) },
    classroom: {
      id: String(row.class_id),
      name: row.class_name_snapshot ? String(row.class_name_snapshot) : String(row.class_name),
      gradeId: String(row.grade_id)
    },
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
    throw notFound("作业任务不存在或无权访问");
  }
  return camelTask(row);
}

function getRegisterTaskRows(classId: string, currentTeacherId: string) {
  return all(
    `SELECT t.*, s.name AS subject_name, g.name AS grade_name, c.name AS class_name, te.name AS teacher_name
     FROM homework_tasks t
     JOIN subjects s ON s.id = t.subject_id
     JOIN grades g ON g.id = t.grade_id
     JOIN classrooms c ON c.id = t.class_id
     JOIN teachers te ON te.id = t.teacher_id
     WHERE t.class_id = ? AND t.teacher_id = ?
     ORDER BY t.due_date ASC, t.created_at ASC`,
    classId,
    currentTeacherId
  );
}

function getHomeworkRegister(classId: string, currentTeacherId: string): HomeworkRegister {
  const classroom = one(
    `SELECT c.id, c.name, c.grade_id, g.name AS grade_name
     FROM classrooms c
     JOIN grades g ON g.id = c.grade_id
     WHERE c.id = ? AND c.deleted_at IS NULL AND g.deleted_at IS NULL`,
    classId
  );
  if (!classroom) {
    throw notFound("班级不存在或已删除");
  }
  const students = getStudents(classId).map((student) => ({
    id: student.id,
    name: student.name,
    displayOrder: student.displayOrder
  }));
  const taskRows = getRegisterTaskRows(classId, currentTeacherId);
  const tasks = taskRows.map((row) => ({
    id: String(row.id),
    title: String(row.title),
    dueDate: String(row.due_date),
    subjectName: row.subject_name_snapshot ? String(row.subject_name_snapshot) : String(row.subject_name),
    teacherName: String(row.teacher_name)
  }));
  const cells: HomeworkRegisterCell[] = [];
  for (const task of tasks) {
    const submissions = new Map(
      all("SELECT student_id, status FROM homework_submissions WHERE task_id = ?", task.id).map((row) => [
        String(row.student_id),
        String(row.status)
      ])
    );
    for (const student of students) {
      const status = submissions.get(student.id) ?? "missing";
      const cell = submissionCell(status);
      cells.push({
        taskId: task.id,
        studentId: student.id,
        status: status as HomeworkRegisterCell["status"],
        symbol: cell.symbol,
        color: cell.color
      });
    }
  }
  return {
    grade: { id: String(classroom.grade_id), name: String(classroom.grade_name) },
    classroom: { id: String(classroom.id), name: String(classroom.name) },
    students,
    tasks,
    cells
  };
}

function shortDate(input: string) {
  const date = new Date(input);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${month}/${day}`;
}

function safeSheetName(input: string) {
  return input.replace(/[\\/*?:[\]]/g, "").slice(0, 31) || "作业登记表";
}

function contentDispositionFilename(filename: string) {
  return `attachment; filename="homework-register.xlsx"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

async function buildHomeworkRegisterWorkbook(register: HomeworkRegister) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Workbook";
  workbook.created = new Date();
  const sheetName = safeSheetName(`${register.grade.name}${register.classroom.name}`);
  const worksheet = workbook.addWorksheet(sheetName);
  const totalColumns = Math.max(2, register.tasks.length + 1);
  worksheet.mergeCells(1, 1, 1, totalColumns);
  worksheet.getCell(1, 1).value = `${register.grade.name}${register.classroom.name}作业登记表`;
  worksheet.getCell(1, 1).alignment = { horizontal: "center", vertical: "middle" };
  worksheet.getCell(1, 1).font = { name: "宋体", size: 16, bold: true };
  worksheet.getCell(2, 1).value = "姓名";
  worksheet.getCell(3, 1).value = "";
  register.tasks.forEach((task, index) => {
    const column = index + 2;
    worksheet.getCell(2, column).value = shortDate(task.dueDate);
    worksheet.getCell(3, column).value = task.title;
  });
  const cellByKey = new Map(register.cells.map((cell) => [`${cell.taskId}:${cell.studentId}`, cell]));
  register.students.forEach((student, studentIndex) => {
    const rowNumber = studentIndex + 4;
    worksheet.getCell(rowNumber, 1).value = student.name;
    register.tasks.forEach((task, taskIndex) => {
      const column = taskIndex + 2;
      const registerCell = cellByKey.get(`${task.id}:${student.id}`);
      const worksheetCell = worksheet.getCell(rowNumber, column);
      worksheetCell.value = registerCell?.symbol ?? "×";
      if (registerCell?.color === "red") {
        worksheetCell.font = { name: "宋体", color: { argb: "FFFF0000" }, bold: true };
      }
    });
  });
  worksheet.columns = [
    { width: 12 },
    ...register.tasks.map(() => ({ width: 12 }))
  ];
  worksheet.views = [{ state: "frozen", xSplit: 1, ySplit: 3 }];
  for (let row = 1; row <= register.students.length + 3; row += 1) {
    for (let column = 1; column <= totalColumns; column += 1) {
      const cell = worksheet.getCell(row, column);
      cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
      cell.border = {
        top: { style: "thin" },
        left: { style: "thin" },
        bottom: { style: "thin" },
        right: { style: "thin" }
      };
      if (row === 2 || row === 3) {
        cell.font = { name: "宋体", bold: true };
      }
    }
  }
  return workbook;
}

function learnVoiceAlias(studentId: string, rawText: string | undefined) {
  if (!rawText) return;
  const alias = shouldLearnVoiceAlias(rawText);
  if (!alias) return;
  const student = one("SELECT name, aliases FROM students WHERE id = ? AND deleted_at IS NULL", studentId);
  if (!student) return;
  if (alias === String(student.name)) return;
  const aliases = parseJsonList(student.aliases);
  if (aliases.includes(alias)) return;
  run("UPDATE students SET aliases = ?, updated_at = ? WHERE id = ?", JSON.stringify([...aliases, alias]), nowIso(), studentId);
}

function applyVoiceMatch(taskId: string, currentTeacherId: string, text: string, source = "voice") {
  const task = getTaskForTeacher(taskId, currentTeacherId);
  const students: StudentLite[] = task.submissions.map((submission) => ({
    id: submission.student.id,
    name: submission.student.name,
    studentNo: submission.student.studentNo,
    aliases: submission.student.aliases
  }));
  const baseBatch = matchStudentNameSequence(text, students, {
    submittedStudentIds: task.submissions
      .filter((submission) => submission.status === "submitted" || submission.status === "late_submitted")
      .map((submission) => submission.student.id)
  });
  for (const segment of baseBatch.segments) {
    if (segment.status !== "auto_submitted" || !segment.matchedStudentId) continue;
    run(
      "UPDATE homework_submissions SET status = 'submitted', source = ?, raw_text = ?, updated_at = ? WHERE task_id = ? AND student_id = ?",
      source,
      segment.rawText,
      nowIso(),
      taskId,
      segment.matchedStudentId
    );
  }
  const updatedTask = getTaskForTeacher(taskId, currentTeacherId);
  const batch: VoiceBatchMatchResult = { ...baseBatch, stats: updatedTask.stats };
  return { batch, task: updatedTask };
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

function volcengineAuthorizationHeader(token: string) {
  return `Bearer; ${token}`;
}

function buildVolcengineHeader(messageType: number, flags: number) {
  return Buffer.from([
    (volcengineProtocolVersion << 4) | volcengineHeaderSize,
    (messageType << 4) | flags,
    (volcengineSerializationJson << 4) | volcengineCompressionGzip,
    0x00
  ]);
}

function buildVolcengineFullClientRequest(payload: unknown) {
  const body = gzipSync(Buffer.from(JSON.stringify(payload), "utf8"));
  const size = Buffer.alloc(4);
  size.writeUInt32BE(body.length, 0);
  return Buffer.concat([
    buildVolcengineHeader(volcengineMessageType.fullClientRequest, volcengineMessageFlags.noSequence),
    size,
    body
  ]);
}

function buildVolcengineAudioRequest(audio: Buffer, last: boolean) {
  const body = gzipSync(audio);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(body.length, 0);
  return Buffer.concat([
    buildVolcengineHeader(
      volcengineMessageType.audioOnlyRequest,
      last ? volcengineMessageFlags.negativeSequence : volcengineMessageFlags.noSequence
    ),
    size,
    body
  ]);
}

function rawDataToBuffer(message: RawData) {
  if (Buffer.isBuffer(message)) return message;
  if (message instanceof ArrayBuffer) return Buffer.from(message);
  return Buffer.concat(message);
}

function parseVolcengineResponse(message: RawData) {
  const buffer = rawDataToBuffer(message);
  if (buffer.length < 8) {
    return { type: "unknown", text: "", error: "火山 ASR 响应过短" };
  }
  const headerSize = (buffer[0] & 0x0f) * 4;
  const messageType = buffer[1] >> 4;
  const flags = buffer[1] & 0x0f;
  const serialization = buffer[2] >> 4;
  const compression = buffer[2] & 0x0f;
  const payload = buffer.subarray(headerSize);
  let payloadMessage: Buffer | null = null;
  let sequence: number | undefined;
  let code: number | undefined;

  if (messageType === volcengineMessageType.fullServerResponse) {
    const payloadSize = payload.readInt32BE(0);
    payloadMessage = payload.subarray(4, 4 + payloadSize);
  } else if (messageType === volcengineMessageType.serverAck) {
    sequence = payload.readInt32BE(0);
    if (payload.length >= 8) {
      const payloadSize = payload.readUInt32BE(4);
      payloadMessage = payload.subarray(8, 8 + payloadSize);
    }
  } else if (messageType === volcengineMessageType.serverError) {
    code = payload.readUInt32BE(0);
    const payloadSize = payload.readUInt32BE(4);
    payloadMessage = payload.subarray(8, 8 + payloadSize);
  }

  if (!payloadMessage) {
    return { type: "ack", text: "", error: "", code };
  }

  if (compression === volcengineCompressionGzip && payloadMessage.length) {
    payloadMessage = gunzipSync(payloadMessage);
  }
  const rawPayload = payloadMessage.toString("utf8");
  let data: Record<string, unknown> | null = null;
  if (serialization === volcengineSerializationJson && rawPayload) {
    data = JSON.parse(rawPayload) as Record<string, unknown>;
  }
  const payloadCode = typeof data?.code === "number" ? data.code : code;
  const payloadErrorMessage =
    typeof data?.message === "string"
      ? data.message
      : typeof data?.Message === "string"
        ? data.Message
        : rawPayload;

  if (messageType !== volcengineMessageType.serverError && payloadCode !== undefined && payloadCode !== 1000) {
    return {
      type: "error",
      text: "",
      error: payloadErrorMessage || rawPayload,
      code: payloadCode
    };
  }

  const findText = (value: unknown): string => {
    if (typeof value === "string") return value;
    if (!value || typeof value !== "object") return "";
    if (Array.isArray(value)) {
      return value.map(findText).filter(Boolean).join(" ");
    }
    const record = value as Record<string, unknown>;
    for (const key of ["text", "utterance", "transcript", "sentence"]) {
      if (typeof record[key] === "string") return String(record[key]);
    }
    for (const key of ["result", "results", "utterances", "sentences"]) {
      const nested = findText(record[key]);
      if (nested) return nested;
    }
    return "";
  };
  const text = findText(data);
  const isFinal =
    flags === volcengineMessageFlags.negativeSequence ||
    sequence !== undefined && sequence < 0 ||
    data?.is_final === true ||
    data?.final === true ||
    data?.type === "final";

  return {
    type: messageType === volcengineMessageType.serverError ? "error" : isFinal ? "final" : "partial",
    text,
    error: messageType === volcengineMessageType.serverError ? payloadErrorMessage || rawPayload : rawPayload,
    code: payloadCode
  };
}

function formatVolcengineAsrError(code: number | undefined, error: string) {
  if (code === 45000292 || /quota exceeded|concurrency/i.test(error)) {
    return "火山引擎流式识别并发额度已用完，请等待上一段录音释放后再试；如果仍然出现，需要在火山控制台提升流式识别并发额度。";
  }
  if (code === 1020 || /response code 1020/i.test(error)) {
    return `火山引擎 ASR 初始化失败 1020：${error}。通常是请求参数、音频格式、cluster 或账号权限不匹配。`;
  }
  if (code === 1013 || /No valid speeches/i.test(error)) {
    return "火山引擎没有检测到有效人声，请确认录音时说话声音足够清晰、麦克风权限已允许，并尽量靠近手机麦克风。";
  }
  return `火山引擎 ASR 错误${code ? ` ${code}` : ""}：${error}`;
}

function ensureClass(gradeId: string, classId: string) {
  const classroom = one("SELECT id FROM classrooms WHERE id = ? AND grade_id = ? AND deleted_at IS NULL", classId, gradeId);
  if (!classroom) {
    throw notFound("班级不存在或无权访问");
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

app.post("/api/auth/register", authLimiter, async (req, res, next) => {
  try {
    const input = teacherRegisterSchema.parse(req.body);
    const timestamp = nowIso();
    const passwordHash = await bcrypt.hash(input.password, 12);
    const created = withTransaction(() => {
      const id = createId();
      run("INSERT INTO teachers (id, username, name, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)", id, input.username, input.name, passwordHash, timestamp, timestamp);
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

app.post("/api/auth/login", authLimiter, async (req, res, next) => {
  try {
    const input = loginSchema.parse(req.body);
    const teacher = one("SELECT * FROM teachers WHERE username = ?", input.username);
    const passwordOk = await bcrypt.compare(input.password, teacher ? String(teacher.password_hash) : DUMMY_PASSWORD_HASH);
    if (!teacher || !passwordOk) return fail(res, 401, "账号或密码错误");
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
      grades: getGrades(),
      classrooms: getClasses(),
      subjects: getSubjects(currentTeacherId),
      students: getStudents(),
      tasks: getTaskRows(currentTeacherId).slice(0, 30).map(camelTask)
    });
  } catch (error) {
    return next(error);
  }
});

app.get("/api/grades", requireAuth, (_req: AuthRequest, res) => ok(res, getGrades()));
app.post("/api/grades", requireAuth, (req: AuthRequest, res, next) => {
  try {
    const input = namedEntitySchema.parse(req.body);
    const existing = one("SELECT * FROM grades WHERE name = ?", input.name);
    if (existing) {
      if (existing.deleted_at) {
        run("UPDATE grades SET deleted_at = NULL, updated_at = ? WHERE id = ?", nowIso(), String(existing.id));
      }
      return ok(res, camelGrade(one("SELECT * FROM grades WHERE id = ?", String(existing.id))!));
    }
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
    const id = routeParam(req, "id");
    run("UPDATE grades SET name = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL", input.name, nowIso(), id);
    return ok(res, camelGrade(one("SELECT * FROM grades WHERE id = ?", id)!));
  } catch (error) {
    return next(error);
  }
});
app.delete("/api/grades/:id", requireAuth, (req: AuthRequest, res, next) => {
  try {
    const id = routeParam(req, "id");
    const activeClass = one("SELECT id FROM classrooms WHERE grade_id = ? AND deleted_at IS NULL", id);
    if (activeClass) {
      throw new ApiError(409, "该年级下仍有班级，不能删除");
    }
    run("UPDATE grades SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL", nowIso(), nowIso(), id);
  } catch (error) {
    return next(error);
  }
  return ok(res, { success: true });
});

app.get("/api/classes", requireAuth, (_req: AuthRequest, res) => ok(res, getClasses()));
app.post("/api/classes", requireAuth, (req: AuthRequest, res, next) => {
  try {
    const input = classSchema.parse(req.body);
    if (!one("SELECT id FROM grades WHERE id = ? AND deleted_at IS NULL", input.gradeId)) {
      throw notFound("年级不存在或无权访问");
    }
    const existing = one("SELECT * FROM classrooms WHERE grade_id = ? AND name = ?", input.gradeId, input.name);
    if (existing) {
      if (existing.deleted_at) {
        run("UPDATE classrooms SET deleted_at = NULL, updated_at = ? WHERE id = ?", nowIso(), String(existing.id));
      }
      return ok(res, getClasses().find((item) => item.id === String(existing.id)));
    }
    const id = createId();
    const timestamp = nowIso();
    run("INSERT INTO classrooms (id, name, teacher_id, grade_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)", id, input.name, teacherId(req), input.gradeId, timestamp, timestamp);
    return ok(res, getClasses().find((item) => item.id === id));
  } catch (error) {
    return next(error);
  }
});
app.patch("/api/classes/:id", requireAuth, (req: AuthRequest, res, next) => {
  try {
    const input = classSchema.parse(req.body);
    const id = routeParam(req, "id");
    if (!one("SELECT id FROM grades WHERE id = ? AND deleted_at IS NULL", input.gradeId)) {
      throw notFound("年级不存在或无权访问");
    }
    run("UPDATE classrooms SET name = ?, grade_id = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL", input.name, input.gradeId, nowIso(), id);
    return ok(res, getClasses().find((item) => item.id === id));
  } catch (error) {
    return next(error);
  }
});
app.delete("/api/classes/:id", requireAuth, (req: AuthRequest, res, next) => {
  try {
    const id = routeParam(req, "id");
    run("UPDATE classrooms SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL", nowIso(), nowIso(), id);
    return ok(res, { success: true });
  } catch (error) {
    return next(error);
  }
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
  return ok(res, getStudents(classId));
});
app.post("/api/students", requireAuth, (req: AuthRequest, res, next) => {
  try {
    const input = studentSchema.parse(req.body);
    const currentTeacherId = teacherId(req);
    ensureClass(input.gradeId, input.classId);
    const existing = one("SELECT * FROM students WHERE class_id = ? AND name = ?", input.classId, input.name);
    if (existing) {
      if (existing.deleted_at) {
        const maxOrder = one<{ max_order?: number }>("SELECT MAX(display_order) AS max_order FROM students WHERE class_id = ? AND deleted_at IS NULL", input.classId);
        run("UPDATE students SET deleted_at = NULL, display_order = ?, updated_at = ? WHERE id = ?", Number(maxOrder?.max_order ?? 0) + 1, nowIso(), String(existing.id));
      }
      return ok(res, getStudents().find((item) => item.id === String(existing.id)));
    }
    const id = createId();
    const timestamp = nowIso();
    const maxOrder = one<{ max_order?: number }>("SELECT MAX(display_order) AS max_order FROM students WHERE class_id = ? AND deleted_at IS NULL", input.classId);
    const displayOrder = input.displayOrder ?? Number(maxOrder?.max_order ?? 0) + 1;
    run("INSERT INTO students (id, name, student_no, aliases, teacher_id, grade_id, class_id, display_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", id, input.name, input.studentNo ?? null, JSON.stringify(input.aliases), currentTeacherId, input.gradeId, input.classId, displayOrder, timestamp, timestamp);
    return ok(res, getStudents().find((item) => item.id === id));
  } catch (error) {
    return next(error);
  }
});
app.patch("/api/students/:id", requireAuth, (req: AuthRequest, res, next) => {
  try {
    const input = studentSchema.parse(req.body);
    const id = routeParam(req, "id");
    ensureClass(input.gradeId, input.classId);
    const existing = one<{ display_order?: number }>("SELECT display_order FROM students WHERE id = ?", id);
    run("UPDATE students SET name = ?, student_no = ?, aliases = ?, grade_id = ?, class_id = ?, display_order = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL", input.name, input.studentNo ?? null, JSON.stringify(input.aliases), input.gradeId, input.classId, input.displayOrder ?? Number(existing?.display_order ?? 0), nowIso(), id);
    return ok(res, getStudents().find((item) => item.id === id));
  } catch (error) {
    return next(error);
  }
});
app.delete("/api/students/:id", requireAuth, (req: AuthRequest, res, next) => {
  try {
    const id = routeParam(req, "id");
    run("UPDATE students SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL", nowIso(), nowIso(), id);
    return ok(res, { success: true });
  } catch (error) {
    return next(error);
  }
});

app.patch("/api/classes/:id/students/order", requireAuth, (req: AuthRequest, res, next) => {
  try {
    const input = studentOrderSchema.parse(req.body);
    const classId = routeParam(req, "id");
    if (!one("SELECT id FROM classrooms WHERE id = ? AND deleted_at IS NULL", classId)) {
      throw notFound("班级不存在或已删除");
    }
    withTransaction(() => {
      input.studentIds.forEach((studentId, index) => {
        run("UPDATE students SET display_order = ?, updated_at = ? WHERE id = ? AND class_id = ? AND deleted_at IS NULL", index + 1, nowIso(), studentId, classId);
      });
    });
    return ok(res, getStudents(classId));
  } catch (error) {
    return next(error);
  }
});

app.get("/api/classes/:id/homework-register", requireAuth, (req: AuthRequest, res, next) => {
  try {
    return ok(res, getHomeworkRegister(routeParam(req, "id"), teacherId(req)));
  } catch (error) {
    return next(error);
  }
});

app.get("/api/classes/:id/homework-register/export", requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const register = getHomeworkRegister(routeParam(req, "id"), teacherId(req));
    const workbook = await buildHomeworkRegisterWorkbook(register);
    const buffer = await workbook.xlsx.writeBuffer();
    const filename = `${register.grade.name}${register.classroom.name}作业登记表.xlsx`;
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", contentDispositionFilename(filename));
    return res.send(Buffer.from(buffer));
  } catch (error) {
    return next(error);
  }
});

app.get("/api/homework-tasks", requireAuth, (req: AuthRequest, res) => ok(res, getTaskRows(teacherId(req)).map(camelTask)));
app.post("/api/homework-tasks", requireAuth, (req: AuthRequest, res, next) => {
  try {
    const input = homeworkTaskSchema.parse(req.body);
    const currentTeacherId = teacherId(req);
    ensureClass(input.gradeId, input.classId);
    if (!one("SELECT id FROM subjects WHERE id = ? AND teacher_id = ?", input.subjectId, currentTeacherId)) {
      throw notFound("学科不存在或无权访问");
    }
    const taskId = withTransaction(() => {
      const id = createId();
      const timestamp = nowIso();
      const grade = one("SELECT name FROM grades WHERE id = ?", input.gradeId);
      const classroom = one("SELECT name FROM classrooms WHERE id = ?", input.classId);
      const subject = one("SELECT name FROM subjects WHERE id = ?", input.subjectId);
      run(
        "INSERT INTO homework_tasks (id, title, due_date, status, teacher_id, subject_id, grade_id, class_id, grade_name_snapshot, class_name_snapshot, subject_name_snapshot, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        id,
        input.title,
        parseDate(input.dueDate),
        input.status,
        currentTeacherId,
        input.subjectId,
        input.gradeId,
        input.classId,
        grade ? String(grade.name) : null,
        classroom ? String(classroom.name) : null,
        subject ? String(subject.name) : null,
        timestamp,
        timestamp
      );
      const students = all("SELECT id, name FROM students WHERE class_id = ? AND deleted_at IS NULL ORDER BY display_order, created_at", input.classId);
      for (const student of students) {
        run("INSERT INTO homework_submissions (id, task_id, student_id, status, source, student_name_snapshot, created_at, updated_at) VALUES (?, ?, ?, 'missing', 'system', ?, ?, ?)", createId(), id, String(student.id), String(student.name), timestamp, timestamp);
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
    ensureClass(input.gradeId, input.classId);
    const grade = one("SELECT name FROM grades WHERE id = ?", input.gradeId);
    const classroom = one("SELECT name FROM classrooms WHERE id = ?", input.classId);
    const subject = one("SELECT name FROM subjects WHERE id = ?", input.subjectId);
    run(
      "UPDATE homework_tasks SET title = ?, due_date = ?, status = ?, subject_id = ?, grade_id = ?, class_id = ?, grade_name_snapshot = ?, class_name_snapshot = ?, subject_name_snapshot = ?, updated_at = ? WHERE id = ? AND teacher_id = ?",
      input.title,
      parseDate(input.dueDate),
      input.status,
      input.subjectId,
      input.gradeId,
      input.classId,
      grade ? String(grade.name) : null,
      classroom ? String(classroom.name) : null,
      subject ? String(subject.name) : null,
      nowIso(),
      routeParam(req, "id"),
      currentTeacherId
    );
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
    run(
      "UPDATE homework_submissions SET status = ?, source = ?, raw_text = COALESCE(?, raw_text), updated_at = ? WHERE task_id = ? AND student_id = ?",
      input.status,
      input.source,
      input.rawText ?? null,
      nowIso(),
      routeParam(req, "id"),
      routeParam(req, "studentId")
    );
    if (input.status === "submitted" && input.source === "voice-confirmed") {
      learnVoiceAlias(routeParam(req, "studentId"), input.rawText);
    }
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
    const filePath = req.file.path;
    const originalName = req.file.originalname;
    const result = await withOcrSlot(async () => {
      const worker = await createWorker("chi_sim+eng");
      try {
        return await worker.recognize(filePath);
      } finally {
        await worker.terminate();
      }
    });
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
    await fs.promises.unlink(filePath).catch(() => undefined);
    const id = createId();
    const timestamp = nowIso();
    run("INSERT INTO import_batches (id, source, original_name, raw_text, parsed_rows, teacher_id, created_at, updated_at) VALUES (?, 'ocr', ?, ?, ?, ?, ?, ?)", id, originalName, rawText, JSON.stringify(rows), teacherId(req), timestamp, timestamp);
    return ok(res, { batchId: id, rawText, rows });
  } catch (error) {
    return next(error);
  }
});

app.post("/api/imports/:id/commit", requireAuth, (req: AuthRequest, res, next) => {
  try {
    const input = importCommitSchema.parse(req.body);
    const currentTeacherId = teacherId(req);
    ensureClass(input.gradeId, input.classId);
    if (!one("SELECT id FROM import_batches WHERE id = ? AND teacher_id = ?", routeParam(req, "id"), currentTeacherId)) {
      throw notFound("导入批次不存在或无权访问");
    }
    let created = 0;
    let skipped = 0;
    let overwritten = 0;
    const timestamp = nowIso();
    withTransaction(() => {
      for (const row of input.rows) {
        const existing = one("SELECT id, deleted_at FROM students WHERE class_id = ? AND name = ?", input.classId, row.name);
        if (existing?.deleted_at) {
          const maxOrder = one<{ max_order?: number }>("SELECT MAX(display_order) AS max_order FROM students WHERE class_id = ? AND deleted_at IS NULL", input.classId);
          run("UPDATE students SET student_no = ?, aliases = ?, grade_id = ?, class_id = ?, display_order = ?, deleted_at = NULL, updated_at = ? WHERE id = ?", row.studentNo ?? null, JSON.stringify(row.aliases), input.gradeId, input.classId, Number(maxOrder?.max_order ?? 0) + 1, timestamp, String(existing.id));
          overwritten += 1;
          continue;
        }
        if (existing && input.duplicateStrategy === "skip") {
          skipped += 1;
          continue;
        }
        if (existing) {
          overwritten += 1;
          run("UPDATE students SET student_no = ?, aliases = ?, grade_id = ?, class_id = ?, deleted_at = NULL, updated_at = ? WHERE id = ?", row.studentNo ?? null, JSON.stringify(row.aliases), input.gradeId, input.classId, timestamp, String(existing.id));
          continue;
        }
        created += 1;
        const maxOrder = one<{ max_order?: number }>("SELECT MAX(display_order) AS max_order FROM students WHERE class_id = ? AND deleted_at IS NULL", input.classId);
        run("INSERT INTO students (id, name, student_no, aliases, teacher_id, grade_id, class_id, display_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", createId(), row.name, row.studentNo ?? null, JSON.stringify(row.aliases), currentTeacherId, input.gradeId, input.classId, Number(maxOrder?.max_order ?? 0) + 1, timestamp, timestamp);
      }
    });
    return ok(res, { created, skipped, overwritten, students: getStudents(input.classId) });
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
  let stopRequested = false;
  let finished = false;
  let lastProviderText = "";
  let lastMatchedText = "";
  let finalizeTimer: ReturnType<typeof setTimeout> | null = null;
  let upstreamReadyForAudio = false;
  let audioChunksReceived = 0;
  let audioBytesReceived = 0;
  let audioChunksSent = 0;
  let audioBytesSent = 0;
  let stopFramePending = false;
  let heldAudioChunk: Buffer | null = null;
  const pendingAudioChunks: Buffer[] = [];
  const maxPendingAudioBytes = 1024 * 1024 * 2;

  function closeUpstream() {
    if (finalizeTimer) {
      clearTimeout(finalizeTimer);
      finalizeTimer = null;
    }
    const socket = upstream;
    upstream = null;
    if (socket && socket.readyState !== WebSocket.CLOSED && socket.readyState !== WebSocket.CLOSING) {
      socket.close();
    }
    activeAsrClients.delete(ws);
  }

  function queueAudioChunk(chunk: Buffer) {
    const queuedBytes = pendingAudioChunks.reduce((total, item) => total + item.length, 0);
    if (queuedBytes + chunk.length <= maxPendingAudioBytes) {
      pendingAudioChunks.push(chunk);
    }
  }

  function sendAudioToProvider(chunk: Buffer, last: boolean) {
    if (upstream?.readyState !== WebSocket.OPEN || !upstreamReadyForAudio) {
      if (!last && chunk.length > 0) {
        queueAudioChunk(chunk);
      } else if (last) {
        stopFramePending = true;
      }
      return;
    }
    if (last) {
      const finalChunk = chunk.length > 0 ? chunk : heldAudioChunk ?? Buffer.alloc(0);
      heldAudioChunk = null;
      upstream.send(buildVolcengineAudioRequest(finalChunk, true));
      audioChunksSent += 1;
      audioBytesSent += finalChunk.length;
      return;
    }
    if (heldAudioChunk) {
      upstream.send(buildVolcengineAudioRequest(heldAudioChunk, false));
      audioChunksSent += 1;
      audioBytesSent += heldAudioChunk.length;
    }
    heldAudioChunk = chunk;
  }

  function flushQueuedAudio() {
    while (pendingAudioChunks.length > 0) {
      const chunk = pendingAudioChunks.shift();
      if (chunk) {
        sendAudioToProvider(chunk, false);
      }
    }
    if (stopFramePending) {
      stopFramePending = false;
      sendAudioToProvider(Buffer.alloc(0), true);
    }
  }

  function closeClientSoon() {
    if (ws.readyState === WebSocket.OPEN) {
      setTimeout(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.close(1000, "ASR session finished");
        }
      }, 100);
    }
  }

  function finishAsrSession(useLastTextFallback: boolean) {
    if (finished) {
      return;
    }
    finished = true;
    if (finalizeTimer) {
      clearTimeout(finalizeTimer);
      finalizeTimer = null;
    }
    if (useLastTextFallback && lastProviderText && lastProviderText !== lastMatchedText) {
      handleFinalText(lastProviderText);
    }
    if (!lastProviderText) {
      sendAsr(ws, {
        type: "status",
        message: `未收到识别文本；浏览器音频 ${audioChunksReceived} 段/${audioBytesReceived} 字节，已转发 ${audioChunksSent} 段/${audioBytesSent} 字节`
      });
    }
    sendAsr(ws, { type: "closed" });
    closeUpstream();
    closeClientSoon();
  }

  function handleFinalText(text: string) {
    const normalized = text.trim();
    if (!normalized) {
      return;
    }
    lastMatchedText = normalized;
    try {
      const result = applyVoiceMatch(asrContext.taskId, asrContext.teacherId, normalized, "asr");
      sendAsr(ws, { type: "batch-final", text: normalized, batch: result.batch, stats: result.task.stats });
    } catch (error) {
      sendAsr(ws, { type: "error", message: error instanceof Error ? error.message : "语音匹配失败" });
    }
  }

  function connectVolcengine() {
    const endpoint = process.env.VOLCENGINE_ASR_ENDPOINT || defaultVolcengineAsrEndpoint;
    const appId = process.env.VOLCENGINE_ASR_APP_ID;
    const token = process.env.VOLCENGINE_ASR_ACCESS_TOKEN;
    const cluster = process.env.VOLCENGINE_ASR_CLUSTER;
    if (!appId || !token || !cluster) {
      sendAsr(ws, { type: "error", message: "火山引擎 ASR 未配置完整，请检查服务器 .env" });
      return null;
    }

    const providerSocket = new WebSocket(endpoint, {
      headers: {
        Authorization: volcengineAuthorizationHeader(token),
        "X-Api-App-Id": appId,
        "X-Api-Access-Key": token,
        "X-Api-Cluster": cluster
      }
    });

    providerSocket.on("open", () => {
      providerSocket.send(
        buildVolcengineFullClientRequest({
          app: { appid: appId, token, cluster },
          user: { uid: asrContext.teacherId },
          request: {
            reqid: createId(),
            workflow: "audio_in,resample,partition,vad,fe,decode,itn,nlu_punctuate",
            result_type: "full",
            sequence: 1
          },
          audio: {
            format: process.env.VOLCENGINE_ASR_FORMAT ?? "pcm",
            rate: envPositiveInt("VOLCENGINE_ASR_SAMPLE_RATE", 16000),
            language: process.env.VOLCENGINE_ASR_LANGUAGE ?? "zh-CN",
            bits: 16,
            channel: 1,
            codec: "raw"
          }
        })
      );
      sendAsr(ws, { type: "status", message: "火山 ASR 已连接，正在初始化识别通道" });
    });

    providerSocket.on("message", (message) => {
      try {
        const response = parseVolcengineResponse(message);
        if (response.type === "error") {
          sendAsr(ws, { type: "error", message: formatVolcengineAsrError(response.code, String(response.error)) });
          finishAsrSession(false);
          return;
        }
        if (!upstreamReadyForAudio) {
          upstreamReadyForAudio = true;
          sendAsr(ws, { type: "ready", provider: "volcengine" });
          flushQueuedAudio();
        }
        if (response.text && response.type === "final") {
          lastProviderText = response.text.trim();
          handleFinalText(response.text);
          if (stopRequested) {
            finishAsrSession(false);
          }
        } else if (response.text) {
          lastProviderText = response.text.trim();
          sendAsr(ws, { type: "partial", text: response.text });
        }
      } catch {
        sendAsr(ws, { type: "status", message: "火山 ASR 响应解析失败" });
      }
    });

    providerSocket.on("error", (error) => {
      sendAsr(ws, { type: "error", message: `火山引擎 ASR 连接失败：${error.message}` });
      finishAsrSession(false);
    });

    providerSocket.on("close", (code, reason) => {
      if (upstream === providerSocket) {
        upstream = null;
      }
      activeAsrClients.delete(ws);
      if (finished) {
        return;
      }
      if (ws.readyState === WebSocket.OPEN) {
        const detail = reason.length ? `，原因：${reason.toString()}` : "";
        sendAsr(ws, { type: "status", message: `火山引擎 ASR 连接已关闭：${code}${detail}` });
        if (stopRequested) {
          finishAsrSession(true);
        } else {
          sendAsr(ws, { type: "closed" });
        }
      }
    });

    return providerSocket;
  }

  sendAsr(ws, { type: "ready", provider: asrProvider });

  ws.on("message", (message: RawData, isBinary) => {
    if (isBinary) {
      if (asrProvider === "volcengine") {
        const chunk = rawDataToBuffer(message);
        audioChunksReceived += 1;
        audioBytesReceived += chunk.length;
        sendAudioToProvider(chunk, false);
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
        if (activeAsrClients.size >= maxAsrConcurrency) {
          sendAsr(ws, { type: "error", message: "当前已有录音识别正在进行，请先结束上一段录音，等待几秒后再开始。" });
          ws.close(1013, "ASR concurrency limit");
          return;
        }
        activeAsrClients.add(ws);
        upstream = connectVolcengine();
        if (!upstream) {
          activeAsrClients.delete(ws);
          ws.close(1011, "ASR upstream unavailable");
        }
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
        finishAsrSession(false);
      } else if (upstream?.readyState === WebSocket.OPEN) {
        stopRequested = true;
        sendAsr(ws, {
          type: "status",
          message: `录音已停止，收到 ${audioChunksReceived} 段音频，正在等待识别结果`
        });
        flushQueuedAudio();
        sendAudioToProvider(Buffer.alloc(0), true);
        finalizeTimer = setTimeout(() => {
          finishAsrSession(true);
        }, 10000);
      } else {
        finishAsrSession(true);
      }
      return;
    }
  });

  ws.on("close", closeUpstream);
  ws.on("error", closeUpstream);
});

app.use((error: unknown, _req: Request, res: Response<ApiEnvelope<never>>, _next: NextFunction) => {
  if (error instanceof z.ZodError) {
    return fail(res, 400, error.issues[0]?.message ?? "请求参数有误");
  }
  if (error instanceof ApiError) {
    return fail(res, error.status, error.message);
  }
  if (error instanceof Error) {
    if (/UNIQUE constraint failed/.test(error.message)) {
      return fail(res, 409, "数据已存在，请检查账号、班级、学生或学科是否重复");
    }
    console.error("[workbook] 未处理的错误:", error);
    return fail(res, 500, "服务器内部错误，请稍后重试");
  }
  return fail(res, 500, "服务器内部错误，请稍后重试");
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

