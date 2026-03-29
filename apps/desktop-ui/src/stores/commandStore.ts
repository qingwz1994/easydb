import { create } from 'zustand'

export interface CommandAction {
  id: string
  title: string
  category: string
  icon?: React.ReactNode
  shortcut?: string[]
  action: () => void
}

interface CommandStore {
  isOpen: boolean
  toggleOpen: () => void
  setOpen: (open: boolean) => void
  commands: CommandAction[]
  registerCommand: (command: CommandAction) => void
  unregisterCommand: (id: string) => void
  executeCommand: (id: string) => void
}

export const useCommandStore = create<CommandStore>((set, get) => ({
  isOpen: false,
  toggleOpen: () => set((state) => ({ isOpen: !state.isOpen })),
  setOpen: (open) => set({ isOpen: open }),
  commands: [],
  registerCommand: (command) =>
    set((state) => {
      // 避免重复注册 (e.g., React StrictMode)
      if (state.commands.some((c) => c.id === command.id)) return state
      return { commands: [...state.commands, command] }
    }),
  unregisterCommand: (id) =>
    set((state) => ({ commands: state.commands.filter((c) => c.id !== id) })),
  executeCommand: (id) => {
    const command = get().commands.find((c) => c.id === id)
    if (command) {
      command.action()
      set({ isOpen: false })
    }
  },
}))
