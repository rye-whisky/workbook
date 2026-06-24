export type StudentStatus = "submitted" | "missing" | "pending_confirm" | "late_submitted" | "leave";

export type HomeworkTaskStatus = "draft" | "active" | "closed";

export interface StudentLite {
  id: string;
  name: string;
  aliases?: string[];
  studentNo?: string | null;
}

export interface VoiceCandidate {
  studentId: string;
  name: string;
  confidence: number;
  reason: "exact" | "alias" | "pinyin" | "pinyin_exact" | "pinyin_fuzzy" | "hanzi_fuzzy" | "contains" | "partial";
}

export interface VoiceMatchResult {
  rawText: string;
  normalizedText: string;
  matchedStudentId: string | null;
  confidence: number;
  reason: VoiceCandidate["reason"] | "none" | "ambiguous";
  candidates: VoiceCandidate[];
  needsConfirmation: boolean;
}

export type VoiceMatchStatus = "auto_submitted" | "pending_confirm" | "duplicate" | "unmatched";

export interface VoiceSegmentMatch {
  rawText: string;
  normalizedText: string;
  matchedStudentId: string | null;
  matchedStudentName: string | null;
  confidence: number;
  reason: VoiceCandidate["reason"] | "none" | "ambiguous";
  status: VoiceMatchStatus;
  candidates: VoiceCandidate[];
}

export interface VoiceBatchMatchResult {
  rawText: string;
  segments: VoiceSegmentMatch[];
  submittedStudentIds: string[];
  pending: VoiceSegmentMatch[];
  unmatched: VoiceSegmentMatch[];
  duplicateStudentIds: string[];
  stats: TaskStats;
}

export interface ApiEnvelope<T> {
  data: T | null;
  error: string | null;
}

export interface TaskStats {
  submitted: number;
  missing: number;
  pending: number;
  lateSubmitted: number;
  leave: number;
  total: number;
}

export interface HomeworkRegisterCell {
  taskId: string;
  studentId: string;
  status: StudentStatus;
  symbol: "√" | "×" | "O" | "?";
  color: "normal" | "red" | "warning";
}

export interface HomeworkRegister {
  grade: { id: string; name: string };
  classroom: { id: string; name: string };
  students: Array<{ id: string; name: string; displayOrder: number }>;
  tasks: Array<{
    id: string;
    title: string;
    dueDate: string;
    subjectName: string;
    teacherName: string;
  }>;
  cells: HomeworkRegisterCell[];
}

export type AsrProvider = "disabled" | "browser" | "volcengine" | "mock";

export type AsrClientEvent =
  | { type: "start" }
  | { type: "stop" }
  | { type: "mock-final"; text: string };

export type AsrServerEvent =
  | { type: "ready"; provider: AsrProvider }
  | { type: "status"; message: string }
  | { type: "partial"; text: string }
  | { type: "final"; text: string; match: VoiceMatchResult; stats: TaskStats }
  | { type: "pending"; text: string; match: VoiceMatchResult; stats: TaskStats }
  | { type: "batch-final"; text: string; batch: VoiceBatchMatchResult; stats: TaskStats }
  | { type: "error"; message: string }
  | { type: "closed" };
