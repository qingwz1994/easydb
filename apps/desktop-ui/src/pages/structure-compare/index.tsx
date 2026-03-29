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
import React, { useState, useEffect, useCallback } from 'react'
import {
  Layout, Select, Button, Space, Typography, Checkbox, Table, Tabs, Tag,
  Card, List, Alert, Divider, theme, Spin, Popover
} from 'antd'
import {
  DiffOutlined, PlayCircleOutlined, CopyOutlined,
  WarningOutlined, CheckCircleOutlined, SendOutlined,
  DownloadOutlined, ReloadOutlined,
  SwapRightOutlined, DatabaseOutlined, SettingOutlined,
} from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import type { ColumnsType } from 'antd/es/table'
import type {
  ConnectionConfig, CompareConfig, CompareOptions,
  CompareResult, ColumnDiff, IndexDiff,
} from '@/types'
import { useConnectionStore } from '@/stores/connectionStore'
import { useSqlEditorStore } from '@/stores/sqlEditorStore'
import { connectionApi, metadataApi, compareApi } from '@/services/api'
import { handleApiError, toast } from '@/utils/notification'

const { Sider, Content } = Layout
const { Text, Title } = Typography

// 差异状态标签颜色
const statusTagMap: Record<string, { color: string; label: string }> = {
  only_in_source: { color: 'blue', label: '仅源存在' },
  only_in_target: { color: 'orange', label: '仅目标存在' },
  different: { color: 'red', label: '定义不一致' },
  identical: { color: 'default', label: '定义一致' },
}

const diffStatusTag: Record<string, { color: string; label: string }> = {
  added: { color: 'green', label: '新增' },
  removed: { color: 'red', label: '缺少' },
  modified: { color: 'orange', label: '修改' },
  identical: { color: 'default', label: '一致' },
}

const riskTagMap: Record<string, { color: string; label: string }> = {
  high: { color: 'red', label: '高风险' },
  medium: { color: 'orange', label: '中风险' },
  low: { color: 'default', label: '低风险' },
}

