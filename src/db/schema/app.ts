import {
    integer,
    jsonb,
    pgEnum,
    pgTable,
    text,
    timestamp,
    unique,
    varchar,
    index,
    primaryKey,
    boolean
} from "drizzle-orm/pg-core";
import {relations} from "drizzle-orm";
import {user} from "./auth.js";

export const classStatusEnum = pgEnum('class_status', ['active', 'inactive', 'archived']);
export const attendanceStatusEnum = pgEnum('attendance_status', ['present', 'absent', 'late', 'excused']);
export const submissionStatusEnum = pgEnum('submission_status', ['submitted', 'late', 'graded']);

const timestamps = {
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().$onUpdate(() => new Date()).notNull()
}

export const departments = pgTable('departments', {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    code: varchar('code', {length: 50}).notNull().unique(),
    name: varchar('name', {length: 255}).notNull(),
    description: varchar('description', {length: 255}),
    ...timestamps
});

export const subjects = pgTable('subjects', {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    departmentId: integer('department_id').notNull().references(() => departments.id, { onDelete: 'restrict' }),
    name: varchar('name', {length: 255}).notNull(),
    code: varchar('code', {length: 50}).notNull().unique(),
    description: varchar('description', {length: 255}),
    // Nullable: rows created before this column existed have no recorded
    // creator, and 'set null' means a subject survives its creator's account
    // being deleted rather than cascading. Only the creating teacher (or an
    // admin) may edit — see the ownership check in routes/subjects.ts.
    createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
    ...timestamps
}, (table) => [
    index('subjects_department_id_idx').on(table.departmentId),
]);

export const classes = pgTable('classes', {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    subjectId: integer('subject_id').notNull().references(() => subjects.id, { onDelete: 'cascade' }),
    teacherId: text('teacher_id').notNull().references(() => user.id, { onDelete: 'restrict' }),
    inviteCode: text('invite_code').notNull().unique(),
    name: varchar('name', {length: 255}).notNull(),
    bannerCldPubId: text('banner_cld_pub_id'),
    bannerUrl: text('banner_url'),
    description: text('description'),
    capacity: integer('capacity').default(50).notNull(),
    status: classStatusEnum('status').default('active').notNull(),
    schedules: jsonb('schedules').$type<any[]>().default([]).notNull(),
    ...timestamps
}, (table) => [
    index('classes_subject_id_idx').on(table.subjectId),
    index('classes_teacher_id_idx').on(table.teacherId),
]);

