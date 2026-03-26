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
  Table, Input, Button, Space, Tag, Popconfirm, Typography, theme, Modal, Pagination, AutoComplete,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import {
  PlusOutlined, DeleteOutlined, SaveOutlined, UndoOutlined,
  ExclamationCircleOutlined, FilterOutlined, CaretUpOutlined, CaretDownOutlined,
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
        style={{ width: '100%', height: '100%', borderRadius: 0 }}
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
}) => {
  const { token } = theme.useToken()
  const containerRef = useRef<HTMLDivElement>(null)
  const toolbarRef = useRef<HTMLDivElement>(null)
  const pagerRef = useRef<HTMLDivElement>(null)
  const selectedRowRef = useRef<number>(-1)
  const cellChangesRef = useRef<CellChange[]>([])

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
  // 触发器：用于需要强制刷新表格的场景
  const [gridVersion, setGridVersion] = useState(0)
  const [currentPage, setCurrentPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [tableScrollY, setTableScrollY] = useState(240)

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

  useEffect(() => {
    selectedRowRef.current = -1
    cellChangesRef.current = []
    setCellChangeCount(0)
    setEditorState(null)
    setCurrentPage(1)
    setPageSize(20)
    setGridVersion((v) => v + 1)
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

  useEffect(() => {
    const totalPages = Math.max(1, Math.ceil(effectiveData.length / pageSize))
    if (currentPage > totalPages) {
      setCurrentPage(totalPages)
    }
  }, [currentPage, effectiveData.length, pageSize])

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
    const cell = containerRef.current?.querySelector(`td[data-row-index="${rowIndex}"][data-column-key="${column}"]`)
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
    requestAnimationFrame(() => {
      const rowEl = containerRef.current?.querySelector(`tr[data-row-key="${rowIndex}"]`)
      if (rowEl instanceof HTMLElement) {
        rowEl.scrollIntoView({ block: 'nearest' })
      }
    })
  }, [])

  const syncSelectedRowClass = useCallback((rowIndex: number) => {
    const container = containerRef.current
    if (!container) return
    container.querySelectorAll('tr.row-selected').forEach((row) => row.classList.remove('row-selected'))
    const nextRow = container.querySelector(`tr[data-row-key="${rowIndex}"]`)
    if (nextRow instanceof HTMLElement) {
      nextRow.classList.add('row-selected')
    }
  }, [])

  const handleRowSelect = useCallback((rowIndex: number, options?: { focusTable?: boolean; scroll?: boolean }) => {
    if (rowIndex < 0 || rowIndex >= effectiveData.length) return
    selectedRowRef.current = rowIndex
    const nextPage = Math.floor(rowIndex / pageSize) + 1
    if (nextPage !== currentPage) {
      setCurrentPage(nextPage)
    }
    syncSelectedRowClass(rowIndex)
    if (options?.scroll !== false) {
      scrollRowIntoView(rowIndex)
    }
    if (options?.focusTable !== false) {
      focusTable()
    }
  }, [currentPage, effectiveData.length, focusTable, pageSize, scrollRowIntoView, syncSelectedRowClass])

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
    const el = containerRef.current
    if (!el) return undefined

    const updateHeight = () => {
      const toolbarHeight = toolbarRef.current?.getBoundingClientRect().height ?? 0
      const pagerHeight = pagerRef.current?.getBoundingClientRect().height ?? 44
      const headerHeight = 40
      const outerGap = 16
      const next = Math.max(220, Math.floor(el.clientHeight - toolbarHeight - pagerHeight - headerHeight - outerGap))
      setTableScrollY(next)
    }

    updateHeight()
    const observer = new ResizeObserver(updateHeight)
    observer.observe(el)
    if (toolbarRef.current) observer.observe(toolbarRef.current)
    if (pagerRef.current) observer.observe(pagerRef.current)
    return () => observer.disconnect()
  }, [])

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
    const td = container?.querySelector(`td[data-row-index="${rowIndex}"][data-column-key="${column}"]`)
    if (!(td instanceof HTMLElement) || !container) return

    const rect = td.getBoundingClientRect()
    const containerRect = container.getBoundingClientRect()
    openEditorAtPosition(rowIndex, column, {
      left: rect.left - containerRect.left,
      top: rect.top - containerRect.top,
      width: rect.width,
      height: rect.height,
    })
  }, [isEditable, openEditorAtPosition])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return undefined

    const handleNativeClick = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null
      if (!target || target.closest('.cell-editor')) return
      const row = target.closest('tr[data-row-key]')
      if (!(row instanceof HTMLElement)) return
      const rowIndex = Number(row.dataset.rowKey)
      if (!Number.isFinite(rowIndex)) return
      handleRowSelect(rowIndex, { focusTable: false })
    }

    const handleNativeDoubleClick = (event: MouseEvent) => {
      if (!isEditable) return
      const target = event.target as HTMLElement | null
      if (!target) return
      const cell = target.closest('td[data-column-key]')
      const row = target.closest('tr[data-row-key]')
      if (!(cell instanceof HTMLElement) || !(row instanceof HTMLElement)) return
      const rowIndex = Number(row.dataset.rowKey)
      const column = cell.dataset.columnKey
      if (!Number.isFinite(rowIndex) || !column) return

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

    container.addEventListener('click', handleNativeClick)
    container.addEventListener('dblclick', handleNativeDoubleClick)

    return () => {
      container.removeEventListener('click', handleNativeClick)
      container.removeEventListener('dblclick', handleNativeDoubleClick)
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
    setInsertPositions((prev) => [...prev, { afterIndex: insertAfter, data: emptyRow }])
    setPendingRows((prev) => [...prev, { type: 'insert', rowIndex: insertAfter + 1, data: emptyRow }])
    handleRowSelect(insertAfter + 1)
  }, [columns, handleRowSelect])

  const deleteRow = useCallback((rowIndex: number) => {
    setPendingRows((prev) => [...prev, { type: 'delete', rowIndex, data: effectiveData[rowIndex] as Record<string, unknown> }])
  }, [effectiveData])

  const undoAll = useCallback(() => {
    cellChangesRef.current = []
    setCellChangeCount(0)
    setPendingRows([])
    setInsertPositions([])
    setGridVersion((v) => v + 1)
  }, [])

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

  const previewSql = useCallback(async () => {
    const changes = buildChanges()
    if (changes.length === 0) return
    try {
      const result = await metadataApi.editData(connectionId, database, tableName, changes, true) as DataEditResult
      Modal.info({
        title: '将执行以下 SQL', width: 600,
        content: (
          <pre style={{ background: '#1e1e1e', color: '#d4d4d4', padding: 12, borderRadius: 6, fontSize: 12, fontFamily: 'Menlo, Monaco, monospace', maxHeight: 300, overflow: 'auto' }}>
            {result.sqlStatements.join(';\n') || '无变更'}
          </pre>
        ),
      })
    } catch (e) { handleApiError(e, '生成 SQL 失败') }
  }, [buildChanges, connectionId, database, tableName])

  const save = useCallback(async () => {
    const changes = buildChanges()
    if (changes.length === 0) return
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
        'data-row-index': record._rowIndex,
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
            <span data-cell-display style={{ fontSize: 11, fontStyle: 'italic', color: token.colorTextTertiary }}>
              NULL
            </span>
          )
        }
        return <span data-cell-display style={{ display: 'block', maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{String(displayValue)}</span>
      },
    }))

    if (isEditable) {
      cols.push({
        title: '操作',
        dataIndex: '_action',
        key: '_action',
        width: 60,
        ellipsis: false,
        onCell: (record: TableRow) => ({
          'data-row-index': record._rowIndex,
          'data-column-key': '_action',
          style: { cursor: 'default' },
        }),
        render: (_: unknown, record: TableRow) => (
          <Popconfirm title="确定删除此行？" onConfirm={() => deleteRow(record._rowIndex)} okText="删除" cancelText="取消">
            <Button type="text" size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        ),
      })
    }
    return cols
  }, [columns, isEditable, token, deleteRow, hasCellChange, getCellValue, handleSort, sortColumn, sortDirection])

  const tableData = useMemo<TableRow[]>(
    () => effectiveData.map((r, i) => ({ ...r, _key: i, _rowIndex: i })),
    [effectiveData]
  )

  const pagedTableData = useMemo(() => {
    const start = (currentPage - 1) * pageSize
    return tableData.slice(start, start + pageSize)
  }, [currentPage, pageSize, tableData])

  const tableNode = useMemo(() => (
    <Table
      key={gridVersion}
      columns={tableColumns}
      dataSource={pagedTableData}
      rowKey="_key"
      pagination={false}
      size="small"
      scroll={{ x: 'max-content', y: tableScrollY }}
      rowClassName={(record) => {
        const classes: string[] = []
        const rowIndex = record._rowIndex as number
        if (pendingRows.some((p) => p.type === 'delete' && p.rowIndex === rowIndex)) classes.push('row-deleted')
        if (pendingRows.some((p) => p.type === 'insert' && p.rowIndex === rowIndex)) classes.push('row-inserted')
        return classes.join(' ')
      }}
    />
  ), [gridVersion, pagedTableData, pendingRows, tableColumns, tableScrollY])

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
        .editable-data-table .ant-table-thead > tr > th {
          background: ${token.colorFillAlter};
          font-weight: 600;
        }
        .editable-data-table .ant-table-tbody > tr.row-selected > td {
          background: ${token.colorPrimaryBg};
        }
        .editable-data-table .ant-table-tbody > tr.row-selected:hover > td {
          background: ${token.colorPrimaryBg};
        }
        .editable-data-table .ant-table-tbody > tr.row-inserted > td {
          background: ${token.colorSuccessBg};
        }
        .editable-data-table .ant-table-tbody > tr.row-inserted:hover > td {
          background: ${token.colorSuccessBg};
        }
        .editable-data-table .ant-table-tbody > tr.row-deleted > td {
          background: ${token.colorErrorBg};
          color: ${token.colorTextQuaternary};
          text-decoration: line-through;
        }
        .editable-data-table .ant-table-tbody > tr.row-deleted:hover > td {
          background: ${token.colorErrorBg};
        }
        .editable-data-table .ant-table-tbody td.cell-changed {
          background: ${token.colorWarningBg} !important;
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
                // 如果没有选中补全项，则触发筛选
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
      {/* 操作栏 */}
      {isEditable && (
        <div
          ref={toolbarRef}
          style={{
            marginBottom: 8,
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            flexWrap: 'wrap',
          }}
        >
          <Text type="secondary" style={{ fontSize: 12 }}>
            单击选中，双击编辑，Enter 确认，Esc 取消，Tab 切换
          </Text>
          <Space size={8} wrap>
            <Button size="small" icon={<PlusOutlined />} onClick={addRow}>新增行</Button>
            <Button size="small" icon={<UndoOutlined />} onClick={undoAll} disabled={!hasChanges}>撤销</Button>
            <Button size="small" icon={<ExclamationCircleOutlined />} onClick={previewSql} disabled={!hasChanges}>预览 SQL</Button>
            <Button size="small" type="primary" icon={<SaveOutlined />} onClick={save} loading={saving} disabled={!hasChanges}>
              保存 {hasChanges ? `(${cellChangeCount + pendingRows.length} 变更)` : ''}
            </Button>
          </Space>
        </div>
      )}

      {/* 表格 */}
      <div style={{ flex: 1, overflow: 'hidden', minHeight: 0 }}>
        {tableNode}
      </div>

      <div
        ref={pagerRef}
        style={{
          display: 'flex',
          justifyContent: 'flex-end',
          alignItems: 'center',
          padding: '10px 0 0',
          flexShrink: 0,
          background: token.colorBgContainer,
          borderTop: `1px solid ${token.colorBorderSecondary}`,
        }}
      >
        <Pagination
          current={currentPage}
          pageSize={pageSize}
          total={tableData.length}
          size="small"
          showSizeChanger
          pageSizeOptions={[20, 50, 100]}
          showTotal={(total) => `共 ${total} 行`}
          onChange={(page, size) => {
            setCurrentPage(page)
            if (size !== pageSize) {
              setPageSize(size)
            }
          }}
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
