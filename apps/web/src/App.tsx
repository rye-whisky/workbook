import {
  BookOpenCheck,
  Check,
  ClipboardList,
  FileSpreadsheet,
  Home,
  LogOut,
  Mic,
  Pause,
  Plus,
  RefreshCcw,
  School,
  Search,
  Settings,
  Trash2,
  Upload,
  Users,
  X
} from "lucide-react";
import { FormEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TaskStats, VoiceMatchResult } from "@workbook/shared";
import { DEFAULT_SUBJECTS } from "@workbook/shared";

type Tab = "home" | "students" | "tasks" | "collect" | "settings";

interface Teacher {
  id: string;
  username: string;
  name: string;
}

interface Grade {
  id: string;
  name: string;
}

interface Classroom {
  id: string;
  name: string;
  gradeId: string;
  grade?: Grade;
}

interface Subject {
  id: string;
  name: string;
}

interface Student {
  id: string;
  name: string;
  studentNo?: string | null;
  aliases: string[];
  gradeId: string;
  classId: string;
  grade?: Grade;
  classroom?: Classroom;
}

interface Submission {
  id: string;
  status: "submitted" | "missing" | "pending_confirm";
  source: string;
  rawText?: string | null;
  student: Student;
}

interface HomeworkTask {
  id: string;
  title: string;
  dueDate: string;
  status: "draft" | "active" | "closed";
  subjectId: string;
  gradeId: string;
  classId: string;
  subject: Subject;
  grade: Grade;
  classroom: Classroom;
  submissions: Submission[];
  stats: TaskStats;
}

interface BootstrapData {
  grades: Grade[];
  classrooms: Classroom[];
  subjects: Subject[];
  students: Student[];
  tasks: HomeworkTask[];
}

interface ImportRow {
  name: string;
  studentNo?: string | null;
  aliases: string[];
}

interface PendingMatch {
  id: string;
  match: VoiceMatchResult;
}

interface ApiEnvelope<T> {
  data: T | null;
  error: string | null;
}

const API_BASE = "";
const DEFAULT_REGISTER: {
  name: string;
  username: string;
  password: string;
  subjectName: string;
  gradeName: string;
  className: string;
} = {
  name: "",
  username: "",
  password: "",
  subjectName: DEFAULT_SUBJECTS[0],
  gradeName: "七年级",
  className: "1班"
};

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  }
}

interface SpeechRecognitionConstructor {
  new (): SpeechRecognitionInstance;
}

interface SpeechRecognitionInstance {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  start: () => void;
  stop: () => void;
}

interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: ArrayLike<{
    isFinal: boolean;
    0: {
      transcript: string;
    };
  }>;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    credentials: "include",
    headers: init?.body instanceof FormData ? undefined : { "Content-Type": "application/json" },
    ...init
  });
  const payload = (await response.json()) as ApiEnvelope<T>;
  if (!response.ok || payload.error) {
    throw new Error(payload.error ?? "请求失败");
  }
  return payload.data as T;
}

function cx(...classes: Array<string | false | undefined>) {
  return classes.filter(Boolean).join(" ");
}

function formatDate(input: string) {
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit" }).format(new Date(input));
}

function toInputDate(input?: string) {
  const date = input ? new Date(input) : new Date();
  return date.toISOString().slice(0, 10);
}

function taskTitle(task: HomeworkTask) {
  return `${task.grade.name}${task.classroom.name} · ${task.subject.name}`;
}

