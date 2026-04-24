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
import React, { useState, useMemo, useCallback, useRef, useEffect, useLayoutEffect } from 'react'
import {
  Table, Input, Button, Space, Tag, Typography, theme, Modal, AutoComplete, Select, Divider, Tooltip,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import {
  PlusOutlined, DeleteOutlined, SaveOutlined, UndoOutlined,
  ExclamationCircleOutlined, FilterOutlined, CaretUpOutlined, CaretDownOutlined,
  CopyOutlined, EditOutlined, CloseOutlined,
} from '@ant-design/icons'
import type { ColumnInfo, RowChange, DataEditResult } from '@/types'
import { metadataApi } from '@/services/api'
import { toast, handleApiError } from '@/utils/notification'

const { Text } = Typography

interface EditableDataTableProps {
  connectionId: string
  database: string
  tableName: string
  columns: ColumnInfo[]
  dataSource: Record<string, unknown>[]
  onRefresh: () => void
  onFilter?: (params: { where?: string; orderBy?: string }) => void
  // 加载更多（preview 模式）
  hasMore?: boolean
  onLoadMore?: () => void
  loadingMore?: boolean
}

type CellChange = {
  rowIndex: number
  column: string
  oldValue: string | null
  newValue: string | null
}

type PendingRow = {
  type: 'insert' | 'delete'
  rowIndex: number
  data: Record<string, unknown>
}

type TableRow = Record<string, unknown> & {
  _key: number
  _rowIndex: number
}

/** 虚拟滚动估算行高（px），用于计算滚动偏移 */
const ESTIMATED_ROW_HEIGHT = 35

/**
 * 浮层编辑器：不触发表格重渲染，直接在单元格上方覆盖 Input
 */
const CellEditor: React.FC<{
  position: { left: number; top: number; width: number; height: number }
  value: string
  onConfirm: (value: string) => void
  onCancel: () => void
  onStepCell: (value: string, direction: 1 | -1) => void
}> = ({ position, value, onConfirm, onCancel, onStepCell }) => {
  const [val, setVal] = useState(value)
  const closingRef = useRef(false)

  return (
    <div style={{
      position: 'absolute',
      left: position.left,
      top: position.top,
      width: position.width,
      height: position.height,
      zIndex: 100,
    }}>
      <Input
        size="small"
        value={val}
        onChange={(e) => setVal(e.target.value)}
        onPressEnter={() => {
          closingRef.current = true
          onConfirm(val)
        }}
        onBlur={() => {
          if (closingRef.current) return
          onConfirm(val)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            closingRef.current = true
            onCancel()
            return
          }
          if (e.key === 'Tab') {
            e.preventDefault()
            closingRef.current = true
            onStepCell(val, e.shiftKey ? -1 : 1)
          }
        }}
        autoFocus
        style={{
          width: '100%',
          height: '100%',
          borderRadius: 0,
          background: 'var(--glass-popup)',
          border: '1px solid var(--edb-accent)',
          color: 'var(--edb-text-primary)',
          caretColor: 'var(--edb-accent)',
        }}
      />
    </div>
  )
}