export const StructureComparePage: React.FC = () => {
  const { token } = theme.useToken()
  const navigate = useNavigate()
  const connections = useConnectionStore((s) => s.connections)
  const setConnections = useConnectionStore((s) => s.setConnections)
  const updateConnection = useConnectionStore((s) => s.updateConnection)
  const setPendingSql = useSqlEditorStore((s) => s.setPendingSql)

  // 配置状态
  const [sourceConnId, setSourceConnId] = useState<string>()
  const [targetConnId, setTargetConnId] = useState<string>()
  const [sourceDb, setSourceDb] = useState<string>()
  const [targetDb, setTargetDb] = useState<string>()
  const [sourceDbs, setSourceDbs] = useState<string[]>([])
  const [targetDbs, setTargetDbs] = useState<string[]>([])

  // 对比选项
  const [options, setOptions] = useState<CompareOptions>({
    ignoreComment: true,
    ignoreAutoIncrement: true,
    ignoreCharset: false,
    ignoreCollation: false,
    includeDropStatements: false,
  })

  // 结果状态
  const [comparing, setComparing] = useState(false)
  const [result, setResult] = useState<CompareResult | null>(null)
  const [selectedTable, setSelectedTable] = useState<string | null>(null)
  const [filter, setFilter] = useState<string>('all')

  const handleConnectionSelect = async (connId: string, type: 'source' | 'target') => {
    const conn = connections.find((c) => c.id === connId)
    if (!conn) return

    if (conn.status !== 'connected') {
      try {
        await connectionApi.open(conn.id)
        updateConnection(conn.id, { status: 'connected' })
        toast.success(`已连接到「${conn.name}」`)
      } catch (e) {
        handleApiError(e, '连接失败')
        return
      }
    }
    
    if (type === 'source') {
      setSourceConnId(connId)
      setSourceDb(undefined)
    } else {
      setTargetConnId(connId)
      setTargetDb(undefined)
    }
  }

  const connOptions = connections.map((c) => ({
    value: c.id,
    label: (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span>{c.name} ({c.host}:{c.port})</span>
        {c.status !== 'connected' && (
          <span style={{ fontSize: 12, color: token.colorTextQuaternary }}>未连接</span>
        )}
      </div>
    )
  }))

  // 加载连接列表
  useEffect(() => {
    if (connections.length === 0) {
      connectionApi.list().then((list) => {
        setConnections(list as ConnectionConfig[])
      }).catch(() => {})
    }
  }, [connections.length, setConnections])

  // 加载源数据库
  useEffect(() => {
    if (!sourceConnId) { setSourceDbs([]); return }
    metadataApi.databases(sourceConnId).then((dbs) => {
      setSourceDbs((dbs as Array<{ name: string }>).map((d) => d.name))
    }).catch(() => setSourceDbs([]))
  }, [sourceConnId])

  // 加载目标数据库
  useEffect(() => {
    if (!targetConnId) { setTargetDbs([]); return }
    metadataApi.databases(targetConnId).then((dbs) => {
      setTargetDbs((dbs as Array<{ name: string }>).map((d) => d.name))
    }).catch(() => setTargetDbs([]))
  }, [targetConnId])

  // 执行对比
  const handleCompare = useCallback(async () => {
    if (!sourceConnId || !targetConnId || !sourceDb || !targetDb) {
      toast.warning('请选择源连接、目标连接和数据库')
      return
    }
    setComparing(true)
    setResult(null)
    setSelectedTable(null)
    try {
      const config: CompareConfig = {
        sourceConnectionId: sourceConnId,
        targetConnectionId: targetConnId,
        sourceDatabase: sourceDb,
        targetDatabase: targetDb,
        tables: [],
        options,
      }
      const res = await compareApi.execute(config) as CompareResult
      setResult(res)
      // 自动选中第一个差异对象
      const firstDiff = res.tables.find((t) => t.status !== 'identical')
      if (firstDiff) setSelectedTable(firstDiff.tableName)
      else if (res.tables.length > 0) setSelectedTable(res.tables[0].tableName)
    } catch (e) {
      handleApiError(e, '结构对比失败')
    } finally {
      setComparing(false)
    }
  }, [sourceConnId, targetConnId, sourceDb, targetDb, options])

  // 筛选后的表列表
  const filteredTables = result?.tables.filter((t) => {
    if (filter === 'all') return true
    if (filter === 'diff') return t.status !== 'identical'
    if (filter === 'high_risk') return t.risk === 'high'
    return true
  }) ?? []

  // 当前选中的表详情
  const selectedDetail = result?.tables.find((t) => t.tableName === selectedTable) ?? null

  // 复制 SQL
  const handleCopySql = () => {
    if (selectedDetail?.sql) {
      navigator.clipboard.writeText(selectedDetail.sql)
      toast.success('SQL 已复制到剪贴板')
    }
  }

  // 复制全部差异 SQL
  const handleCopyAllSql = () => {
    if (!result) return
    const allSql = buildAllSql()
    if (allSql) {
      navigator.clipboard.writeText(allSql)
      toast.success('全部差异 SQL 已复制')
    }
  }

  // 构建全部差异 SQL
  const buildAllSql = () => {
    if (!result) return ''
    return result.tables
      .filter((t) => t.sql)
      .map((t) => `-- ${t.tableName}\n${t.sql}`)
      .join('\n\n')
  }

  // 发送到 SQL 编辑器
  const handleSendToEditor = (sql: string) => {
    if (!sql) return
    setPendingSql(sql, targetConnId, targetDb)
    navigate('/sql-editor')
  }

  // 导出 SQL 文件
  const handleExportSql = () => {
    const allSql = buildAllSql()
    if (!allSql) { toast.warning('无可导出的 SQL'); return }
    const header = `-- EasyDB 结构对比 SQL\n-- 源: ${sourceDb} → 目标: ${targetDb}\n-- 生成时间: ${new Date().toLocaleString()}\n\n`
    const blob = new Blob([header + allSql], { type: 'text/sql;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `structure-compare-${targetDb}-${Date.now()}.sql`
    a.click()
    URL.revokeObjectURL(url)
    toast.success('SQL 文件已导出')
  }

  // 字段对比表格列
  const columnDiffColumns: ColumnsType<ColumnDiff> = [
    {
      title: '字段名', dataIndex: 'columnName', key: 'columnName', width: 140,
      render: (v: string, r: ColumnDiff) => (
        <Space>
          <Text strong>{v}</Text>
          <Tag color={diffStatusTag[r.status]?.color}>{diffStatusTag[r.status]?.label}</Tag>
        </Space>
      ),
    },
    { title: '源类型', dataIndex: 'sourceType', key: 'sourceType', width: 140, render: (v: string) => v ?? '-' },
    { title: '目标类型', dataIndex: 'targetType', key: 'targetType', width: 140, render: (v: string) => v ?? '-' },
    { title: '差异说明', dataIndex: 'details', key: 'details', ellipsis: true, render: (v: string) => v || '一致' },
  ]

  // 索引对比表格列
  const indexDiffColumns: ColumnsType<IndexDiff> = [
    {
      title: '索引名', dataIndex: 'indexName', key: 'indexName', width: 160,
      render: (v: string, r: IndexDiff) => (
        <Space>
          <Text strong>{v}</Text>
          <Tag color={diffStatusTag[r.status]?.color}>{diffStatusTag[r.status]?.label}</Tag>
        </Space>
      ),
    },
    { title: '源列', dataIndex: 'sourceColumns', key: 'sourceColumns', width: 200, render: (v: string[]) => v?.join(', ') ?? '-' },
    { title: '目标列', dataIndex: 'targetColumns', key: 'targetColumns', width: 200, render: (v: string[]) => v?.join(', ') ?? '-' },
    { title: '差异说明', dataIndex: 'details', key: 'details', ellipsis: true, render: (v: string) => v || '一致' },
  ]

  const optionsContent = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 200, padding: '8px 4px' }}>
      <Checkbox checked={options.ignoreComment} onChange={(e) => setOptions({ ...options, ignoreComment: e.target.checked })}>
        忽略表注释 (Ignore Comment)
      </Checkbox>
      <Checkbox checked={options.ignoreAutoIncrement} onChange={(e) => setOptions({ ...options, ignoreAutoIncrement: e.target.checked })}>
        忽略自增初始值 (Ignore AUTO_INCREMENT)
      </Checkbox>
      <Checkbox checked={options.ignoreCharset} onChange={(e) => setOptions({ ...options, ignoreCharset: e.target.checked })}>
        忽略字符集 (Ignore Charset)
      </Checkbox>
      <Checkbox checked={options.ignoreCollation} onChange={(e) => setOptions({ ...options, ignoreCollation: e.target.checked })}>
        忽略排序规则 (Ignore Collation)
      </Checkbox>
      <Divider style={{ margin: '4px 0' }} />
      <Checkbox checked={options.includeDropStatements} onChange={(e) => setOptions({ ...options, includeDropStatements: e.target.checked })}>
        <Text type={options.includeDropStatements ? 'danger' : undefined}>
          包含删除语句 (Include Drop Statements)
        </Text>
      </Checkbox>
    </div>
  )

  return (
    <Layout style={{ height: '100%' }}>
      {/* 顶部配置栏 (迷你双屏) */}
      <div style={{
        padding: '16px 24px',
        background: token.colorBgContainer,
        borderBottom: `1px solid ${token.colorBorderSecondary}`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        boxShadow: '0 2px 8px rgba(0,0,0,0.02)',
        zIndex: 10
      }}>
        <div style={{ display: 'flex', alignItems: 'center', flex: 1, gap: 16 }}>
          {/* 左侧：源端 */}
          <div style={{ 
            display: 'flex', alignItems: 'center', gap: 12, padding: '10px 16px', 
            background: token.colorBgLayout, borderRadius: 8, 
            border: `1px solid ${sourceConnId ? token.colorPrimaryBorder : token.colorBorderSecondary}` 
          }}>
            <Text strong type="secondary" style={{ width: 45, color: token.colorPrimary }}><DatabaseOutlined style={{ marginRight: 4 }}/>源端:</Text>
            <Select
              style={{ width: 180 }} placeholder="选择源连接"
              value={sourceConnId} onChange={(v) => handleConnectionSelect(v, 'source')}
              options={connOptions} listHeight={320} bordered={false}
            />
            <Divider type="vertical" />
            <Select
              style={{ width: 150 }} placeholder="源数据库"
              value={sourceDb} onChange={setSourceDb}
              options={sourceDbs.map((d) => ({ label: d, value: d }))}
              disabled={!sourceConnId} showSearch bordered={false}
            />
          </div>

          <div style={{ padding: '0 8px', background: token.colorBgContainer, borderRadius: '50%', boxShadow: '0 2px 6px rgba(0,0,0,0.08)', display: 'flex', alignItems: 'center', justifyContent: 'center', width: 32, height: 32 }}>
            <SwapRightOutlined style={{ fontSize: 18, color: token.colorPrimary }} />
          </div>

          {/* 右侧：目标端 */}
          <div style={{ 
            display: 'flex', alignItems: 'center', gap: 12, padding: '10px 16px', 
            background: token.colorBgLayout, borderRadius: 8, 
            border: `1px solid ${targetConnId ? token.colorSuccessBorder : token.colorBorderSecondary}` 
          }}>
            <Text strong type="secondary" style={{ width: 45, color: token.colorSuccess }}><DatabaseOutlined style={{ marginRight: 4 }}/>目标:</Text>
            <Select
              style={{ width: 180 }} placeholder="选择目标连接"
              value={targetConnId} onChange={(v) => handleConnectionSelect(v, 'target')}
              options={connOptions} listHeight={320} bordered={false}
            />
            <Divider type="vertical" />
            <Select
              style={{ width: 150 }} placeholder="目标数据库"
              value={targetDb} onChange={setTargetDb}
              options={targetDbs.map((d) => ({ label: d, value: d }))}
              disabled={!targetConnId} showSearch bordered={false}
            />
          </div>
        </div>

        <Space size="middle">
          <Popover content={optionsContent} title="对比高级设置" trigger="click" placement="bottomRight">
            <Button size="large" icon={<SettingOutlined />}>高级选项</Button>
          </Popover>
          <Button
            type="primary" size="large" icon={<PlayCircleOutlined />}
            onClick={handleCompare} loading={comparing}
            disabled={!sourceConnId || !targetConnId || !sourceDb || !targetDb}
            style={{ paddingLeft: 32, paddingRight: 32 }}
          >
            执行结构对比
          </Button>
        </Space>
      </div>

      {/* 主体区域 */}
      {comparing ? (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Spin size="large" tip="正在分析结构差异..." />
        </div>
      ) : !result ? (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ textAlign: 'center', color: token.colorTextSecondary }}>
            <DiffOutlined style={{ fontSize: 48, marginBottom: 16 }} />
            <div>选择源连接和目标连接后，点击「开始对比」</div>
          </div>
        </div>
      ) : (
        <Layout style={{ flex: 1, overflow: 'hidden' }}>
          {/* 左侧：差异对象列表 */}
          <Sider width={300} style={{
            background: token.colorBgContainer,
            borderRight: `1px solid ${token.colorBorderSecondary}`,
            overflow: 'auto',
          }}>
            {/* 摘要头部 */}
            <div style={{ padding: '12px 16px', borderBottom: `1px solid ${token.colorBorderSecondary}` }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <Space size={8}>
                  <Text strong style={{ fontSize: 14 }}>对比结果</Text>
                  <Tag color={result.diffCount > 0 ? 'red' : 'green'} style={{ margin: 0 }}>
                    {result.diffCount > 0 ? `${result.diffCount} 差异` : '无差异'}
                  </Tag>
                </Space>
                <Button type="text" size="small" icon={<ReloadOutlined />} onClick={handleCompare} title="重新对比" />
              </div>
              <Text type="secondary" style={{ fontSize: 12 }}>
                共 {result.totalTables} 个表，{result.tables.filter(t => t.status === 'only_in_source').length} 仅源存在，{result.tables.filter(t => t.status === 'different').length} 不一致
              </Text>
              <div style={{ marginTop: 8, display: 'flex', gap: 4 }}>
                <Button size="small" type={filter === 'all' ? 'primary' : 'default'} onClick={() => setFilter('all')}>全部 ({result.totalTables})</Button>
                <Button size="small" type={filter === 'diff' ? 'primary' : 'default'} onClick={() => setFilter('diff')}>差异 ({result.diffCount})</Button>
                <Button size="small" type={filter === 'high_risk' ? 'primary' : 'default'} onClick={() => setFilter('high_risk')}>高风险</Button>
              </div>
            </div>

            <List
              size="small"
              dataSource={filteredTables}
              renderItem={(item) => (
                <List.Item
                  style={{
                    padding: '8px 16px',
                    cursor: 'pointer',
                    background: selectedTable === item.tableName ? token.colorPrimaryBg : undefined,
                  }}
                  onClick={() => setSelectedTable(item.tableName)}
                >
                  <div style={{ width: '100%' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <Text strong style={{ fontSize: 13 }}>{item.tableName}</Text>
                      <Tag color={statusTagMap[item.status]?.color} style={{ margin: 0 }}>
                        {statusTagMap[item.status]?.label}
                      </Tag>
                    </div>
                    {item.summary && item.status !== 'identical' && (
                      <Text type="secondary" style={{ fontSize: 11 }}>{item.summary}</Text>
                    )}
                  </div>
                </List.Item>
              )}
            />
          </Sider>

          {/* 中间 + 右侧：详情与 SQL */}
          <Content style={{ overflow: 'auto' }}>
            {/* 全局操作工具栏 */}
            <div style={{
              padding: '8px 16px',
              background: token.colorBgContainer,
              borderBottom: `1px solid ${token.colorBorderSecondary}`,
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}>
              <Text type="secondary" style={{ fontSize: 12 }}>
                {selectedDetail ? `${selectedDetail.tableName} — ${selectedDetail.summary || statusTagMap[selectedDetail.status]?.label}` : '选择左侧对象查看详情'}
              </Text>
              <Space size={8}>
                <Button size="small" icon={<CopyOutlined />} onClick={handleCopyAllSql} disabled={result.diffCount === 0}>复制全部 SQL</Button>
                <Button size="small" icon={<DownloadOutlined />} onClick={handleExportSql} disabled={result.diffCount === 0}>导出</Button>
                <Button size="small" type="primary" icon={<SendOutlined />} onClick={() => handleSendToEditor(buildAllSql())} disabled={result.diffCount === 0}>发送到编辑器</Button>
              </Space>
            </div>

            <div style={{ padding: 16 }}>
            {selectedDetail ? (
              <div>
                {/* 对象标题 */}
                <div style={{
                  marginBottom: 16,
                  paddingBottom: 12,
                  borderBottom: `1px solid ${token.colorBorderSecondary}`,
                }}>
                  <Space size={8}>
                    <Title level={5} style={{ margin: 0 }}>{selectedDetail.tableName}</Title>
                    <Tag color={statusTagMap[selectedDetail.status]?.color}>
                      {statusTagMap[selectedDetail.status]?.label}
                    </Tag>
                    {selectedDetail.risk !== 'low' && (
                      <Tag color={riskTagMap[selectedDetail.risk]?.color}>
                        {riskTagMap[selectedDetail.risk]?.label}
                      </Tag>
                    )}
                  </Space>
                  {selectedDetail.summary && (
                    <div style={{ marginTop: 4 }}>
                      <Text type="secondary">{selectedDetail.summary}</Text>
                    </div>
                  )}
                </div>

                {/* 差异详情 Tab */}
                {(selectedDetail.status === 'different') && (
                  <Tabs
                    size="small"
                    items={[
                      {
                        key: 'columns',
                        label: `字段对比 (${selectedDetail.columnDiffs.filter((c) => c.status !== 'identical').length} 差异)`,
                        children: (
                          <Table
                            columns={columnDiffColumns}
                            dataSource={selectedDetail.columnDiffs}
                            rowKey="columnName"
                            size="small"
                            pagination={false}
                            rowClassName={(r) => r.status !== 'identical' ? 'diff-row' : ''}
                          />
                        ),
                      },
                      {
                        key: 'indexes',
                        label: `索引对比 (${selectedDetail.indexDiffs.filter((i) => i.status !== 'identical').length} 差异)`,
                        children: (
                          <Table
                            columns={indexDiffColumns}
                            dataSource={selectedDetail.indexDiffs}
                            rowKey="indexName"
                            size="small"
                            pagination={false}
                          />
                        ),
                      },
                    ]}
                  />
                )}

                {/* SQL 预览 */}
                {selectedDetail.sql && (
                  <Card
                    size="small"
                    title="生成 SQL"
                    style={{ marginTop: 16 }}
                    extra={
                      <Space>
                        <Button size="small" icon={<CopyOutlined />} onClick={handleCopySql}>复制</Button>
                        <Button size="small" icon={<DownloadOutlined />} onClick={handleExportSql}>导出</Button>
                        <Button size="small" type="primary" icon={<SendOutlined />} onClick={() => handleSendToEditor(selectedDetail.sql)}>发送到编辑器</Button>
                      </Space>
                    }
                  >
                    {selectedDetail.risk === 'high' && (
                      <Alert
                        type="warning"
                        showIcon
                        icon={<WarningOutlined />}
                        message="高风险操作：包含 DROP 语句，请仔细审核后再执行"
                        style={{ marginBottom: 12 }}
                      />
                    )}
                    <pre style={{
                      background: token.colorBgLayout,
                      padding: 12,
                      borderRadius: 6,
                      fontSize: 12,
                      fontFamily: 'Monaco, Consolas, monospace',
                      overflow: 'auto',
                      maxHeight: 400,
                      whiteSpace: 'pre-wrap',
                      margin: 0,
                    }}>
                      {selectedDetail.sql}
                    </pre>
                  </Card>
                )}

                {!selectedDetail.sql && selectedDetail.status === 'identical' && (
                  <div style={{ textAlign: 'center', padding: 40, color: token.colorTextSecondary }}>
                    <CheckCircleOutlined style={{ fontSize: 32, marginBottom: 8 }} />
                    <div>结构一致，无需生成 SQL</div>
                  </div>
                )}

                {/* 底部提示 */}
                <Alert
                  type="info"
                  style={{ marginTop: 16 }}
                  message="当前对比以「源连接」为准，系统分别读取两端元数据完成分析，不要求源实例与目标实例之间直接互通。生成 SQL 默认仅供人工审核与手动执行。"
                />
              </div>
            ) : (
              <div style={{ textAlign: 'center', padding: 40, color: token.colorTextSecondary }}>
                <DiffOutlined style={{ fontSize: 32, marginBottom: 8 }} />
                <div>请在左侧选择一个对象查看差异</div>
              </div>
            )}
            </div>
          </Content>
        </Layout>
      )}
    </Layout>
  )
}
