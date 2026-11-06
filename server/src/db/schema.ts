import { relations } from 'drizzle-orm';
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const users = sqliteTable(
  'users',
  {
    id: text('id').primaryKey(),
    /** SHA-256 hash of the API key. The plaintext key is never stored. */
    apiKeyHash: text('api_key_hash').notNull(),
    name: text('name').notNull(),
    /** 'admin' owns the instance; 'user' is a provisioned tenant. */
    role: text('role', { enum: ['admin', 'user'] })
      .notNull()
      .default('user'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .defaultNow(),
  },
  (table) => [uniqueIndex('users_api_key_hash_idx').on(table.apiKeyHash)],
);

export const projects = sqliteTable(
  'projects',
  {
    id: text('id').primaryKey(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    /** Path of the main TeX file relative to the project root, e.g. "main.tex". */
    mainFile: text('main_file').notNull().default('main.tex'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .defaultNow(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .defaultNow(),
  },
  (table) => [index('projects_owner_id_idx').on(table.ownerId)],
);

export const shareTokens = sqliteTable(
  'share_tokens',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    /** The plaintext token handed to the collaborator. Hashed for lookup. */
    tokenHash: text('token_hash').notNull(),
    /** 'rw' allows editing, 'ro' allows viewing only. */
    permission: text('permission', { enum: ['rw', 'ro'] })
      .notNull()
      .default('ro'),
    label: text('label'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .defaultNow(),
    /** Unix ms timestamp; null means the token never expires. */
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }),
  },
  (table) => [
    uniqueIndex('share_tokens_token_hash_idx').on(table.tokenHash),
    index('share_tokens_project_id_idx').on(table.projectId),
  ],
);

export const projectSnapshots = sqliteTable(
  'project_snapshots',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    label: text('label').notNull(),
    /** JSON-serialized map of relative file path -> file content. */
    snapshotData: text('snapshot_data').notNull(),
    /** SHA-256 of the snapshot payload, used to detect identical snapshots. */
    hash: text('hash').notNull(),
    createdBy: text('created_by'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .defaultNow(),
  },
  (table) => [index('project_snapshots_project_id_idx').on(table.projectId)],
);

export const usersRelations = relations(users, ({ many }) => ({
  projects: many(projects),
}));

export const projectsRelations = relations(projects, ({ one, many }) => ({
  owner: one(users, { fields: [projects.ownerId], references: [users.id] }),
  shareTokens: many(shareTokens),
  snapshots: many(projectSnapshots),
}));

export const shareTokensRelations = relations(shareTokens, ({ one }) => ({
  project: one(projects, { fields: [shareTokens.projectId], references: [projects.id] }),
}));

export const projectSnapshotsRelations = relations(projectSnapshots, ({ one }) => ({
  project: one(projects, {
    fields: [projectSnapshots.projectId],
    references: [projects.id],
  }),
}));

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;
export type ShareToken = typeof shareTokens.$inferSelect;
export type NewShareToken = typeof shareTokens.$inferInsert;
export type ProjectSnapshot = typeof projectSnapshots.$inferSelect;
export type NewProjectSnapshot = typeof projectSnapshots.$inferInsert;