export default function App() {
  const [teacher, setTeacher] = useState<Teacher | null>(null);
  const [data, setData] = useState<BootstrapData | null>(null);
  const [tab, setTab] = useState<Tab>("home");
  const [selectedClassId, setSelectedClassId] = useState("");
  const [selectedTaskId, setSelectedTaskId] = useState("");
  const [selectedTask, setSelectedTask] = useState<HomeworkTask | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const loadBootstrap = useCallback(async () => {
    const bootstrap = await api<BootstrapData>("/api/bootstrap");
    setData(bootstrap);
    setSelectedClassId((current) => current || bootstrap.classrooms[0]?.id || "");
    setSelectedTaskId((current) => current || bootstrap.tasks[0]?.id || "");
  }, []);

  const loadMe = useCallback(async () => {
    try {
      const me = await api<Teacher>("/api/auth/me");
      setTeacher(me);
      await loadBootstrap();
    } catch {
      setTeacher(null);
    }
  }, [loadBootstrap]);

  useEffect(() => {
    loadMe();
  }, [loadMe]);

  const refreshTask = useCallback(
    async (taskId = selectedTaskId) => {
      if (!taskId) {
        setSelectedTask(null);
        return;
      }
      const task = await api<HomeworkTask>(`/api/homework-tasks/${taskId}`);
      setSelectedTask(task);
      setSelectedTaskId(task.id);
      await loadBootstrap();
    },
    [loadBootstrap, selectedTaskId]
  );

  useEffect(() => {
    if (selectedTaskId) {
      refreshTask(selectedTaskId).catch(() => undefined);
    }
  }, [refreshTask, selectedTaskId]);

  const activeClass = useMemo(
    () => data?.classrooms.find((classroom) => classroom.id === selectedClassId),
    [data?.classrooms, selectedClassId]
  );
  const classStudents = useMemo(
    () => data?.students.filter((student) => student.classId === selectedClassId) ?? [],
    [data?.students, selectedClassId]
  );
  const recentTasks = data?.tasks ?? [];
  const openTasks = recentTasks.filter((task) => task.status !== "closed");

  async function runAction(action: () => Promise<void>, success?: string) {
    try {
      setBusy(true);
      setMessage("");
      await action();
      if (success) {
        setMessage(success);
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "操作失败");
    } finally {
      setBusy(false);
    }
  }

  if (!teacher) {
    return <AuthScreen busy={busy} setBusy={setBusy} setMessage={setMessage} message={message} onAuthed={loadMe} />;
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <span className="eyebrow">Workbook</span>
          <h1>{teacher.name}的作业台</h1>
        </div>
        <button
          className="icon-button"
          title="退出登录"
          onClick={() =>
            runAction(async () => {
              await api("/api/auth/logout", { method: "POST" });
              setTeacher(null);
              setData(null);
            })
          }
        >
          <LogOut size={19} />
        </button>
      </header>

      {message ? <div className="toast">{message}</div> : null}

      <main className="main-panel">
        {tab === "home" && (
          <HomeView
            data={data}
            activeClass={activeClass}
            classStudents={classStudents}
            openTasks={openTasks}
            selectedClassId={selectedClassId}
            selectedTaskId={selectedTaskId}
            onClassChange={setSelectedClassId}
            onTaskSelect={(taskId) => {
              setSelectedTaskId(taskId);
              setTab("collect");
            }}
          />
        )}

        {tab === "students" && data && (
          <StudentsView
            data={data}
            busy={busy}
            selectedClassId={selectedClassId}
            onClassChange={setSelectedClassId}
            onAction={runAction}
            onRefresh={loadBootstrap}
          />
        )}

        {tab === "tasks" && data && (
          <TasksView
            data={data}
            busy={busy}
            selectedClassId={selectedClassId}
            onClassChange={setSelectedClassId}
            onAction={runAction}
            onRefresh={loadBootstrap}
            onOpenTask={(taskId) => {
              setSelectedTaskId(taskId);
              setTab("collect");
            }}
          />
        )}

        {tab === "collect" && (
          <CollectView
            tasks={recentTasks}
            task={selectedTask}
            selectedTaskId={selectedTaskId}
            busy={busy}
            onTaskChange={setSelectedTaskId}
            onAction={runAction}
            onRefreshTask={refreshTask}
          />
        )}

        {tab === "settings" && data && (
          <SettingsView data={data} busy={busy} onAction={runAction} onRefresh={loadBootstrap} />
        )}
      </main>

      <nav className="bottom-nav" aria-label="主导航">
        <NavButton icon={<Home size={20} />} label="工作台" active={tab === "home"} onClick={() => setTab("home")} />
        <NavButton icon={<Users size={20} />} label="学生库" active={tab === "students"} onClick={() => setTab("students")} />
        <NavButton icon={<ClipboardList size={20} />} label="作业" active={tab === "tasks"} onClick={() => setTab("tasks")} />
        <NavButton icon={<Mic size={20} />} label="收作业" active={tab === "collect"} onClick={() => setTab("collect")} />
        <NavButton icon={<Settings size={20} />} label="设置" active={tab === "settings"} onClick={() => setTab("settings")} />
      </nav>
    </div>
  );
}

function NavButton(props: { icon: ReactNode; label: string; active: boolean; onClick: () => void }) {
  return (
    <button className={cx("nav-button", props.active && "active")} onClick={props.onClick}>
      {props.icon}
      <span>{props.label}</span>
    </button>
  );
}

