import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const storyboardProjects = sqliteTable("storyboard_projects", {
  room: text("room").primaryKey(),
  payload: text("payload").notNull(),
  version: integer("version").notNull().default(1),
  updatedAt: integer("updated_at").notNull(),
});
