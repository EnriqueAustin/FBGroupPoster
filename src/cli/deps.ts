/** Single place where the concrete implementations are wired together. */
import { openStore } from '../store/sqlite-store.ts';
import { createScheduler } from '../scheduler/planner.ts';
import { DB_PATH } from '../config.ts';

export function openApp() {
  // openStore migrates on open, so there is nothing to do first.
  const store = openStore(DB_PATH);
  return { store, scheduler: createScheduler(store) };
}