function AuthScreen(props: {
  busy: boolean;
  message: string;
  setBusy: (busy: boolean) => void;
  setMessage: (message: string) => void;
  onAuthed: () => Promise<void>;
}) {
  const [mode, setMode] = useState<"login" | "register">("register");
  const [registerForm, setRegisterForm] = useState(DEFAULT_REGISTER);
  const [loginForm, setLoginForm] = useState({ username: "", password: "" });

  async function submit(event: FormEvent) {
    event.preventDefault();
    try {
      props.setBusy(true);
      props.setMessage("");
      if (mode === "register") {
        await api("/api/auth/register", { method: "POST", body: JSON.stringify(registerForm) });
      } else {
        await api("/api/auth/login", { method: "POST", body: JSON.stringify(loginForm) });
      }
      await props.onAuthed();
    } catch (error) {
      props.setMessage(error instanceof Error ? error.message : "登录失败");
    } finally {
      props.setBusy(false);
    }
  }

  return (
    <div className="auth-page">
      <section className="auth-panel">
        <div className="brand-mark">
          <BookOpenCheck size={28} />
        </div>
        <span className="eyebrow">Workbook</span>
        <h1>作业收齐</h1>
        <div className="segmented">
          <button className={cx(mode === "register" && "active")} onClick={() => setMode("register")}>
            注册
          </button>
          <button className={cx(mode === "login" && "active")} onClick={() => setMode("login")}>
            登录
          </button>
        </div>
        <form className="form-grid" onSubmit={submit}>
          {mode === "register" ? (
            <>
              <label>
                教师姓名
                <input
                  value={registerForm.name}
                  onChange={(event) => setRegisterForm({ ...registerForm, name: event.target.value })}
                  placeholder="例如：王老师"
                />
              </label>
              <label>
                登录账号
                <input
                  value={registerForm.username}
                  onChange={(event) => setRegisterForm({ ...registerForm, username: event.target.value })}
                  placeholder="至少 3 位"
                />
              </label>
              <label>
                登录密码
                <input
                  type="password"
                  value={registerForm.password}
                  onChange={(event) => setRegisterForm({ ...registerForm, password: event.target.value })}
                  placeholder="至少 6 位"
                />
              </label>
              <div className="inline-fields">
                <label>
                  学科
                  <input
                    value={registerForm.subjectName}
                    onChange={(event) => setRegisterForm({ ...registerForm, subjectName: event.target.value })}
                  />
                </label>
                <label>
                  年级
                  <input
                    value={registerForm.gradeName}
                    onChange={(event) => setRegisterForm({ ...registerForm, gradeName: event.target.value })}
                  />
                </label>
                <label>
                  班级
                  <input
                    value={registerForm.className}
                    onChange={(event) => setRegisterForm({ ...registerForm, className: event.target.value })}
                  />
                </label>
              </div>
            </>
          ) : (
            <>
              <label>
                登录账号
                <input
                  value={loginForm.username}
                  onChange={(event) => setLoginForm({ ...loginForm, username: event.target.value })}
                />
              </label>
              <label>
                登录密码
                <input
                  type="password"
                  value={loginForm.password}
                  onChange={(event) => setLoginForm({ ...loginForm, password: event.target.value })}
                />
              </label>
            </>
          )}
          <button className="primary-button" disabled={props.busy}>
            {mode === "register" ? "创建教师账号" : "进入工作台"}
          </button>
        </form>
        {props.message ? <div className="form-error">{props.message}</div> : null}
      </section>
    </div>
  );
}

function HomeView(props: {
  data: BootstrapData | null;
  activeClass?: Classroom;
  classStudents: Student[];
  openTasks: HomeworkTask[];
  selectedClassId: string;
  selectedTaskId: string;
  onClassChange: (id: string) => void;
  onTaskSelect: (id: string) => void;
}) {
  const totalPending = props.openTasks.reduce((sum, task) => sum + task.stats.missing + task.stats.pending, 0);
  return (
    <section className="screen-stack">
      <div className="hero-band">
        <div>
          <span className="eyebrow">今日</span>
          <h2>{totalPending} 人次待处理</h2>
        </div>
        <div className="metric-pill">
          <School size={18} />
          <span>{props.activeClass ? `${props.activeClass.grade?.name}${props.activeClass.name}` : "未选班级"}</span>
        </div>
      </div>

      <ClassSelect
        classes={props.data?.classrooms ?? []}
        value={props.selectedClassId}
        onChange={props.onClassChange}
      />

      <div className="stats-grid">
        <Stat label="班级学生" value={props.classStudents.length} tone="ink" />
        <Stat label="进行中" value={props.openTasks.length} tone="amber" />
        <Stat label="未交待确" value={totalPending} tone="red" />
      </div>

      <section className="section-block">
        <div className="section-heading">
          <h3>最近作业</h3>
        </div>
        <div className="task-list">
          {props.openTasks.length === 0 ? <Empty label="暂无进行中的作业" /> : null}
          {props.openTasks.slice(0, 5).map((task) => (
            <button className="task-row" key={task.id} onClick={() => props.onTaskSelect(task.id)}>
              <div>
                <strong>{task.title}</strong>
                <span>{taskTitle(task)}</span>
              </div>
              <div className="row-stats">
                <b>{task.stats.submitted}</b>
                <small>/ {task.stats.total}</small>
              </div>
            </button>
          ))}
        </div>
      </section>
    </section>
  );
}

