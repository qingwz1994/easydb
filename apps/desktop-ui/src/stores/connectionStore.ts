import { create } from 'zustand'
import type { ConnectionConfig, ConnectionStatus } from '@/types'

interface ConnectionState {
  connections: ConnectionConfig[]
  currentConnectionId: string | null
  currentDatabase: string | null

  setConnections: (connections: ConnectionConfig[]) => void
  addConnection: (connection: ConnectionConfig) => void
  updateConnection: (id: string, updates: Partial<ConnectionConfig>) => void
  removeConnection: (id: string) => void
  setCurrentConnection: (id: string | null) => void
  setCurrentDatabase: (db: string | null) => void
  updateConnectionStatus: (id: string, status: ConnectionStatus) => void
}

export const useConnectionStore = create<ConnectionState>((set) => ({
  connections: [],
  currentConnectionId: null,
  currentDatabase: null,

  setConnections: (connections) => set({ connections }),

  addConnection: (connection) =>
    set((state) => ({ connections: [...state.connections, connection] })),

  updateConnection: (id, updates) =>
    set((state) => ({
      connections: state.connections.map((c) =>
        c.id === id ? { ...c, ...updates } : c
      ),
    })),

  removeConnection: (id) =>
    set((state) => ({
      connections: state.connections.filter((c) => c.id !== id),
      currentConnectionId:
        state.currentConnectionId === id ? null : state.currentConnectionId,
    })),

  setCurrentConnection: (id) => set({ currentConnectionId: id }),

  setCurrentDatabase: (db) => set({ currentDatabase: db }),

  updateConnectionStatus: (id, status) =>
    set((state) => ({
      connections: state.connections.map((c) =>
        c.id === id ? { ...c, status } : c
      ),
    })),
}))
