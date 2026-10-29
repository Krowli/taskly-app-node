import type { z } from 'zod';
import type { createSchema, updateSchema, todoSchema } from './validators.js';
import type { PrismaClient, Todo as PrismaTodo } from '../../generated/prisma/client.js';

export type TodoCreate = z.infer<typeof createSchema>;
export type TodoUpdate = z.infer<typeof updateSchema>;
export type Todo = z.infer<typeof todoSchema>;
export type TodoRecord = PrismaTodo;
export type Database = PrismaClient;
export interface TodoStats {
  total: number;
  completed: number;
  active: number;
  overdue: number;
}
export interface TodoStore {
  list(): Promise<Todo[]>;
  stats(): Promise<TodoStats>;
  get(id: number): Promise<Todo | null>;
  create(payload: TodoCreate): Promise<Todo>;
  update(id: number, payload: TodoUpdate): Promise<Todo | null>;
  delete(id: number): Promise<boolean>;
}