function StudentsView(props: {
  data: BootstrapData;
  busy: boolean;
  selectedClassId: string;
  onClassChange: (id: string) => void;
  onAction: (action: () => Promise<void>, success?: string) => Promise<void>;
  onRefresh: () => Promise<void>;
}) {
  const [studentForm, setStudentForm] = useState({ name: "", studentNo: "", aliases: "" });
  const [query, setQuery] = useState("");
  const [importRows, setImportRows] = useState<ImportRow[]>([]);
  const [importBatchId, setImportBatchId] = useState("");
  const [duplicateStrategy, setDuplicateStrategy] = useState<"skip" | "overwrite">("skip");
  const selectedClass = props.data.classrooms.find((classroom) => classroom.id === props.selectedClassId);
  const students = props.data.students.filter((student) => {
    const inClass = student.classId === props.selectedClassId;
    const hit = !query || `${student.name}${student.studentNo ?? ""}${student.aliases.join("")}`.includes(query);
    return inClass && hit;
  });

  async function createStudent(event: FormEvent) {
    event.preventDefault();
    if (!selectedClass) {
      return;
    }
    await props.onAction(async () => {
      await api("/api/students", {
        method: "POST",
        body: JSON.stringify({
          name: studentForm.name,
          studentNo: studentForm.studentNo || null,
          aliases: studentForm.aliases.split(/[、,，/]/).map((item) => item.trim()).filter(Boolean),
          gradeId: selectedClass.gradeId,
          classId: selectedClass.id
        })
      });
      setStudentForm({ name: "", studentNo: "", aliases: "" });
      await props.onRefresh();
    }, "学生已加入");
  }

  async function importFile(file: File, mode: "file" | "ocr") {
    const form = new FormData();
    form.append("file", file);
    await props.onAction(async () => {
      const result = await api<{ batchId: string; rows: ImportRow[] }>(
        mode === "file" ? "/api/imports/roster-file" : "/api/imports/roster-ocr",
        { method: "POST", body: form }
      );
      setImportBatchId(result.batchId);
      setImportRows(result.rows);
    }, "花名册已解析");
  }

  async function commitImport() {
    if (!selectedClass || !importBatchId) {
      return;
    }
    await props.onAction(async () => {
      await api(`/api/imports/${importBatchId}/commit`, {
        method: "POST",
        body: JSON.stringify({
          gradeId: selectedClass.gradeId,
          classId: selectedClass.id,
          rows: importRows,
          duplicateStrategy
        })
      });
      setImportRows([]);
      setImportBatchId("");
      await props.onRefresh();
    }, "学生库已更新");
  }

  return (
    <section className="screen-stack">
      <ClassSelect classes={props.data.classrooms} value={props.selectedClassId} onChange={props.onClassChange} />
      <form className="compact-form" onSubmit={createStudent}>
        <input placeholder="姓名" value={studentForm.name} onChange={(event) => setStudentForm({ ...studentForm, name: event.target.value })} />
        <input placeholder="学号" value={studentForm.studentNo} onChange={(event) => setStudentForm({ ...studentForm, studentNo: event.target.value })} />
        <input placeholder="别名" value={studentForm.aliases} onChange={(event) => setStudentForm({ ...studentForm, aliases: event.target.value })} />
        <button className="icon-text-button" disabled={props.busy}>
          <Plus size={17} />
          新增
        </button>
      </form>

      <div className="import-band">
        <label className="file-button">
          <FileSpreadsheet size={18} />
          Excel/CSV
          <input type="file" accept=".xlsx,.xls,.csv" onChange={(event) => event.target.files?.[0] && importFile(event.target.files[0], "file")} />
        </label>
        <label className="file-button">
          <Upload size={18} />
          拍照OCR
          <input type="file" accept="image/*" capture="environment" onChange={(event) => event.target.files?.[0] && importFile(event.target.files[0], "ocr")} />
        </label>
      </div>

      {importRows.length > 0 ? (
        <section className="section-block">
          <div className="section-heading">
            <h3>导入校对</h3>
            <select value={duplicateStrategy} onChange={(event) => setDuplicateStrategy(event.target.value as "skip" | "overwrite")}>
              <option value="skip">重复跳过</option>
              <option value="overwrite">重复覆盖</option>
            </select>
          </div>
          <div className="review-table">
            {importRows.map((row, index) => (
              <div className="review-row" key={`${row.name}-${index}`}>
                <input value={row.name} onChange={(event) => setImportRows(importRows.map((item, i) => (i === index ? { ...item, name: event.target.value } : item)))} />
                <input value={row.studentNo ?? ""} placeholder="学号" onChange={(event) => setImportRows(importRows.map((item, i) => (i === index ? { ...item, studentNo: event.target.value } : item)))} />
                <button type="button" className="icon-button small" onClick={() => setImportRows(importRows.filter((_, i) => i !== index))}>
                  <X size={15} />
                </button>
              </div>
            ))}
          </div>
          <button className="primary-button" onClick={commitImport} disabled={props.busy}>
            确认入库
          </button>
        </section>
      ) : null}

      <div className="search-box">
        <Search size={17} />
        <input placeholder="搜索学生" value={query} onChange={(event) => setQuery(event.target.value)} />
      </div>

      <section className="student-list">
        {students.length === 0 ? <Empty label="当前班级暂无学生" /> : null}
        {students.map((student) => (
          <div className="student-row" key={student.id}>
            <div>
              <strong>{student.name}</strong>
              <span>{student.studentNo ? `学号 ${student.studentNo}` : "未填学号"}</span>
            </div>
            <div className="row-actions">
              <button
                className="icon-button small"
                title="编辑学生"
                onClick={() => {
                  const nextName = window.prompt("学生姓名", student.name);
                  if (!nextName || !selectedClass) return;
                  props.onAction(async () => {
                    await api(`/api/students/${student.id}`, {
                      method: "PATCH",
                      body: JSON.stringify({
                        name: nextName,
                        studentNo: student.studentNo,
                        aliases: student.aliases,
                        gradeId: selectedClass.gradeId,
                        classId: selectedClass.id
                      })
                    });
                    await props.onRefresh();
                  }, "学生已更新");
                }}
              >
                <RefreshCcw size={15} />
              </button>
              <button
                className="icon-button small danger"
                title="删除学生"
                onClick={() => {
                  if (!window.confirm(`删除 ${student.name}？`)) return;
                  props.onAction(async () => {
                    await api(`/api/students/${student.id}`, { method: "DELETE" });
                    await props.onRefresh();
                  }, "学生已删除");
                }}
              >
                <Trash2 size={15} />
              </button>
            </div>
          </div>
        ))}
      </section>
    </section>
  );
}

