/*
 * Copyright (c) 2024-2026 EasyDB Contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */
import { create } from 'zustand'
import type { ConnectionConfig, ConnectionStatus, ConnectionGroup } from '@/types'

interface ConnectionState {
  connections: ConnectionConfig[]
  groups: ConnectionGroup[]
  currentConnectionId: string | null
  currentDatabase: string | null

  setConnections: (connections: ConnectionConfig[]) => void
  setGroups: (groups: ConnectionGroup[]) => void
  addGroup: (group: ConnectionGroup) => void
  updateGroup: (id: string, group: ConnectionGroup) => void
  removeGroup: (id: string) => void
  addConnection: (connection: ConnectionConfig) => void
  updateConnection: (id: string, updates: Partial<ConnectionConfig>) => void
  removeConnection: (id: string) => void
  setCurrentConnection: (id: string | null) => void
  setCurrentDatabase: (db: string | null) => void
  updateConnectionStatus: (id: string, status: ConnectionStatus) => void
}

export const useConnectionStore = create<ConnectionState>((set) => ({
  connections: [],
  groups: [],
  currentConnectionId: null,
  currentDatabase: null,

  setConnections: (connections) => set({ connections }),
  setGroups: (groups) => set({ groups }),
  addGroup: (group) => set((state) => ({ groups: [...state.groups, group] })),
  updateGroup: (id, group) => set((state) => ({
    groups: state.groups.map(g => g.id === id ? group : g)
  })),
  removeGroup: (id) => set((state) => ({
    groups: state.groups.filter(g => g.id !== id)
  })),

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
