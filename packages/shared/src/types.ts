export type StudentStatus = "submitted" | "missing" | "pending_confirm";

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
  reason: "exact" | "alias" | "pinyin" | "contains" | "partial";
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

export interface ApiEnvelope<T> {
  data: T | null;
  error: string | null;
}

export interface TaskStats {
  submitted: number;
  missing: number;
  pending: number;
  total: number;
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
  | { type: "error"; message: string }
  | { type: "closed" };
