import { z } from "zod";

export const teacherRegisterSchema = z.object({
  name: z.string().trim().min(2, "请输入教师姓名"),
  username: z.string().trim().min(3, "账号至少 3 个字符"),
  password: z.string().min(8, "密码至少 8 位"),
  subjectName: z.string().trim().min(1, "请选择或填写学科")
});

export const loginSchema = z.object({
  username: z.string().trim().min(1),
  password: z.string().min(1)
});

export const namedEntitySchema = z.object({
  name: z.string().trim().min(1)
});

export const classSchema = z.object({
  name: z.string().trim().min(1),
  gradeId: z.string().min(1)
});

export const studentSchema = z.object({
  name: z.string().trim().min(1),
  studentNo: z.string().trim().optional().nullable(),
  aliases: z.array(z.string().trim()).optional().default([]),
  gradeId: z.string().min(1),
  classId: z.string().min(1),
  displayOrder: z.number().int().nonnegative().optional()
});

export const studentOrderSchema = z.object({
  studentIds: z.array(z.string().min(1)).min(1)
});

export const homeworkTaskSchema = z.object({
  title: z.string().trim().min(1),
  subjectId: z.string().min(1),
  gradeId: z.string().min(1),
  classId: z.string().min(1),
  dueDate: z.string().trim().min(1),
  status: z.enum(["draft", "active", "closed"]).default("active")
});

export const submissionStatusSchema = z.object({
  status: z.enum(["submitted", "missing", "pending_confirm"]),
  source: z.string().trim().optional().default("manual"),
  rawText: z.string().trim().optional()
});

export const voiceMatchSchema = z.object({
  text: z.string().trim().min(1)
});

export const importCommitSchema = z.object({
  gradeId: z.string().min(1),
  classId: z.string().min(1),
  rows: z.array(
    z.object({
      name: z.string().trim().min(1),
      studentNo: z.string().trim().optional().nullable(),
      aliases: z.array(z.string().trim()).optional().default([])
    })
  ),
  duplicateStrategy: z.enum(["skip", "overwrite"]).default("skip")
});

export type TeacherRegisterInput = z.infer<typeof teacherRegisterSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type HomeworkTaskInput = z.infer<typeof homeworkTaskSchema>;
