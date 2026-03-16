import { create } from 'zustand'
import type { TaskInfo, TaskStep, TaskLog } from '@/types'

interface TaskState {
  tasks: TaskInfo[]
  selectedTaskId: string | null
  taskSteps: Record<string, TaskStep[]>
  taskLogs: Record<string, TaskLog[]>

  setTasks: (tasks: TaskInfo[]) => void
  upsertTask: (task: TaskInfo) => void
  setSelectedTask: (id: string | null) => void
  setTaskSteps: (taskId: string, steps: TaskStep[]) => void
  setTaskLogs: (taskId: string, logs: TaskLog[]) => void
  appendTaskLog: (taskId: string, log: TaskLog) => void
  updateTaskProgress: (taskId: string, progress: number) => void
}

export const useTaskStore = create<TaskState>((set) => ({
  tasks: [],
  selectedTaskId: null,
  taskSteps: {},
  taskLogs: {},

  setTasks: (tasks) => set({ tasks }),

  upsertTask: (task) =>
    set((state) => {
      const exists = state.tasks.find((t) => t.id === task.id)
      return {
        tasks: exists
          ? state.tasks.map((t) => (t.id === task.id ? task : t))
          : [...state.tasks, task],
      }
    }),

  setSelectedTask: (id) => set({ selectedTaskId: id }),

  setTaskSteps: (taskId, steps) =>
    set((state) => ({ taskSteps: { ...state.taskSteps, [taskId]: steps } })),

  setTaskLogs: (taskId, logs) =>
    set((state) => ({ taskLogs: { ...state.taskLogs, [taskId]: logs } })),

  appendTaskLog: (taskId, log) =>
    set((state) => ({
      taskLogs: {
        ...state.taskLogs,
        [taskId]: [...(state.taskLogs[taskId] ?? []), log],
      },
    })),

  updateTaskProgress: (taskId, progress) =>
    set((state) => ({
      tasks: state.tasks.map((t) =>
        t.id === taskId ? { ...t, progress } : t
      ),
    })),
}))
