import React, { useEffect, useState, useCallback } from 'react'
import {
  Layout, Tree, Tabs, Table, Typography, Input, Space, Button, Tag, Tooltip,
  theme, Spin,
} from 'antd'
import {
  DatabaseOutlined, TableOutlined, EyeOutlined,
  SearchOutlined, CodeOutlined,
} from '@ant-design/icons'
import type { DataNode } from 'antd/es/tree'
import type { DatabaseInfo, TableInfo, ColumnInfo, IndexInfo } from '@/types'
import { useWorkbenchStore } from '@/stores/workbenchStore'
import { metadataApi } from '@/services/api'
import { handleApiError } from '@/utils/notification'
import { EmptyState } from '@/components/EmptyState'
import { useNavigate } from 'react-router-dom'

const { Sider, Content } = Layout
const { Text } = Typography

export const WorkbenchPage: React.FC = () => {
  const { token } = theme.useToken()
  const navigate = useNavigate()

  const activeConnectionId = useWorkbenchStore((s) => s.activeConnectionId)
  const activeConnectionName = useWorkbenchStore((s) => s.activeConnectionName)
  const activeDatabase = useWorkbenchStore((s) => s.activeDatabase)
  const activeTable = useWorkbenchStore((s) => s.activeTable)
  const setActiveDatabase = useWorkbenchStore((s) => s.setActiveDatabase)
  const setActiveTable = useWorkbenchStore((s) => s.setActiveTable)

  const [databases, setDatabases] = useState<DatabaseInfo[]>([])
  const [tables, setTables] = useState<TableInfo[]>([])
  const [columns, setColumns] = useState<ColumnInfo[]>([])
  const [indexes, setIndexes] = useState<IndexInfo[]>([])
  const [ddl, setDdl] = useState('')
  const [previewRows, setPreviewRows] = useState<Record<string, unknown>[]>([])
  const [loading, setLoading] = useState(false)
  const [searchText, setSearchText] = useState('')

  // 未连接时展示空状态
  if (!activeConnectionId) {
    return (
      <EmptyState
        description="请先在「连接管理」中打开一个连接"
        actionText="前往连接管理"
        onAction={() => navigate('/connection')}
      />
    )
  }

  // 加载数据库列表
  const loadDatabases = useCallback(async () => {
    if (!activeConnectionId) return
    setLoading(true)
    try {
      const dbs = await metadataApi.databases(activeConnectionId) as DatabaseInfo[]
      setDatabases(dbs)
    } catch (e) {
      handleApiError(e, '加载数据库列表失败')
    } finally {
      setLoading(false)
    }
  }, [activeConnectionId])

  useEffect(() => { loadDatabases() }, [loadDatabases])

  // 选中数据库时加载表
  const loadTables = useCallback(async (dbName: string) => {
    if (!activeConnectionId) return
    try {
      const tbls = await metadataApi.objects(activeConnectionId, dbName) as TableInfo[]
      setTables(tbls)
    } catch (e) {
      handleApiError(e, '加载对象列表失败')
    }
  }, [activeConnectionId])

  // 选中表时加载详情
  const loadTableDetail = useCallback(async (dbName: string, tableName: string) => {
    if (!activeConnectionId) return
    try {
      const [def, idxs, rows, ddlStr] = await Promise.all([
        metadataApi.tableDefinition(activeConnectionId, dbName, tableName) as Promise<{ columns: ColumnInfo[] }>,
        metadataApi.indexes(activeConnectionId, dbName, tableName) as Promise<IndexInfo[]>,
        metadataApi.previewRows(activeConnectionId, dbName, tableName) as Promise<Record<string, unknown>[]>,
        metadataApi.ddl(activeConnectionId, dbName, tableName) as Promise<string>,
      ])
      setColumns(def.columns || [])
      setIndexes(idxs)
      setPreviewRows(rows)
      setDdl(ddlStr)
    } catch (e) {
      handleApiError(e, '加载表详情失败')
    }
  }, [activeConnectionId])

  const treeData: DataNode[] = databases
    .map((db) => {
      const filteredTables = activeDatabase === db.name
        ? tables.filter((t) => !searchText || t.name.toLowerCase().includes(searchText.toLowerCase()))
        : []
      return {
        key: db.name,
        title: db.name,
        icon: <DatabaseOutlined />,
        children: filteredTables.map((t) => ({
          key: `${db.name}.${t.name}`,
          title: (
            <Tooltip title={t.name} mouseEnterDelay={0.5}>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'inline-block', maxWidth: 180, verticalAlign: 'middle' }}>
                {t.name}
                {t.type === 'view' && <Tag style={{ marginLeft: 4, fontSize: 10 }}>VIEW</Tag>}
              </span>
            </Tooltip>
          ),
          icon: t.type === 'view' ? <EyeOutlined /> : <TableOutlined />,
          isLeaf: true,
        })),
      }
    })
    .filter((db) => {
      const dbMatch = db.key.toString().toLowerCase().includes(searchText.toLowerCase())
      const hasMatchingTable = db.children.length > 0
      return !searchText || dbMatch || hasMatchingTable
    })

  const handleTreeSelect = (_: React.Key[], info: { node: DataNode }) => {
    const key = info.node.key as string
    if (key.includes('.')) {
      // 选中表
      const [db, table] = key.split('.')
      setActiveTable(table)
      loadTableDetail(db, table)
    } else {
      // 选中数据库
      setActiveDatabase(key)
      setActiveTable(null)
      loadTables(key)
    }
  }

  // 表结构列定义
  const columnTableColumns = [
    { title: '字段名', dataIndex: 'name', key: 'name', width: 160 },
    { title: '类型', dataIndex: 'type', key: 'type', width: 140 },
    {
      title: '可空',
      dataIndex: 'nullable',
      key: 'nullable',
      width: 60,
      render: (v: boolean) => v ? '是' : '否',
    },
    { title: '默认值', dataIndex: 'defaultValue', key: 'defaultValue', width: 120 },
    {
      title: '主键',
      dataIndex: 'isPrimaryKey',
      key: 'isPrimaryKey',
      width: 60,
      render: (v: boolean) => v ? <Tag color="gold">PK</Tag> : null,
    },
    { title: '备注', dataIndex: 'comment', key: 'comment' },
  ]

  // 索引列定义
  const indexTableColumns = [
    { title: '索引名', dataIndex: 'name', key: 'name', width: 200 },
    {
      title: '字段',
      dataIndex: 'columns',
      key: 'columns',
      render: (cols: string[]) => cols.join(', '),
    },
    {
      title: '唯一',
      dataIndex: 'isUnique',
      key: 'isUnique',
      width: 60,
      render: (v: boolean) => v ? '是' : '否',
    },
    {
      title: '主键',
      dataIndex: 'isPrimary',
      key: 'isPrimary',
      width: 60,
      render: (v: boolean) => v ? <Tag color="gold">PK</Tag> : null,
    },
  ]

  // 数据预览列
  const previewColumns = previewRows.length > 0
    ? Object.keys(previewRows[0]).map((col) => ({
        title: col,
        dataIndex: col,
        key: col,
        width: 150,
        ellipsis: true,
        render: (v: unknown) => String(v ?? 'NULL'),
      }))
    : []

  return (
    <Layout style={{ height: '100%' }}>
      {/* 左侧对象树 */}
      <Sider
        width={260}
        style={{
          background: token.colorBgContainer,
          borderRight: `1px solid ${token.colorBorderSecondary}`,
          overflow: 'auto',
        }}
      >
        <div style={{ padding: '12px 12px 8px' }}>
          <Space style={{ marginBottom: 8, width: '100%' }} direction="vertical" size={8}>
            <Text strong style={{ fontSize: 13 }}>
              <DatabaseOutlined style={{ marginRight: 4 }} />
              {activeConnectionName ?? '对象浏览'}
            </Text>
            <Input
              placeholder="搜索数据库或表..."
              prefix={<SearchOutlined />}
              size="small"
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              allowClear
            />
          </Space>
        </div>
        <Spin spinning={loading}>
          <Tree
            treeData={treeData}
            showIcon
            blockNode
            onSelect={handleTreeSelect}
            selectedKeys={activeTable && activeDatabase ? [`${activeDatabase}.${activeTable}`] : activeDatabase ? [activeDatabase] : []}
            expandedKeys={activeDatabase ? [activeDatabase] : []}
            onExpand={(keys) => {
              const lastKey = keys[keys.length - 1] as string
              if (lastKey && !lastKey.includes('.')) {
                setActiveDatabase(lastKey)
                loadTables(lastKey)
              }
            }}
          />
        </Spin>
      </Sider>

      {/* 右侧详情区 */}
      <Content style={{ overflow: 'auto', background: token.colorBgLayout }}>
        {activeTable && activeDatabase ? (
          <div style={{ padding: 16 }}>
            <Space style={{ marginBottom: 12 }}>
              <Text strong>
                <TableOutlined style={{ marginRight: 4 }} />
                {activeDatabase}.{activeTable}
              </Text>
              <Button
                size="small"
                icon={<CodeOutlined />}
                onClick={() => navigate('/sql-editor')}
              >
                打开 SQL 编辑器
              </Button>
            </Space>

            <Tabs
              size="small"
              items={[
                {
                  key: 'columns',
                  label: '字段结构',
                  children: (
                    <Table
                      columns={columnTableColumns}
                      dataSource={columns}
                      rowKey="name"
                      pagination={false}
                      size="small"
                    />
                  ),
                },
                {
                  key: 'indexes',
                  label: '索引',
                  children: (
                    <Table
                      columns={indexTableColumns}
                      dataSource={indexes}
                      rowKey="name"
                      pagination={false}
                      size="small"
                    />
                  ),
                },
                {
                  key: 'preview',
                  label: '数据预览',
                  children: (
                    <Table
                      columns={previewColumns}
                      dataSource={previewRows.map((r, i) => ({ ...r, _key: i }))}
                      rowKey="_key"
                      pagination={false}
                      size="small"
                      scroll={{ x: 'max-content' }}
                    />
                  ),
                },
                {
                  key: 'ddl',
                  label: 'DDL',
                  children: (
                    <pre style={{
                      background: '#1e1e1e',
                      color: '#d4d4d4',
                      padding: 16,
                      borderRadius: token.borderRadius,
                      fontSize: 12,
                      fontFamily: 'Menlo, Monaco, monospace',
                      overflow: 'auto',
                      maxHeight: 400,
                    }}>
                      {ddl || '无 DDL 数据'}
                    </pre>
                  ),
                },
              ]}
            />
          </div>
        ) : (
          <EmptyState description="选择左侧对象树中的表以查看详情" />
        )}
      </Content>
    </Layout>
  )
}