function TasksView(props: {
  data: BootstrapData;
  busy: boolean;
  selectedClassId: string;
  onClassChange: (id: string) => void;
  onAction: (action: () => Promise<void>, success?: string) => Promise<void>;
  onRefresh: () => Promise<void>;
  onOpenTask: (id: string) => void;
}) {
  const selectedClass = props.data.classrooms.find((classroom) => classroom.id === props.selectedClassId);
  const [form, setForm] = useState({
    title: "",
    subjectId: props.data.subjects[0]?.id ?? "",
    dueDate: toInputDate()
  });

  async function createTask(event: FormEvent) {
    event.preventDefault();
    if (!selectedClass) return;
    await props.onAction(async () => {
      const task = await api<HomeworkTask>("/api/homework-tasks", {
        method: "POST",
        body: JSON.stringify({
          title: form.title,
          subjectId: form.subjectId,
          gradeId: selectedClass.gradeId,
          classId: selectedClass.id,
          dueDate: form.dueDate,
          status: "active"
        })
      });
      setForm({ ...form, title: "" });
      await props.onRefresh();
      props.onOpenTask(task.id);
    }, "作业任务已创建");
  }

  return (
    <section className="screen-stack">
      <ClassSelect classes={props.data.classrooms} value={props.selectedClassId} onChange={props.onClassChange} />
      <form className="task-form" onSubmit={createTask}>
        <input placeholder="作业标题" value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} />
        <select value={form.subjectId} onChange={(event) => setForm({ ...form, subjectId: event.target.value })}>
          {props.data.subjects.map((subject) => (
            <option value={subject.id} key={subject.id}>
              {subject.name}
            </option>
          ))}
        </select>
        <input type="date" value={form.dueDate} onChange={(event) => setForm({ ...form, dueDate: event.target.value })} />
        <button className="primary-button" disabled={props.busy || !form.subjectId}>
          创建作业
        </button>
      </form>
      <section className="task-list">
        {props.data.tasks.length === 0 ? <Empty label="暂无作业任务" /> : null}
        {props.data.tasks.map((task) => (
          <div className="task-row" key={task.id}>
            <button onClick={() => props.onOpenTask(task.id)}>
              <div>
                <strong>{task.title}</strong>
                <span>
                  {formatDate(task.dueDate)} · {taskTitle(task)}
                </span>
              </div>
              <div className="row-stats">
                <b>{task.stats.submitted}</b>
                <small>/ {task.stats.total}</small>
              </div>
            </button>
            <button
              className="icon-button small"
              title="编辑作业"
              onClick={() => {
                const nextTitle = window.prompt("作业标题", task.title);
                if (!nextTitle) return;
                props.onAction(async () => {
                  await api(`/api/homework-tasks/${task.id}`, {
                    method: "PATCH",
                    body: JSON.stringify({
                      title: nextTitle,
                      subjectId: task.subjectId,
                      gradeId: task.gradeId,
                      classId: task.classId,
                      dueDate: toInputDate(task.dueDate),
                      status: task.status
                    })
                  });
                  await props.onRefresh();
                }, "作业已更新");
              }}
            >
              <RefreshCcw size={15} />
            </button>
            <button
              className="icon-button small danger"
              title="删除作业"
              onClick={() => {
                if (!window.confirm(`删除 ${task.title}？`)) return;
                props.onAction(async () => {
                  await api(`/api/homework-tasks/${task.id}`, { method: "DELETE" });
                  await props.onRefresh();
                }, "作业已删除");
              }}
            >
              <Trash2 size={15} />
            </button>
          </div>
        ))}
      </section>
    </section>
  );
}