export const EditableDataTable: React.FC<EditableDataTableProps> = ({
  connectionId,
  database,
  tableName,
  columns,
  dataSource,
  onRefresh,
  onFilter,
  hasMore,
  onLoadMore,
  loadingMore,
}) => {
  const { token } = theme.useToken()
  const containerRef = useRef<HTMLDivElement>(null)
  const toolbarRef = useRef<HTMLDivElement>(null)
  // 直接测量 flex:1 wrapper 的实际可用高度，避免手工计算 toolbar/header 高度
  const tableWrapperRef = useRef<HTMLDivElement>(null)
  const selectedRowRef = useRef<number>(-1)
  const cellChangesRef = useRef<CellChange[]>([])
  const tableBodyRef = useRef<HTMLDivElement | null>(null)
  const autoLoadLockRef = useRef(false)
  // 强制触发 virtual-list 的 onHolderResize，让其重算 height 依赖并重新渲染可见行
  const forceVirtualRefreshRef = useRef<() => void>(() => {})
  // Ant Design Table 的 scrollTo ref
  const tableRef = useRef<import('@rc-component/table').Reference>(null)

  // 筛选状态
  const [whereClause, setWhereClause] = useState('')
  const [appliedWhere, setAppliedWhere] = useState('')
  const [sortColumn, setSortColumn] = useState<string | null>(null)
  const [sortDirection, setSortDirection] = useState<'ASC' | 'DESC' | null>(null)

  // 编辑状态用 ref 追踪，只在确认编辑时触发渲染
  const [editorState, setEditorState] = useState<{
    rowIndex: number
    column: string
    position: { left: number; top: number; width: number; height: number }
    value: string
  } | null>(null)

  const [pendingRows, setPendingRows] = useState<PendingRow[]>([])
  const [saving, setSaving] = useState(false)
  const [insertPositions, setInsertPositions] = useState<{ afterIndex: number; data: Record<string, unknown> }[]>([])
  const [cellChangeCount, setCellChangeCount] = useState(0)
  const [tableScrollY, setTableScrollY] = useState(240)

  // 多行选择
  const [selectedRowKeys, setSelectedRowKeys] = useState<number[]>([])

  // 批量改列 Modal
  const [batchEditOpen, setBatchEditOpen] = useState(false)
  const [batchEditColumn, setBatchEditColumn] = useState<string | null>(null)
  const [batchEditValue, setBatchEditValue] = useState('')

  // 右键菜单
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; rowIndex: number } | null>(null)

  const primaryKeys = useMemo(() =>
    columns.filter((c) => c.isPrimaryKey).map((c) => c.name),
    [columns]
  )
  const isEditable = primaryKeys.length > 0

  const effectiveData = useMemo(() => {
    const deletedIndices = new Set(
      pendingRows.filter((p) => p.type === 'delete').map((p) => p.rowIndex)
    )
    const existing = dataSource.filter((_, i) => !deletedIndices.has(i))
    const result = [...existing]
    const sorted = [...insertPositions].sort((a, b) => b.afterIndex - a.afterIndex)
    for (const ins of sorted) {
      const pos = Math.min(ins.afterIndex + 1, result.length)
      result.splice(pos, 0, ins.data)
    }
    return result
  }, [dataSource, pendingRows, insertPositions])

  const hasChanges = cellChangeCount > 0 || pendingRows.length > 0
  const editableColumnNames = useMemo(() => columns.map((col) => col.name), [columns])

  // 加载更多逻辑
  const maybeLoadMore = useCallback(() => {
    const scrollBody = tableBodyRef.current
    if (!scrollBody || !hasMore || !onLoadMore || loadingMore || autoLoadLockRef.current) return

    const threshold = 120
    const reachedBottom = scrollBody.scrollTop + scrollBody.clientHeight >= scrollBody.scrollHeight - threshold
    if (!reachedBottom) return

    autoLoadLockRef.current = true
    onLoadMore()
  }, [hasMore, onLoadMore, loadingMore])

  // 重置加载锁
  useEffect(() => {
    autoLoadLockRef.current = false
  }, [loadingMore, dataSource.length])

  useEffect(() => {
    selectedRowRef.current = -1
    cellChangesRef.current = []
    setCellChangeCount(0)
    setEditorState(null)
    setWhereClause('')
    setAppliedWhere('')
    setSortColumn(null)
    setSortDirection(null)
  }, [connectionId, database, tableName])

  const applyFilter = useCallback(() => {
    setAppliedWhere(whereClause)
    const orderBy = sortColumn && sortDirection ? `\`${sortColumn}\` ${sortDirection}` : undefined
    onFilter?.({
      where: whereClause || undefined,
      orderBy,
    })
  }, [whereClause, sortColumn, sortDirection, onFilter])

  const handleSort = useCallback((colName: string) => {
    let newDir: 'ASC' | 'DESC' | null
    if (sortColumn !== colName) {
      newDir = 'ASC'
    } else if (sortDirection === 'ASC') {
      newDir = 'DESC'
    } else {
      newDir = null
    }
    setSortColumn(newDir ? colName : null)
    setSortDirection(newDir)
    const orderBy = newDir ? `\`${colName}\` ${newDir}` : undefined
    onFilter?.({
      where: appliedWhere || undefined,
      orderBy,
    })
  }, [sortColumn, sortDirection, appliedWhere, onFilter])

  const getCellValue = useCallback((rowIndex: number, column: string): string | null => {
    const changedCell = cellChangesRef.current.find((item) => item.rowIndex === rowIndex && item.column === column)
    if (changedCell) return changedCell.newValue
    const row = effectiveData[rowIndex]
    if (!row) return null
    const v = row[column]
    return v == null ? null : String(v)
  }, [effectiveData])

  const hasCellChange = useCallback((rowIndex: number, column: string) => (
    cellChangesRef.current.some((item) => item.rowIndex === rowIndex && item.column === column)
  ), [])

  const syncCellVisual = useCallback((rowIndex: number, column: string, value: string | null) => {
    const container = containerRef.current
    if (!container) return

    // 使用多种查找方式确保在虚拟表格中也能找到元素
    const row = container.querySelector(`.ant-table-row[data-row-key="${rowIndex}"]`)
    if (!(row instanceof HTMLElement)) return

    const cellContent = row.querySelector(`[data-column="${column}"]`)
    const cell = cellContent?.closest('.ant-table-cell')
      ?? row.querySelector(`.ant-table-cell[data-column-key="${column}"]`)

    if (!(cell instanceof HTMLElement)) return

    const content = cell.querySelector('[data-cell-display]')
    if (content instanceof HTMLElement) {
      content.textContent = value ?? 'NULL'
      content.style.fontStyle = value == null ? 'italic' : 'normal'
      content.style.color = value == null ? token.colorTextTertiary : token.colorText
    }

    if (hasCellChange(rowIndex, column)) {
      cell.classList.add('cell-changed')
    } else {
      cell.classList.remove('cell-changed')
    }
  }, [hasCellChange, token.colorText, token.colorTextTertiary])

  const focusTable = useCallback(() => {
    requestAnimationFrame(() => {
      containerRef.current?.focus()
    })
  }, [])

  const scrollRowIntoView = useCallback((rowIndex: number) => {
    const container = containerRef.current
    if (!container) return

    // 先检查行是否已在 DOM 中
    const rowEl = container.querySelector(`.ant-table-row[data-row-key="${rowIndex}"]`)
    if (rowEl instanceof HTMLElement) {
      requestAnimationFrame(() => {
        rowEl.scrollIntoView({ block: 'nearest' })
      })
      return
    }

    // 行不在 DOM 中（虚拟滚动），使用虚拟表格的滚动方法
    const virtualBody = container.querySelector('.ant-table-tbody-virtual-holder') as HTMLDivElement | null
    if (virtualBody && typeof virtualBody.scrollTo === 'function') {
      // 估算行高
      requestAnimationFrame(() => {
        virtualBody.scrollTo({ top: rowIndex * ESTIMATED_ROW_HEIGHT, behavior: 'smooth' })
      })
    }
  }, [])

  const syncSelectedRowClass = useCallback((rowIndex: number) => {
    const container = containerRef.current
    if (!container) return
    container.querySelectorAll('tr.row-selected').forEach((row) => row.classList.remove('row-selected'))
    const nextRow = container.querySelector(`.ant-table-row[data-row-key="${rowIndex}"]`)
    if (nextRow instanceof HTMLElement) {
      nextRow.classList.add('row-selected')
    }
  }, [])

  const handleRowSelect = useCallback((rowIndex: number, options?: { focusTable?: boolean; scroll?: boolean }) => {
    if (rowIndex < 0 || rowIndex >= effectiveData.length) return
    selectedRowRef.current = rowIndex
    syncSelectedRowClass(rowIndex)
    if (options?.scroll !== false) {
      scrollRowIntoView(rowIndex)
    }
    if (options?.focusTable !== false) {
      focusTable()
    }
  }, [effectiveData.length, focusTable, scrollRowIntoView, syncSelectedRowClass])

  useLayoutEffect(() => {
    if (effectiveData.length === 0) {
      selectedRowRef.current = -1
      return
    }
    const nextIndex = selectedRowRef.current >= 0 && selectedRowRef.current < effectiveData.length
      ? selectedRowRef.current
      : 0
    selectedRowRef.current = nextIndex
    syncSelectedRowClass(nextIndex)
  })

  useLayoutEffect(() => {
    const wrapperEl = tableWrapperRef.current
    if (!wrapperEl) return undefined

    const updateHeight = () => {
      const wrapperHeight = wrapperEl.clientHeight
      if (wrapperHeight === 0) return  // 容器尚未可见，跳过
      // 动态测量表头实际高度，避免硬编码 40 导致末行被裁切
      const thead = wrapperEl.querySelector('.ant-table-thead')
      const headerHeight = thead ? Math.ceil(thead.getBoundingClientRect().height) : 42
      // 2px 安全边距，确保最后一行完整可见
      const next = Math.max(220, wrapperHeight - headerHeight - 2)
      setTableScrollY(next)
    }

    // 暴露给行变更操作调用：dispatch resize 事件，触发 rc-virtual-list 内部的 onHolderResize
    // 使其重测容器 height 并重算 visible-range，确保新行在 Tabs 场景下即时显示
    forceVirtualRefreshRef.current = () => {
      window.dispatchEvent(new Event('resize'))
    }

    updateHeight()
    // mount 后再测一次：首次渲染时 .ant-table-thead 可能还不存在
    requestAnimationFrame(updateHeight)

    // 直接观测 wrapper（flex:1），toolbar 和 container 尺寸变化都会传导到 wrapper
    const observer = new ResizeObserver(updateHeight)
    observer.observe(wrapperEl)
    return () => observer.disconnect()
  }, [])


  // 监听表格滚动，触发加载更多
  useEffect(() => {
    const container = containerRef.current
    if (!container || !hasMore) return undefined

    // 找到表格滚动容器
    const nextTableBody = (
      container.querySelector('.ant-table-tbody-virtual-holder') ??
      container.querySelector('.ant-table-body')
    ) as HTMLDivElement | null

    tableBodyRef.current = nextTableBody
    if (!nextTableBody) return undefined

    const handleScroll = () => maybeLoadMore()
    nextTableBody.addEventListener('scroll', handleScroll, { passive: true })
    window.requestAnimationFrame(maybeLoadMore)

    return () => {
      nextTableBody.removeEventListener('scroll', handleScroll)
      if (tableBodyRef.current === nextTableBody) {
        tableBodyRef.current = null
      }
    }
  }, [hasMore, maybeLoadMore, tableScrollY])

  const openEditorAtPosition = useCallback((
    rowIndex: number,
    column: string,
    position: { left: number; top: number; width: number; height: number }
  ) => {
    if (!isEditable) return
    const value = getCellValue(rowIndex, column) ?? ''

    setEditorState({
      rowIndex,
      column,
      position,
      value,
    })
  }, [getCellValue, isEditable])

  const openEditorAtCell = useCallback((rowIndex: number, column: string) => {
    if (!isEditable) return
    const container = containerRef.current
    if (!container) return

    // 虚拟表格：行可能不在 DOM 中，需要先滚动
    const row = container.querySelector(`.ant-table-row[data-row-key="${rowIndex}"]`)
    const virtualBody = container.querySelector('.ant-table-tbody-virtual-holder') as HTMLDivElement | null

    const tryOpenEditor = () => {
      const rowEl = container.querySelector(`.ant-table-row[data-row-key="${rowIndex}"]`)
      if (!(rowEl instanceof HTMLElement)) return

      // 尝试多种方式查找单元格
      const cellContent = rowEl.querySelector(`[data-column="${column}"]`)
      const cell = cellContent?.closest('.ant-table-cell')
        ?? rowEl.querySelector(`.ant-table-cell[data-column-key="${column}"]`)
        ?? (rowEl.querySelectorAll('.ant-table-cell')[columns.findIndex(c => c.name === column)] as HTMLElement | undefined)

      if (!(cell instanceof HTMLElement)) return

      const rect = cell.getBoundingClientRect()
      const containerRect = container.getBoundingClientRect()
      openEditorAtPosition(rowIndex, column, {
        left: rect.left - containerRect.left,
        top: rect.top - containerRect.top,
        width: rect.width,
        height: rect.height,
      })
    }

    // 如果行已在 DOM 中，直接打开编辑器
    if (row instanceof HTMLElement) {
      tryOpenEditor()
    } else if (virtualBody && typeof virtualBody.scrollTo === 'function') {
      // 行不在 DOM 中，先滚动到该行
      const estimatedRowHeight = ESTIMATED_ROW_HEIGHT
      virtualBody.scrollTo({ top: rowIndex * estimatedRowHeight, behavior: 'smooth' })
      requestAnimationFrame(() => {
        requestAnimationFrame(tryOpenEditor)
      })
    }
  }, [isEditable, openEditorAtPosition, columns])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return undefined

    const handleNativeClick = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null
      if (!target || target.closest('.cell-editor')) return
      // Ant Design 虚拟滚动使用 DIV
      const row = target.closest('.ant-table-row[data-row-key]')
      if (!(row instanceof HTMLElement)) return
      const rowIndex = Number(row.dataset.rowKey)
      if (!Number.isFinite(rowIndex)) return
      handleRowSelect(rowIndex, { focusTable: false })
    }

    const handleNativeDoubleClick = (event: MouseEvent) => {
      if (!isEditable) return
      const target = event.target as HTMLElement | null
      if (!target) return

      // Ant Design 虚拟滚动使用 DIV 而非 TR/TD
      const cell = target.closest('.ant-table-cell')
      const row = target.closest('.ant-table-row[data-row-key]')

      if (!(cell instanceof HTMLElement) || !(row instanceof HTMLElement)) return

      // 获取列名：优先从内容元素获取，其次从 td 的属性获取，最后从子元素查找
      const cellContent = target.closest('[data-column]')
      const column = cellContent?.getAttribute('data-column')
        ?? cell.getAttribute('data-column-key')
        ?? cell.querySelector('[data-column]')?.getAttribute('data-column')

      if (!column) return

      const rowIndex = Number(row.dataset.rowKey)
      if (!Number.isFinite(rowIndex)) return

      // 虚拟表格：先滚动到该行，等待渲染后再打开编辑器
      const container = containerRef.current
      if (!container) return

      // 找到表格的虚拟滚动容器
      const virtualBody = container.querySelector('.ant-table-tbody-virtual-holder') as HTMLDivElement | null

      const tryOpenEditor = () => {
        const containerRect = container.getBoundingClientRect()
        const rect = cell.getBoundingClientRect()
        handleRowSelect(rowIndex, { focusTable: false, scroll: false })
        openEditorAtPosition(rowIndex, column, {
          left: rect.left - containerRect.left,
          top: rect.top - containerRect.top,
          width: rect.width,
          height: rect.height,
        })
      }

      // 检查行是否在 DOM 中，如果在则直接打开编辑器
      const existingRow = container.querySelector(`.ant-table-row[data-row-key="${rowIndex}"]`)
      if (existingRow instanceof HTMLElement) {
        tryOpenEditor()
      } else if (virtualBody && typeof virtualBody.scrollTo === 'function') {
        // 行不在 DOM 中，需要先滚动到该行
        // 估算行高 ~35px，滚动到目标位置
        virtualBody.scrollTo({ top: rowIndex * ESTIMATED_ROW_HEIGHT, behavior: 'smooth' })
        // 等待虚拟滚动渲染后打开编辑器
        requestAnimationFrame(() => {
          requestAnimationFrame(tryOpenEditor)
        })
      } else {
        // 无法找到滚动容器，直接尝试打开（虚拟表格应该有）
        handleRowSelect(rowIndex, { focusTable: false, scroll: false })
        openEditorAtPosition(rowIndex, column, { left: 0, top: 0, width: 100, height: 30 })
      }
    }

    const handleContextMenu = (event: MouseEvent) => {
      event.preventDefault()
      const row = (event.target as HTMLElement | null)?.closest('.ant-table-row[data-row-key]')
      if (!(row instanceof HTMLElement)) return
      const rowIndex = Number(row.dataset.rowKey)
      if (!Number.isFinite(rowIndex)) return
      handleRowSelect(rowIndex, { focusTable: false })
      // 边界检测：防止菜单超出视口
      const MENU_WIDTH = 200
      const MENU_HEIGHT = 260 // 保守估算（含批量操作时更高）
      const safeX = event.clientX + MENU_WIDTH > window.innerWidth
        ? Math.max(8, event.clientX - MENU_WIDTH)
        : event.clientX
      const safeY = event.clientY + MENU_HEIGHT > window.innerHeight
        ? Math.max(8, event.clientY - MENU_HEIGHT)
        : event.clientY
      setContextMenu({ x: safeX, y: safeY, rowIndex })
    }

    container.addEventListener('click', handleNativeClick)
    container.addEventListener('dblclick', handleNativeDoubleClick)
    container.addEventListener('contextmenu', handleContextMenu)

    return () => {
      container.removeEventListener('click', handleNativeClick)
      container.removeEventListener('dblclick', handleNativeDoubleClick)
      container.removeEventListener('contextmenu', handleContextMenu)
    }
  }, [handleRowSelect, isEditable, openEditorAtPosition])

  const getAdjacentCell = useCallback((rowIndex: number, column: string, direction: 1 | -1) => {
    const columnIndex = editableColumnNames.indexOf(column)
    if (columnIndex === -1 || editableColumnNames.length === 0 || effectiveData.length === 0) return null

    const flatIndex = rowIndex * editableColumnNames.length + columnIndex + direction
    const maxIndex = effectiveData.length * editableColumnNames.length - 1
    if (flatIndex < 0 || flatIndex > maxIndex) return null

    return {
      rowIndex: Math.floor(flatIndex / editableColumnNames.length),
      column: editableColumnNames[flatIndex % editableColumnNames.length],
    }
  }, [editableColumnNames, effectiveData.length])

  const commitEdit = useCallback((newVal: string, nextCell?: { rowIndex: number; column: string } | null) => {
    if (!editorState) return
    const { rowIndex, column } = editorState
    const baseRow = effectiveData[rowIndex]
    const sourceValue = baseRow?.[column]
    const oldValue = sourceValue == null ? null : String(sourceValue)
    const newValue = newVal || null
    const nextChanges = [...cellChangesRef.current]
    const existingIndex = nextChanges.findIndex((item) => item.rowIndex === rowIndex && item.column === column)

    if (oldValue === newValue) {
      if (existingIndex >= 0) nextChanges.splice(existingIndex, 1)
    } else if (existingIndex >= 0) {
      nextChanges[existingIndex] = { rowIndex, column, oldValue, newValue }
    } else {
      nextChanges.push({ rowIndex, column, oldValue, newValue })
    }

    cellChangesRef.current = nextChanges
    setCellChangeCount(nextChanges.length)
    syncCellVisual(rowIndex, column, newValue)
    setEditorState(null)
    if (nextCell) {
      handleRowSelect(nextCell.rowIndex, { focusTable: false })
      requestAnimationFrame(() => openEditorAtCell(nextCell.rowIndex, nextCell.column))
    }
  }, [editorState, effectiveData, handleRowSelect, openEditorAtCell, syncCellVisual])

  // 确认编辑 → 记录变更 → 关闭浮层
  const handleEditConfirm = useCallback((newVal: string) => {
    commitEdit(newVal)
  }, [commitEdit])

  const handleStepCell = useCallback((newVal: string, direction: 1 | -1) => {
    if (!editorState) return
    const nextCell = getAdjacentCell(editorState.rowIndex, editorState.column, direction)
    commitEdit(newVal, nextCell)
  }, [commitEdit, editorState, getAdjacentCell])

  const handleEditCancel = useCallback(() => setEditorState(null), [])

  const addRow = useCallback(() => {
    const emptyRow: Record<string, unknown> = {}
    columns.forEach((c) => { emptyRow[c.name] = c.defaultValue ?? null })
    const insertAfter = selectedRowRef.current
    const newRowIndex = insertAfter + 1
    setInsertPositions((prev) => [...prev, { afterIndex: insertAfter, data: emptyRow }])
    setPendingRows((prev) => [...prev, { type: 'insert', rowIndex: newRowIndex, data: emptyRow }])
    handleRowSelect(newRowIndex)
    requestAnimationFrame(() => {
      tableRef.current?.scrollTo({ index: newRowIndex })
      forceVirtualRefreshRef.current()
    })
  }, [columns, handleRowSelect])

  const deleteRow = useCallback((rowIndex: number) => {
    setPendingRows((prev) => [...prev, { type: 'delete', rowIndex, data: effectiveData[rowIndex] as Record<string, unknown> }])
    requestAnimationFrame(() => {
      tableRef.current?.scrollTo({ index: Math.max(0, rowIndex - 1) })
      forceVirtualRefreshRef.current()
    })
  }, [effectiveData])

  const undoAll = useCallback(() => {
    cellChangesRef.current = []
    setCellChangeCount(0)
    setPendingRows([])
    setInsertPositions([])
    setSelectedRowKeys([])
  }, [])

  // ─── 批量操作 ────────────────────────────────────────────

  /** 批量删除选中行 */
  const batchDelete = useCallback(() => {
    if (selectedRowKeys.length === 0) return
    for (const rowIndex of selectedRowKeys) {
      const alreadyDeleted = pendingRows.some(p => p.type === 'delete' && p.rowIndex === rowIndex)
      if (!alreadyDeleted) {
        setPendingRows(prev => [...prev, { type: 'delete', rowIndex, data: effectiveData[rowIndex] as Record<string, unknown> }])
      }
    }
    setSelectedRowKeys([])
    // 强制 virtual list 重算
    const firstKey = selectedRowKeys[0] ?? 0
    requestAnimationFrame(() => {
      tableRef.current?.scrollTo({ index: Math.max(0, firstKey - 1) })
      forceVirtualRefreshRef.current()
    })
    toast.success(`已标记 ${selectedRowKeys.length} 行待删除，请点击保存确认`)
  }, [selectedRowKeys, pendingRows, effectiveData])

  /** 批量克隆选中行（主键列置空，插入为新行） */
  const batchClone = useCallback(() => {
    if (selectedRowKeys.length === 0) return
    for (const rowIndex of selectedRowKeys) {
      const sourceRow = { ...effectiveData[rowIndex] }
      // 主键列置空
      for (const pk of primaryKeys) sourceRow[pk] = null
      setInsertPositions(prev => [...prev, { afterIndex: effectiveData.length - 1, data: sourceRow }])
      setPendingRows(prev => [...prev, { type: 'insert', rowIndex: effectiveData.length, data: sourceRow }])
    }
    setSelectedRowKeys([])
    // 强制 virtual list 重算，滚动到末尾新增的复制行
    const targetIndex = effectiveData.length
    requestAnimationFrame(() => {
      tableRef.current?.scrollTo({ index: targetIndex })
      forceVirtualRefreshRef.current()
    })
    toast.success(`已复制 ${selectedRowKeys.length} 行到末尾，请修改后保存`)
  }, [selectedRowKeys, effectiveData, primaryKeys])

  /** 确认批量改列 */
  const confirmBatchEdit = useCallback(() => {
    if (!batchEditColumn || selectedRowKeys.length === 0) return
    const col = batchEditColumn
    const newValue = batchEditValue || null
    let changedCount = 0
    for (const rowIndex of selectedRowKeys) {
      const baseRow = effectiveData[rowIndex]
      if (!baseRow) continue
      const oldValue = baseRow[col] == null ? null : String(baseRow[col])
      const nextChanges = [...cellChangesRef.current]
      const existingIdx = nextChanges.findIndex(c => c.rowIndex === rowIndex && c.column === col)
      if (oldValue === newValue) {
        if (existingIdx >= 0) nextChanges.splice(existingIdx, 1)
      } else if (existingIdx >= 0) {
        nextChanges[existingIdx] = { rowIndex, column: col, oldValue, newValue }
        changedCount++
      } else {
        nextChanges.push({ rowIndex, column: col, oldValue, newValue })
        changedCount++
      }
      cellChangesRef.current = nextChanges
      syncCellVisual(rowIndex, col, newValue)
    }
    setCellChangeCount(cellChangesRef.current.length)
    setBatchEditOpen(false)
    setBatchEditColumn(null)
    setBatchEditValue('')
    setSelectedRowKeys([])
    toast.success(`已批量修改 ${changedCount} 行的「${col}」字段`)
  }, [batchEditColumn, batchEditValue, selectedRowKeys, effectiveData, syncCellVisual])

  const buildChanges = useCallback((): RowChange[] => {
    const changes: RowChange[] = []
    const updatedRows = new Map<number, Map<string, { oldValue: string | null; newValue: string | null }>>()
    for (const c of cellChangesRef.current) {
      if (!updatedRows.has(c.rowIndex)) updatedRows.set(c.rowIndex, new Map())
      updatedRows.get(c.rowIndex)!.set(c.column, { oldValue: c.oldValue, newValue: c.newValue })
    }
    for (const [rowIndex, cols] of updatedRows) {
      const row = dataSource[rowIndex]
      if (!row) continue
      const pks: Record<string, string | null> = {}
      for (const pk of primaryKeys) { pks[pk] = row[pk] == null ? null : String(row[pk]) }
      const values: Record<string, string | null> = {}
      const oldValues: Record<string, string | null> = {}
      for (const [col, { oldValue, newValue }] of cols) { values[col] = newValue; oldValues[col] = oldValue }
      changes.push({ type: 'update', primaryKeys: pks, values, oldValues })
    }
    for (const p of pendingRows.filter((pp) => pp.type === 'insert')) {
      const values: Record<string, string | null> = {}
      for (const [k, v] of Object.entries(p.data)) { values[k] = v == null ? null : String(v) }
      const edits = cellChangesRef.current.filter((c) => c.rowIndex === p.rowIndex)
      for (const e of edits) { values[e.column] = e.newValue }
      changes.push({ type: 'insert', primaryKeys: {}, values, oldValues: {} })
    }
    for (const p of pendingRows.filter((pp) => pp.type === 'delete')) {
      const pks: Record<string, string | null> = {}
      for (const pk of primaryKeys) { pks[pk] = p.data[pk] == null ? null : String(p.data[pk]) }
      changes.push({ type: 'delete', primaryKeys: pks, values: {}, oldValues: {} })
    }
    return changes
  }, [pendingRows, dataSource, primaryKeys])

  const save = useCallback(async () => {
    const changes = buildChanges()
    if (changes.length === 0) return

    // Step 1: 硬获 SQL 预览
    let sqlPreview = ''
    try {
      const result = await metadataApi.editData(connectionId, database, tableName, changes, true) as DataEditResult
      sqlPreview = result.sqlStatements.join(';\n') || '无变更'
    } catch (e) {
      handleApiError(e, '生成 SQL 失败')
      return
    }

    // Step 2: 展示确认寻单
    Modal.confirm({
      title: '确认保存？将执行以下 SQL',
      width: 640,
      icon: <ExclamationCircleOutlined />,
      content: (
        <pre style={{
          background: 'var(--glass-panel)',
          border: '1px solid var(--glass-border)',
          color: 'inherit',
          padding: 12, borderRadius: 8, fontSize: 12,
          fontFamily: 'Menlo, Monaco, "Courier New", monospace',
          maxHeight: 320, overflow: 'auto', margin: 0,
          lineHeight: 1.6,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-all',
        }}>
          {sqlPreview}
        </pre>
      ),
      okText: '确认执行',
      cancelText: '取消',
      okButtonProps: { danger: changes.some(c => c.type === 'delete') },
      onOk: async () => {
        setSaving(true)
        try {
          const result = await metadataApi.editData(connectionId, database, tableName, changes) as DataEditResult
          if (result.success) {
            toast.success(`保存成功，影响 ${result.affectedRows} 行`)
            undoAll()
            onRefresh()
          } else {
            toast.error(`保存失败：${result.errors.join('; ')}`)
          }
        } catch (e) { handleApiError(e, '保存失败') }
        finally { setSaving(false) }
      },
    })
  }, [buildChanges, connectionId, database, tableName, undoAll, onRefresh])

  // 表格列（不包含编辑状态判断，render 纯展示）
  const tableColumns = useMemo<ColumnsType<TableRow>>(() => {
    const cols: ColumnsType<TableRow> = columns.map((col) => ({
      title: (
        <div
          style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer', userSelect: 'none' }}
          onClick={() => handleSort(col.name)}
        >
          <Space size={2}>
            {col.name}
            {col.isPrimaryKey && <Tag color="gold" style={{ fontSize: 10, lineHeight: '14px', padding: '0 3px' }}>PK</Tag>}
          </Space>
          {sortColumn === col.name && sortDirection === 'ASC' && <CaretUpOutlined style={{ fontSize: 10, color: token.colorPrimary }} />}
          {sortColumn === col.name && sortDirection === 'DESC' && <CaretDownOutlined style={{ fontSize: 10, color: token.colorPrimary }} />}
        </div>
      ),
      dataIndex: col.name,
      key: col.name,
      width: 150,
      ellipsis: true,
      onCell: (record: TableRow) => ({
        'data-row-key': record._key,
        'data-column-key': col.name,
        style: {
          cursor: isEditable ? 'cell' : 'default',
          ...(hasCellChange(record._rowIndex, col.name)
            ? { background: token.colorWarningBg }
            : {}),
        },
      }),
      render: (_value: unknown, record: TableRow) => {
        const rowIndex = record._rowIndex
        const displayValue = getCellValue(rowIndex, col.name)
        if (displayValue == null) {
          return (
            <span data-cell-display data-column={col.name} style={{ fontSize: 11, fontStyle: 'italic', color: token.colorTextTertiary }}>
              NULL
            </span>
          )
        }
        return <span data-cell-display data-column={col.name} style={{ display: 'block', maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{String(displayValue)}</span>
      },
    }))

    // 移除“操作”列，行级删除改为右键菜单操作
    return cols
  }, [columns, isEditable, token, hasCellChange, getCellValue, handleSort, sortColumn, sortDirection])

  const tableData = useMemo<TableRow[]>(
    () => effectiveData.map((r, i) => ({ ...r, _key: i, _rowIndex: i })),
    [effectiveData]
  )


  return (
    <div
      ref={containerRef}
      className="editable-data-table"
      tabIndex={0}
      onKeyDown={(event) => {
        if (editorState || effectiveData.length === 0) return
        const currentIndex = selectedRowRef.current >= 0 ? selectedRowRef.current : 0

        if (event.key === 'ArrowDown') {
          event.preventDefault()
          handleRowSelect(Math.min(currentIndex + 1, effectiveData.length - 1))
        }

        if (event.key === 'ArrowUp') {
          event.preventDefault()
          handleRowSelect(Math.max(currentIndex - 1, 0))
        }

        // Delete 键：删除当前选中行（不删除已标记删除的行）
        if (event.key === 'Delete' && isEditable && selectedRowRef.current >= 0) {
          event.preventDefault()
          const idx = selectedRowRef.current
          const alreadyDeleted = pendingRows.some(p => p.type === 'delete' && p.rowIndex === idx)
          if (!alreadyDeleted) deleteRow(idx)
        }
      }}
      style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', position: 'relative' }}
    >
      <style>{`
        .editable-data-table:focus {
          outline: none;
        }
        .editable-data-table .ant-table-wrapper {
          height: 100%;
        }
        /* Pro-Max Spreadsheet Header */
        .editable-data-table .ant-table-thead > tr > th {
          background: transparent !important;
          font-weight: 600;
          color: ${token.colorTextSecondary};
          border-bottom: 2px solid var(--glass-border) !important;
          padding: 8px 12px !important;
        }
        /* Pro-Max Spreadsheet Cells */
        .editable-data-table .ant-table-tbody > tr > td {
          padding: 4px 12px !important;
          border-bottom: 1px solid var(--glass-border) !important;
          border-right: none !important;
          font-family: 'JetBrains Mono', monospace;
          font-size: 13px;
        }
        .editable-data-table .ant-table-tbody > tr:hover > td {
          background: ${token.colorFillAlter} !important;
        }
        .editable-data-table .ant-table-tbody > tr.row-selected > td {
          background: ${token.colorPrimaryBg} !important;
        }
        .editable-data-table .ant-table-tbody > tr.row-multi-selected > td {
          background: ${token.colorPrimaryBg} !important;
          outline: 1px solid ${token.colorPrimary};
          outline-offset: -1px;
        }
        .editable-data-table .ant-table-tbody > tr.row-inserted > td {
          background: ${token.colorSuccessBg} !important;
        }
        .editable-data-table .ant-table-tbody > tr.row-deleted > td {
          background: ${token.colorErrorBg} !important;
          color: ${token.colorTextQuaternary};
          text-decoration: line-through;
        }
        .editable-data-table .ant-table-tbody td.cell-changed {
          background: ${token.colorWarningBg} !important;
        }
        /* Remove default AntD column dividers */
        .editable-data-table .ant-table-cell::before {
          display: none !important;
        }
      `}</style>
      {/* WHERE 筛选栏 */}
      {onFilter && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexShrink: 0 }}>
          <FilterOutlined style={{ color: token.colorTextSecondary, fontSize: 13 }} />
          <AutoComplete
            size="small"
            style={{ flex: 1 }}
            value={whereClause}
            onChange={(val) => setWhereClause(val)}
            options={(() => {
              // 提取光标位置前的最后一个单词
              const input = document.activeElement as HTMLInputElement | null
              const cursorPos = input?.selectionStart ?? whereClause.length
              const textBeforeCursor = whereClause.slice(0, cursorPos)
              const match = textBeforeCursor.match(/([a-zA-Z_][a-zA-Z0-9_]*)$/)
              const partial = match ? match[1].toLowerCase() : ''
              if (!partial || partial.length < 1) return []
              const colSuggestions = columns
                .filter(c => c.name.toLowerCase().startsWith(partial))
                .map(c => ({
                  value: whereClause.slice(0, cursorPos - partial.length) + c.name + whereClause.slice(cursorPos),
                  label: (
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span style={{ fontWeight: 500 }}>{c.name}</span>
                      <span style={{ fontSize: 11, color: token.colorTextTertiary }}>{c.type}</span>
                    </div>
                  ),
                }))
              const sqlKeywords = ['AND', 'OR', 'NOT', 'LIKE', 'IN', 'IS NULL', 'IS NOT NULL', 'BETWEEN', 'EXISTS']
              const kwSuggestions = sqlKeywords
                .filter(kw => kw.toLowerCase().startsWith(partial))
                .map(kw => ({
                  value: whereClause.slice(0, cursorPos - partial.length) + kw + ' ' + whereClause.slice(cursorPos),
                  label: <span style={{ color: token.colorPrimary, fontSize: 12 }}>{kw}</span>,
                }))
              return [...colSuggestions, ...kwSuggestions]
            })()}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.defaultPrevented) {
                setTimeout(() => applyFilter(), 0)
              }
            }}
          >
            <Input
              size="small"
              placeholder="输入 WHERE 条件，字段名自动补全"
              allowClear
            />
          </AutoComplete>
          <Button size="small" type="primary" onClick={applyFilter}>筛选</Button>
          {appliedWhere && (
            <Button size="small" onClick={() => {
              setWhereClause('')
              setAppliedWhere('')
              setSortColumn(null)
              setSortDirection(null)
              onFilter?.({})
            }}>重置</Button>
          )}
        </div>
      )}
      {/* 图标工具栏 */}
      {isEditable && (
        <div
          ref={toolbarRef}
          style={{
            marginBottom: 8,
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 8,
          }}
        >
          <Text type="secondary" style={{ fontSize: 12 }}>
            {selectedRowKeys.length > 0 ? `已选 ${selectedRowKeys.length} 行` : '单击选中，双击编辑，右键更多操作'}
          </Text>
          <Space size={2}>
            {/* 批量操作区 — 有多行选中时出现 */}
            {selectedRowKeys.length > 0 && (
              <>
                <Tooltip title={`删除已选 ${selectedRowKeys.length} 行`} placement="bottom">
                  <Button size="small" type="text" danger icon={<DeleteOutlined />} onClick={batchDelete} />
                </Tooltip>
                <Tooltip title={`复制 ${selectedRowKeys.length} 行到末尾`} placement="bottom">
                  <Button size="small" type="text" icon={<CopyOutlined />} onClick={batchClone} />
                </Tooltip>
                <Tooltip title="批量修改某列的值" placement="bottom">
                  <Button
                    size="small" type="text" icon={<EditOutlined />}
                    onClick={() => { setBatchEditColumn(null); setBatchEditValue(''); setBatchEditOpen(true) }}
                  />
                </Tooltip>
                <Tooltip title="取消多行选择" placement="bottom">
                  <Button size="small" type="text" icon={<CloseOutlined />} onClick={() => setSelectedRowKeys([])} />
                </Tooltip>
                <Divider type="vertical" style={{ margin: '0 4px' }} />
              </>
            )}
            {/* 常驻操作 */}
            <Tooltip title="新增一行" placement="bottom">
              <Button size="small" type="text" icon={<PlusOutlined />} onClick={addRow} />
            </Tooltip>
            <Tooltip title="撤销所有未保存变更" placement="bottom">
              <Button size="small" type="text" icon={<UndoOutlined />} onClick={undoAll} disabled={!hasChanges} />
            </Tooltip>
            <Tooltip title={hasChanges ? `保存（${cellChangeCount + pendingRows.length} 项变更）` : '保存'} placement="bottom">
              <Button
                size="small"
                type={hasChanges ? 'primary' : 'text'}
                icon={<SaveOutlined />}
                onClick={save}
                loading={saving}
                disabled={!hasChanges}
              />
            </Tooltip>
          </Space>
        </div>
      )}
      {/* 批量改列 Modal */}
      <Modal
        title={`批量修改 ${selectedRowKeys.length} 行的某列值`}
        open={batchEditOpen}
        onCancel={() => setBatchEditOpen(false)}
        onOk={confirmBatchEdit}
        okText="确认修改"
        cancelText="取消"
        okButtonProps={{ disabled: !batchEditColumn }}
        width={420}
      >
        <Space direction="vertical" style={{ width: '100%' }} size={12}>
          <div>
            <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 6 }}>选择要修改的字段</Text>
            <Select
              style={{ width: '100%' }}
              placeholder="选择字段"
              value={batchEditColumn ?? undefined}
              onChange={v => setBatchEditColumn(v)}
              options={columns
                .filter(c => !c.isPrimaryKey)
                .map(c => ({ label: `${c.name} (${c.type})`, value: c.name }))
              }
              showSearch
            />
          </div>
          <div>
            <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 6 }}>新值（留空表示 NULL）</Text>
            <Input
              value={batchEditValue}
              onChange={e => setBatchEditValue(e.target.value)}
              placeholder="输入新值，留空则设为 NULL"
              allowClear
            />
          </div>
        </Space>
      </Modal>


      {/* 右键菜单 */}
      {contextMenu && (
        <div
          style={{
            position: 'fixed',
            left: contextMenu.x,
            top: contextMenu.y,
            zIndex: 1000,
            background: 'var(--glass-popup, rgba(30,30,40,0.92))',
            border: '1px solid var(--glass-border)',
            borderRadius: 10,
            boxShadow: '0 12px 40px rgba(0,0,0,0.3)',
            backdropFilter: 'blur(20px)',
            padding: '4px 0',
            minWidth: 180,
          }}
          onClick={e => e.stopPropagation()}
        >
          {[...(
            selectedRowKeys.length > 1
              ? [
                  { label: `删除已选 ${selectedRowKeys.length} 行`, icon: <DeleteOutlined />, danger: true, action: () => { batchDelete(); setContextMenu(null) } },
                  { label: `复制已选 ${selectedRowKeys.length} 行`, icon: <CopyOutlined />, action: () => { batchClone(); setContextMenu(null) } },
                  { label: '批量改列…', icon: <EditOutlined />, action: () => { setBatchEditColumn(null); setBatchEditValue(''); setBatchEditOpen(true); setContextMenu(null) } },
                  'divider' as const,
                ]
              : []
          ),
            { label: '新增一行', icon: <PlusOutlined />, action: () => { addRow(); setContextMenu(null) } },
            { label: '删除此行', icon: <DeleteOutlined />, danger: true, action: () => {
              const alreadyDeleted = pendingRows.some(p => p.type === 'delete' && p.rowIndex === contextMenu.rowIndex)
              if (!alreadyDeleted) deleteRow(contextMenu.rowIndex)
              setContextMenu(null)
            }},
            { label: '复制此行', icon: <CopyOutlined />, action: () => {
              const sourceRow = { ...effectiveData[contextMenu.rowIndex] }
              for (const pk of primaryKeys) sourceRow[pk] = null
              const targetIndex = effectiveData.length
              setInsertPositions(prev => [...prev, { afterIndex: effectiveData.length - 1, data: sourceRow }])
              setPendingRows(prev => [...prev, { type: 'insert', rowIndex: effectiveData.length, data: sourceRow }])
              requestAnimationFrame(() => {
                tableRef.current?.scrollTo({ index: targetIndex })
                forceVirtualRefreshRef.current()
              })
              toast.success('已复制到末尾')
              setContextMenu(null)
            }},
          ].map((item, i) => {
            if (item === 'divider') return (
              <div key={i} style={{ height: 1, background: 'var(--glass-border)', margin: '4px 0' }} />
            )
            return (
              <div
                key={i}
                onClick={item.action}
                style={{
                  padding: '7px 14px',
                  cursor: 'pointer',
                  fontSize: 13,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  color: item.danger ? 'var(--ant-color-error, #ff4d4f)' : 'inherit',
                  transition: 'background 0.12s',
                  borderRadius: 6,
                  margin: '0 4px',
                }}
                onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.08)')}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
              >
                {item.icon}
                <span>{item.label}</span>
              </div>
            )
          })}
        </div>
      )}

      {/* 点击任意处关闭右键菜单 */}
      {contextMenu && (
        <div
          style={{ position: 'fixed', inset: 0, zIndex: 999 }}
          onClick={() => setContextMenu(null)}
          onContextMenu={() => setContextMenu(null)}
        />
      )}

      {/* 表格 */}
      <div ref={tableWrapperRef} style={{ flex: 1, overflow: 'hidden', minHeight: 0 }}>
        <Table
          ref={tableRef}
          virtual
          columns={tableColumns}
          dataSource={tableData}
          rowKey="_key"
          pagination={false}
          size="small"
          scroll={{ x: 'max-content', y: tableScrollY }}
          rowClassName={(record) => {
            const classes: string[] = []
            const rowIndex = record._rowIndex as number
            if (pendingRows.some((p) => p.type === 'delete' && p.rowIndex === rowIndex)) classes.push('row-deleted')
            if (pendingRows.some((p) => p.type === 'insert' && p.rowIndex === rowIndex)) classes.push('row-inserted')
            if (selectedRowKeys.includes(rowIndex)) classes.push('row-multi-selected')
            return classes.join(' ')
          }}
          rowSelection={isEditable ? {
            type: 'checkbox',
            selectedRowKeys,
            onChange: (keys) => setSelectedRowKeys(keys as number[]),
            columnWidth: 36,
          } : undefined}
        />
      </div>

      {/* 浮层编辑器：覆盖在单元格上方，不触发 Table 重渲染 */}
      {editorState && (
        <CellEditor
          key={`${editorState.rowIndex}:${editorState.column}`}
          position={editorState.position}
          value={editorState.value}
          onConfirm={handleEditConfirm}
          onCancel={handleEditCancel}
          onStepCell={handleStepCell}
        />
      )}
    </div>
  )
}
