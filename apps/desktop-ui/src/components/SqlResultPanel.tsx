import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Alert, Dropdown, Modal, Space, Table, Typography, theme } from 'antd'
import { DownloadOutlined } from '@ant-design/icons'
import type { SqlResult } from '@/types'
import { sqlApi } from '@/services/api'
import { exportResultSet } from '@/utils/exportUtils'
import {
  formatSqlCell,
  isSqlCellTruncated,
  previewSqlCellText,
  stripSqlCellTruncationMarker,
} from '@/pages/sql-editor/queryPreview'

const { Text } = Typography

interface SqlResultPanelProps {
  result: SqlResult
  displayLabel: string
  tableHeight: number
  loadMoreKey?: string
  currentLoadKey?: string | null
  onLoadMore?: () => void
  onResultMetaChange?: (patch: Partial<SqlResult>) => void
}

interface CellPreviewState {
  column: string
  value: string
  truncated: boolean
}

export const SqlResultPanel: React.FC<SqlResultPanelProps> = ({
  result,
  displayLabel,
  tableHeight,
  loadMoreKey,
  currentLoadKey,
  onLoadMore,
  onResultMetaChange,
}) => {
  const { token } = theme.useToken()
  const [cellPreview, setCellPreview] = useState<CellPreviewState | null>(null)
  const [tableScrollY, setTableScrollY] = useState(Math.max(220, tableHeight - 24))
  const containerRef = useRef<HTMLDivElement | null>(null)
  const toolbarRef = useRef<HTMLDivElement | null>(null)
  const tableBodyRef = useRef<HTMLDivElement | null>(null)
  const autoLoadLockRef = useRef(false)
  const isLoadingMore = currentLoadKey === loadMoreKey

  const maybeLoadMore = useMemo(() => {
    return () => {
      const scrollBody = tableBodyRef.current
      if (!scrollBody || !result.preview || !result.hasMore || !onLoadMore || isLoadingMore || autoLoadLockRef.current) {
        return
      }

      const threshold = 120
      const reachedBottom = scrollBody.scrollTop + scrollBody.clientHeight >= scrollBody.scrollHeight - threshold
      const noOverflowYet = scrollBody.scrollHeight <= scrollBody.clientHeight + 8
      if (!reachedBottom && !noOverflowYet) return

      autoLoadLockRef.current = true
      onLoadMore()
    }
  }, [isLoadingMore, onLoadMore, result.hasMore, result.preview])

  useLayoutEffect(() => {
    const container = containerRef.current
    if (!container) return undefined

    const updateHeight = () => {
      const toolbarHeight = toolbarRef.current?.getBoundingClientRect().height ?? 0
      const headerHeight = 40
      const outerGap = 16
      
      const containerTop = container.getBoundingClientRect().top
      const availableHeight = window.innerHeight - containerTop
      
      const next = Math.max(
        220,
        Math.floor(availableHeight - toolbarHeight - headerHeight - outerGap)
      )
      
      setTableScrollY(next)
    }

    updateHeight()
    const observer = new ResizeObserver(updateHeight)
    observer.observe(container)
    if (toolbarRef.current) observer.observe(toolbarRef.current)
    return () => observer.disconnect()
  }, [result.hasMore, result.rows?.length, tableHeight])

  useEffect(() => {
    autoLoadLockRef.current = false
  }, [isLoadingMore, result.rows?.length])

  useEffect(() => {
    if (!result.querySessionId || typeof result.totalRows === 'number' || !onResultMetaChange) {
      return undefined
    }

    let cancelled = false
    const poll = async () => {
      try {
        const status = await sqlApi.querySessionStatus(result.querySessionId!) as {
          querySessionId: string
          totalRows?: number
          counting: boolean
          exists: boolean
        }

        if (cancelled) return

        if (typeof status.totalRows === 'number') {
          onResultMetaChange({ totalRows: status.totalRows })
          return
        }

        if (!status.exists || !status.counting) {
          return
        }

        window.setTimeout(poll, 1000)
      } catch {
        // ignore polling failures
      }
    }

    const timerId = window.setTimeout(poll, 500)
    return () => {
      cancelled = true
      window.clearTimeout(timerId)
    }
  }, [onResultMetaChange, result.querySessionId, result.totalRows])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return undefined

    const nextTableBody = (
      container.querySelector('.ant-table-tbody-virtual-holder') ??
      container.querySelector('.ant-table-body')
    ) as HTMLDivElement | null

    tableBodyRef.current = nextTableBody
    if (!nextTableBody) return undefined

    const handleScroll = () => {
      maybeLoadMore()
    }

    nextTableBody.addEventListener('scroll', handleScroll, { passive: true })
    window.requestAnimationFrame(maybeLoadMore)

    return () => {
      nextTableBody.removeEventListener('scroll', handleScroll)
      if (tableBodyRef.current === nextTableBody) {
        tableBodyRef.current = null
      }
    }
  }, [maybeLoadMore, result.rows?.length, tableScrollY])

  const columns = useMemo(() => (
    result.columns?.map((column) => ({
      title: column,
      dataIndex: column,
      key: column,
      width: 180,
      ellipsis: true,
      render: (value: unknown) => {
        const cellText = formatSqlCell(value)
        const truncated = isSqlCellTruncated(cellText)
        const cleanValue = stripSqlCellTruncationMarker(cellText)
        return (
          <button
            type="button"
            onClick={() => setCellPreview({ column, value: cleanValue, truncated })}
            style={{
              all: 'unset',
              display: 'block',
              width: '100%',
              cursor: 'pointer',
              fontFamily: 'Menlo, Monaco, Consolas, monospace',
              fontSize: 13,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              color: token.colorText,
            }}
            title={truncated ? '点击查看已加载内容（当前单元格已截断）' : '点击查看内容'}
          >
            {previewSqlCellText(cleanValue)}
          </button>
        )
      },
      onCell: () => ({
        style: {
          fontFamily: 'Menlo, Monaco, Consolas, monospace',
          fontSize: 13,
          padding: '4px 8px',
          whiteSpace: 'nowrap',
        },
      }),
      onHeaderCell: () => ({
        style: { padding: '6px 8px', fontWeight: 600 },
      }),
    })) ?? []
  ), [result.columns, token.colorText])

  return (
    <div ref={containerRef} style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div ref={toolbarRef} style={{ display: 'flex', justifyContent: 'flex-end', padding: '2px 0 4px', gap: 8, flexShrink: 0 }}>
        <Space size={8} style={{ flex: 1, flexWrap: 'wrap' }}>
          <Text type="secondary" style={{ fontSize: 12, lineHeight: '24px' }}>
            已加载 {result.loadedRows ?? result.rows?.length ?? 0} 行 · {result.duration}ms
            {typeof result.totalRows === 'number' ? ` · 共 ${result.totalRows} 条` : ''}
          </Text>
        </Space>
        <Dropdown
          menu={{
            items: [
              {
                key: 'csv',
                label: result.preview ? '导出当前已加载为 CSV' : '导出为 CSV',
                onClick: () => exportResultSet(result.columns ?? [], result.rows ?? [], 'csv', displayLabel),
              },
              {
                key: 'json',
                label: result.preview ? '导出当前已加载为 JSON' : '导出为 JSON',
                onClick: () => exportResultSet(result.columns ?? [], result.rows ?? [], 'json', displayLabel),
              },
            ],
          }}
        >
          <Typography.Link>
            <Space size={4}>
              <DownloadOutlined />
              导出
            </Space>
          </Typography.Link>
        </Dropdown>
      </div>

      <div style={{ flex: 1, overflow: 'hidden', minHeight: 0 }}>
        <Table
          bordered
          virtual
          className="sql-spreadsheet-grid"
          columns={columns}
          dataSource={result.rows?.map((row, index) => ({ ...row, _key: index })) ?? []}
          rowKey="_key"
          pagination={false}
          size="small"
          scroll={{ x: 'max-content', y: tableScrollY }}
          rowClassName={(_, index) => index % 2 === 0 ? 'table-row-light' : 'table-row-dark'}
        />
      </div>

      <Modal
        open={Boolean(cellPreview)}
        title={cellPreview ? `查看单元格：${cellPreview.column}` : '查看单元格'}
        footer={null}
        width={720}
        onCancel={() => setCellPreview(null)}
      >
        {cellPreview?.truncated && (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 12 }}
            message="当前单元格内容已在预览模式中截断"
            description="为避免大结果集拖慢页面，这里显示的是当前已加载内容，不一定是数据库中的完整值。"
          />
        )}
        <div
          style={{
            maxHeight: 480,
            overflow: 'auto',
            padding: 12,
            borderRadius: token.borderRadius,
            background: token.colorFillAlter,
            border: '1px solid var(--glass-border)',
            fontFamily: 'Menlo, Monaco, Consolas, monospace',
            fontSize: 13,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {cellPreview?.value ?? ''}
        </div>
      </Modal>
    </div>
  )
}