function CollectView(props: {
  tasks: HomeworkTask[];
  task: HomeworkTask | null;
  selectedTaskId: string;
  busy: boolean;
  onTaskChange: (id: string) => void;
  onAction: (action: () => Promise<void>, success?: string) => Promise<void>;
  onRefreshTask: (id?: string) => Promise<void>;
}) {
  const [manualName, setManualName] = useState("");
  const [listening, setListening] = useState(false);
  const [pending, setPending] = useState<PendingMatch[]>([]);
  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);
  const task = props.task;
  const recognitionSupported = typeof window !== "undefined" && Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);

  const submitted = task?.submissions.filter((item) => item.status === "submitted") ?? [];
  const missing = task?.submissions.filter((item) => item.status === "missing") ?? [];
  const pendingSubmissions = task?.submissions.filter((item) => item.status === "pending_confirm") ?? [];

  const sendVoiceText = useCallback(
    async (text: string) => {
      if (!props.selectedTaskId || !text.trim()) return;
      const result = await api<{ match: VoiceMatchResult; task: HomeworkTask }>(
        `/api/homework-tasks/${props.selectedTaskId}/voice-matches`,
        { method: "POST", body: JSON.stringify({ text }) }
      );
      if (result.match.needsConfirmation) {
        setPending((current) => [{ id: `${Date.now()}-${text}`, match: result.match }, ...current].slice(0, 8));
      }
      await props.onRefreshTask(props.selectedTaskId);
    },
    [props]
  );

  function startVoice() {
    if (!recognitionSupported || !props.selectedTaskId) return;
    const Recognition = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (!Recognition) return;
    const recognition = new Recognition();
    recognition.lang = "zh-CN";
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.onresult = (event) => {
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        if (result.isFinal) {
          sendVoiceText(result[0].transcript).catch(() => undefined);
        }
      }
    };
    recognition.onend = () => setListening(false);
    recognition.onerror = () => setListening(false);
    recognitionRef.current = recognition;
    recognition.start();
    setListening(true);
  }

  function stopVoice() {
    recognitionRef.current?.stop();
    setListening(false);
  }

  async function setSubmission(studentId: string, status: "submitted" | "missing" | "pending_confirm", source = "manual") {
    if (!props.selectedTaskId) return;
    await props.onAction(async () => {
      await api(`/api/homework-tasks/${props.selectedTaskId}/submissions/${studentId}`, {
        method: "PATCH",
        body: JSON.stringify({ status, source })
      });
      await props.onRefreshTask(props.selectedTaskId);
    });
  }

  return (
    <section className="screen-stack">
      <select className="full-select" value={props.selectedTaskId} onChange={(event) => props.onTaskChange(event.target.value)}>
        <option value="">选择作业任务</option>
        {props.tasks.map((taskItem) => (
          <option value={taskItem.id} key={taskItem.id}>
            {taskItem.title} · {taskTitle(taskItem)}
          </option>
        ))}
      </select>

      {!task ? <Empty label="请选择一个作业任务" /> : null}

      {task ? (
        <>
          <div className="collect-header">
            <div>
              <span className="eyebrow">{taskTitle(task)}</span>
              <h2>{task.title}</h2>
            </div>
            <span className="date-badge">{formatDate(task.dueDate)}</span>
          </div>

          <div className="stats-grid">
            <Stat label="已交" value={task.stats.submitted} tone="green" />
            <Stat label="未交" value={task.stats.missing} tone="red" />
            <Stat label="待确认" value={task.stats.pending + pending.length} tone="amber" />
          </div>

          <div className="voice-dock">
            <button className={cx("voice-button", listening && "recording")} onClick={listening ? stopVoice : startVoice} disabled={!recognitionSupported}>
              {listening ? <Pause size={28} /> : <Mic size={28} />}
              <span>{listening ? "暂停" : "语音"}</span>
            </button>
            <form
              className="manual-name"
              onSubmit={(event) => {
                event.preventDefault();
                props.onAction(async () => {
                  await sendVoiceText(manualName);
                  setManualName("");
                });
              }}
            >
              <input placeholder="手动输入姓名" value={manualName} onChange={(event) => setManualName(event.target.value)} />
              <button className="icon-button" title="提交姓名" disabled={props.busy}>
                <Check size={18} />
              </button>
            </form>
          </div>

          {!recognitionSupported ? <div className="notice">当前浏览器不支持语音识别，请使用手动输入。</div> : null}

          {pending.length > 0 ? (
            <section className="section-block">
              <div className="section-heading">
                <h3>待确认</h3>
              </div>
              {pending.map((item) => (
                <div className="pending-row" key={item.id}>
                  <div>
                    <strong>{item.match.rawText}</strong>
                    <span>{item.match.candidates.length ? "选择匹配学生" : "未找到候选"}</span>
                  </div>
                  <div className="candidate-list">
                    {item.match.candidates.map((candidate) => (
                      <button
                        key={candidate.studentId}
                        onClick={() => {
                          setSubmission(candidate.studentId, "submitted", "voice-confirmed").then(() =>
                            setPending((current) => current.filter((pendingItem) => pendingItem.id !== item.id))
                          );
                        }}
                      >
                        {candidate.name}
                      </button>
                    ))}
                    <button className="ghost-button" onClick={() => setPending((current) => current.filter((pendingItem) => pendingItem.id !== item.id))}>
                      忽略
                    </button>
                  </div>
                </div>
              ))}
            </section>
          ) : null}

          <SubmissionGroup title="未交" submissions={missing} tone="red" onSet={setSubmission} />
          <SubmissionGroup title="已交" submissions={submitted} tone="green" onSet={setSubmission} />
          <SubmissionGroup title="状态待确认" submissions={pendingSubmissions} tone="amber" onSet={setSubmission} />
        </>
      ) : null}
    </section>
  );
}

