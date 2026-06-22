import { describe, expect, it } from "vitest";
import { matchStudentName } from "./matching";
import type { StudentLite } from "./types";

const students: StudentLite[] = [
  { id: "1", name: "张三", aliases: ["小张"] },
  { id: "2", name: "李四" },
  { id: "3", name: "王芳" },
  { id: "4", name: "王方" }
];

describe("matchStudentName", () => {
  it("matches exact names confidently", () => {
    const result = matchStudentName("张三", students);
    expect(result.matchedStudentId).toBe("1");
    expect(result.needsConfirmation).toBe(false);
  });

  it("matches aliases confidently", () => {
    const result = matchStudentName("小张交了", students);
    expect(result.matchedStudentId).toBe("1");
    expect(result.reason).toBe("alias");
  });

  it("marks same-pinyin conflicts as pending confirmation", () => {
    const result = matchStudentName("wangfang", students);
    expect(result.matchedStudentId).toBeNull();
    expect(result.needsConfirmation).toBe(true);
    expect(result.candidates.length).toBeGreaterThan(1);
  });

  it("returns no match for unknown names", () => {
    const result = matchStudentName("赵六", students);
    expect(result.matchedStudentId).toBeNull();
    expect(result.candidates).toHaveLength(0);
  });
});