export const enrollments = pgTable('enrollments', {
    studentId: text('student_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
    classId: integer('class_id').notNull().references(() => classes.id, { onDelete: 'cascade' }),
}, (table) => [
    primaryKey({ columns: [table.studentId, table.classId] }),
    unique('enrollments_student_id_class_id_unique').on(table.studentId, table.classId),
    index('enrollments_student_id_idx').on(table.studentId),
    index('enrollments_class_id_idx').on(table.classId),
]);

export const attendance = pgTable('attendance', {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    classId: integer('class_id').notNull().references(() => classes.id, { onDelete: 'cascade' }),
    studentId: text('student_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
    markedBy: text('marked_by').notNull().references(() => user.id, { onDelete: 'restrict' }),
    date: text('date').notNull(), // ISO date (YYYY-MM-DD); attendance is a once-per-day record
    status: attendanceStatusEnum('status').notNull(),
    notes: text('notes'),
    ...timestamps
}, (table) => [
    unique('attendance_class_id_student_id_date_unique').on(table.classId, table.studentId, table.date),
    index('attendance_class_id_idx').on(table.classId),
    index('attendance_student_id_idx').on(table.studentId),
    index('attendance_date_idx').on(table.date),
]);

export const assignments = pgTable('assignments', {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    classId: integer('class_id').notNull().references(() => classes.id, { onDelete: 'cascade' }),
    createdBy: text('created_by').notNull().references(() => user.id, { onDelete: 'restrict' }),
    title: varchar('title', { length: 255 }).notNull(),
    description: text('description'),
    dueAt: timestamp('due_at'),
    maxScore: integer('max_score').default(100).notNull(),
    attachmentUrl: text('attachment_url'),
    attachmentCldPubId: text('attachment_cld_pub_id'),
    attachmentName: text('attachment_name'),
    ...timestamps
}, (table) => [
    index('assignments_class_id_idx').on(table.classId),
    index('assignments_due_at_idx').on(table.dueAt),
]);

export const submissions = pgTable('submissions', {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    assignmentId: integer('assignment_id').notNull().references(() => assignments.id, { onDelete: 'cascade' }),
    studentId: text('student_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
    content: text('content'),
    fileUrl: text('file_url'),
    fileCldPubId: text('file_cld_pub_id'),
    fileName: text('file_name'),
    status: submissionStatusEnum('status').default('submitted').notNull(),
    score: integer('score'),
    feedback: text('feedback'),
    gradedBy: text('graded_by').references(() => user.id, { onDelete: 'set null' }),
    gradedAt: timestamp('graded_at'),
    submittedAt: timestamp('submitted_at').defaultNow().notNull(),
    ...timestamps
}, (table) => [
    unique('submissions_assignment_id_student_id_unique').on(table.assignmentId, table.studentId),
    index('submissions_assignment_id_idx').on(table.assignmentId),
    index('submissions_student_id_idx').on(table.studentId),
]);

// classId is nullable: a school-wide announcement has no class, a class announcement is scoped to one.
export const announcements = pgTable('announcements', {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    classId: integer('class_id').references(() => classes.id, { onDelete: 'cascade' }),
    authorId: text('author_id').notNull().references(() => user.id, { onDelete: 'restrict' }),
    title: varchar('title', { length: 255 }).notNull(),
    content: text('content').notNull(),
    pinned: boolean('pinned').default(false).notNull(),
    ...timestamps
}, (table) => [
    index('announcements_class_id_idx').on(table.classId),
    index('announcements_created_at_idx').on(table.createdAt),
]);

// Exams — scheduled assessments separate from assignments
export const exams = pgTable('exams', {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    classId: integer('class_id').notNull().references(() => classes.id, { onDelete: 'cascade' }),
    createdBy: text('created_by').notNull().references(() => user.id, { onDelete: 'restrict' }),
    title: varchar('title', { length: 255 }).notNull(),
    description: text('description'),
    scheduledAt: timestamp('scheduled_at'),
    durationMinutes: integer('duration_minutes'),
    maxScore: integer('max_score').default(100).notNull(),
    venue: varchar('venue', { length: 255 }),
    ...timestamps
}, (table) => [
    index('exams_class_id_idx').on(table.classId),
    index('exams_scheduled_at_idx').on(table.scheduledAt),
]);

// Exam results — a teacher enters the score a student achieved in an exam
export const examResults = pgTable('exam_results', {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    examId: integer('exam_id').notNull().references(() => exams.id, { onDelete: 'cascade' }),
    studentId: text('student_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
    score: integer('score').notNull(),
    remarks: text('remarks'),
    gradedBy: text('graded_by').notNull().references(() => user.id, { onDelete: 'restrict' }),
    ...timestamps
}, (table) => [
    unique('exam_results_exam_student_unique').on(table.examId, table.studentId),
    index('exam_results_exam_id_idx').on(table.examId),
    index('exam_results_student_id_idx').on(table.studentId),
]);

// Class grades — final computed grade per student per class (teacher can also override)
export const classGrades = pgTable('class_grades', {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    classId: integer('class_id').notNull().references(() => classes.id, { onDelete: 'cascade' }),
    studentId: text('student_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
    assignmentAvg: integer('assignment_avg'),   // computed from submissions
    examAvg: integer('exam_avg'),               // computed from exam_results
    attendanceRate: integer('attendance_rate'), // computed from attendance
    finalGrade: integer('final_grade'),         // weighted total (or teacher override)
    letterGrade: varchar('letter_grade', { length: 4 }),
    gpa: text('gpa'),                          // e.g. "3.7"
    remarks: text('remarks'),
    gradedBy: text('graded_by').references(() => user.id, { onDelete: 'set null' }),
    ...timestamps
}, (table) => [
    unique('class_grades_class_student_unique').on(table.classId, table.studentId),
    index('class_grades_class_id_idx').on(table.classId),
    index('class_grades_student_id_idx').on(table.studentId),
]);

// ─── CALENDAR ─────────────────────────────────────────────────────────────────
export const calendarEventTypeEnum = pgEnum('calendar_event_type', [
    'class', 'exam', 'holiday', 'event', 'deadline',
]);

// Recurrence is stored on the base row only (no per-occurrence rows) — GET
// /api/calendar expands 'daily'/'weekly'/'monthly' events into occurrences
// at read time for the requested date range. Editing/deleting always acts on
// the base row, i.e. the whole series — there's no per-occurrence override.
export const calendarRecurrenceFreqEnum = pgEnum('calendar_recurrence_freq', [
    'none', 'daily', 'weekly', 'monthly',
]);

export const calendarEvents = pgTable('calendar_events', {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    title: varchar('title', { length: 255 }).notNull(),
    description: text('description'),
    type: calendarEventTypeEnum('type').default('event').notNull(),
    startAt: timestamp('start_at').notNull(),
    endAt: timestamp('end_at'),
    allDay: boolean('all_day').default(false).notNull(),
    classId: integer('class_id').references(() => classes.id, { onDelete: 'cascade' }),
    createdBy: text('created_by').notNull().references(() => user.id, { onDelete: 'restrict' }),
    recurrenceFreq: calendarRecurrenceFreqEnum('recurrence_freq').default('none').notNull(),
    recurrenceInterval: integer('recurrence_interval').default(1).notNull(),
    recurrenceEndAt: timestamp('recurrence_end_at'),
    ...timestamps
}, (table) => [
    index('calendar_events_start_at_idx').on(table.startAt),
    index('calendar_events_class_id_idx').on(table.classId),
]);

// ─── NOTIFICATIONS ────────────────────────────────────────────────────────────
export const notificationTypeEnum = pgEnum('notification_type', [
    'announcement', 'assignment', 'grade', 'attendance', 'exam', 'general',
]);

export const notifications = pgTable('notifications', {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
    type: notificationTypeEnum('type').default('general').notNull(),
    title: varchar('title', { length: 255 }).notNull(),
    message: text('message').notNull(),
    read: boolean('read').default(false).notNull(),
    link: text('link'),
    ...timestamps
}, (table) => [
    index('notifications_user_id_idx').on(table.userId),
    index('notifications_read_idx').on(table.read),
    index('notifications_created_at_idx').on(table.createdAt),
]);

// Student profiles — extends the base user with academic-specific fields
export const studentProfiles = pgTable('student_profiles', {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    userId: text('user_id').notNull().unique().references(() => user.id, { onDelete: 'cascade' }),
    registrationNumber: varchar('registration_number', { length: 50 }).unique(),
    dateOfBirth: text('date_of_birth'),   // ISO string YYYY-MM-DD
    phone: varchar('phone', { length: 30 }),
    address: text('address'),
    parentName: text('parent_name'),
    parentPhone: varchar('parent_phone', { length: 30 }),
    parentEmail: varchar('parent_email', { length: 255 }),
    // The authoritative parent↔child link: set explicitly by an admin (see
    // PATCH /api/profile/student/:studentId/link-parent), not inferred from
    // parentEmail matching a logged-in user's email — that match was fragile
    // (typos, case, a parent using a different login email than the one on file).
    parentUserId: text('parent_user_id').references(() => user.id, { onDelete: 'set null' }),
    bio: text('bio'),
    ...timestamps
}, (table) => [
    index('student_profiles_user_id_idx').on(table.userId),
    index('student_profiles_parent_user_id_idx').on(table.parentUserId),
]);

export const departmentRelations = relations(departments, ({ many }) => ({ subjects: many(subjects) }));

export const subjectsRelations = relations(subjects, ({ one, many }) => ({
    department: one(departments, {
        fields: [subjects.departmentId],
        references: [departments.id],
    }),
    classes: many(classes)
}));

export const classesRelations = relations(classes, ({ one, many }) => ({
    subject: one(subjects, {
        fields: [classes.subjectId],
        references: [subjects.id],
    }),
    teacher: one(user, {
        fields: [classes.teacherId],
        references: [user.id],
    }),
    enrollments: many(enrollments),
    attendanceRecords: many(attendance),
    assignments: many(assignments),
    announcements: many(announcements)
}));

export const enrollmentsRelations = relations(enrollments, ({ one }) => ({
    student: one(user, {
        fields: [enrollments.studentId],
        references: [user.id],
    }),
    class: one(classes, {
        fields: [enrollments.classId],
        references: [classes.id],
    }),
}));

export const attendanceRelations = relations(attendance, ({ one }) => ({
    class: one(classes, {
        fields: [attendance.classId],
        references: [classes.id],
    }),
    student: one(user, {
        fields: [attendance.studentId],
        references: [user.id],
        relationName: 'attendance_student'
    }),
    markedByUser: one(user, {
        fields: [attendance.markedBy],
        references: [user.id],
        relationName: 'attendance_marked_by'
    }),
}));

export const assignmentsRelations = relations(assignments, ({ one, many }) => ({
    class: one(classes, {
        fields: [assignments.classId],
        references: [classes.id],
    }),
    creator: one(user, {
        fields: [assignments.createdBy],
        references: [user.id],
    }),
    submissions: many(submissions),
}));

export const submissionsRelations = relations(submissions, ({ one }) => ({
    assignment: one(assignments, {
        fields: [submissions.assignmentId],
        references: [assignments.id],
    }),
    student: one(user, {
        fields: [submissions.studentId],
        references: [user.id],
        relationName: 'submission_student'
    }),
    grader: one(user, {
        fields: [submissions.gradedBy],
        references: [user.id],
        relationName: 'submission_grader'
    }),
}));

export const announcementsRelations = relations(announcements, ({ one }) => ({
    class: one(classes, {
        fields: [announcements.classId],
        references: [classes.id],
    }),
    author: one(user, {
        fields: [announcements.authorId],
        references: [user.id],
    }),
}));

export const examsRelations = relations(exams, ({ one, many }) => ({
    class: one(classes, { fields: [exams.classId], references: [classes.id] }),
    creator: one(user, { fields: [exams.createdBy], references: [user.id] }),
    results: many(examResults),
}));

export const examResultsRelations = relations(examResults, ({ one }) => ({
    exam: one(exams, { fields: [examResults.examId], references: [exams.id] }),
    student: one(user, {
        fields: [examResults.studentId],
        references: [user.id],
        relationName: 'exam_result_student'
    }),
    grader: one(user, {
        fields: [examResults.gradedBy],
        references: [user.id],
        relationName: 'exam_result_grader'
    }),
}));

export const classGradesRelations = relations(classGrades, ({ one }) => ({
    class: one(classes, { fields: [classGrades.classId], references: [classes.id] }),
    student: one(user, {
        fields: [classGrades.studentId],
        references: [user.id],
        relationName: 'class_grade_student'
    }),
    grader: one(user, {
        fields: [classGrades.gradedBy],
        references: [user.id],
        relationName: 'class_grade_grader'
    }),
}));

export const calendarEventsRelations = relations(calendarEvents, ({ one }) => ({
    class: one(classes, { fields: [calendarEvents.classId], references: [classes.id] }),
    creator: one(user, { fields: [calendarEvents.createdBy], references: [user.id] }),
}));

export const notificationsRelations = relations(notifications, ({ one }) => ({
    user: one(user, { fields: [notifications.userId], references: [user.id] }),
}));

export type Department = typeof departments.$inferSelect;
export type NewDepartment = typeof departments.$inferInsert;

export type Subject = typeof subjects.$inferSelect;
export type NewSubject = typeof subjects.$inferInsert;

export type Class = typeof classes.$inferSelect;
export type NewClass = typeof classes.$inferInsert;

export type Enrollment = typeof enrollments.$inferSelect;
export type NewEnrollment = typeof enrollments.$inferInsert;

export type Attendance = typeof attendance.$inferSelect;
export type NewAttendance = typeof attendance.$inferInsert;

export type Assignment = typeof assignments.$inferSelect;
export type NewAssignment = typeof assignments.$inferInsert;

export type Submission = typeof submissions.$inferSelect;
export type NewSubmission = typeof submissions.$inferInsert;

export type Announcement = typeof announcements.$inferSelect;
export type NewAnnouncement = typeof announcements.$inferInsert;

export type Exam = typeof exams.$inferSelect;
export type NewExam = typeof exams.$inferInsert;

export type ExamResult = typeof examResults.$inferSelect;
export type NewExamResult = typeof examResults.$inferInsert;

export type ClassGrade = typeof classGrades.$inferSelect;
export type NewClassGrade = typeof classGrades.$inferInsert;

export type CalendarEvent = typeof calendarEvents.$inferSelect;
export type NewCalendarEvent = typeof calendarEvents.$inferInsert;

export type Notification = typeof notifications.$inferSelect;
export type NewNotification = typeof notifications.$inferInsert;

// ─── MESSAGES ─────────────────────────────────────────────────────────────────
export const messages = pgTable('messages', {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    senderId: text('sender_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
    receiverId: text('receiver_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
    content: text('content').notNull(),
    read: boolean('read').default(false).notNull(),
    ...timestamps
}, (table) => [
    index('messages_sender_id_idx').on(table.senderId),
    index('messages_receiver_id_idx').on(table.receiverId),
    index('messages_created_at_idx').on(table.createdAt),
]);

export const messagesRelations = relations(messages, ({ one }) => ({
    sender: one(user, { fields: [messages.senderId], references: [user.id], relationName: 'message_sender' }),
    receiver: one(user, { fields: [messages.receiverId], references: [user.id], relationName: 'message_receiver' }),
}));

export type Message = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;

export type StudentProfile = typeof studentProfiles.$inferSelect;
export type NewStudentProfile = typeof studentProfiles.$inferInsert;

// ─── AUDIT LOGS ───────────────────────────────────────────────────────────────
export const auditLogs = pgTable('audit_logs', {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    userId: text('user_id').references(() => user.id, { onDelete: 'set null' }),
    action: varchar('action', { length: 100 }).notNull(), // e.g. 'class.create', 'grade.update'
    resource: varchar('resource', { length: 100 }).notNull(),
    resourceId: text('resource_id'),
    details: text('details'),
    ipAddress: varchar('ip_address', { length: 64 }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
    index('audit_logs_user_id_idx').on(table.userId),
    index('audit_logs_action_idx').on(table.action),
    index('audit_logs_created_at_idx').on(table.createdAt),
]);

export type AuditLog = typeof auditLogs.$inferSelect;

// ─── QR ATTENDANCE SESSIONS ───────────────────────────────────────────────────
// A teacher generates a short-lived token; students scan the QR and
// hit /api/attendance/qr/:token to mark themselves present.
export const qrSessions = pgTable('qr_sessions', {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    token: varchar('token', { length: 64 }).notNull().unique(),
    classId: integer('class_id').notNull().references(() => classes.id, { onDelete: 'cascade' }),
    date: text('date').notNull(), // YYYY-MM-DD
    createdBy: text('created_by').notNull().references(() => user.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at').notNull(),
    ...timestamps
}, (table) => [
    index('qr_sessions_token_idx').on(table.token),
    index('qr_sessions_class_id_idx').on(table.classId),
]);

export type QrSession = typeof qrSessions.$inferSelect;

// ─── STUDENT DOCUMENTS ────────────────────────────────────────────────────────
// Generic file library, distinct from the single-purpose attachment columns
// bolted onto classes/assignments/submissions/user (banner, attachment, avatar).
// Scoped per-student: IDs, certificates, medical forms, etc.
export const fileCategoryEnum = pgEnum('file_category', ['document', 'certificate', 'medical', 'other']);

export const files = pgTable('files', {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    studentId: text('student_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
    uploadedBy: text('uploaded_by').notNull().references(() => user.id, { onDelete: 'restrict' }),
    name: varchar('name', { length: 255 }).notNull(),
    category: fileCategoryEnum('category').default('document').notNull(),
    url: text('url').notNull(),
    cldPubId: text('cld_pub_id').notNull(),
    fileSize: integer('file_size'),
    ...timestamps
}, (table) => [
    index('files_student_id_idx').on(table.studentId),
]);

export const filesRelations = relations(files, ({ one }) => ({
    student: one(user, { fields: [files.studentId], references: [user.id], relationName: 'file_student' }),
    uploader: one(user, { fields: [files.uploadedBy], references: [user.id], relationName: 'file_uploader' }),
}));

export type StudentFile = typeof files.$inferSelect;
export type NewStudentFile = typeof files.$inferInsert;