function SubmissionGroup(props: {
  title: string;
  tone: "green" | "red" | "amber";
  submissions: Submission[];
  onSet: (studentId: string, status: "submitted" | "missing" | "pending_confirm") => Promise<void>;
}) {
  return (
    <section className="section-block">
      <div className="section-heading">
        <h3>{props.title}</h3>
        <span className={cx("count-badge", props.tone)}>{props.submissions.length}</span>
      </div>
      {props.submissions.length === 0 ? <Empty label="暂无名单" /> : null}
      {props.submissions.map((submission) => (
        <div className="submission-row" key={submission.id}>
          <div>
            <strong>{submission.student.name}</strong>
            <span>{submission.student.studentNo ? `学号 ${submission.student.studentNo}` : submission.source}</span>
          </div>
          <div className="row-actions">
            <button className="icon-button small good" title="标记已交" onClick={() => props.onSet(submission.student.id, "submitted")}>
              <Check size={15} />
            </button>
            <button className="icon-button small danger" title="标记未交" onClick={() => props.onSet(submission.student.id, "missing")}>
              <X size={15} />
            </button>
          </div>
        </div>
      ))}
    </section>
  );
}

function SettingsView(props: {
  data: BootstrapData;
  busy: boolean;
  onAction: (action: () => Promise<void>, success?: string) => Promise<void>;
  onRefresh: () => Promise<void>;
}) {
  const [gradeName, setGradeName] = useState("");
  const [className, setClassName] = useState("");
  const [classGradeId, setClassGradeId] = useState(props.data.grades[0]?.id ?? "");
  const [subjectName, setSubjectName] = useState("");

  return (
    <section className="screen-stack">
      <section className="section-block">
        <div className="section-heading">
          <h3>年级</h3>
        </div>
        <form
          className="compact-form"
          onSubmit={(event) => {
            event.preventDefault();
            props.onAction(async () => {
              await api("/api/grades", { method: "POST", body: JSON.stringify({ name: gradeName }) });
              setGradeName("");
              await props.onRefresh();
            }, "年级已创建");
          }}
        >
          <input value={gradeName} placeholder="例如：七年级" onChange={(event) => setGradeName(event.target.value)} />
          <button className="icon-text-button" disabled={props.busy}>
            <Plus size={17} />
            新增
          </button>
        </form>
        <PillList items={props.data.grades} endpoint="/api/grades" onAction={props.onAction} onRefresh={props.onRefresh} />
      </section>

      <section className="section-block">
        <div className="section-heading">
          <h3>班级</h3>
        </div>
        <form
          className="compact-form"
          onSubmit={(event) => {
            event.preventDefault();
            props.onAction(async () => {
              await api("/api/classes", { method: "POST", body: JSON.stringify({ name: className, gradeId: classGradeId }) });
              setClassName("");
              await props.onRefresh();
            }, "班级已创建");
          }}
        >
          <select value={classGradeId} onChange={(event) => setClassGradeId(event.target.value)}>
            {props.data.grades.map((grade) => (
              <option value={grade.id} key={grade.id}>
                {grade.name}
              </option>
            ))}
          </select>
          <input value={className} placeholder="例如：1班" onChange={(event) => setClassName(event.target.value)} />
          <button className="icon-text-button" disabled={props.busy}>
            <Plus size={17} />
            新增
          </button>
        </form>
        <div className="pill-list">
          {props.data.classrooms.map((classroom) => (
            <span className="pill" key={classroom.id}>
              {classroom.grade?.name}{classroom.name}
              <button
                title="编辑"
                onClick={() => {
                  const nextName = window.prompt("班级名称", classroom.name);
                  if (!nextName) return;
                  props.onAction(async () => {
                    await api(`/api/classes/${classroom.id}`, {
                      method: "PATCH",
                      body: JSON.stringify({ name: nextName, gradeId: classroom.gradeId })
                    });
                    await props.onRefresh();
                  }, "班级已更新");
                }}
              >
                <RefreshCcw size={12} />
              </button>
              <button
                title="删除"
                onClick={() => {
                  if (!window.confirm(`删除 ${classroom.grade?.name}${classroom.name}？`)) return;
                  props.onAction(async () => {
                    await api(`/api/classes/${classroom.id}`, { method: "DELETE" });
                    await props.onRefresh();
                  }, "班级已删除");
                }}
              >
                <Trash2 size={12} />
              </button>
            </span>
          ))}
        </div>
      </section>

      <section className="section-block">
        <div className="section-heading">
          <h3>学科</h3>
        </div>
        <form
          className="compact-form"
          onSubmit={(event) => {
            event.preventDefault();
            props.onAction(async () => {
              await api("/api/subjects", { method: "POST", body: JSON.stringify({ name: subjectName }) });
              setSubjectName("");
              await props.onRefresh();
            }, "学科已创建");
          }}
        >
          <input value={subjectName} placeholder="例如：劳动" onChange={(event) => setSubjectName(event.target.value)} />
          <button className="icon-text-button" disabled={props.busy}>
            <Plus size={17} />
            新增
          </button>
        </form>
        <PillList items={props.data.subjects} endpoint="/api/subjects" onAction={props.onAction} onRefresh={props.onRefresh} />
      </section>
    </section>
  );
}

function PillList(props: {
  items: Array<{ id: string; name: string }>;
  endpoint: string;
  onAction: (action: () => Promise<void>, success?: string) => Promise<void>;
  onRefresh: () => Promise<void>;
}) {
  return (
    <div className="pill-list">
      {props.items.map((item) => (
        <span className="pill" key={item.id}>
          {item.name}
          <button
            title="编辑"
            onClick={() => {
              const nextName = window.prompt("名称", item.name);
              if (!nextName) return;
              props.onAction(async () => {
                await api(`${props.endpoint}/${item.id}`, { method: "PATCH", body: JSON.stringify({ name: nextName }) });
                await props.onRefresh();
              }, "已更新");
            }}
          >
            <RefreshCcw size={12} />
          </button>
          <button
            title="删除"
            onClick={() => {
              if (!window.confirm(`删除 ${item.name}？`)) return;
              props.onAction(async () => {
                await api(`${props.endpoint}/${item.id}`, { method: "DELETE" });
                await props.onRefresh();
              }, "已删除");
            }}
          >
            <Trash2 size={12} />
          </button>
        </span>
      ))}
    </div>
  );
}

function ClassSelect(props: { classes: Classroom[]; value: string; onChange: (id: string) => void }) {
  return (
    <label className="field-label">
      班级
      <select className="full-select" value={props.value} onChange={(event) => props.onChange(event.target.value)}>
        <option value="">选择班级</option>
        {props.classes.map((classroom) => (
          <option value={classroom.id} key={classroom.id}>
            {classroom.grade?.name}{classroom.name}
          </option>
        ))}
      </select>
    </label>
  );
}

function Stat(props: { label: string; value: number; tone: "green" | "red" | "amber" | "ink" }) {
  return (
    <div className={cx("stat", props.tone)}>
      <span>{props.label}</span>
      <strong>{props.value}</strong>
    </div>
  );
}

function Empty(props: { label: string }) {
  return <div className="empty">{props.label}</div>;
}
